import type { AuthCredentials, AuthSession } from "../shared/auth";
import type { AuthSessionIdentity } from "../shared/session-identity";
import type { ModelRelayPurpose } from "./model-relay-transport";

export type { AuthSessionIdentity } from "../shared/session-identity";

/** A session generation binds local encrypted work to one exact account login. */
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
	authorizedFetch(
		path: string,
		init?: RequestInit,
		purpose?: ModelRelayPurpose,
	): Promise<Response>;
	captureCurrentSession(): AuthSessionIdentity | null;
	isCurrentSession(identity: AuthSessionIdentity): boolean;
	clearSessionIfCurrent(identity: AuthSessionIdentity): Promise<boolean>;
}
