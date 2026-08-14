import type { AgentRuntime } from "../agent-runtime";
import type {
	LocalPlanningVaultReference,
	LocalPlanningVaultReferences,
	LocalPlanningVaultReferencesResult,
	LocalVaultInventoryRecord,
	LocalVaultListRecords,
	LocalVaultListRecordsResult,
} from "../local-protocol";
import {
	PLANNING_VAULT_CHUNK_SCHEMA,
	PLANNING_VAULT_MANIFEST_SCHEMA,
	PLANNING_VAULT_NAMESPACE,
	inspectPlanningVaultManifest,
	type PlanningVaultTransport,
} from "./native-vault";
import { withPlanningVaultExclusiveLease } from "./native-vault-coordinator";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_SCAN_PAGES = 100_000;
const MAX_DELETE_BATCH = 64;
const MAX_PAGE_LIMIT = 1_000;

export const MIN_PLANNING_VAULT_GC_RETENTION_MS = DAY_MS;
export const DEFAULT_PLANNING_VAULT_GC_RETENTION_MS = 7 * DAY_MS;
export const DEFAULT_PLANNING_VAULT_GC_PAGE_LIMIT = 256;

export type PlanningVaultInventoryQuery = LocalVaultListRecords;
export type PlanningVaultInventoryRecord = LocalVaultInventoryRecord;
export type PlanningVaultInventoryPage = LocalVaultListRecordsResult;
export type PlanningVaultReferenceQuery = LocalPlanningVaultReferences;
export type PlanningVaultReferenceRecord = LocalPlanningVaultReference;
export type PlanningVaultReferencePage = LocalPlanningVaultReferencesResult;

export interface PlanningVaultGarbageCollectionPort
	extends PlanningVaultTransport,
		Pick<
			AgentRuntime,
			"deleteVaultBatch" | "listVaultRecords" | "listPlanningVaultReferences"
		> {}

export interface PlanningVaultGarbageCollectorOptions {
	retentionMs?: number;
	pageLimit?: number;
	nowMs?: () => number;
	coordinationOwner?: object;
}

export type PlanningVaultGarbageCollectionResult =
	| {
			status: "completed";
			cutoffMs: number;
			scannedRecordCount: number;
			scannedReferenceCount: number;
			candidateRecordCount: number;
			deletedRecordCount: number;
			alreadyAbsentRecordCount: number;
	  }
	| {
			status: "aborted";
			reason:
				| "vault-inventory-incomplete"
				| "planning-references-incomplete"
				| "referenced-manifest-invalid";
			cutoffMs: number;
			deletedRecordCount: 0;
	  }
	| {
			status: "partial";
			reason: "delete-response-uncertain";
			cutoffMs: number;
			candidateRecordCount: number;
			deletedRecordCount: number;
			uncertainRecordCount: number;
	  };

/**
 * Collects only aged, unreachable records in the dedicated planning Vault
 * namespace. Every inventory/reference page and every referenced manifest is
 * validated before the first destructive call.
 */
export class PlanningVaultGarbageCollector {
	private readonly retentionMs: number;
	private readonly pageLimit: number;
	private readonly nowMs: () => number;
	private readonly coordinationOwner: object;

	constructor(
		private readonly port: PlanningVaultGarbageCollectionPort,
		options: PlanningVaultGarbageCollectorOptions = {},
	) {
		this.retentionMs =
			options.retentionMs ?? DEFAULT_PLANNING_VAULT_GC_RETENTION_MS;
		this.pageLimit = options.pageLimit ?? DEFAULT_PLANNING_VAULT_GC_PAGE_LIMIT;
		this.nowMs = options.nowMs ?? Date.now;
		this.coordinationOwner = options.coordinationOwner ?? port;
		if (
			!Number.isSafeInteger(this.retentionMs) ||
			this.retentionMs < MIN_PLANNING_VAULT_GC_RETENTION_MS
		) {
			throw new Error("Planning Vault GC retention is below the safe minimum.");
		}
		if (
			!Number.isSafeInteger(this.pageLimit) ||
			this.pageLimit < 1 ||
			this.pageLimit > MAX_PAGE_LIMIT
		) {
			throw new Error("Planning Vault GC page limit is invalid.");
		}
	}

	collect(): Promise<PlanningVaultGarbageCollectionResult> {
		return withPlanningVaultExclusiveLease(this.coordinationOwner, () =>
			this.collectExclusive(),
		);
	}

	private async collectExclusive(): Promise<PlanningVaultGarbageCollectionResult> {
		const nowMs = this.nowMs();
		if (!nonNegativeSafeInteger(nowMs)) {
			throw new Error("Planning Vault GC clock is invalid.");
		}
		const cutoffMs = Math.max(0, nowMs - this.retentionMs);

		let inventory: PlanningVaultInventoryRecord[];
		try {
			inventory = await this.scanVaultInventory(cutoffMs);
		} catch {
			return {
				status: "aborted",
				reason: "vault-inventory-incomplete",
				cutoffMs,
				deletedRecordCount: 0,
			};
		}

		let references: PlanningVaultReferenceRecord[];
		try {
			references = await this.scanPlanningReferences();
		} catch {
			return {
				status: "aborted",
				reason: "planning-references-incomplete",
				cutoffMs,
				deletedRecordCount: 0,
			};
		}

		const reachableRecordIds = new Set<string>();
		const reachableContentRefs = new Set<string>();
		try {
			for (const reference of references) {
				if (reference.manifestRecordId === null) {
					throw new Error("Planning Vault reference omitted its manifest identity.");
				}
				const inspected = await inspectPlanningVaultManifest(this.port, {
					planId: reference.planId,
					planVersion: reference.version,
					sealedContentRef: reference.sealedContentRef,
				});
				if (inspected.manifest.recordId !== reference.manifestRecordId) {
					throw new Error("Planning Vault manifest reference did not match.");
				}
				reachableRecordIds.add(inspected.manifest.recordId);
				reachableContentRefs.add(inspected.manifest.contentRef);
				for (const chunk of inspected.chunks) {
					reachableRecordIds.add(chunk.recordId);
					reachableContentRefs.add(chunk.contentRef);
				}
			}
		} catch {
			return {
				status: "aborted",
				reason: "referenced-manifest-invalid",
				cutoffMs,
				deletedRecordCount: 0,
			};
		}

		const candidates = inventory
			.filter(
				(record) =>
					isPlanningOwnedRecord(record) &&
					!reachableRecordIds.has(record.recordId) &&
					!reachableContentRefs.has(record.contentRef),
			)
			.sort(compareDeletionOrder);
		let deletedRecordCount = 0;
		let alreadyAbsentRecordCount = 0;
		for (let offset = 0; offset < candidates.length; offset += MAX_DELETE_BATCH) {
			const batch = candidates.slice(offset, offset + MAX_DELETE_BATCH);
			try {
				const result = await this.port.deleteVaultBatch({
					namespace: PLANNING_VAULT_NAMESPACE,
					recordIds: batch.map((record) => record.recordId),
				});
				if (!validDeleteResult(result, batch)) {
					throw new Error("Planning Vault delete response was invalid.");
				}
				for (const record of result.records) {
					if (record.deleted) deletedRecordCount += 1;
					else alreadyAbsentRecordCount += 1;
				}
			} catch {
				return {
					status: "partial",
					reason: "delete-response-uncertain",
					cutoffMs,
					candidateRecordCount: candidates.length,
					deletedRecordCount,
					uncertainRecordCount: candidates.length - offset,
				};
			}
		}

		return {
			status: "completed",
			cutoffMs,
			scannedRecordCount: inventory.length,
			scannedReferenceCount: references.length,
			candidateRecordCount: candidates.length,
			deletedRecordCount,
			alreadyAbsentRecordCount,
		};
	}

	private async scanVaultInventory(
		cutoffMs: number,
	): Promise<PlanningVaultInventoryRecord[]> {
		const records: PlanningVaultInventoryRecord[] = [];
		const recordIds = new Set<string>();
		const contentRefs = new Set<string>();
		let cursor: string | null = null;
		const cursors = new Set<string>();
		for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex += 1) {
			const page: unknown = await this.port.listVaultRecords({
				namespace: PLANNING_VAULT_NAMESPACE,
				createdBeforeMs: cutoffMs,
				cursor,
				limit: this.pageLimit,
			});
			if (!isInventoryPage(page, cutoffMs, this.pageLimit)) {
				throw new Error("Planning Vault inventory page was invalid.");
			}
			for (const record of page.records) {
				if (recordIds.has(record.recordId) || contentRefs.has(record.contentRef)) {
					throw new Error("Planning Vault inventory repeated an identity.");
				}
				recordIds.add(record.recordId);
				contentRefs.add(record.contentRef);
				records.push(record);
			}
			if (page.nextCursor === null) return records;
			if (
				page.records.length === 0 ||
				page.nextCursor === cursor ||
				cursors.has(page.nextCursor)
			) {
				throw new Error("Planning Vault inventory cursor did not advance.");
			}
			cursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		throw new Error("Planning Vault inventory exceeded its page bound.");
	}

	private async scanPlanningReferences(): Promise<PlanningVaultReferenceRecord[]> {
		const references: PlanningVaultReferenceRecord[] = [];
		const identities = new Map<string, string>();
		let cursor: string | null = null;
		const cursors = new Set<string>();
		for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex += 1) {
			const page: unknown = await this.port.listPlanningVaultReferences({
				cursor,
				limit: this.pageLimit,
			});
			if (!isReferencePage(page, this.pageLimit)) {
				throw new Error("Planning Vault reference page was invalid.");
			}
			for (const reference of page.references) {
				const identity = `${reference.planId}\u0000${reference.version}\u0000${reference.manifestRecordId ?? ""}`;
				const prior = identities.get(reference.sealedContentRef);
				if (prior !== undefined && prior !== identity) {
					throw new Error("Planning Vault reference identity was inconsistent.");
				}
				if (prior === undefined) {
					identities.set(reference.sealedContentRef, identity);
					references.push(reference);
				}
			}
			if (page.nextCursor === null) return references;
			if (
				page.references.length === 0 ||
				page.nextCursor === cursor ||
				cursors.has(page.nextCursor)
			) {
				throw new Error("Planning Vault reference cursor did not advance.");
			}
			cursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		throw new Error("Planning Vault references exceeded their page bound.");
	}
}

function isInventoryPage(
	value: unknown,
	cutoffMs: number,
	pageLimit: number,
): value is PlanningVaultInventoryPage {
	return (
		isExactRecord(value, ["records", "nextCursor"]) &&
		Array.isArray(value.records) &&
		value.records.length <= pageLimit &&
		value.records.every((record) => isInventoryRecord(record, cutoffMs)) &&
		validCursor(value.nextCursor)
	);
}

function isInventoryRecord(
	value: unknown,
	cutoffMs: number,
): value is PlanningVaultInventoryRecord {
	return (
		isExactRecord(value, [
			"recordId",
			"schemaVersion",
			"contentRef",
			"createdAtMs",
			"expiresAtMs",
		]) &&
		boundedString(value.recordId, 1, 256) &&
		boundedString(value.schemaVersion, 1, 160) &&
		boundedString(value.contentRef, 1, 512) &&
		nonNegativeSafeInteger(value.createdAtMs) &&
		value.createdAtMs < cutoffMs &&
		(value.expiresAtMs === null ||
			(nonNegativeSafeInteger(value.expiresAtMs) &&
				value.expiresAtMs >= value.createdAtMs))
	);
}

function isReferencePage(
	value: unknown,
	pageLimit: number,
): value is PlanningVaultReferencePage {
	return (
		isExactRecord(value, ["references", "nextCursor"]) &&
		Array.isArray(value.references) &&
		value.references.length <= pageLimit &&
		value.references.every(isReferenceRecord) &&
		validCursor(value.nextCursor)
	);
}

function isReferenceRecord(value: unknown): value is PlanningVaultReferenceRecord {
	return (
		isExactRecord(value, [
			"source",
			"planId",
			"version",
			"sealedContentRef",
			"manifestRecordId",
		]) &&
		(value.source === "current" ||
			value.source === "history" ||
			value.source === "operation") &&
		boundedString(value.planId, 1, 256) &&
		positiveSafeInteger(value.version) &&
		boundedString(value.sealedContentRef, 1, 512) &&
		(value.manifestRecordId === null ||
			boundedString(value.manifestRecordId, 1, 256))
	);
}

function isPlanningOwnedRecord(record: PlanningVaultInventoryRecord): boolean {
	return (
		(record.schemaVersion === PLANNING_VAULT_MANIFEST_SCHEMA &&
			/^planning-manifest-[a-f0-9]{64}$/.test(record.recordId)) ||
		(record.schemaVersion === PLANNING_VAULT_CHUNK_SCHEMA &&
			/^planning-chunk-[a-f0-9]{64}$/.test(record.recordId))
	);
}

function compareDeletionOrder(
	left: PlanningVaultInventoryRecord,
	right: PlanningVaultInventoryRecord,
): number {
	const leftManifest = left.schemaVersion === PLANNING_VAULT_MANIFEST_SCHEMA;
	const rightManifest = right.schemaVersion === PLANNING_VAULT_MANIFEST_SCHEMA;
	if (leftManifest !== rightManifest) return leftManifest ? 1 : -1;
	return left.recordId.localeCompare(right.recordId);
}

function validDeleteResult(
	value: unknown,
	requested: readonly PlanningVaultInventoryRecord[],
): value is Awaited<ReturnType<AgentRuntime["deleteVaultBatch"]>> {
	if (!isExactRecord(value, ["records"]) || !Array.isArray(value.records)) {
		return false;
	}
	if (value.records.length !== requested.length) return false;
	return value.records.every((record, index) => {
		const expected = requested[index];
		return (
			expected !== undefined &&
			isExactRecord(record, ["recordId", "deleted"]) &&
			record.recordId === expected.recordId &&
			typeof record.deleted === "boolean"
		);
	});
}

function validCursor(value: unknown): value is string | null {
	return value === null || boundedString(value, 1, 512);
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

function nonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}
