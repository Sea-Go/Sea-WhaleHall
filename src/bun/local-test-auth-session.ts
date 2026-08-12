import { randomUUID } from "node:crypto";
import {
	type AuthCredentials,
	type AuthRpcFailureKind,
	type AuthSession,
	LOCAL_TEST_AUTH_EXPERIENCE,
	LOCAL_TEST_AUTH_USER,
} from "../shared/auth";
import type {
	AuthSessionIdentity,
	DesktopAuthSessionManager,
} from "./auth-session";
import type { ModelRelayPurpose } from "./model-relay-transport";

export const LOCAL_TEST_ACCOUNT_ID = LOCAL_TEST_AUTH_USER.id;

export interface LocalTestAuthSessionManagerOptions {
	onSessionInvalidated?: (accountId: string | null) => void;
	onBeforeSessionClear?: (accountId: string | null) => Promise<void>;
}

export type LocalTestSessionIdentity = AuthSessionIdentity;

export class LocalTestAuthError extends Error {
	constructor(
		readonly kind: AuthRpcFailureKind,
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "LocalTestAuthError";
	}
}

/**
 * Unit-test-only desktop-owned identity.
 *
 * The Renderer may submit only the documented experience email/password. Bun
 * validates those fixed values locally and always binds the same account; no
 * caller-supplied identity is trusted. Production composition uses
 * RemoteAuthSessionManager instead. This fixture deliberately has no remote
 * bearer, so relay calls fail closed.
 */
export class LocalTestAuthSessionManager implements DesktopAuthSessionManager {
	private readonly onSessionInvalidated: (accountId: string | null) => void;
	private readonly onBeforeSessionClear: (
		accountId: string | null,
	) => Promise<void>;
	private current: AuthSession | null = null;
	private generation = 0;
	private transitionTail = Promise.resolve();

	constructor(options: LocalTestAuthSessionManagerOptions = {}) {
		this.onSessionInvalidated = options.onSessionInvalidated ?? (() => {});
		this.onBeforeSessionClear =
			options.onBeforeSessionClear ?? (async () => {});
	}

	get accountId(): string | null {
		return this.current?.user.id ?? null;
	}

	get sessionGeneration(): number {
		return this.generation;
	}

	getSession(): AuthSession | null {
		return this.current ? structuredClone(this.current) : null;
	}

	async restoreSession(): Promise<AuthSession | null> {
		return this.getSession();
	}

	async signInTestAccount(credentials: AuthCredentials): Promise<AuthSession> {
		if (
			credentials.email.trim().toLowerCase() !==
				LOCAL_TEST_AUTH_EXPERIENCE.email ||
			credentials.password !== LOCAL_TEST_AUTH_EXPERIENCE.password
		) {
			throw new LocalTestAuthError(
				"invalid-credentials",
				"邮箱或密码不正确。",
				401,
			);
		}

		const existing = this.current;
		const expectedGeneration = existing ? this.generation : ++this.generation;
		const expectedSessionId = existing?.id ?? null;
		return this.withTransitionLock(async () => {
			if (expectedGeneration !== this.generation) {
				throw new LocalTestAuthError(
					"expired",
					"测试会话已被新的会话操作取代。",
				);
			}
			if (this.current) {
				if (this.current.id !== expectedSessionId) {
					throw new LocalTestAuthError(
						"expired",
						"测试会话已被新的会话操作取代。",
					);
				}
				return structuredClone(this.current);
			}
			if (expectedSessionId !== null) {
				throw new LocalTestAuthError(
					"expired",
					"测试会话已被新的会话操作取代。",
				);
			}
			this.current = {
				id: `local-test-session-${randomUUID()}`,
				user: { ...LOCAL_TEST_AUTH_USER },
				expiresAtMs: Number.MAX_SAFE_INTEGER,
			};
			return structuredClone(this.current);
		});
	}

	async signIn(credentials: AuthCredentials): Promise<AuthSession> {
		return this.signInTestAccount(credentials);
	}

	captureCurrentSession(): LocalTestSessionIdentity | null {
		if (!this.current) return null;
		return {
			accountId: this.current.user.id,
			sessionId: this.current.id,
			generation: this.generation,
		};
	}

	isCurrentSession(identity: LocalTestSessionIdentity): boolean {
		return (
			this.generation === identity.generation &&
			this.current?.id === identity.sessionId &&
			this.current.user.id === identity.accountId
		);
	}

	async clearSessionIfCurrent(
		identity: LocalTestSessionIdentity,
	): Promise<boolean> {
		if (!this.isCurrentSession(identity)) return false;
		const accountId = this.current?.user.id ?? null;
		this.generation += 1;
		this.current = null;
		this.notifySessionInvalidated(accountId);
		await this.withTransitionLock(() => this.onBeforeSessionClear(accountId));
		return true;
	}

	async signOut(): Promise<void> {
		this.generation += 1;
		const accountId = this.current?.user.id ?? null;
		this.current = null;
		this.notifySessionInvalidated(accountId);
		await this.withTransitionLock(() => this.onBeforeSessionClear(accountId));
	}

	async authorizedFetch(
		_path: string,
		_init: RequestInit,
		_purpose: ModelRelayPurpose,
	): Promise<Response> {
		throw new LocalTestAuthError(
			"service-unavailable",
			"测试身份不提供远端模型凭据。",
		);
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

	private notifySessionInvalidated(accountId: string | null): void {
		try {
			this.onSessionInvalidated(accountId);
		} catch {
			// Session invalidation is already committed. Slow cleanup still runs via
			// onBeforeSessionClear and must not be skipped by a UI notification error.
		}
	}
}
