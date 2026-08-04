import type { AuthCredentials, AuthSession } from "../shared/auth";

/** A session generation binds local encrypted work to one exact account login. */
export interface AuthSessionIdentity {
	accountId: string;
	sessionId: string;
	generation: number;
}

/**
 * The Bun composition depends only on this narrow desktop authentication
 * contract. Implementations keep access, refresh, and personal relay keys out
 * of both renderers and the Mastra sidecar.
 */
export interface DesktopAuthSessionManager {
	readonly accountId: string | null;
	getSession(): AuthSession | null;
	restoreSession(): Promise<AuthSession | null>;
	signIn(credentials: AuthCredentials): Promise<AuthSession>;
	signOut(): Promise<void>;
	authorizedFetch(path: string, init?: RequestInit): Promise<Response>;
	captureCurrentSession(): AuthSessionIdentity | null;
	isCurrentSession(identity: AuthSessionIdentity): boolean;
	clearSessionIfCurrent(identity: AuthSessionIdentity): Promise<boolean>;
}
