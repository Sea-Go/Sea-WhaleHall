import { randomUUID } from "node:crypto";
import type { AuthCredentials } from "../shared/auth";
import type {
	AuthSessionIdentity,
	DesktopAuthSessionManager,
} from "./auth-session";

const REFRESH_TOKEN_KEY = "auth.refresh-token.current";
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
	/** Personal relay capability; never leaves the Bun main process except as a header. */
	agentKey?: string;
	fetch?: typeof fetch;
	requestTimeoutMs?: number;
	onBeforeSessionClear?: (accountId: string | null) => Promise<void>;
	onSessionExpired?: () => void;
}

/**
 * Owns all bearer credentials in the Bun main process. Renderers and the
 * Mastra sidecar only receive the public session projection.
 */
export class RemoteAuthSessionManager implements DesktopAuthSessionManager {
	private readonly baseUrl: URL | null;
	private readonly agentKey: string | null;
	private readonly fetchImpl: typeof fetch;
	private readonly requestTimeoutMs: number;
	private readonly onBeforeSessionClear: (
		accountId: string | null,
	) => Promise<void>;
	private readonly onSessionExpired: () => void;
	private current: { session: RemoteAuthSession; accessToken: string } | null =
		null;
	private refreshPromise: Promise<RemoteAuthSession> | null = null;
	private generation = 0;
	private transitionTail = Promise.resolve();

	constructor(
		private readonly credentials: SecureCredentialStore,
		options: RemoteAuthSessionManagerOptions = {},
	) {
		this.baseUrl = options.baseUrl
			? validateRemoteBaseUrl(options.baseUrl)
			: null;
		this.agentKey = options.agentKey
			? normalizeAgentKey(options.agentKey)
			: null;
		this.fetchImpl = options.fetch ?? fetch;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.onBeforeSessionClear =
			options.onBeforeSessionClear ?? (async () => {});
		this.onSessionExpired = options.onSessionExpired ?? (() => {});
	}

	getSession(): RemoteAuthSession | null {
		return this.current ? cloneSession(this.current.session) : null;
	}

	get accountId(): string | null {
		return this.current?.session.user.id ?? null;
	}

	get sessionGeneration(): number {
		return this.generation;
	}

	async restoreSession(): Promise<RemoteAuthSession | null> {
		this.requireConfigured();
		const generation = ++this.generation;
		let refreshToken: string | null;
		try {
			refreshToken = await this.credentials.read(REFRESH_TOKEN_KEY);
		} catch (error) {
			throw credentialFailure(error);
		}
		if (!refreshToken) return null;
		return this.refreshWith(refreshToken, generation);
	}

	async signIn(credentials: AuthCredentials): Promise<RemoteAuthSession> {
		this.requireConfigured();
		const generation = ++this.generation;
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
		if (!this.current) return null;
		return {
			accountId: this.current.session.user.id,
			sessionId: this.current.session.id,
			generation: this.generation,
		};
	}

	isCurrentSession(identity: AuthSessionIdentity): boolean {
		return (
			this.generation === identity.generation &&
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
		});

		if (!accessToken || !this.baseUrl) return;
		void this.request("/v1/auth/sessions/current", {
			method: "DELETE",
			headers: { authorization: `Bearer ${accessToken}` },
		}).catch(() => {
			// Remote revoke is explicitly best effort and cannot reopen AuthGate.
		});
	}

	async authorizedFetch(
		path: string,
		init: RequestInit = {},
	): Promise<Response> {
		if (path !== "/v1/chat/completions") {
			throw new RemoteAuthError(
				"unexpected",
				"个人 Agent relay key 只能发送到固定聊天入口。",
			);
		}
		return this.authorizedRequest(path, init, this.requireAgentKey());
	}

	/** Sends a bearer-only request to a code-owned DataCenter path. */
	async bearerFetch(path: string, init: RequestInit = {}): Promise<Response> {
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
		return this.authorizedRequest(path, init, null);
	}

	private async authorizedRequest(
		path: string,
		init: RequestInit,
		agentKey: string | null,
	): Promise<Response> {
		await this.getValidAccessToken();
		const current = this.current;
		if (!current) throw new RemoteAuthError("expired", "登录会话已过期。", 401);
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${current.accessToken}`);
		if (agentKey) headers.set("x-whalehall-agent-key", agentKey);
		headers.set("x-session-generation", String(this.generation));
		const first = await this.request(path, { ...init, headers });
		if (first.status !== 401) return first;

		await this.refreshSession();
		const refreshed = this.current;
		if (!refreshed)
			throw new RemoteAuthError("expired", "登录会话已过期。", 401);
		const nextHeaders = new Headers(init.headers);
		nextHeaders.set("authorization", `Bearer ${refreshed.accessToken}`);
		if (agentKey) nextHeaders.set("x-whalehall-agent-key", agentKey);
		nextHeaders.set("x-session-generation", String(this.generation));
		const second = await this.request(path, { ...init, headers: nextHeaders });
		if (second.status === 401) await this.expireLocalSession();
		return second;
	}

	async refreshSession(): Promise<RemoteAuthSession> {
		if (!this.current) {
			throw new RemoteAuthError("expired", "没有可刷新的登录会话。", 401);
		}
		if (this.refreshPromise) return this.refreshPromise;
		const operation = (async () => {
			const generation = this.generation;
			let token: string | null;
			try {
				token = await this.credentials.read(REFRESH_TOKEN_KEY);
			} catch (error) {
				throw credentialFailure(error);
			}
			if (!token) {
				await this.expireLocalSession();
				throw new RemoteAuthError("expired", "本地没有可用的刷新凭据。", 401);
			}
			return this.refreshWith(token, generation);
		})();
		this.refreshPromise = operation;
		try {
			return await operation;
		} finally {
			if (this.refreshPromise === operation) this.refreshPromise = null;
		}
	}

	private async getValidAccessToken(): Promise<string> {
		if (
			this.current &&
			this.current.session.expiresAtMs - Date.now() > 30_000
		) {
			return this.current.accessToken;
		}
		await this.refreshSession();
		if (!this.current) throw new RemoteAuthError("expired", "登录会话已过期。");
		return this.current.accessToken;
	}

	private async refreshWith(
		refreshToken: string,
		generation: number,
	): Promise<RemoteAuthSession> {
		this.requireConfigured();
		if (generation !== this.generation) {
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
			await this.expireLocalSession(generation);
			throw new RemoteAuthError("expired", "刷新凭据已失效。", 401);
		}
		if (!response.ok) throw responseFailure(response);
		const payload = parseSessionResponse(await readJson(response));
		if (!(await this.persistAndActivate(payload, generation))) {
			throw new RemoteAuthError(
				"expired",
				"刷新操作已被新的会话操作取代。",
				401,
			);
		}
		return cloneSession(payload);
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
	): Promise<boolean> {
		return this.withTransitionLock(async () => {
			if (generation !== this.generation) return false;
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
			try {
				await this.credentials.write(REFRESH_TOKEN_KEY, payload.refreshToken);
			} catch (error) {
				throw credentialFailure(error);
			}
			if (generation !== this.generation) {
				await this.credentials.delete(REFRESH_TOKEN_KEY).catch(() => {});
				return false;
			}
			this.current = {
				session: cloneSession(payload),
				accessToken: payload.accessToken,
			};
			return true;
		});
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

	private requireConfigured(): URL {
		if (!this.baseUrl) {
			throw new RemoteAuthError(
				"service-unavailable",
				"尚未配置 WhaleHall 模型转发服务地址。",
			);
		}
		return this.baseUrl;
	}

	private requireAgentKey(): string {
		if (!this.agentKey) {
			throw new RemoteAuthError(
				"service-unavailable",
				"尚未配置个人 Agent relay key。",
			);
		}
		return this.agentKey;
	}
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

function normalizeAgentKey(value: string): string {
	const key = value.trim();
	if (key.length < 1 || key.length > 1_024 || /[\p{Cc}\s]/u.test(key)) {
		throw new Error("Personal Agent relay key is invalid.");
	}
	return key;
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
