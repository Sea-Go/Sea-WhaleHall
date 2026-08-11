/**
 * Renderer-safe projections shared between the Electrobun main process and
 * the client WebView. These types intentionally never carry bearer tokens,
 * refresh tokens, or agent private keys.
 */

export type DataCenterSyncState =
	| "disabled"
	| "needs_session"
	| "needs_agent"
	| "ready"
	| "sending"
	| "committing"
	| "retry_wait"
	| "blocked_content"
	| "blocked_reconcile";

export type DataCenterSyncErrorCode =
	| "offline"
	| "http_error"
	| "invalid_credentials"
	| "session_expired"
	| "agent_invalid"
	| "consent_revoked"
	| "contract_violation"
	| "content_blocked"
	| "time_window_violation"
	| "server_unavailable"
	| "internal";

export type DataCenterSyncStatus = {
	state: DataCenterSyncState;
	enabled: boolean;
	signedIn: boolean;
	agentRegistered: boolean;
	baseUrl: string;
	lastSyncAtMs: number | null;
	lastErrorCode: DataCenterSyncErrorCode | null;
	lastErrorMessage: string | null;
	pendingEventCount: number;
	blockedCursor: string | null;
	blockedReason: string | null;
	updatedAtMs: number;
};

export type DataCenterAuthUserProjection = {
	id: string;
	displayName: string;
	email: string;
	initials: string;
};

export type DataCenterAuthSessionProjection = {
	id: string;
	user: DataCenterAuthUserProjection;
	expiresAtMs: number;
};
