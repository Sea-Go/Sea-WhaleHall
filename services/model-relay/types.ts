export interface RelayUser {
	id: string;
	email: string;
	displayName: string;
	initials: string;
	passwordHash: string;
	/** scrypt hash of the owner's personal desktop relay key. */
	agentKeyHash: string;
	/** Public lookup ID plus scrypt hash for the non-interactive reflection key. */
	reflectionKeyId: string;
	reflectionKeyHash: string;
	disabled?: boolean;
}

export interface RelayPublicUser {
	id: string;
	email: string;
	displayName: string;
	initials: string;
}

export interface UserStore {
	findByEmail(normalizedEmail: string): Promise<RelayUser | null>;
	findById(id: string): Promise<RelayUser | null>;
	findByReflectionKeyId(reflectionKeyId: string): Promise<RelayUser | null>;
}

export interface StoredSession {
	id: string;
	familyId: string;
	subject: string;
	accessDigest: string;
	refreshDigest: string;
	accessExpiresAtMs: number;
	refreshExpiresAtMs: number;
	createdAtMs: number;
	revokedAtMs: number | null;
}

export interface SessionStore {
	create(session: StoredSession): Promise<void>;
	findActiveByAccessDigest(
		digest: string,
		nowMs: number,
	): Promise<StoredSession | null>;
	consumeRefresh(digest: string, nowMs: number): Promise<StoredSession | null>;
	revokeByAccessDigest(digest: string, nowMs: number): Promise<void>;
	cleanup(nowMs: number): Promise<void>;
}

export interface RelayRecordClaim {
	recordId: string;
	subject: string;
	idempotencyKey: string;
	requestHash: string;
	model: string;
	stream: boolean;
	requestBody: Uint8Array;
	createdAtMs: number;
	expiresAtMs: number;
}

export interface StoredRelayResponse {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

export type RelayClaimResult =
	| { kind: "claimed"; recordId: string }
	| { kind: "replay"; recordId: string; response: StoredRelayResponse }
	| { kind: "inflight" | "duplicate" | "conflict"; recordId: string };

export interface RelayRecordStore {
	claim(claim: RelayRecordClaim): Promise<RelayClaimResult>;
	appendResponse(recordId: string, chunk: Uint8Array): Promise<void>;
	complete(
		recordId: string,
		response: { status: number; headers: Record<string, string> },
	): Promise<void>;
	fail(
		recordId: string,
		reason: "upstream" | "client-abort" | "storage" | "response-too-large",
	): Promise<void>;
	cleanup(nowMs: number): Promise<void>;
}

export interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

export interface RateLimiter {
	consume(key: string, nowMs: number): Promise<RateLimitResult>;
}

export interface RelayClock {
	now(): number;
}

export const systemClock: RelayClock = {
	now: () => Date.now(),
};

export function publicUser(user: RelayUser): RelayPublicUser {
	return {
		id: user.id,
		email: user.email,
		displayName: user.displayName,
		initials: user.initials,
	};
}
