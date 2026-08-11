import type {
	DataCenterAuthSessionProjection,
	DataCenterSyncStatus,
} from "../../shared/datacenter";

export type {
	DataCenterAuthSessionProjection,
	DataCenterSyncStatus,
} from "../../shared/datacenter";

export type DataCenterNativeUser = {
	id: string;
	displayName: string;
	email: string;
	initials: string;
};

export type DataCenterNativeSession = {
	id: string;
	accessToken: string;
	refreshToken: string;
	expiresAtMs: number;
	user: DataCenterNativeUser;
};

export function projectNativeSession(
	session: DataCenterNativeSession,
): DataCenterAuthSessionProjection {
	return {
		id: session.id,
		user: { ...session.user },
		expiresAtMs: session.expiresAtMs,
	};
}

export type DataCenterAgentRegistration = {
	agentId: string;
	deviceId: string;
	configVersion: number;
};

export type DataCenterAgentIdentity = {
	installationId: string;
	publicKeyB64: string;
	privateKeyPkcs8B64: string;
	createdAtMs: number;
};

/** desktop-event.v1 wire event as required by the DataCenter desktop batch API. */
export type DataCenterDesktopEvent = {
	schemaVersion: "desktop-event.v1";
	eventId: string;
	cursor: string;
	deviceId: string;
	sessionId: string;
	kind: string;
	source: string;
	occurredAtMs: number;
	observedAtMs: number;
	goalVersion: number | null;
	sensitivity: "metadata" | "content";
	payload: Record<string, unknown>;
};

export type DataCenterDesktopBatch = {
	schemaVersion: "desktop-event-batch.v1";
	batchKey: string;
	firstCursor: string;
	lastCursor: string;
	events: DataCenterDesktopEvent[];
};

export type DataCenterDesktopBatchResult = {
	batchId: string;
	ackCursor: string;
	acceptedCount: number;
	duplicateCount: number;
	results: {
		eventId: string;
		cursor: string;
		status: "accepted" | "duplicate";
	}[];
};

export type DataCenterConsentSensor = "activity" | "browser" | "presence";

export type DataCenterConsentInput = {
	sensor: DataCenterConsentSensor;
	granted: boolean;
	dataLevel: number;
	policyVersion?: string;
};
