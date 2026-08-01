import {
	chmodSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ReflectionServiceIdentity } from "./service";

const IDENTITY_SCHEMA_VERSION = "reflection-identity.v1" as const;

type StoredReflectionIdentity = ReflectionServiceIdentity & {
	schemaVersion: typeof IDENTITY_SCHEMA_VERSION;
};

/**
 * The logical session remains stable across process restarts so an open
 * five-minute window can be recovered instead of orphaned. Presence boundaries
 * still split windows; training derives day/session groups from those boundaries.
 */
export function loadOrCreateReflectionIdentity(path: string): ReflectionServiceIdentity {
	const existing = readIdentity(path);
	if (existing) return withoutSchema(existing);

	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const installationId = crypto.randomUUID();
	const created: StoredReflectionIdentity = {
		schemaVersion: IDENTITY_SCHEMA_VERSION,
		collectorId: `collector_${installationId}`,
		deviceId: `device_${installationId}`,
		sessionId: `session_${crypto.randomUUID()}`,
	};
	try {
		writeFileSync(path, `${JSON.stringify(created, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		const raced = readIdentity(path);
		if (raced) return withoutSchema(raced);
		throw error;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		// Some virtual/test filesystems do not expose POSIX permissions.
	}
	return withoutSchema(created);
}

function readIdentity(path: string): StoredReflectionIdentity | null {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== IDENTITY_SCHEMA_VERSION ||
		!("collectorId" in value) ||
		typeof value.collectorId !== "string" ||
		!("deviceId" in value) ||
		typeof value.deviceId !== "string" ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string"
	) {
		throw new Error(`Invalid WhaleHall reflection identity file: ${path}`);
	}
	return value as StoredReflectionIdentity;
}

function withoutSchema(identity: StoredReflectionIdentity): ReflectionServiceIdentity {
	return {
		collectorId: identity.collectorId,
		deviceId: identity.deviceId,
		sessionId: identity.sessionId,
	};
}
