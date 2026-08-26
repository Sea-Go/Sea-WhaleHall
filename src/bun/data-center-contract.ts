import {
	createHash,
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	sign,
} from "node:crypto";
import { canonicalJson } from "../agent/reflection/hash";
import type {
	DesktopEventKind,
	DesktopEventV1,
} from "../agent/reflection/types";
import type {
	CloudSyncConfiguration,
	CloudSyncConsentLevel,
} from "./client-config";
import type { DataCenterClientEncryptionEnvelope } from "./data-center-crypto";
import type {
	DataCenterAgentCredentialsRecord,
	DataCenterConsumerAuditRecord,
	DataCenterPendingAdvanceRecord,
	DataCenterPendingBatchRecord,
} from "./encrypted-agent-repository";

/** Production-only local cursor; retired staging builds own a different slot. */
export const DATA_CENTER_CONSUMER_ID = "whalehall.datacenter.production.v1";
export const DATA_CENTER_REGISTER_PATH = "/v1/agent/register";
export const DATA_CENTER_BATCH_PATH = "/api/v1/agent/events/desktop/batch";
export const DATA_CENTER_CURSOR_PATH = "/api/v1/agent/events/desktop/cursor";
export const DATA_CENTER_ADVANCE_PATH = "/api/v1/agent/events/desktop/advance";
export const DATA_CENTER_SIGNATURE_VERSION = "2";
export const DATA_CENTER_MAX_BATCH_EVENTS = 500;
export const DATA_CENTER_MAX_BATCH_BODY_BYTES = 15 * 1024 * 1024;
export const DATA_CENTER_MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
export const DATA_CENTER_MAX_ENCRYPTION_ENVELOPE_BYTES = 384 * 1024;
export const DATA_CENTER_EVENT_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1_000;
export const DATA_CENTER_EMPTY_BATCH_BODY_BYTES = Buffer.byteLength(
	JSON.stringify({
		schemaVersion: "desktop-event-batch.v1",
		batchKey: `dcb1_${"0".repeat(64)}`,
		firstCursor: "ec1_0000000000000000",
		lastCursor: "ec1_0000000000000000",
		events: [],
	}),
	"utf8",
);

export type DataCenterConsentDomain = "activity" | "browser" | "presence";
export type DataCenterEventDomain = DataCenterConsentDomain | "system";
export type DataCenterAdvanceReason =
	| "content-not-consented"
	| "consent-revoked"
	| "account-boundary"
	| "retention-expired"
	| "payload-unsupported";

export type DataCenterMetadataEvent = {
	schemaVersion: "desktop-event.v1";
	eventId: string;
	cursor: string;
	deviceId: string;
	sessionId: string;
	kind: DesktopEventKind;
	source: string;
	occurredAtMs: number;
	observedAtMs: number;
	goalVersion: number | null;
	sensitivity: "metadata";
	payload: Record<string, unknown>;
};

export type DataCenterContentEvent = Omit<
	DataCenterMetadataEvent,
	"sensitivity" | "payload"
> & {
	sensitivity: "content";
	publicPayload: Record<string, unknown>;
	encryptionEnvelope: Record<string, unknown>;
};

export type DataCenterWireEvent =
	| DataCenterMetadataEvent
	| DataCenterContentEvent;

/** Narrow content-crypto seam; exact envelopes are persisted only by sync. */
export interface DataCenterContentEncryptor {
	encrypt(
		event: DesktopEventV1,
		publicPayload: Record<string, unknown>,
	): Promise<DataCenterClientEncryptionEnvelope>;
}

export type DataCenterProjectionResult =
	| {
			kind: "upload";
			domain: DataCenterEventDomain;
			event: DataCenterWireEvent;
	  }
	| {
			kind: "advance";
			domain: DataCenterEventDomain;
			reason: DataCenterAdvanceReason;
	  };

export type DataCenterBatchBody = {
	schemaVersion: "desktop-event-batch.v1";
	batchKey: string;
	firstCursor: string;
	lastCursor: string;
	events: DataCenterWireEvent[];
};

export type DataCenterAdvanceBody = {
	schemaVersion: "desktop-event-advance.v1";
	fromCursor: string | null;
	toCursor: string;
	reason: DataCenterAdvanceReason;
	eventCount: number;
};

export type DataCenterCursor = {
	schemaVersion: "desktop-event-cursor.v1";
	ackCursor: string | null;
	sequence: number | null;
	updatedAt: string | null;
};

export type DataCenterErrorEnvelope = {
	error: {
		code: string;
		message: string;
		requestId: string;
		details: { retryable: boolean };
	};
};

export type DataCenterAgentRegistration = {
	agentId: string;
	deviceId: string;
	configVersion: number;
};

export type DataCenterSignedHeaders = {
	"X-Agent-ID": string;
	"X-Agent-Timestamp": string;
	"X-Agent-Nonce": string;
	"X-Agent-Signature-Version": typeof DATA_CENTER_SIGNATURE_VERSION;
	"X-Agent-Signature": string;
};

export function createDataCenterAgentCredentials(options: {
	accountId: string;
	installationId: string;
	nowMs: number;
	platform?: NodeJS.Platform;
	agentVersion?: string;
}): DataCenterAgentCredentialsRecord {
	if (!isUuid(options.installationId)) {
		throw new Error("DataCenter cloud installation ID is invalid.");
	}
	const keyPair = generateKeyPairSync("ed25519");
	const privateDer = keyPair.privateKey.export({
		format: "der",
		type: "pkcs8",
	});
	const publicJwk = keyPair.publicKey.export({ format: "jwk" });
	if (typeof publicJwk.x !== "string") {
		privateDer.fill(0);
		throw new Error("Ed25519 public key export is unavailable.");
	}
	const publicRaw = Buffer.from(publicJwk.x, "base64url");
	if (publicRaw.byteLength !== 32) {
		privateDer.fill(0);
		publicRaw.fill(0);
		throw new Error("Ed25519 public key has an invalid length.");
	}
	const publicKey = publicRaw.toString("base64");
	const privateKeyPkcs8 = privateDer.toString("base64");
	const fingerprint = createHash("sha256")
		.update(options.installationId, "utf8")
		.update("\0")
		.update(publicRaw)
		.digest("hex");
	privateDer.fill(0);
	publicRaw.fill(0);
	const requestBody = JSON.stringify({
		device_name: "WhaleHall Desktop",
		device_type: "desktop",
		os_type: dataCenterOsType(options.platform ?? process.platform),
		fingerprint,
		agent_version: options.agentVersion ?? "0.1.0",
		installation_id: options.installationId,
		public_key: publicKey,
	});
	return {
		schemaVersion: "datacenter-agent-credentials.v1",
		accountId: options.accountId,
		installationId: options.installationId,
		publicKey,
		privateKeyPkcs8,
		fingerprint,
		registrationRequestBody: requestBody,
		registrationStatus: "pending",
		agentId: null,
		deviceId: null,
		configVersion: null,
		consentDigest: null,
		createdAtMs: options.nowMs,
		updatedAtMs: options.nowMs,
	};
}

export function completeDataCenterRegistration(
	credentials: DataCenterAgentCredentialsRecord,
	registration: DataCenterAgentRegistration,
	nowMs: number,
): DataCenterAgentCredentialsRecord {
	return {
		...credentials,
		registrationStatus: "registered",
		agentId: registration.agentId,
		deviceId: registration.deviceId,
		configVersion: registration.configVersion,
		updatedAtMs: nowMs,
	};
}

export async function projectDataCenterEvent(options: {
	event: DesktopEventV1;
	configuration: CloudSyncConfiguration;
	nowMs: number;
	contentEncryptor?: DataCenterContentEncryptor | null;
}): Promise<DataCenterProjectionResult> {
	const { event, configuration } = options;
	const domain = dataCenterEventDomain(event.kind);
	if (event.occurredAtMs < options.nowMs - DATA_CENTER_EVENT_MAX_AGE_MS) {
		return { kind: "advance", domain, reason: "retention-expired" };
	}
	const consent = consentForDomain(configuration, domain);
	if (consent === "off") {
		return { kind: "advance", domain, reason: "consent-revoked" };
	}
	const publicPayload = metadataPayloadForEvent(event);
	if (event.sensitivity === "metadata") {
		return publicPayload && dataCenterPayloadFits(publicPayload)
			? {
					kind: "upload",
					domain,
					event: metadataWireEvent(event, publicPayload),
				}
			: { kind: "advance", domain, reason: "payload-unsupported" };
	}
	if (
		consent === "content" &&
		configuration.contentEncryptionEnabled &&
		dataCenterSupportsContent(event.kind)
	) {
		if (
			Buffer.byteLength(canonicalJson(event.payload), "utf8") >
			DATA_CENTER_MAX_EVENT_PAYLOAD_BYTES
		) {
			return { kind: "advance", domain, reason: "payload-unsupported" };
		}
		if (!options.contentEncryptor) {
			throw new Error("DataCenter content encryption is unavailable.");
		}
		const contentPublicPayload = publicPayload ?? {};
		const encryptionEnvelope = await options.contentEncryptor.encrypt(
			event,
			contentPublicPayload,
		);
		if (
			!dataCenterPayloadFits(contentPublicPayload) ||
			Buffer.byteLength(JSON.stringify(encryptionEnvelope), "utf8") >
				DATA_CENTER_MAX_ENCRYPTION_ENVELOPE_BYTES
		) {
			return { kind: "advance", domain, reason: "payload-unsupported" };
		}
		return {
			kind: "upload",
			domain,
			event: {
				...eventIdentity(event),
				sensitivity: "content",
				publicPayload: contentPublicPayload,
				encryptionEnvelope,
			},
		};
	}
	if (!publicPayload) {
		return { kind: "advance", domain, reason: "content-not-consented" };
	}
	return dataCenterPayloadFits(publicPayload)
		? {
				kind: "upload",
				domain,
				event: metadataWireEvent(event, publicPayload),
			}
		: { kind: "advance", domain, reason: "payload-unsupported" };
}

export function createPendingDataCenterBatch(
	accountId: string,
	events: DataCenterWireEvent[],
	createdAtMs: number,
): DataCenterPendingBatchRecord {
	if (events.length < 1 || events.length > DATA_CENTER_MAX_BATCH_EVENTS) {
		throw new Error("DataCenter batch requires 1 to 500 events.");
	}
	for (let index = 1; index < events.length; index += 1) {
		if (
			dataCenterCursorSequence(events[index]?.cursor ?? "") !==
			dataCenterCursorSequence(events[index - 1]?.cursor ?? "") + 1n
		) {
			throw new Error("DataCenter batch cursors must be contiguous.");
		}
	}
	const firstCursor = events[0]?.cursor;
	const lastCursor = events.at(-1)?.cursor;
	if (!firstCursor || !lastCursor)
		throw new Error("DataCenter batch is empty.");
	const material = JSON.stringify({ firstCursor, lastCursor, events });
	const batchKey = `dcb1_${sha256Hex(material)}`;
	const body: DataCenterBatchBody = {
		schemaVersion: "desktop-event-batch.v1",
		batchKey,
		firstCursor,
		lastCursor,
		events,
	};
	const exactBody = JSON.stringify(body);
	if (Buffer.byteLength(exactBody, "utf8") > DATA_CENTER_MAX_BATCH_BODY_BYTES) {
		throw new Error("DataCenter batch body exceeds the client wire limit.");
	}
	return {
		schemaVersion: "datacenter-pending-batch.v1",
		accountId,
		batchKey,
		body: exactBody,
		requestHash: sha256Hex(exactBody),
		firstCursor,
		lastCursor,
		createdAtMs,
	};
}

export function createPendingDataCenterBatchPrefix(
	accountId: string,
	events: DataCenterWireEvent[],
	createdAtMs: number,
): { pending: DataCenterPendingBatchRecord; eventCount: number } | null {
	if (events.length === 0) return null;
	const maximum = Math.min(events.length, DATA_CENTER_MAX_BATCH_EVENTS);
	let bodyBytes = DATA_CENTER_EMPTY_BATCH_BODY_BYTES;
	let acceptedCount = 0;
	for (let index = 0; index < maximum; index += 1) {
		const event = events[index];
		if (!event) break;
		const candidateBytes =
			bodyBytes + dataCenterWireEventByteLength(event) + (index === 0 ? 0 : 1);
		if (candidateBytes > DATA_CENTER_MAX_BATCH_BODY_BYTES) break;
		bodyBytes = candidateBytes;
		acceptedCount = index + 1;
	}
	if (acceptedCount === 0) return null;
	return {
		pending: createPendingDataCenterBatch(
			accountId,
			events.slice(0, acceptedCount),
			createdAtMs,
		),
		eventCount: acceptedCount,
	};
}

export function dataCenterPendingBatchReplacementReason(options: {
	pending: DataCenterPendingBatchRecord;
	configuration: CloudSyncConfiguration;
	nowMs: number;
}): DataCenterAdvanceReason | null {
	const body = parsePendingBatchBody(options.pending.body);
	let expired = false;
	for (const event of body.events) {
		const consent = consentForDomain(
			options.configuration,
			dataCenterEventDomain(event.kind),
		);
		if (consent === "off") return "consent-revoked";
		if (
			event.sensitivity === "content" &&
			(consent !== "content" || !options.configuration.contentEncryptionEnabled)
		) {
			return "content-not-consented";
		}
		if (event.occurredAtMs < options.nowMs - DATA_CENTER_EVENT_MAX_AGE_MS) {
			expired = true;
		}
	}
	return expired ? "retention-expired" : null;
}

export function dataCenterWireEventByteLength(
	event: DataCenterWireEvent,
): number {
	return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export function createPendingDataCenterAdvance(options: {
	accountId: string;
	fromCursor: string | null;
	toCursor: string;
	reason: DataCenterAdvanceReason;
	createdAtMs: number;
}): DataCenterPendingAdvanceRecord {
	const eventCount = dataCenterCursorDistance(
		options.fromCursor,
		options.toCursor,
	);
	const body: DataCenterAdvanceBody = {
		schemaVersion: "desktop-event-advance.v1",
		fromCursor: options.fromCursor,
		toCursor: options.toCursor,
		reason: options.reason,
		eventCount,
	};
	const exactBody = JSON.stringify(body);
	const requestHash = sha256Hex(exactBody);
	return {
		schemaVersion: "datacenter-pending-advance.v1",
		accountId: options.accountId,
		advanceKey: `dca1_${requestHash}`,
		body: exactBody,
		requestHash,
		fromCursor: options.fromCursor,
		toCursor: options.toCursor,
		eventCount,
		createdAtMs: options.createdAtMs,
	};
}

export function createDataCenterConsumerAudit(options: {
	fromAccountId: string | null;
	toAccountId: string;
	fromCursor: string | null;
	toCursor: string;
	boundaryEpochMs: number;
	createdAtMs: number;
}): DataCenterConsumerAuditRecord {
	const material = {
		schemaVersion: "datacenter-consumer-audit.v1" as const,
		fromAccountId: options.fromAccountId,
		toAccountId: options.toAccountId,
		fromCursor: options.fromCursor,
		toCursor: options.toCursor,
		reason: "account-boundary" as const,
		createdAtMs: options.createdAtMs,
	};
	return {
		...material,
		id: `dcaudit1_${sha256Hex(
			JSON.stringify({
				fromAccountId: options.fromAccountId,
				toAccountId: options.toAccountId,
				fromCursor: options.fromCursor,
				toCursor: options.toCursor,
				boundaryEpochMs: options.boundaryEpochMs,
			}),
		)}`,
	};
}

export function signDataCenterRequestV2(options: {
	agentId: string;
	privateKeyPkcs8: string;
	method: string;
	url: URL;
	body: string;
	nowMs: number;
	nonce?: string;
}): DataCenterSignedHeaders {
	const timestamp = new Date(options.nowMs).toISOString();
	const nonce = options.nonce ?? randomBytes(18).toString("base64url");
	if (!/^[\x21-\x7e]{16,128}$/u.test(nonce)) {
		throw new Error(
			"DataCenter signature nonce must contain 16 to 128 printable ASCII bytes.",
		);
	}
	const canonical = dataCenterCanonicalRequestV2({
		agentId: options.agentId,
		method: options.method,
		url: options.url,
		timestamp,
		nonce,
		body: options.body,
	});
	const privateDer = Buffer.from(options.privateKeyPkcs8, "base64");
	try {
		const privateKey = createPrivateKey({
			key: privateDer,
			format: "der",
			type: "pkcs8",
		});
		return {
			"X-Agent-ID": options.agentId,
			"X-Agent-Timestamp": timestamp,
			"X-Agent-Nonce": nonce,
			"X-Agent-Signature-Version": DATA_CENTER_SIGNATURE_VERSION,
			"X-Agent-Signature": sign(null, canonical, privateKey).toString("base64"),
		};
	} finally {
		privateDer.fill(0);
		canonical.fill(0);
	}
}

export function dataCenterCanonicalRequestV2(options: {
	agentId: string;
	method: string;
	url: URL;
	timestamp: string;
	nonce: string;
	body: string;
}): Buffer {
	if (!isUuid(options.agentId)) {
		throw new Error("DataCenter signature Agent ID is invalid.");
	}
	const bodyHash = createHash("sha256")
		.update(options.body, "utf8")
		.digest("base64")
		.replace(/=+$/u, "");
	return Buffer.from(
		[
			options.agentId,
			options.method.toUpperCase(),
			options.url.pathname,
			canonicalRfc3986Query(options.url.search),
			options.timestamp,
			options.nonce,
			bodyHash,
		].join("\n"),
		"utf8",
	);
}

export function canonicalRfc3986Query(rawQuery: string): string {
	const source = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
	if (source === "") return "";
	return source
		.split("&")
		.map((part, index) => {
			const separator = part.indexOf("=");
			const rawKey = separator < 0 ? part : part.slice(0, separator);
			const rawValue = separator < 0 ? "" : part.slice(separator + 1);
			return {
				key: rfc3986Encode(decodeURIComponent(rawKey)),
				value: rfc3986Encode(decodeURIComponent(rawValue)),
				index,
			};
		})
		.sort(
			(left, right) =>
				compareCanonicalComponent(left.key, right.key) ||
				compareCanonicalComponent(left.value, right.value) ||
				left.index - right.index,
		)
		.map(({ key, value }) => `${key}=${value}`)
		.join("&");
}

export function parseDataCenterRegistration(
	value: unknown,
): DataCenterAgentRegistration {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["agent_id", "device_id", "config_version"]) ||
		!isUuid(value.agent_id) ||
		!isUuid(value.device_id) ||
		!Number.isSafeInteger(value.config_version) ||
		(value.config_version as number) < 1
	) {
		throw new Error("DataCenter registration response is invalid.");
	}
	return {
		agentId: value.agent_id,
		deviceId: value.device_id,
		configVersion: value.config_version as number,
	};
}

export function parseDataCenterCursor(value: unknown): DataCenterCursor {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"ackCursor",
			"sequence",
			"updatedAt",
		]) ||
		value.schemaVersion !== "desktop-event-cursor.v1" ||
		!(value.ackCursor === null || isDesktopCursor(value.ackCursor)) ||
		!(value.sequence === null || isNonNegativeSafeInteger(value.sequence)) ||
		!(value.updatedAt === null || isRfc3339Instant(value.updatedAt)) ||
		(value.ackCursor === null
			? value.sequence !== null || value.updatedAt !== null
			: value.sequence === null ||
				value.updatedAt === null ||
				BigInt(value.sequence) !== dataCenterCursorSequence(value.ackCursor))
	) {
		throw new Error("DataCenter cursor response is invalid.");
	}
	return value as DataCenterCursor;
}

export function parseDataCenterErrorEnvelope(
	value: unknown,
): DataCenterErrorEnvelope {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["error"]) ||
		!isRecord(value.error) ||
		!hasExactKeys(value.error, ["code", "message", "requestId", "details"]) ||
		typeof value.error.code !== "string" ||
		value.error.code.length === 0 ||
		typeof value.error.message !== "string" ||
		value.error.message.length === 0 ||
		typeof value.error.requestId !== "string" ||
		value.error.requestId.length === 0 ||
		!isRecord(value.error.details) ||
		!hasExactKeys(value.error.details, ["retryable"]) ||
		typeof value.error.details.retryable !== "boolean"
	) {
		throw new Error("DataCenter error envelope is invalid.");
	}
	return value as DataCenterErrorEnvelope;
}

export function validateDataCenterAdvanceResponse(
	value: unknown,
	pending: DataCenterPendingAdvanceRecord,
): void {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "ackCursor", "advancedCount"]) ||
		value.schemaVersion !== "desktop-event-cursor.v1" ||
		value.ackCursor !== pending.toCursor ||
		value.advancedCount !== pending.eventCount
	) {
		throw new Error("DataCenter cursor advance ACK is invalid.");
	}
}

export function validateDataCenterBatchResponse(
	value: unknown,
	pending: DataCenterPendingBatchRecord,
): void {
	const body = parsePendingBatchBody(pending.body);
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"batchId",
			"ackCursor",
			"acceptedCount",
			"duplicateCount",
			"results",
			"requestHash",
		]) ||
		!isUuid(value.batchId) ||
		value.ackCursor !== pending.lastCursor ||
		value.requestHash !== pending.requestHash ||
		!Number.isSafeInteger(value.acceptedCount) ||
		!Number.isSafeInteger(value.duplicateCount) ||
		(value.acceptedCount as number) < 0 ||
		(value.duplicateCount as number) < 0 ||
		!Array.isArray(value.results) ||
		value.results.length !== body.events.length
	) {
		throw new Error("DataCenter desktop batch ACK is invalid.");
	}
	let accepted = 0;
	let duplicate = 0;
	for (let index = 0; index < body.events.length; index += 1) {
		const event = body.events[index];
		const result = value.results[index];
		if (
			!event ||
			!isRecord(result) ||
			!hasExactKeys(result, ["eventId", "cursor", "status"]) ||
			result.eventId !== event.eventId ||
			result.cursor !== event.cursor ||
			(result.status !== "accepted" && result.status !== "duplicate")
		) {
			throw new Error("DataCenter desktop batch result order is invalid.");
		}
		if (result.status === "accepted") accepted += 1;
		else duplicate += 1;
	}
	if (value.acceptedCount !== accepted || value.duplicateCount !== duplicate) {
		throw new Error("DataCenter desktop batch result counts are invalid.");
	}
}

export function cloudSyncConsentDigest(
	configuration: CloudSyncConfiguration,
): string {
	return sha256Hex(
		JSON.stringify({
			policyVersion: "desktop-metadata.v1",
			consents: configuration.consents,
		}),
	);
}

export function dataCenterConsentRequest(level: CloudSyncConsentLevel): {
	granted: boolean;
	data_level: number;
	policy_version: "desktop-metadata.v1";
} {
	return {
		granted: level !== "off",
		data_level: level === "content" ? 2 : level === "metadata" ? 1 : 0,
		policy_version: "desktop-metadata.v1",
	};
}

export function parsePendingBatchBody(body: string): DataCenterBatchBody {
	const value = JSON.parse(body) as unknown;
	if (
		!isRecord(value) ||
		value.schemaVersion !== "desktop-event-batch.v1" ||
		typeof value.batchKey !== "string" ||
		!isDesktopCursor(value.firstCursor) ||
		!isDesktopCursor(value.lastCursor) ||
		!Array.isArray(value.events)
	) {
		throw new Error("Durable DataCenter batch body is invalid.");
	}
	return value as DataCenterBatchBody;
}

function metadataWireEvent(
	event: DesktopEventV1,
	payload: Record<string, unknown>,
): DataCenterMetadataEvent {
	return { ...eventIdentity(event), sensitivity: "metadata", payload };
}

function eventIdentity(
	event: DesktopEventV1,
): Omit<DataCenterMetadataEvent, "sensitivity" | "payload"> {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: event.eventId,
		cursor: event.cursor,
		deviceId: event.deviceId,
		sessionId: event.sessionId,
		kind: event.kind,
		source: event.source,
		occurredAtMs: event.occurredAtMs,
		observedAtMs: event.observedAtMs,
		goalVersion: event.goalVersion,
	};
}

function metadataPayloadForEvent(
	event: DesktopEventV1,
): Record<string, unknown> | null {
	switch (event.kind) {
		case "application.processObservedBatch":
			return {
				started: event.payload.started,
				exited: event.payload.exited,
			};
		case "application.foregroundChanged":
			return {
				appId: event.payload.appId,
				appName: event.payload.appName,
			};
		case "browser.tabOpened":
		case "browser.tabNavigated":
		case "browser.tabClosed":
			return {
				browserId: event.payload.browserId,
				tabId: event.payload.tabId,
			};
		case "accessibility.focusChanged":
		case "accessibility.valueChanged":
			return { appId: event.payload.appId, role: event.payload.role };
		case "accessibility.documentChanged":
			return {
				appId: event.payload.appId,
				...(event.payload.documentId
					? { documentId: event.payload.documentId }
					: {}),
				insertedChars: event.payload.insertedChars,
				deletedChars: event.payload.deletedChars,
				...(event.payload.textChangeObserved
					? { textChangeObserved: true }
					: {}),
			};
		case "editor.documentChanged":
			return {
				editorId: event.payload.editorId,
				documentId: event.payload.documentId,
				...(event.payload.language ? { language: event.payload.language } : {}),
				insertedChars: event.payload.insertedChars,
				deletedChars: event.payload.deletedChars,
				burstStartedAtMs: event.payload.burstStartedAtMs,
				burstEndedAtMs: event.payload.burstEndedAtMs,
			};
		case "input.activityAggregated":
			return {
				bucketStartedAtMs: event.payload.bucketStartedAtMs,
				bucketEndedAtMs: event.payload.bucketEndedAtMs,
				keyCount: event.payload.keyCount,
				clickCount: event.payload.clickCount,
				scrollDelta: event.payload.scrollDelta,
				mouseDistance: event.payload.mouseDistance,
				...(event.payload.coalescedBucketCount === undefined
					? {}
					: { coalescedBucketCount: event.payload.coalescedBucketCount }),
			};
		case "presence.afkStarted":
		case "presence.afkEnded":
			return { idleForMs: event.payload.idleForMs };
		case "presence.locked":
		case "presence.unlocked":
		case "presence.sleep":
		case "presence.wake":
		case "system.heartbeat":
		case "system.cursorCheckpoint":
		case "authorization.changed":
			return {};
		case "goal.contextChanged":
			return null;
		case "authorization.revoked":
		case "authorization.granted":
			return { permissions: event.payload.permissions };
		case "reflection.completed":
			return { windowId: event.payload.windowId };
		case "reflection.failed":
			return {
				windowId: event.payload.windowId,
				code: event.payload.code,
			};
		case "tool.started":
		case "tool.completed":
			return {
				callId: event.payload.callId,
				...(event.payload.name ? { name: event.payload.name } : {}),
			};
		case "tool.progress":
			return {
				callId: event.payload.callId,
				...(event.payload.progress === undefined
					? {}
					: { progress: event.payload.progress }),
			};
		case "tool.failed":
			return {
				callId: event.payload.callId,
				...(event.payload.code ? { code: event.payload.code } : {}),
			};
		case "tool.cancelled":
			return { callId: event.payload.callId };
	}
}

function dataCenterEventDomain(kind: DesktopEventKind): DataCenterEventDomain {
	if (kind.startsWith("browser.")) return "browser";
	if (kind.startsWith("presence.")) return "presence";
	if (
		kind.startsWith("authorization.") ||
		kind.startsWith("tool.") ||
		kind === "system.heartbeat" ||
		kind === "system.cursorCheckpoint"
	) {
		return "system";
	}
	return "activity";
}

function dataCenterSupportsContent(kind: DesktopEventKind): boolean {
	return (
		kind === "application.foregroundChanged" ||
		kind === "browser.tabOpened" ||
		kind === "browser.tabNavigated" ||
		kind === "accessibility.focusChanged" ||
		kind === "accessibility.valueChanged" ||
		kind === "accessibility.documentChanged" ||
		kind === "editor.documentChanged" ||
		kind === "goal.contextChanged"
	);
}

function dataCenterPayloadFits(payload: Record<string, unknown>): boolean {
	return (
		Buffer.byteLength(JSON.stringify(payload), "utf8") <=
		DATA_CENTER_MAX_EVENT_PAYLOAD_BYTES
	);
}

function consentForDomain(
	configuration: CloudSyncConfiguration,
	domain: DataCenterEventDomain,
): CloudSyncConsentLevel {
	return domain === "system" ? "metadata" : configuration.consents[domain];
}

function dataCenterOsType(platform: NodeJS.Platform): string {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	return "linux";
}

export function dataCenterCursorDistance(
	fromCursor: string | null,
	toCursor: string,
): number {
	const from = fromCursor === null ? 0n : dataCenterCursorSequence(fromCursor);
	const distance = dataCenterCursorSequence(toCursor) - from;
	if (distance < 1n || distance > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("DataCenter cursor advance distance is invalid.");
	}
	return Number(distance);
}

export function dataCenterCursorSequence(cursor: string): bigint {
	if (!isDesktopCursor(cursor)) {
		throw new Error("DataCenter desktop cursor is invalid.");
	}
	return BigInt(`0x${cursor.slice(4)}`);
}

function compareCanonicalComponent(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function rfc3986Encode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/gu,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isDesktopCursor(value: unknown): value is string {
	return typeof value === "string" && /^ec1_[0-7][0-9a-f]{15}$/u.test(value);
}

function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
			value,
		)
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRfc3339Instant(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}
