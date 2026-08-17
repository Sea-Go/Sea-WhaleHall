import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
	RelayClaimResult,
	RelayModelPurpose,
	RelayRecordClaim,
	RelayRecordStore,
	RelayUser,
	SessionStore,
	StoredSession,
	UserStore,
} from "./types.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export class JsonFileUserStore implements UserStore {
	private constructor(private readonly users: readonly RelayUser[]) {}

	static async open(path: string): Promise<JsonFileUserStore> {
		const absolute = resolve(path);
		const info = await stat(absolute);
		if (!info.isFile()) throw new Error("Relay users path is not a file.");
		const parsed: unknown = JSON.parse(await readFile(absolute, "utf8"));
		const items = Array.isArray(parsed)
			? parsed
			: isRecord(parsed) && Array.isArray(parsed.users)
				? parsed.users
				: null;
		if (!items || items.length < 1 || items.length > 100_000) {
			throw new Error("Relay users file must contain a non-empty users array.");
		}
		const users = items.map(validateUser);
		const ids = new Set<string>();
		const emails = new Set<string>();
		for (const user of users) {
			const email = user.email.toLowerCase();
			if (ids.has(user.id) || emails.has(email))
				throw new Error("Relay users file contains duplicates.");
			ids.add(user.id);
			emails.add(email);
		}
		return new JsonFileUserStore(users);
	}

	async findByEmail(normalizedEmail: string): Promise<RelayUser | null> {
		const user = this.users.find(
			(item) => item.email.toLowerCase() === normalizedEmail,
		);
		return user ? { ...user } : null;
	}

	async findById(id: string): Promise<RelayUser | null> {
		const user = this.users.find((item) => item.id === id);
		return user ? { ...user } : null;
	}
}

export class FileSessionStore implements SessionStore {
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly path: string) {
		if (!basename(path)) throw new Error("Session store path is invalid.");
	}

	async create(session: StoredSession): Promise<void> {
		await this.exclusive(async () => {
			const sessions = await this.read();
			if (
				sessions.some(
					(item) =>
						item.id === session.id ||
						item.accessDigest === session.accessDigest ||
						item.refreshDigest === session.refreshDigest,
				)
			) {
				throw new Error("Duplicate session record.");
			}
			sessions.push({ ...session });
			await this.write(sessions);
		});
	}

	async findActiveByAccessDigest(
		digest: string,
		nowMs: number,
	): Promise<StoredSession | null> {
		return this.exclusive(async () => {
			const sessions = await this.read();
			const match = sessions.find(
				(session) =>
					session.accessDigest === digest &&
					session.revokedAtMs === null &&
					session.accessExpiresAtMs > nowMs,
			);
			return match ? { ...match } : null;
		});
	}

	async consumeRefresh(
		digest: string,
		nowMs: number,
	): Promise<StoredSession | null> {
		return this.exclusive(async () => {
			const sessions = await this.read();
			const match = sessions.find(
				(session) =>
					session.refreshDigest === digest &&
					session.revokedAtMs === null &&
					session.refreshExpiresAtMs > nowMs,
			);
			if (!match) return null;
			match.revokedAtMs = nowMs;
			await this.write(sessions);
			return { ...match };
		});
	}

	async revokeByAccessDigest(digest: string, nowMs: number): Promise<void> {
		await this.exclusive(async () => {
			const sessions = await this.read();
			let changed = false;
			for (const session of sessions) {
				if (session.accessDigest === digest && session.revokedAtMs === null) {
					session.revokedAtMs = nowMs;
					changed = true;
				}
			}
			if (changed) await this.write(sessions);
		});
	}

	async cleanup(nowMs: number): Promise<void> {
		await this.exclusive(async () => {
			const sessions = await this.read();
			const retained = sessions.filter(
				(session) => session.refreshExpiresAtMs > nowMs,
			);
			if (retained.length !== sessions.length) await this.write(retained);
		});
	}

	private async read(): Promise<StoredSession[]> {
		try {
			const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!Array.isArray(value)) throw new Error("Session store is malformed.");
			return value.map(validateSession);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return [];
			throw error;
		}
	}

	private async write(sessions: readonly StoredSession[]): Promise<void> {
		await atomicPrivateWrite(this.path, JSON.stringify(sessions));
	}

	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

interface FileRelayMetadata {
	recordId: string;
	subject: string;
	purpose: RelayModelPurpose;
	idempotencyKey: string;
	requestHash: string;
	model: string;
	stream: boolean;
	state: "inflight" | "completed" | "failed";
	createdAtMs: number;
	expiresAtMs: number;
	responseStatus: number | null;
	responseHeaders: Record<string, string>;
	failureReason: string | null;
}

interface ActiveRecordPaths {
	metadataPath: string;
	responsePath: string;
}

export class FileRelayRecordStore implements RelayRecordStore {
	private tail: Promise<void> = Promise.resolve();
	private readonly active = new Map<string, ActiveRecordPaths>();
	private lastCleanupMs = 0;

	constructor(private readonly directory: string) {
		if (!basename(resolve(directory)))
			throw new Error("Relay record directory is invalid.");
	}

	async claim(claim: RelayRecordClaim): Promise<RelayClaimResult> {
		return this.exclusive(async () => {
			const recordId = safeRecordId(claim.recordId);
			await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
			const keyName = scopedFileName(claim.subject, claim.idempotencyKey);
			const metadataPath = join(this.directory, `${keyName}.json`);
			const existing = await readMetadata(metadataPath);
			if (existing && existing.expiresAtMs > claim.createdAtMs) {
				if (
					existing.requestHash !== claim.requestHash ||
					existing.purpose !== claim.purpose
				) {
					return { kind: "conflict", recordId: existing.recordId };
				}
				if (existing.state === "inflight")
					return { kind: "inflight", recordId: existing.recordId };
				if (existing.state === "completed" && !existing.stream) {
					return {
						kind: "replay",
						recordId: existing.recordId,
						response: {
							status: existing.responseStatus ?? 500,
							headers: { ...existing.responseHeaders },
							body: new Uint8Array(
								await readFile(
									join(this.directory, `${existing.recordId}.response.bin`),
								),
							),
						},
					};
				}
				return { kind: "duplicate", recordId: existing.recordId };
			}
			if (existing)
				await deleteRecordArtifacts(this.directory, existing, metadataPath);

			const requestPath = join(this.directory, `${recordId}.request.bin`);
			const responsePath = join(this.directory, `${recordId}.response.bin`);
			try {
				await writeFile(requestPath, claim.requestBody, {
					mode: FILE_MODE,
					flag: "wx",
				});
				await writeFile(responsePath, new Uint8Array(), {
					mode: FILE_MODE,
					flag: "wx",
				});
			} catch (error) {
				await unlink(requestPath).catch(ignoreMissing);
				await unlink(responsePath).catch(ignoreMissing);
				throw error;
			}
			const metadata: FileRelayMetadata = {
				recordId,
				subject: claim.subject,
				purpose: claim.purpose,
				idempotencyKey: claim.idempotencyKey,
				requestHash: claim.requestHash,
				model: claim.model,
				stream: claim.stream,
				state: "inflight",
				createdAtMs: claim.createdAtMs,
				expiresAtMs: claim.expiresAtMs,
				responseStatus: null,
				responseHeaders: {},
				failureReason: null,
			};
			try {
				await atomicPrivateWrite(metadataPath, JSON.stringify(metadata));
			} catch (error) {
				await unlink(requestPath).catch(ignoreMissing);
				await unlink(responsePath).catch(ignoreMissing);
				throw error;
			}
			this.active.set(recordId, { metadataPath, responsePath });
			return { kind: "claimed", recordId };
		});
	}

	async appendResponse(recordId: string, chunk: Uint8Array): Promise<void> {
		await this.exclusive(async () => {
			const paths = this.requireActive(recordId);
			await appendFile(paths.responsePath, chunk);
		});
	}

	async complete(
		recordId: string,
		response: { status: number; headers: Record<string, string> },
	): Promise<void> {
		await this.exclusive(async () => {
			const paths = this.requireActive(recordId);
			const metadata = await requireMetadata(paths.metadataPath);
			metadata.state = "completed";
			metadata.responseStatus = response.status;
			metadata.responseHeaders = { ...response.headers };
			await atomicPrivateWrite(paths.metadataPath, JSON.stringify(metadata));
			this.active.delete(recordId);
		});
	}

	async fail(recordId: string, reason: string): Promise<void> {
		await this.exclusive(async () => {
			const paths = this.active.get(recordId);
			if (!paths) return;
			const metadata = await requireMetadata(paths.metadataPath);
			metadata.state = "failed";
			metadata.failureReason = reason.slice(0, 64);
			await atomicPrivateWrite(paths.metadataPath, JSON.stringify(metadata));
			this.active.delete(recordId);
		});
	}

	async cleanup(nowMs: number): Promise<void> {
		if (nowMs - this.lastCleanupMs < 60_000) return;
		this.lastCleanupMs = nowMs;
		await this.exclusive(async () => {
			await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
			const names = await readdir(this.directory);
			for (const name of names) {
				if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
				const metadataPath = join(this.directory, name);
				const metadata = await readMetadata(metadataPath);
				if (metadata && metadata.expiresAtMs <= nowMs) {
					this.active.delete(metadata.recordId);
					await deleteRecordArtifacts(this.directory, metadata, metadataPath);
				}
			}
		});
	}

	private requireActive(recordId: string): ActiveRecordPaths {
		const paths = this.active.get(recordId);
		if (!paths) throw new Error("Relay record is not active in this process.");
		return paths;
	}

	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

async function atomicPrivateWrite(
	path: string,
	contents: string,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, contents, {
			encoding: "utf8",
			mode: FILE_MODE,
			flag: "wx",
		});
		await rename(temporary, path);
		await chmod(path, FILE_MODE).catch(() => {});
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

async function readMetadata(path: string): Promise<FileRelayMetadata | null> {
	try {
		return validateMetadata(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function requireMetadata(path: string): Promise<FileRelayMetadata> {
	const value = await readMetadata(path);
	if (!value) throw new Error("Relay metadata is missing.");
	return value;
}

async function deleteRecordArtifacts(
	directory: string,
	metadata: FileRelayMetadata,
	metadataPath: string,
): Promise<void> {
	await unlink(join(directory, `${metadata.recordId}.request.bin`)).catch(
		ignoreMissing,
	);
	await unlink(join(directory, `${metadata.recordId}.response.bin`)).catch(
		ignoreMissing,
	);
	await unlink(metadataPath).catch(ignoreMissing);
}

function validateUser(value: unknown): RelayUser {
	if (!isRecord(value)) throw new Error("Relay user record is malformed.");
	// Existing deployments may retain this retired hash until their next
	// operator-managed rewrite. It is never read, so discard it without
	// letting a malformed legacy value reject the whole user store.
	return {
		id: boundedString(value.id, 256),
		email: boundedString(value.email, 320).trim().toLowerCase(),
		displayName: boundedString(value.displayName, 256),
		initials: boundedString(value.initials, 16),
		passwordHash: boundedString(value.passwordHash, 4_096),
		disabled: value.disabled === true,
	};
}

function validateSession(value: unknown): StoredSession {
	if (!isRecord(value)) throw new Error("Session record is malformed.");
	return {
		id: boundedString(value.id, 256),
		familyId: boundedString(value.familyId, 256),
		subject: boundedString(value.subject, 256),
		accessDigest: hexDigest(value.accessDigest),
		refreshDigest: hexDigest(value.refreshDigest),
		accessExpiresAtMs: finiteNumber(value.accessExpiresAtMs),
		refreshExpiresAtMs: finiteNumber(value.refreshExpiresAtMs),
		createdAtMs: finiteNumber(value.createdAtMs),
		revokedAtMs:
			value.revokedAtMs === null ? null : finiteNumber(value.revokedAtMs),
	};
}

function validateMetadata(value: unknown): FileRelayMetadata {
	if (!isRecord(value)) throw new Error("Relay metadata is malformed.");
	if (
		value.state !== "inflight" &&
		value.state !== "completed" &&
		value.state !== "failed"
	) {
		throw new Error("Relay metadata state is invalid.");
	}
	if (!isRecord(value.responseHeaders))
		throw new Error("Relay response headers are invalid.");
	const responseHeaders: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(value.responseHeaders)) {
		responseHeaders[boundedString(name, 256)] = boundedString(
			headerValue,
			8_192,
		);
	}
	return {
		recordId: safeRecordId(value.recordId),
		subject: boundedString(value.subject, 256),
		purpose:
			// Before purpose became mandatory this store served only the ordinary
			// chat route. Classify those records as agent without weakening replay.
			value.purpose === undefined ? "agent" : relayModelPurpose(value.purpose),
		idempotencyKey: boundedString(value.idempotencyKey, 200),
		requestHash: hexDigest(value.requestHash),
		model: boundedString(value.model, 256),
		stream: value.stream === true,
		state: value.state,
		createdAtMs: finiteNumber(value.createdAtMs),
		expiresAtMs: finiteNumber(value.expiresAtMs),
		responseStatus:
			value.responseStatus === null ? null : finiteNumber(value.responseStatus),
		responseHeaders,
		failureReason:
			value.failureReason === null
				? null
				: boundedString(value.failureReason, 64),
	};
}

function relayModelPurpose(value: unknown): RelayModelPurpose {
	if (value !== "agent" && value !== "activity" && value !== "planning") {
		throw new Error("Relay model purpose is invalid.");
	}
	return value;
}

function scopedFileName(subject: string, idempotencyKey: string): string {
	return createHash("sha256")
		.update(subject)
		.update("\0")
		.update(idempotencyKey)
		.digest("hex");
}

function safeRecordId(value: unknown): string {
	const id = boundedString(value, 64);
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
			id,
		)
	) {
		throw new Error("Relay record id is invalid.");
	}
	return id;
}

function hexDigest(value: unknown): string {
	const text = boundedString(value, 64);
	if (!/^[a-f0-9]{64}$/.test(text)) throw new Error("Digest is invalid.");
	return text;
}

function boundedString(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
		throw new Error("Stored string is invalid.");
	}
	return value;
}

function finiteNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error("Stored number is invalid.");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function ignoreMissing(error: unknown): void {
	if (!isNodeError(error, "ENOENT")) throw error;
}
