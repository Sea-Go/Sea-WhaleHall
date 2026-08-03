import {
	AuthServiceError,
	type AuthService,
	type SessionExpiredListener,
} from "../../features/auth/auth-service";
import {
	type AuthCredentials,
	type AuthFailureKind,
	type AuthSession,
	type AuthUser,
	normalizeAuthEmail,
} from "../../features/auth/domain";
import { LOCAL_TEST_AUTH_EXPERIENCE, LOCAL_TEST_AUTH_USER } from "../../../../shared/auth";

const MOCK_SESSION_STORAGE_KEY = "whalehall.mock-auth-session.v1";
const DEFAULT_LATENCY_MS = 420;
const DEFAULT_SESSION_DURATION_MS = 60 * 60 * 1_000;

const mockUser: AuthUser = {
	...LOCAL_TEST_AUTH_USER,
};

export const MOCK_AUTH_EXPERIENCE = LOCAL_TEST_AUTH_EXPERIENCE;

export const MOCK_AUTH_SCENARIOS = {
	offlineEmail: "offline@whalehall.local",
	serviceUnavailableEmail: "service@whalehall.local",
} as const;

export interface MockAuthServiceOptions {
	latencyMs?: number;
	sessionDurationMs?: number;
	now?: () => number;
	signInFailure?: AuthFailureKind;
}

export class MockAuthService implements AuthService {
	private readonly latencyMs: number;
	private readonly sessionDurationMs: number;
	private readonly now: () => number;
	private readonly signInFailure: AuthFailureKind | null;
	private readonly sessionExpiredListeners = new Set<SessionExpiredListener>();
	private expiryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: MockAuthServiceOptions = {}) {
		this.latencyMs = options.latencyMs ?? DEFAULT_LATENCY_MS;
		this.sessionDurationMs =
			options.sessionDurationMs ?? DEFAULT_SESSION_DURATION_MS;
		this.now = options.now ?? Date.now;
		this.signInFailure = options.signInFailure ?? null;
	}

	async restoreSession(): Promise<AuthSession | null> {
		await this.waitForMockNetwork();
		const session = readStoredSession();
		if (!session) return null;

		if (session.expiresAtMs <= this.now()) {
			removeStoredSession();
			throw new AuthServiceError("expired");
		}

		this.scheduleExpiry(session);
		return session;
	}

	async signIn(credentials: AuthCredentials): Promise<AuthSession> {
		await this.waitForMockNetwork();
		if (this.signInFailure) throw new AuthServiceError(this.signInFailure);
		const email = normalizeAuthEmail(credentials.email);
		if (email === MOCK_AUTH_SCENARIOS.offlineEmail) {
			throw new AuthServiceError("offline");
		}
		if (email === MOCK_AUTH_SCENARIOS.serviceUnavailableEmail) {
			throw new AuthServiceError("service-unavailable");
		}
		if (
			email !== MOCK_AUTH_EXPERIENCE.email ||
			credentials.password !== MOCK_AUTH_EXPERIENCE.password
		) {
			throw new AuthServiceError("invalid-credentials");
		}

		const session: AuthSession = {
			id: "mock-session-demo",
			user: mockUser,
			expiresAtMs: this.now() + this.sessionDurationMs,
		};
		writeStoredSession(session);
		this.scheduleExpiry(session);
		return session;
	}

	async signOut(): Promise<void> {
		await this.waitForMockNetwork();
		this.clearExpiryTimer();
		removeStoredSession();
	}

	onSessionExpired(listener: SessionExpiredListener): () => void {
		this.sessionExpiredListeners.add(listener);
		return () => this.sessionExpiredListeners.delete(listener);
	}

	private scheduleExpiry(session: AuthSession): void {
		this.clearExpiryTimer();
		const remainingMs = Math.max(0, session.expiresAtMs - this.now());
		this.expiryTimer = setTimeout(() => {
			this.expiryTimer = null;
			removeStoredSession();
			for (const listener of this.sessionExpiredListeners) {
				listener();
			}
		}, remainingMs);
	}

	private clearExpiryTimer(): void {
		if (!this.expiryTimer) return;
		clearTimeout(this.expiryTimer);
		this.expiryTimer = null;
	}

	private async waitForMockNetwork(): Promise<void> {
		if (this.latencyMs <= 0) return;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, this.latencyMs);
		});
	}
}

function readStoredSession(): AuthSession | null {
	const storage = getSessionStorage();
	if (!storage) return null;

	try {
		const value = storage.getItem(MOCK_SESSION_STORAGE_KEY);
		if (!value) return null;
		const parsed: unknown = JSON.parse(value);
		if (!isAuthSession(parsed)) {
			storage.removeItem(MOCK_SESSION_STORAGE_KEY);
			return null;
		}
		return parsed;
	} catch {
		removeStoredSession();
		return null;
	}
}

function writeStoredSession(session: AuthSession): void {
	const storage = getSessionStorage();
	if (!storage) return;
	try {
		storage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify(session));
	} catch {
		// Storage may be unavailable in hardened WebViews. The in-memory session
		// remains valid for the current renderer lifetime.
	}
}

function removeStoredSession(): void {
	const storage = getSessionStorage();
	if (!storage) return;
	try {
		storage.removeItem(MOCK_SESSION_STORAGE_KEY);
	} catch {
		// A failed cleanup must not reveal storage details to the renderer UI.
	}
}

function getSessionStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

function isAuthSession(value: unknown): value is AuthSession {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.expiresAtMs === "number" &&
		Number.isFinite(value.expiresAtMs) &&
		isAuthUser(value.user)
	);
}

function isAuthUser(value: unknown): value is AuthUser {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.displayName === "string" &&
		typeof value.email === "string" &&
		typeof value.initials === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
