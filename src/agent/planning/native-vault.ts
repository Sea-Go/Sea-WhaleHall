import type { AgentRuntime } from "../agent-runtime";
import type {
	LocalPlanningPlanSnapshot,
	LocalVaultOpenResultRecord,
	LocalVaultSealResultRecord,
} from "../local-protocol";
import type { PlanningPlan } from "./types";
import { parsePlanningPlan } from "./validation";

export const PLANNING_VAULT_NAMESPACE = "planning.runtime.v1";
export const PLANNING_VAULT_REFERENCE_SCHEMA = "planning.runtime.reference.v1";
export const PLANNING_VAULT_MANIFEST_SCHEMA = "planning.runtime.manifest.v1";
export const PLANNING_VAULT_CHUNK_SCHEMA = "planning.runtime.chunk.v1";
export const PLANNING_PAYLOAD_SCHEMA = "planning.plan.v1";

// Rust accepts at most 512 KiB of serialized JSON per record and 768 KiB per
// seal batch. Encoding one 360 KiB raw chunk as base64 leaves more than 30 KiB
// for the authenticated envelope, and one record per call stays below both
// limits. The explicit 8 MiB aggregate bound supports long-lived complete
// conversations while keeping allocation/open-call counts deterministic.
export const MAX_PLANNING_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const PLANNING_VAULT_RAW_CHUNK_BYTES = 360 * 1024;
export const MAX_PLANNING_VAULT_CHUNK_COUNT = Math.ceil(
	MAX_PLANNING_PAYLOAD_BYTES / PLANNING_VAULT_RAW_CHUNK_BYTES,
);
const RAW_CHUNK_BYTES = PLANNING_VAULT_RAW_CHUNK_BYTES;
const MAX_CHUNK_COUNT = MAX_PLANNING_VAULT_CHUNK_COUNT;

export type PlanningVaultTransport = Pick<
	AgentRuntime,
	"sealVaultBatch" | "openVaultBatch"
>;

export interface SealedPlanningReference {
	schemaVersion: typeof PLANNING_VAULT_REFERENCE_SCHEMA;
	namespace: typeof PLANNING_VAULT_NAMESPACE;
	manifestSchemaVersion: typeof PLANNING_VAULT_MANIFEST_SCHEMA;
	manifestRecordId: string;
}

export interface SealedPlanningResult {
	contentRef: string;
	reference: SealedPlanningReference;
}

export interface PlanningVaultManifestIdentity {
	planId: string;
	planVersion: number;
	sealedContentRef: string;
}

export interface PlanningVaultManifestRecord {
	recordId: string;
	schemaVersion: typeof PLANNING_VAULT_MANIFEST_SCHEMA;
	contentRef: string;
}

export interface PlanningVaultChunkRecord {
	recordId: string;
	schemaVersion: typeof PLANNING_VAULT_CHUNK_SCHEMA;
	contentRef: string;
}

export interface InspectedPlanningVaultManifest {
	manifest: PlanningVaultManifestRecord;
	chunks: readonly PlanningVaultChunkRecord[];
}

interface PlanningChunkDescriptor {
	index: number;
	recordId: string;
	schemaVersion: typeof PLANNING_VAULT_CHUNK_SCHEMA;
	contentRef: string;
	contentHash: string;
	byteOffset: number;
	byteLength: number;
}

interface PlanningManifest {
	kind: "planning-runtime-manifest";
	namespace: typeof PLANNING_VAULT_NAMESPACE;
	schemaVersion: typeof PLANNING_VAULT_MANIFEST_SCHEMA;
	payloadSchemaVersion: typeof PLANNING_PAYLOAD_SCHEMA;
	manifestRecordId: string;
	planId: string;
	planVersion: number;
	operationId: string;
	byteLength: number;
	payloadHash: string;
	chunkCount: number;
	chunks: PlanningChunkDescriptor[];
}

interface PlanningChunkEnvelope {
	kind: "planning-runtime-chunk";
	namespace: typeof PLANNING_VAULT_NAMESPACE;
	schemaVersion: typeof PLANNING_VAULT_CHUNK_SCHEMA;
	manifestRecordId: string;
	planId: string;
	planVersion: number;
	operationId: string;
	index: number;
	chunkCount: number;
	byteOffset: number;
	byteLength: number;
	encoding: "base64";
	data: string;
}

/** Stable fail-closed error for encrypted planning persistence boundaries. */
export class PlanningVaultPersistenceError extends Error {
	constructor(
		public readonly code:
			| "payload-too-large"
			| "invalid-reference"
			| "invalid-manifest"
			| "invalid-chunk"
			| "identity-mismatch",
	) {
		super("Encrypted planning persistence validation failed.");
		this.name = "PlanningVaultPersistenceError";
	}
}

/** Seals one complete plan as an encrypted manifest plus encrypted chunks. */
export async function sealPlanningPlan(
	vault: PlanningVaultTransport,
	plan: PlanningPlan,
	operationId: string,
): Promise<SealedPlanningResult> {
	if (!nativeIdentifier(operationId, 200)) {
		throw new PlanningVaultPersistenceError("invalid-reference");
	}
	const validated = parsePlanningPlan(plan);
	assertNativeProjectionIdentifiers(validated);
	const payload = new TextEncoder().encode(JSON.stringify(validated));
	if (payload.byteLength > MAX_PLANNING_PAYLOAD_BYTES) {
		throw new PlanningVaultPersistenceError("payload-too-large");
	}
	const chunkCount = Math.max(
		1,
		Math.ceil(payload.byteLength / RAW_CHUNK_BYTES),
	);
	const manifestRecordId = await boundRecordId(
		"manifest",
		validated.id,
		validated.version,
		operationId,
	);
	const descriptors: PlanningChunkDescriptor[] = [];
	for (let index = 0; index < chunkCount; index += 1) {
		const byteOffset = index * RAW_CHUNK_BYTES;
		const chunk = payload.slice(
			byteOffset,
			Math.min(payload.byteLength, byteOffset + RAW_CHUNK_BYTES),
		);
		const recordId = await boundRecordId(
			"chunk",
			validated.id,
			validated.version,
			operationId,
			index,
		);
		const content: PlanningChunkEnvelope = {
			kind: "planning-runtime-chunk",
			namespace: PLANNING_VAULT_NAMESPACE,
			schemaVersion: PLANNING_VAULT_CHUNK_SCHEMA,
			manifestRecordId,
			planId: validated.id,
			planVersion: validated.version,
			operationId,
			index,
			chunkCount,
			byteOffset,
			byteLength: chunk.byteLength,
			encoding: "base64",
			data: Buffer.from(chunk).toString("base64"),
		};
		const result = await vault.sealVaultBatch({
			namespace: PLANNING_VAULT_NAMESPACE,
			records: [
				{
					recordId,
					schemaVersion: PLANNING_VAULT_CHUNK_SCHEMA,
					content,
				},
			],
		});
		const sealed = exactSealResult(result.records, recordId);
		descriptors.push({
			index,
			recordId,
			schemaVersion: PLANNING_VAULT_CHUNK_SCHEMA,
			contentRef: sealed.contentRef,
			contentHash: sealed.contentHash,
			byteOffset,
			byteLength: chunk.byteLength,
		});
	}

	const manifest: PlanningManifest = {
		kind: "planning-runtime-manifest",
		namespace: PLANNING_VAULT_NAMESPACE,
		schemaVersion: PLANNING_VAULT_MANIFEST_SCHEMA,
		payloadSchemaVersion: PLANNING_PAYLOAD_SCHEMA,
		manifestRecordId,
		planId: validated.id,
		planVersion: validated.version,
		operationId,
		byteLength: payload.byteLength,
		payloadHash: await sha256Hex(payload),
		chunkCount,
		chunks: descriptors,
	};
	const result = await vault.sealVaultBatch({
		namespace: PLANNING_VAULT_NAMESPACE,
		records: [
			{
				recordId: manifestRecordId,
				schemaVersion: PLANNING_VAULT_MANIFEST_SCHEMA,
				content: manifest,
			},
		],
	});
	const sealedManifest = exactSealResult(result.records, manifestRecordId);
	return {
		contentRef: sealedManifest.contentRef,
		reference: {
			schemaVersion: PLANNING_VAULT_REFERENCE_SCHEMA,
			namespace: PLANNING_VAULT_NAMESPACE,
			manifestSchemaVersion: PLANNING_VAULT_MANIFEST_SCHEMA,
			manifestRecordId,
		},
	};
}

/** Opens and validates every encrypted layer before parsing a persisted plan. */
export async function openSealedPlanningPlan(
	vault: PlanningVaultTransport,
	snapshot: LocalPlanningPlanSnapshot,
): Promise<PlanningPlan> {
	if (
		typeof snapshot.sealedContentRef !== "string" ||
		!snapshot.sealedContentRef
	) {
		throw new PlanningVaultPersistenceError("invalid-reference");
	}
	const reference = parsePlanningReference(snapshot.runtimePayload);
	const manifestResult = await vault.openVaultBatch({
		namespace: PLANNING_VAULT_NAMESPACE,
		contentRefs: [snapshot.sealedContentRef],
	});
	const openedManifest = exactOpenResult(
		manifestResult.records,
		reference.manifestRecordId,
		PLANNING_VAULT_MANIFEST_SCHEMA,
		snapshot.sealedContentRef,
		"invalid-manifest",
	);
	const manifest = parseManifest(openedManifest.content);
	if (
		manifest.namespace !== reference.namespace ||
		manifest.schemaVersion !== reference.manifestSchemaVersion ||
		manifest.manifestRecordId !== reference.manifestRecordId ||
		manifest.planId !== snapshot.planId ||
		manifest.planVersion !== snapshot.version ||
		(await boundRecordId(
			"manifest",
			manifest.planId,
			manifest.planVersion,
			manifest.operationId,
		)) !== manifest.manifestRecordId
	) {
		throw new PlanningVaultPersistenceError("identity-mismatch");
	}

	const payload = new Uint8Array(manifest.byteLength);
	for (const descriptor of manifest.chunks) {
		const result = await vault.openVaultBatch({
			namespace: PLANNING_VAULT_NAMESPACE,
			contentRefs: [descriptor.contentRef],
		});
		const opened = exactOpenResult(
			result.records,
			descriptor.recordId,
			descriptor.schemaVersion,
			descriptor.contentRef,
			"invalid-chunk",
		);
		if (opened.contentHash !== descriptor.contentHash) {
			throw new PlanningVaultPersistenceError("invalid-chunk");
		}
		const chunk = parseChunk(opened.content);
		if (
			chunk.namespace !== manifest.namespace ||
			chunk.manifestRecordId !== manifest.manifestRecordId ||
			chunk.planId !== manifest.planId ||
			chunk.planVersion !== manifest.planVersion ||
			chunk.operationId !== manifest.operationId ||
			chunk.index !== descriptor.index ||
			chunk.chunkCount !== manifest.chunkCount ||
			chunk.byteOffset !== descriptor.byteOffset ||
			chunk.byteLength !== descriptor.byteLength ||
			(await boundRecordId(
				"chunk",
				chunk.planId,
				chunk.planVersion,
				chunk.operationId,
				chunk.index,
			)) !== descriptor.recordId
		) {
			throw new PlanningVaultPersistenceError("identity-mismatch");
		}
		const decoded = decodeCanonicalBase64(chunk.data);
		if (decoded.byteLength !== descriptor.byteLength) {
			throw new PlanningVaultPersistenceError("invalid-chunk");
		}
		payload.set(decoded, descriptor.byteOffset);
	}
	if ((await sha256Hex(payload)) !== manifest.payloadHash) {
		throw new PlanningVaultPersistenceError("invalid-manifest");
	}

	let parsed: unknown;
	try {
		const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(payload);
		parsed = JSON.parse(plaintext);
	} catch {
		throw new PlanningVaultPersistenceError("invalid-manifest");
	}
	const plan = parsePlanningPlan(parsed);
	if (plan.id !== snapshot.planId || plan.version !== snapshot.version) {
		throw new PlanningVaultPersistenceError("identity-mismatch");
	}
	return plan;
}

/**
 * Opens only the authenticated manifest layer for reachability analysis. It
 * validates the plan/version/operation binding before exposing chunk records.
 */
export async function inspectPlanningVaultManifest(
	vault: PlanningVaultTransport,
	identity: PlanningVaultManifestIdentity,
): Promise<InspectedPlanningVaultManifest> {
	if (
		!boundedString(identity.planId, 1, 256) ||
		!positiveSafeInteger(identity.planVersion) ||
		!boundedString(identity.sealedContentRef, 1, 512)
	) {
		throw new PlanningVaultPersistenceError("invalid-reference");
	}
	const result = await vault.openVaultBatch({
		namespace: PLANNING_VAULT_NAMESPACE,
		contentRefs: [identity.sealedContentRef],
	});
	const opened = result.records[0];
	if (
		result.records.length !== 1 ||
		!opened ||
		opened.schemaVersion !== PLANNING_VAULT_MANIFEST_SCHEMA ||
		opened.contentRef !== identity.sealedContentRef ||
		!manifestRecordId(opened.recordId) ||
		!boundedString(opened.contentHash, 1, 512)
	) {
		throw new PlanningVaultPersistenceError("invalid-manifest");
	}
	const manifest = parseManifest(opened.content);
	if (
		manifest.manifestRecordId !== opened.recordId ||
		manifest.planId !== identity.planId ||
		manifest.planVersion !== identity.planVersion ||
		(await boundRecordId(
			"manifest",
			manifest.planId,
			manifest.planVersion,
			manifest.operationId,
		)) !== manifest.manifestRecordId
	) {
		throw new PlanningVaultPersistenceError("identity-mismatch");
	}
	for (const chunk of manifest.chunks) {
		if (
			(await boundRecordId(
				"chunk",
				manifest.planId,
				manifest.planVersion,
				manifest.operationId,
				chunk.index,
			)) !== chunk.recordId
		) {
			throw new PlanningVaultPersistenceError("identity-mismatch");
		}
	}
	return {
		manifest: {
			recordId: manifest.manifestRecordId,
			schemaVersion: PLANNING_VAULT_MANIFEST_SCHEMA,
			contentRef: identity.sealedContentRef,
		},
		chunks: manifest.chunks.map((chunk) => ({
			recordId: chunk.recordId,
			schemaVersion: PLANNING_VAULT_CHUNK_SCHEMA,
			contentRef: chunk.contentRef,
		})),
	};
}

export function parseLegacyPlanningSnapshot(
	snapshot: LocalPlanningPlanSnapshot,
): PlanningPlan {
	const plan = parsePlanningPlan(snapshot.runtimePayload);
	if (plan.id !== snapshot.planId || plan.version !== snapshot.version) {
		throw new PlanningVaultPersistenceError("identity-mismatch");
	}
	return plan;
}

function exactSealResult(
	records: readonly LocalVaultSealResultRecord[],
	recordId: string,
): LocalVaultSealResultRecord {
	const record = records[0];
	if (
		records.length !== 1 ||
		!record ||
		record.recordId !== recordId ||
		!boundedString(record.contentRef, 1, 256) ||
		!boundedString(record.contentHash, 1, 512)
	) {
		throw new PlanningVaultPersistenceError("invalid-reference");
	}
	return record;
}

function exactOpenResult(
	records: readonly LocalVaultOpenResultRecord[],
	recordId: string,
	schemaVersion: string,
	contentRef: string,
	code: "invalid-manifest" | "invalid-chunk",
): LocalVaultOpenResultRecord {
	const record = records[0];
	if (
		records.length !== 1 ||
		!record ||
		record.recordId !== recordId ||
		record.schemaVersion !== schemaVersion ||
		record.contentRef !== contentRef ||
		!boundedString(record.contentHash, 1, 512)
	) {
		throw new PlanningVaultPersistenceError(code);
	}
	return record;
}

function parsePlanningReference(value: unknown): SealedPlanningReference {
	if (
		!isExactRecord(value, [
			"schemaVersion",
			"namespace",
			"manifestSchemaVersion",
			"manifestRecordId",
		]) ||
		value.schemaVersion !== PLANNING_VAULT_REFERENCE_SCHEMA ||
		value.namespace !== PLANNING_VAULT_NAMESPACE ||
		value.manifestSchemaVersion !== PLANNING_VAULT_MANIFEST_SCHEMA ||
		!manifestRecordId(value.manifestRecordId)
	) {
		throw new PlanningVaultPersistenceError("invalid-reference");
	}
	return value as unknown as SealedPlanningReference;
}

function parseManifest(value: unknown): PlanningManifest {
	if (
		!isExactRecord(value, [
			"kind",
			"namespace",
			"schemaVersion",
			"payloadSchemaVersion",
			"manifestRecordId",
			"planId",
			"planVersion",
			"operationId",
			"byteLength",
			"payloadHash",
			"chunkCount",
			"chunks",
		]) ||
		value.kind !== "planning-runtime-manifest" ||
		value.namespace !== PLANNING_VAULT_NAMESPACE ||
		value.schemaVersion !== PLANNING_VAULT_MANIFEST_SCHEMA ||
		value.payloadSchemaVersion !== PLANNING_PAYLOAD_SCHEMA ||
		!manifestRecordId(value.manifestRecordId) ||
		!boundedString(value.planId, 1, 256) ||
		!positiveSafeInteger(value.planVersion) ||
		!boundedString(value.operationId, 1, 200) ||
		!positiveSafeInteger(value.byteLength) ||
		value.byteLength > MAX_PLANNING_PAYLOAD_BYTES ||
		!sha256(value.payloadHash) ||
		!positiveSafeInteger(value.chunkCount) ||
		value.chunkCount > MAX_CHUNK_COUNT ||
		!Array.isArray(value.chunks) ||
		value.chunks.length !== value.chunkCount
	) {
		throw new PlanningVaultPersistenceError("invalid-manifest");
	}
	const chunks = value.chunks.map(parseChunkDescriptor);
	let offset = 0;
	const recordIds = new Set<string>();
	const contentRefs = new Set<string>();
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index];
		if (
			!chunk ||
			chunk.index !== index ||
			chunk.byteOffset !== offset ||
			chunk.byteLength > RAW_CHUNK_BYTES ||
			recordIds.has(chunk.recordId) ||
			contentRefs.has(chunk.contentRef)
		) {
			throw new PlanningVaultPersistenceError("invalid-manifest");
		}
		recordIds.add(chunk.recordId);
		contentRefs.add(chunk.contentRef);
		offset += chunk.byteLength;
	}
	if (offset !== value.byteLength) {
		throw new PlanningVaultPersistenceError("invalid-manifest");
	}
	return { ...value, chunks } as unknown as PlanningManifest;
}

function parseChunkDescriptor(value: unknown): PlanningChunkDescriptor {
	if (
		!isExactRecord(value, [
			"index",
			"recordId",
			"schemaVersion",
			"contentRef",
			"contentHash",
			"byteOffset",
			"byteLength",
		]) ||
		!nonNegativeSafeInteger(value.index) ||
		!chunkRecordId(value.recordId) ||
		value.schemaVersion !== PLANNING_VAULT_CHUNK_SCHEMA ||
		!boundedString(value.contentRef, 1, 256) ||
		!boundedString(value.contentHash, 1, 512) ||
		!nonNegativeSafeInteger(value.byteOffset) ||
		!positiveSafeInteger(value.byteLength)
	) {
		throw new PlanningVaultPersistenceError("invalid-manifest");
	}
	return value as unknown as PlanningChunkDescriptor;
}

function parseChunk(value: unknown): PlanningChunkEnvelope {
	if (
		!isExactRecord(value, [
			"kind",
			"namespace",
			"schemaVersion",
			"manifestRecordId",
			"planId",
			"planVersion",
			"operationId",
			"index",
			"chunkCount",
			"byteOffset",
			"byteLength",
			"encoding",
			"data",
		]) ||
		value.kind !== "planning-runtime-chunk" ||
		value.namespace !== PLANNING_VAULT_NAMESPACE ||
		value.schemaVersion !== PLANNING_VAULT_CHUNK_SCHEMA ||
		!manifestRecordId(value.manifestRecordId) ||
		!boundedString(value.planId, 1, 256) ||
		!positiveSafeInteger(value.planVersion) ||
		!boundedString(value.operationId, 1, 200) ||
		!nonNegativeSafeInteger(value.index) ||
		!positiveSafeInteger(value.chunkCount) ||
		value.chunkCount > MAX_CHUNK_COUNT ||
		!nonNegativeSafeInteger(value.byteOffset) ||
		!positiveSafeInteger(value.byteLength) ||
		value.byteLength > RAW_CHUNK_BYTES ||
		value.encoding !== "base64" ||
		typeof value.data !== "string"
	) {
		throw new PlanningVaultPersistenceError("invalid-chunk");
	}
	if (value.data.length !== Math.ceil(value.byteLength / 3) * 4) {
		throw new PlanningVaultPersistenceError("invalid-chunk");
	}
	return value as unknown as PlanningChunkEnvelope;
}

function assertNativeProjectionIdentifiers(plan: PlanningPlan): void {
	const identifiers: unknown[] = [
		plan.id,
		plan.activeRevisionId,
		plan.proposedRevisionId,
		plan.analysisDiagnostic?.code ?? null,
	];
	for (const task of plan.tasks) {
		identifiers.push(task.id, ...task.dependencyTaskIds);
	}
	for (const revision of plan.revisions) identifiers.push(revision.id);
	for (const evidence of plan.observationEvidence) {
		identifiers.push(evidence.id, evidence.taskId, evidence.observationId);
	}
	if (
		identifiers.some((value) => value !== null && !nativeIdentifier(value, 256))
	) {
		throw new PlanningVaultPersistenceError("invalid-reference");
	}
}

function decodeCanonicalBase64(value: string): Uint8Array {
	if (
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	) {
		throw new PlanningVaultPersistenceError("invalid-chunk");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) {
		throw new PlanningVaultPersistenceError("invalid-chunk");
	}
	return decoded;
}

async function boundRecordId(
	kind: "manifest" | "chunk",
	planId: string,
	planVersion: number,
	operationId: string,
	index: number | null = null,
): Promise<string> {
	const binding = JSON.stringify([
		PLANNING_VAULT_NAMESPACE,
		kind,
		planId,
		planVersion,
		operationId,
		index,
	]);
	return `planning-${kind}-${await sha256Hex(new TextEncoder().encode(binding))}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const owned = new Uint8Array(bytes.byteLength);
	owned.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function isExactRecord(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function boundedString(
	value: unknown,
	minimum: number,
	maximum: number,
): value is string {
	return (
		typeof value === "string" &&
		value.length >= minimum &&
		value.length <= maximum
	);
}

function nativeIdentifier(
	value: unknown,
	maximumBytes: number,
): value is string {
	return (
		typeof value === "string" &&
		new TextEncoder().encode(value).byteLength <= maximumBytes &&
		/^[A-Za-z0-9._:/-]+$/.test(value)
	);
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
	return nonNegativeSafeInteger(value) && value > 0;
}

function sha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function manifestRecordId(value: unknown): value is string {
	return (
		typeof value === "string" && /^planning-manifest-[a-f0-9]{64}$/.test(value)
	);
}

function chunkRecordId(value: unknown): value is string {
	return (
		typeof value === "string" && /^planning-chunk-[a-f0-9]{64}$/.test(value)
	);
}
