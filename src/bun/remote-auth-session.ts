import { randomUUID } from "node:crypto";
import type { AuthCredentials } from "../shared/auth";
import type {
	AuthSessionIdentity,
	DesktopAuthSessionManager,
} from "./auth-session";
import { AUTH_REFRESH_TOKEN_CREDENTIAL } from "./credential-helper-client";
import type { ModelRelayPurpose } from "./model-relay-transport";

const REFRESH_TOKEN_KEY = AUTH_REFRESH_TOKEN_CREDENTIAL;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface SecureCredentialStore {
	read(name: string): Promise<string | null>;
	write(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
}

export interface RemoteAuthUser {
	id: string;
	displayName: string;
	email: string;
	initials: string;
}

export interface RemoteAuthSession {
	id: string;
	user: RemoteAuthUser;
	expiresAtMs: number;
}

interface SessionResponse extends RemoteAuthSession {
	accessToken: string;
	refreshToken: string;
}

export type RemoteAuthFailureKind =
	| "invalid-credentials"
	| "offline"
	| "service-unavailable"
	| "expired"
	| "secure-storage-unavailable"
	| "unexpected";

export class RemoteAuthError extends Error {
	constructor(
		readonly kind: RemoteAuthFailureKind,
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "RemoteAuthError";
	}
}

export interface RemoteAuthSessionManagerOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	requestTimeoutMs?: number;
	onBeforeSessionClear?: (accountId: string | null) => Promise<void>;
	/** Must durably prepare account-owned local state before current is exposed. */
	onBeforeSessionActivate?: (identity: AuthSessionIdentity) => Promise<void>;
	/** Runs after current is published; failure revokes that activation fail closed. */
	onSessionActivated?: (identity: AuthSessionIdentity) => Promise<void>;
	onSessionExpired?: () => void;
}

/**
 * Owns all bearer credentials in the Bun main process. Renderers and the
 * Mastra sidecar only receive the public session projection.
 */
export class RemoteAuthSessionManager implements DesktopAuthSessionManager {
	private readonly baseUrl: URL | null;
	private readonly fetchImpl: typeof fetch;
	private readonly requestTimeoutMs: number;
	private readonly onBeforeSessionClear: (
		accountId: string | null,
	) => Promise<void>;
	private readonly onBeforeSessionActivate: (
		identity: AuthSessionIdentity,
	) => Promise<void>;
	private readonly onSessionActivated: (
		identity: AuthSessionIdentity,
	) => Promise<void>;
	private readonly onSessionExpired: () => void;
	private current: {
		session: RemoteAuthSession;
		accessToken: string;
		generation: number;
	} | null = null;
	private refreshPromise: {
		identity: AuthSessionIdentity;
		operation: Promise<RemoteAuthSession>;
	} | null = null;
	private generation = 0;
	private transitionTail = Promise.resolve();
	private readonly remoteSettlements = new Set<Promise<void>>();
	private acceptingWork = true;

	constructor(
		private readonly credentials: SecureCredentialStore,
		options: RemoteAuthSessionManagerOptions = {},
	) {
		this.baseUrl = options.baseUrl
			? validateRemoteBaseUrl(options.baseUrl)
			: null;
		this.fetchImpl = options.fetch ?? fetch;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.onBeforeSessionClear =
			options.onBeforeSessionClear ?? (async () => {});
		this.onBeforeSessionActivate =
			options.onBeforeSessionActivate ?? (async () => {});
		this.onSessionActivated = options.onSessionActivated ?? (async () => {});
		this.onSessionExpired = options.onSessionExpired ?? (() => {});
	}

	getSession(): RemoteAuthSession | null {
		return this.current?.generation === this.generation
			? cloneSession(this.current.session)
			: null;
	}

	/** Waits until every already-started transition and refresh has settled. */
	async drain(): Promise<void> {
		for (;;) {
			const transition = this.transitionTail;
			const refresh = this.refreshPromise?.operation ?? null;
			const remoteSettlements = [...this.remoteSettlements];
			const settlements: Promise<unknown>[] = [
				transition,
				...remoteSettlements,
			];
			if (refresh !== null) settlements.push(refresh);
			await Promise.allSettled(settlements);
			if (
				this.transitionTail === transition &&
				(this.refreshPromise?.operation ?? null) === refresh &&
				remoteSettlements.every(
					(settlement) => !this.remoteSettlements.has(settlement),
				) &&
				this.remoteSettlements.size === 0
			) {
				return;
			}
		}
	}

	beginShutdown(): void {
		this.acceptingWork = false;
	}

	get accountId(): string | null {
		return this.current?.generation === this.generation
			? this.current.session.user.id
			: null;
	}

	get sessionGeneration(): number {
		return this.generation;
	}

	async restoreSession(): Promise<RemoteAuthSession | null> {
		this.requireAcceptingWork();
		this.requireConfigured();
		const previousAccountId = this.current?.session.user.id ?? null;
		const generation = ++this.generation;
		let refreshToken: string | null;
		if (previousAccountId !== null) {
			// Restoring over a live session is an account replacement, just like a
			// new sign-in. Run the old-owner barrier before reading its credential;
			// only a fully successful cleanup may carry that token into the network.
			this.current = null;
			this.refreshPromise = null;
			refreshToken = await this.clearLiveSessionForReplacement(
				previousAccountId,
				true,
			);
		} else {
			try {
				refreshToken = await this.credentials.read(REFRESH_TOKEN_KEY);
			} catch (error) {
				throw credentialFailure(error);
			}
		}
		if (!refreshToken) return null;
		return this.refreshWith(refreshToken, generation);
	}

	async signIn(credentials: AuthCredentials): Promise<RemoteAuthSession> {
		this.requireAcceptingWork();
		this.requireConfigured();
		const previousAccountId = this.current?.session.user.id ?? null;
		const generation = ++this.generation;
		if (previousAccountId !== null) {
			// A replacement sign-in is an immediate ownership boundary, not a
			// speculative request layered over the live account. Invalidate the old
			// session and finish its local cleanup before waiting on the network so a
			// failed or slow login cannot leave an unauthenticated cloud owner active.
			this.current = null;
			this.refreshPromise = null;
			await this.clearLiveSessionForReplacement(previousAccountId, false);
		}
		let response: Response;
		try {
			response = await this.request("/v1/auth/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: credentials.email.trim().toLowerCase(),
					password: credentials.password,
				}),
			});
		} catch (error) {
			throw transportFailure(error);
		}
		if (response.status === 401) {
			throw new RemoteAuthError(
				"invalid-credentials",
				"邮箱或密码不正确。",
				401,
			);
		}
		if (!response.ok) throw responseFailure(response);
		const payload = parseSessionResponse(await readJson(response));
		if (generation !== this.generation) {
			throw new RemoteAuthError("expired", "登录操作已被新的会话操作取代。");
		}
		if (!(await this.persistAndActivate(payload, generation))) {
			throw new RemoteAuthError("expired", "登录操作已被新的会话操作取代。");
		}
		return cloneSession(payload);
	}

	captureCurrentSession(): AuthSessionIdentity | null {
		if (!this.current || this.current.generation !== this.generation)
			return null;
		return {
			accountId: this.current.session.user.id,
			sessionId: this.current.session.id,
			generation: this.current.generation,
		};
	}

	isCurrentSession(identity: AuthSessionIdentity): boolean {
		return (
			this.generation === identity.generation &&
			this.current?.generation === identity.generation &&
			this.current?.session.id === identity.sessionId &&
			this.current.session.user.id === identity.accountId
		);
	}

	async clearSessionIfCurrent(identity: AuthSessionIdentity): Promise<boolean> {
		if (!this.isCurrentSession(identity)) return false;
		await this.expireLocalSession(identity.generation);
		return true;
	}

	async signOut(): Promise<void> {
		this.requireAcceptingWork();
		this.generation += 1;
		const accountId = this.current?.session.user.id ?? null;
		const accessToken = this.current?.accessToken ?? null;
		this.current = null;
		this.refreshPromise = null;

		await this.withTransitionLock(async () => {
			let barrierError: unknown;
			try {
				// The barrier runs before another account can be activated. It cancels
				// local runs/tools and clears the active goal for the old account.
				await this.onBeforeSessionClear(accountId);
			} catch (error) {
				barrierError = error;
			}
			try {
				await this.credentials.delete(REFRESH_TOKEN_KEY);
			} catch (error) {
				throw credentialFailure(error);
			}
			if (barrierError) throw barrierError;
			if (accessToken && this.baseUrl) {
				this.trackBestEffortRemote(
					this.request("/v1/auth/sessions/current", {
						method: "DELETE",
						headers: { authorization: `Bearer ${accessToken}` },
					}),
				);
			}
		});
	}

	async authorizedFetch(
		path: string,
		init: RequestInit,
		purpose: ModelRelayPurpose,
	): Promise<Response> {
		this.requireAcceptingWork();
		if (path !== "/v1/chat/completions") {
			throw new RemoteAuthError(
				"unexpected",
				"模型 Bearer 凭据只能发送到固定聊天入口。",
			);
		}
		if (
			purpose !== "agent" &&
			purpose !== "activity" &&
			purpose !== "planning"
		) {
			throw new RemoteAuthError(
				"unexpected",
				"模型请求用途不是 WhaleHall 允许的固定用途。",
			);
		}
		const headers = new Headers(init.headers);
		if (headers.has("x-whalehall-model-purpose")) {
			throw new RemoteAuthError(
				"unexpected",
				"模型请求用途只能由 WhaleHall 主进程设置。",
			);
		}
		headers.set("x-whalehall-model-purpose", purpose);
		return this.authorizedRequest(path, { ...init, headers });
	}

	/** Sends a bearer-only request to a code-owned DataCenter path. */
	async bearerFetch(path: string, init: RequestInit = {}): Promise<Response> {
		this.requireAcceptingWork();
		if (
			path !== "/v1/agent/register" &&
			!/^\/v1\/devices\/[a-f0-9-]{36}\/consents\/(activity|browser|presence)$/iu.test(
				path,
			)
		) {
			throw new RemoteAuthError(
				"unexpected",
				"Bearer 凭据只能发送到固定 DataCenter 注册与授权入口。",
			);
		}
		return this.authorizedRequest(path, init);
	}

	private async authorizedRequest(
		path: string,
		init: RequestInit,
	): Promise<Response> {
		const current = await this.getValidAuthorization();
		const headers = authorizationHeaders(init.headers, current);
		const first = await this.request(path, { ...init, headers });
		await this.assertResponseSession(first, current.identity);
		if (first.status !== 401) return first;

		await this.refreshSessionFor(current.identity);
		const refreshed = this.requireCurrentAuthorization();
		const nextHeaders = authorizationHeaders(init.headers, refreshed);
		const second = await this.request(path, { ...init, headers: nextHeaders });
		await this.assertResponseSession(second, refreshed.identity);
		if (second.status === 401) {
			await this.clearSessionIfCurrent(refreshed.identity);
		}
		return second;
	}

	async refreshSession(): Promise<RemoteAuthSession> {
		return this.refreshSessionFor(this.requireCurrentAuthorization().identity);
	}

	private async refreshSessionFor(
		identity: AuthSessionIdentity,
	): Promise<RemoteAuthSession> {
		if (!this.isCurrentSession(identity)) {
			throw new RemoteAuthError(
				"expired",
				"刷新会话已被新的登录操作取代。",
				401,
			);
		}
		if (this.refreshPromise) {
			if (sameSessionIdentity(this.refreshPromise.identity, identity)) {
				return this.refreshPromise.operation;
			}
			throw new RemoteAuthError(
				"expired",
				"刷新会话已被新的登录操作取代。",
				401,
			);
		}
		const operation = (async () => {
			let token: string | null;
			try {
				token = await this.credentials.read(REFRESH_TOKEN_KEY);
			} catch (error) {
				throw credentialFailure(error);
			}
			if (!this.isCurrentSession(identity)) {
				throw new RemoteAuthError(
					"expired",
					"刷新会话已被新的登录操作取代。",
					401,
				);
			}
			if (!token) {
				await this.clearSessionIfCurrent(identity);
				throw new RemoteAuthError("expired", "本地没有可用的刷新凭据。", 401);
			}
			return this.refreshWith(token, identity.generation, identity);
		})();
		this.refreshPromise = {
			identity: { ...identity },
			operation,
		};
		try {
			return await operation;
		} finally {
			if (this.refreshPromise?.operation === operation) {
				this.refreshPromise = null;
			}
		}
	}

	private async getValidAuthorization(): Promise<{
		accessToken: string;
		identity: AuthSessionIdentity;
	}> {
		const current = this.requireCurrentAuthorization();
		const active = this.current;
		if (active !== null && active.session.expiresAtMs - Date.now() > 30_000) {
			return current;
		}
		await this.refreshSessionFor(current.identity);
		return this.requireCurrentAuthorization();
	}

	private async refreshWith(
		refreshToken: string,
		generation: number,
		sourceIdentity?: AuthSessionIdentity,
	): Promise<RemoteAuthSession> {
		this.requireConfigured();
		if (
			generation !== this.generation ||
			(sourceIdentity !== undefined && !this.isCurrentSession(sourceIdentity))
		) {
			throw new RemoteAuthError(
				"expired",
				"刷新操作已被新的会话操作取代。",
				401,
			);
		}
		let response: Response;
		try {
			response = await this.request("/v1/auth/sessions/refresh", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ refreshToken }),
			});
		} catch (error) {
			throw transportFailure(error);
		}
		if (response.status === 401) {
			if (sourceIdentity) {
				await this.clearSessionIfCurrent(sourceIdentity);
			} else {
				await this.expireLocalSession(generation);
			}
			throw new RemoteAuthError("expired", "刷新凭据已失效。", 401);
		}
		if (!response.ok) throw responseFailure(response);
		const payload = parseSessionResponse(await readJson(response));
		if (
			sourceIdentity !== undefined &&
			payload.user.id !== sourceIdentity.accountId
		) {
			await this.clearSessionIfCurrent(sourceIdentity);
			throw new RemoteAuthError(
				"expired",
				"刷新响应与当前登录账号不一致。",
				401,
			);
		}
		if (!(await this.persistAndActivate(payload, generation, sourceIdentity))) {
			throw new RemoteAuthError(
				"expired",
				"刷新操作已被新的会话操作取代。",
				401,
			);
		}
		return cloneSession(payload);
	}

	private async clearLiveSessionForReplacement(
		accountId: string,
		captureRefreshToken: boolean,
	): Promise<string | null> {
		return this.withTransitionLock(async () => {
			const failures: unknown[] = [];
			try {
				await this.onBeforeSessionClear(accountId);
			} catch (error) {
				failures.push(error);
			}

			let refreshToken: string | null = null;
			if (captureRefreshToken) {
				try {
					refreshToken = await this.credentials.read(REFRESH_TOKEN_KEY);
				} catch (error) {
					failures.push(credentialFailure(error));
				}
			}
			try {
				await this.credentials.delete(REFRESH_TOKEN_KEY);
			} catch (error) {
				failures.push(credentialFailure(error));
			}

			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					"Session replacement cleanup did not complete.",
				);
			}
			return refreshToken;
		});
	}

	private async expireLocalSession(
		expectedGeneration = this.generation,
	): Promise<void> {
		if (expectedGeneration !== this.generation) return;
		this.generation += 1;
		const accountId = this.current?.session.user.id ?? null;
		const hadSession = this.current !== null;
		this.current = null;
		this.refreshPromise = null;
		await this.withTransitionLock(async () => {
			let barrierError: unknown;
			if (accountId) {
				try {
					await this.onBeforeSessionClear(accountId);
				} catch (error) {
					barrierError = error;
				}
			}
			await this.credentials.delete(REFRESH_TOKEN_KEY).catch(() => {});
			if (hadSession) this.onSessionExpired();
			if (barrierError) throw barrierError;
		});
	}

	private async persistAndActivate(
		payload: SessionResponse,
		generation: number,
		expectedCurrent?: AuthSessionIdentity,
	): Promise<boolean> {
		return this.withTransitionLock(async () => {
			if (generation !== this.generation) return false;
			if (
				expectedCurrent !== undefined &&
				(!this.isCurrentSession(expectedCurrent) ||
					payload.user.id !== expectedCurrent.accountId)
			) {
				return false;
			}
			const previousAccountId = this.current?.session.user.id ?? null;
			if (previousAccountId && previousAccountId !== payload.user.id) {
				this.current = null;
				await this.onBeforeSessionClear(previousAccountId);
				try {
					await this.credentials.delete(REFRESH_TOKEN_KEY);
				} catch (error) {
					throw credentialFailure(error);
				}
			}
			if (generation !== this.generation) return false;
			const nextIdentity: AuthSessionIdentity = {
				accountId: payload.user.id,
				sessionId: payload.id,
				generation,
			};
			const preparedNewOwner = previousAccountId !== payload.user.id;
			const rollbackPreparedOwner = async (): Promise<void> => {
				if (!preparedNewOwner) return;
				// onBeforeSessionClear is a process-wide ownership barrier. A stale
				// activation must never run it after any newer activation is live.
				if (this.current !== null) return;
				await this.onBeforeSessionClear(payload.user.id);
			};
			try {
				// This hook is inside the same transition lock as logout cleanup. It
				// must finish before current can expose the incoming account to any
				// model, activity, renderer, or background worker.
				await this.onBeforeSessionActivate(nextIdentity);
			} catch (error) {
				if (preparedNewOwner) {
					try {
						await rollbackPreparedOwner();
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							"Session activation and its local owner rollback both failed.",
						);
					}
				}
				throw error;
			}
			if (generation !== this.generation) {
				await rollbackPreparedOwner();
				return false;
			}
			try {
				await this.credentials.write(REFRESH_TOKEN_KEY, payload.refreshToken);
			} catch (error) {
				if (preparedNewOwner) {
					try {
						await rollbackPreparedOwner();
					} catch (rollbackError) {
						throw new AggregateError(
							[credentialFailure(error), rollbackError],
							"Credential persistence and local owner rollback both failed.",
						);
					}
				}
				throw credentialFailure(error);
			}
			if (generation !== this.generation) {
				// The transition lock normally keeps current null here. Preserve the
				// winning session's credential if that invariant ever changes.
				if (this.current === null) {
					await this.credentials.delete(REFRESH_TOKEN_KEY).catch(() => {});
				}
				await rollbackPreparedOwner();
				return false;
			}
			this.current = {
				session: cloneSession(payload),
				accessToken: payload.accessToken,
				generation,
			};
			try {
				await this.onSessionActivated({ ...nextIdentity });
			} catch (error) {
				await this.revokeFailedActivation(
					nextIdentity,
					error,
					expectedCurrent !== undefined,
				);
			}
			if (!this.isCurrentSession(nextIdentity)) return false;
			return true;
		});
	}

	private async revokeFailedActivation(
		identity: AuthSessionIdentity,
		activationError: unknown,
		notifySessionExpired: boolean,
	): Promise<never> {
		// A newer transition has already invalidated current and queued its own
		// account-clear barrier behind this lock. Do not delete the refresh token it
		// may need to restore or clear a winning session out of order.
		if (!this.isCurrentSession(identity)) throw activationError;

		this.generation += 1;
		this.current = null;
		this.refreshPromise = null;
		const failures: unknown[] = [activationError];
		try {
			await this.onBeforeSessionClear(identity.accountId);
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.credentials.delete(REFRESH_TOKEN_KEY);
		} catch (error) {
			failures.push(credentialFailure(error));
		}
		if (notifySessionExpired) {
			try {
				this.onSessionExpired();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw activationError;
		throw new AggregateError(
			failures,
			"Session activation and its fail-closed cleanup did not complete.",
		);
	}

	private requireCurrentAuthorization(): {
		accessToken: string;
		identity: AuthSessionIdentity;
	} {
		const current = this.current;
		if (current === null) {
			throw new RemoteAuthError("expired", "没有可刷新的登录会话。", 401);
		}
		const identity: AuthSessionIdentity = {
			accountId: current.session.user.id,
			sessionId: current.session.id,
			generation: current.generation,
		};
		if (!this.isCurrentSession(identity)) {
			throw new RemoteAuthError("expired", "登录会话已被新的操作取代。", 401);
		}
		return { accessToken: current.accessToken, identity };
	}

	private requireAcceptingWork(): void {
		if (!this.acceptingWork) {
			throw new RemoteAuthError(
				"unexpected",
				"WhaleHall 正在安全退出，新的认证请求已停止。",
			);
		}
	}

	private async assertResponseSession(
		response: Response,
		identity: AuthSessionIdentity,
	): Promise<void> {
		if (this.isCurrentSession(identity)) return;
		await response.body?.cancel().catch(() => undefined);
		throw new RemoteAuthError("expired", "登录会话已被新的操作取代。", 401);
	}

	private async withTransitionLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.transitionTail;
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		this.transitionTail = queued;
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.transitionTail === queued)
				this.transitionTail = Promise.resolve();
		}
	}

	private request(path: string, init: RequestInit): Promise<Response> {
		const baseUrl = this.requireConfigured();
		const url = new URL(path, baseUrl);
		if (url.origin !== baseUrl.origin) {
			throw new RemoteAuthError("unexpected", "拒绝跨来源认证请求。");
		}
		return this.fetchImpl(url, {
			...init,
			redirect: "error",
			signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
		});
	}

	private trackBestEffortRemote(operation: Promise<unknown>): void {
		let settlement!: Promise<void>;
		settlement = operation
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => this.remoteSettlements.delete(settlement));
		this.remoteSettlements.add(settlement);
	}

	private requireConfigured(): URL {
		if (!this.baseUrl) {
			throw new RemoteAuthError(
				"service-unavailable",
				"尚未配置 WhaleHall 模型转发服务地址。",
			);
		}
		return this.baseUrl;
	}
}

function authorizationHeaders(
	input: HeadersInit | undefined,
	authorization: {
		accessToken: string;
		identity: AuthSessionIdentity;
	},
): Headers {
	const headers = new Headers(input);
	// Compatibility-only callers may still provide the retired header. It is
	// discarded before every first attempt and refresh retry and is never logged.
	headers.delete("x-whalehall-agent-key");
	headers.set("authorization", `Bearer ${authorization.accessToken}`);
	headers.set(
		"x-session-generation",
		String(authorization.identity.generation),
	);
	return headers;
}

function validateRemoteBaseUrl(value: string): URL {
	const url = new URL(value);
	const loopback =
		url.hostname === "127.0.0.1" ||
		url.hostname === "localhost" ||
		url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error(
			"Agent relay base URL must use HTTPS, or HTTP on loopback only.",
		);
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "" && url.pathname !== "/")
	) {
		throw new Error(
			"Agent relay base URL must be an origin without URL components.",
		);
	}
	url.pathname = "/";
	return url;
}

function parseSessionResponse(value: unknown): SessionResponse {
	if (!isRecord(value) || !isRecord(value.user)) throw malformedResponse();
	const result: SessionResponse = {
		id: requiredString(value.id, 256),
		accessToken: requiredString(value.accessToken, 16_384),
		refreshToken: requiredString(value.refreshToken, 16_384),
		expiresAtMs: requiredFiniteNumber(value.expiresAtMs),
		user: {
			id: requiredString(value.user.id, 256),
			displayName: requiredString(value.user.displayName, 256),
			email: requiredString(value.user.email, 512),
			initials: requiredString(value.user.initials, 16),
		},
	};
	if (result.expiresAtMs <= Date.now()) throw malformedResponse();
	return result;
}

function requiredString(value: unknown, maxLength: number): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength
	)
		throw malformedResponse();
	return value;
}

function requiredFiniteNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw malformedResponse();
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedResponse(): RemoteAuthError {
	return new RemoteAuthError("unexpected", "认证服务返回了无效响应。");
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw malformedResponse();
	}
}

function responseFailure(response: Response): RemoteAuthError {
	if (response.status === 401)
		return new RemoteAuthError("expired", "登录会话已过期。", response.status);
	if (response.status >= 500)
		return new RemoteAuthError(
			"service-unavailable",
			"认证服务暂时不可用。",
			response.status,
		);
	return new RemoteAuthError(
		"unexpected",
		`认证请求失败（${response.status}）。`,
		response.status,
	);
}

function transportFailure(error: unknown): RemoteAuthError {
	if (error instanceof RemoteAuthError) return error;
	if (
		error instanceof DOMException &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	) {
		return new RemoteAuthError("offline", "网络连接超时。");
	}
	return new RemoteAuthError("offline", "无法连接登录服务。");
}

function credentialFailure(error: unknown): RemoteAuthError {
	return new RemoteAuthError(
		"secure-storage-unavailable",
		error instanceof Error ? error.message : "系统安全凭据库不可用。",
	);
}

function cloneSession(session: RemoteAuthSession): RemoteAuthSession {
	return {
		id: session.id || randomUUID(),
		expiresAtMs: session.expiresAtMs,
		user: { ...session.user },
	};
}

function sameSessionIdentity(
	left: AuthSessionIdentity,
	right: AuthSessionIdentity,
): boolean {
	return (
		left.accountId === right.accountId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation
	);
}
