import type {
	RateLimiter,
	RelayClaimResult,
	RelayRecordClaim,
	RelayRecordStore,
	RelayUser,
	SessionStore,
	StoredRelayResponse,
	StoredSession,
	UserStore,
} from "./types.js";

export class InMemoryUserStore implements UserStore {
	private readonly byId = new Map<string, RelayUser>();
	private readonly byEmail = new Map<string, RelayUser>();
	private readonly byReflectionKeyId = new Map<string, RelayUser>();

	constructor(users: readonly RelayUser[]) {
		for (const user of users) {
			const value = cloneUser(user);
			this.byId.set(value.id, value);
			this.byEmail.set(value.email.trim().toLowerCase(), value);
			this.byReflectionKeyId.set(value.reflectionKeyId, value);
		}
	}

	async findByEmail(normalizedEmail: string): Promise<RelayUser | null> {
		const user = this.byEmail.get(normalizedEmail);
		return user ? cloneUser(user) : null;
	}

	async findById(id: string): Promise<RelayUser | null> {
		const user = this.byId.get(id);
		return user ? cloneUser(user) : null;
	}

	async findByReflectionKeyId(reflectionKeyId: string): Promise<RelayUser | null> {
		const user = this.byReflectionKeyId.get(reflectionKeyId);
		return user ? cloneUser(user) : null;
	}
}

export class InMemorySessionStore implements SessionStore {
	private readonly sessions = new Map<string, StoredSession>();

	async create(session: StoredSession): Promise<void> {
		if (this.sessions.has(session.id)) throw new Error("Duplicate session id.");
		this.sessions.set(session.id, cloneSession(session));
	}

	async findActiveByAccessDigest(digest: string, nowMs: number): Promise<StoredSession | null> {
		for (const session of this.sessions.values()) {
			if (
				session.accessDigest === digest
				&& session.revokedAtMs === null
				&& session.accessExpiresAtMs > nowMs
			) {
				return cloneSession(session);
			}
		}
		return null;
	}

	async consumeRefresh(digest: string, nowMs: number): Promise<StoredSession | null> {
		for (const session of this.sessions.values()) {
			if (
				session.refreshDigest === digest
				&& session.revokedAtMs === null
				&& session.refreshExpiresAtMs > nowMs
			) {
				session.revokedAtMs = nowMs;
				return cloneSession(session);
			}
		}
		return null;
	}

	async revokeByAccessDigest(digest: string, nowMs: number): Promise<void> {
		for (const session of this.sessions.values()) {
			if (session.accessDigest === digest && session.revokedAtMs === null) {
				session.revokedAtMs = nowMs;
			}
		}
	}

	async cleanup(nowMs: number): Promise<void> {
		for (const [id, session] of this.sessions) {
			if (session.refreshExpiresAtMs <= nowMs) this.sessions.delete(id);
		}
	}

	snapshot(): readonly StoredSession[] {
		return [...this.sessions.values()].map(cloneSession);
	}
}

interface MemoryRelayRecord extends RelayRecordClaim {
	state: "inflight" | "completed" | "failed";
	responseStatus: number | null;
	responseHeaders: Record<string, string>;
	responseChunks: Uint8Array[];
}

export class InMemoryRelayRecordStore implements RelayRecordStore {
	private readonly byId = new Map<string, MemoryRelayRecord>();
	private readonly byKey = new Map<string, string>();

	async claim(claim: RelayRecordClaim): Promise<RelayClaimResult> {
		const scope = scopedKey(claim.subject, claim.idempotencyKey);
		const existingId = this.byKey.get(scope);
		const existing = existingId ? this.byId.get(existingId) : undefined;
		if (existing && existing.expiresAtMs > claim.createdAtMs) {
			if (existing.requestHash !== claim.requestHash) {
				return { kind: "conflict", recordId: existing.recordId };
			}
			if (existing.state === "inflight") {
				return { kind: "inflight", recordId: existing.recordId };
			}
			if (existing.state === "completed" && !existing.stream) {
				return {
					kind: "replay",
					recordId: existing.recordId,
					response: memoryResponse(existing),
				};
			}
			return { kind: "duplicate", recordId: existing.recordId };
		}

		if (existing) this.byId.delete(existing.recordId);
		const record: MemoryRelayRecord = {
			...claim,
			requestBody: claim.requestBody.slice(),
			state: "inflight",
			responseStatus: null,
			responseHeaders: {},
			responseChunks: [],
		};
		this.byKey.set(scope, record.recordId);
		this.byId.set(record.recordId, record);
		return { kind: "claimed", recordId: record.recordId };
	}

	async appendResponse(recordId: string, chunk: Uint8Array): Promise<void> {
		const record = this.requireInflight(recordId);
		record.responseChunks.push(chunk.slice());
	}

	async complete(
		recordId: string,
		response: { status: number; headers: Record<string, string> },
	): Promise<void> {
		const record = this.requireInflight(recordId);
		record.state = "completed";
		record.responseStatus = response.status;
		record.responseHeaders = { ...response.headers };
	}

	async fail(recordId: string): Promise<void> {
		const record = this.byId.get(recordId);
		if (record?.state === "inflight") record.state = "failed";
	}

	async cleanup(nowMs: number): Promise<void> {
		for (const [id, record] of this.byId) {
			if (record.expiresAtMs <= nowMs) {
				this.byId.delete(id);
				this.byKey.delete(scopedKey(record.subject, record.idempotencyKey));
			}
		}
	}

	snapshot(): ReadonlyArray<{
		recordId: string;
		subject: string;
		requestBody: Uint8Array;
		responseBody: Uint8Array;
		state: string;
	}> {
		return [...this.byId.values()].map((record) => ({
			recordId: record.recordId,
			subject: record.subject,
			requestBody: record.requestBody.slice(),
			responseBody: concatenate(record.responseChunks),
			state: record.state,
		}));
	}

	private requireInflight(id: string): MemoryRelayRecord {
		const record = this.byId.get(id);
		if (!record || record.state !== "inflight") {
			throw new Error("Relay record is not active.");
		}
		return record;
	}
}

export class FixedWindowRateLimiter implements RateLimiter {
	private readonly windows = new Map<string, { startMs: number; count: number }>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
	) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Rate limit must be positive.");
		if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) throw new Error("Rate window is invalid.");
	}

	async consume(key: string, nowMs: number) {
		let window = this.windows.get(key);
		if (!window || nowMs - window.startMs >= this.windowMs) {
			window = { startMs: nowMs, count: 0 };
			this.windows.set(key, window);
		}
		if (window.count >= this.limit) {
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((window.startMs + this.windowMs - nowMs) / 1_000)),
			};
		}
		window.count += 1;
		return { allowed: true, retryAfterSeconds: 0 };
	}
}

function memoryResponse(record: MemoryRelayRecord): StoredRelayResponse {
	if (record.responseStatus === null) throw new Error("Completed relay record has no response status.");
	return {
		status: record.responseStatus,
		headers: { ...record.responseHeaders },
		body: concatenate(record.responseChunks),
	};
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function scopedKey(subject: string, key: string): string {
	return `${subject}\0${key}`;
}

function cloneSession(session: StoredSession): StoredSession {
	return { ...session };
}

function cloneUser(user: RelayUser): RelayUser {
	return { ...user };
}
