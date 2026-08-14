import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import type {
	LocalPlanningVaultReference,
	LocalVaultOpenResultRecord,
} from "../src/agent/local-protocol";
import {
	NativePlanningRepository,
	PlanningVaultGarbageCollector,
	sealPlanningPlan,
	type PlanningPlan,
} from "../src/agent/planning";
import { withPlanningVaultExclusiveLease } from "../src/agent/planning/native-vault-coordinator";

interface StoredVaultRecord extends LocalVaultOpenResultRecord {
	contentJson: string;
}

class FakePlanningVaultMaintenancePort {
	readonly records = new Map<string, StoredVaultRecord>();
	readonly deletedRecordIds: string[] = [];
	references: LocalPlanningVaultReference[] = [];
	recordCreatedAtMs = 100;
	failInventory = false;
	failReferences = false;
	listRecordCalls = 0;
	listReferenceCalls = 0;

	async sealVaultBatch(
		batch: Parameters<AgentRuntime["sealVaultBatch"]>[0],
	): ReturnType<AgentRuntime["sealVaultBatch"]> {
		return {
			records: batch.records.map((request) => {
				const contentRef = `vault.${request.recordId}`;
				const contentJson = JSON.stringify(request.content);
				const record: StoredVaultRecord = {
					recordId: request.recordId,
					schemaVersion: request.schemaVersion,
					contentRef,
					contentHash: `hash.${request.recordId}`,
					content: structuredClone(request.content),
					contentJson,
					createdAtMs: this.recordCreatedAtMs,
					expiresAtMs: null,
				};
				const prior = this.records.get(request.recordId);
				if (prior && prior.contentJson !== contentJson) {
					throw new Error("conflicting fake Vault record");
				}
				this.records.set(request.recordId, prior ?? record);
				return {
					recordId: request.recordId,
					contentRef,
					contentHash: record.contentHash,
					keyVersion: "test-key",
					inserted: prior === undefined,
				};
			}),
		};
	}

	async openVaultBatch(
		batch: Parameters<AgentRuntime["openVaultBatch"]>[0],
	): ReturnType<AgentRuntime["openVaultBatch"]> {
		return {
			records: batch.contentRefs.map((contentRef) => {
				const record = [...this.records.values()].find(
					(item) => item.contentRef === contentRef,
				);
				if (!record) throw new Error("missing fake Vault content reference");
				return structuredClone(record);
			}),
		};
	}

	async listVaultRecords(
		query: Parameters<AgentRuntime["listVaultRecords"]>[0],
	): ReturnType<AgentRuntime["listVaultRecords"]> {
		this.listRecordCalls += 1;
		if (this.failInventory) throw new Error("inventory unavailable");
		const offset = query.cursor ? Number(query.cursor) : 0;
		const eligible = [...this.records.values()]
			.filter((record) => record.createdAtMs < query.createdBeforeMs)
			.sort((left, right) => left.recordId.localeCompare(right.recordId));
		const page = eligible.slice(offset, offset + (query.limit ?? 100));
		const nextOffset = offset + page.length;
		return {
			records: page.map(
				({ recordId, schemaVersion, contentRef, createdAtMs, expiresAtMs }) => ({
					recordId,
					schemaVersion,
					contentRef,
					createdAtMs,
					expiresAtMs,
				}),
			),
			nextCursor: nextOffset < eligible.length ? String(nextOffset) : null,
		};
	}

	async listPlanningVaultReferences(
		query: Parameters<AgentRuntime["listPlanningVaultReferences"]>[0] = {},
	): ReturnType<AgentRuntime["listPlanningVaultReferences"]> {
		this.listReferenceCalls += 1;
		if (this.failReferences) throw new Error("references unavailable");
		const offset = query.cursor ? Number(query.cursor) : 0;
		const page = this.references.slice(offset, offset + (query.limit ?? 100));
		const nextOffset = offset + page.length;
		return {
			references: structuredClone(page),
			nextCursor:
				nextOffset < this.references.length ? String(nextOffset) : null,
		};
	}

	async deleteVaultBatch(
		batch: Parameters<AgentRuntime["deleteVaultBatch"]>[0],
	): ReturnType<AgentRuntime["deleteVaultBatch"]> {
		return {
			records: batch.recordIds.map((recordId) => {
				const deleted = this.records.delete(recordId);
				this.deletedRecordIds.push(recordId);
				return { recordId, deleted };
			}),
		};
	}

	seedUnknownRecord(recordId: string): void {
		this.records.set(recordId, {
			recordId,
			schemaVersion: "planning.runtime.future.v2",
			contentRef: `vault.${recordId}`,
			contentHash: `hash.${recordId}`,
			content: { future: true },
			contentJson: '{"future":true}',
			createdAtMs: this.recordCreatedAtMs,
			expiresAtMs: null,
		});
	}

	mutateContent(contentRef: string, mutate: (value: unknown) => unknown): void {
		const record = [...this.records.values()].find(
			(item) => item.contentRef === contentRef,
		);
		if (!record) throw new Error("missing content to mutate");
		const content = mutate(structuredClone(record.content));
		record.content = content;
		record.contentJson = JSON.stringify(content);
	}
}

function draftPlan(planId: string, version: number): PlanningPlan {
	return {
		id: planId,
		goal: `敏感目标 ${planId}`,
		requestedStartToday: false,
		timeZone: "Asia/Shanghai",
		effectiveStartDate: null,
		type: null,
		status: "draft",
		analysisState: "awaiting-analysis",
		analysisDiagnostic: null,
		pendingAnalysis: null,
		autoAdjustAuthorized: false,
		version,
		createdAt: "2026-08-01T00:00:00Z",
		updatedAt: "2026-08-01T00:00:00Z",
		activeRevisionId: null,
		proposedRevisionId: null,
		revisions: [],
		estimates: [],
		tasks: [],
		messages: [],
		observationEvidence: [],
		pendingObservationAttributions: [],
		adjustments: [],
		dailySummaryDates: [],
	};
}

async function sealReference(
	port: FakePlanningVaultMaintenancePort,
	planId: string,
	version: number,
	operationId: string,
	source: LocalPlanningVaultReference["source"],
): Promise<LocalPlanningVaultReference> {
	const sealed = await sealPlanningPlan(
		port,
		draftPlan(planId, version),
		operationId,
	);
	return {
		source,
		planId,
		version,
		sealedContentRef: sealed.contentRef,
		manifestRecordId: sealed.reference.manifestRecordId,
	};
}

const NOW_MS = 10 * 24 * 60 * 60 * 1_000;

describe("Planning Vault fail-closed garbage collection", () => {
	test("keeps current, history, and operation references while deleting only aged orphans", async () => {
		const port = new FakePlanningVaultMaintenancePort();
		const current = await sealReference(port, "plan-live", 3, "live-current", "current");
		const history = await sealReference(port, "plan-live", 2, "live-history", "history");
		const operation = await sealReference(
			port,
			"plan-live",
			1,
			"live-operation",
			"operation",
		);
		const beforeOrphan = new Set(port.records.keys());
		await sealReference(port, "plan-orphan", 1, "orphan-write", "current");
		const orphanRecordIds = new Set(
			[...port.records.keys()].filter((recordId) => !beforeOrphan.has(recordId)),
		);
		port.references = [current, history, operation, structuredClone(current)];
		port.seedUnknownRecord("planning-manifest-" + "a".repeat(64));

		const result = await new PlanningVaultGarbageCollector(port, {
			retentionMs: 24 * 60 * 60 * 1_000,
			pageLimit: 1,
			nowMs: () => NOW_MS,
		}).collect();

		expect(result.status).toBe("completed");
		expect(port.listRecordCalls).toBeGreaterThan(1);
		expect(port.listReferenceCalls).toBeGreaterThan(1);
		expect(port.deletedRecordIds).toHaveLength(2);
		expect(new Set(port.deletedRecordIds)).toEqual(orphanRecordIds);
		expect(
			port.records.has("planning-manifest-" + "a".repeat(64)),
		).toBeTrue();
	});

	test("retains a recent unreferenced seal", async () => {
		const port = new FakePlanningVaultMaintenancePort();
		port.recordCreatedAtMs = NOW_MS - 12 * 60 * 60 * 1_000;
		await sealReference(port, "plan-recent", 1, "recent-write", "current");
		const result = await new PlanningVaultGarbageCollector(port, {
			retentionMs: 24 * 60 * 60 * 1_000,
			nowMs: () => NOW_MS,
		}).collect();
		expect(result).toMatchObject({
			status: "completed",
			candidateRecordCount: 0,
			deletedRecordCount: 0,
		});
		expect(port.records.size).toBe(2);
	});

	for (const failure of ["inventory", "references"] as const) {
		test(`deletes nothing when the ${failure} scan is incomplete`, async () => {
			const port = new FakePlanningVaultMaintenancePort();
			await sealReference(port, "plan-orphan", 1, `failed-${failure}`, "current");
			if (failure === "inventory") port.failInventory = true;
			else port.failReferences = true;
			const result = await new PlanningVaultGarbageCollector(port, {
				retentionMs: 24 * 60 * 60 * 1_000,
				nowMs: () => NOW_MS,
			}).collect();
			expect(result.status).toBe("aborted");
			expect(port.deletedRecordIds).toEqual([]);
			expect(port.records.size).toBe(2);
		});
	}

	test("deletes nothing when a referenced manifest cannot be authenticated", async () => {
		const port = new FakePlanningVaultMaintenancePort();
		const reference = await sealReference(
			port,
			"plan-live",
			1,
			"corrupt-live",
			"current",
		);
		port.references = [reference];
		port.mutateContent(reference.sealedContentRef, (content) => ({
			...(content as Record<string, unknown>),
			planId: "wrong-plan",
		}));
		const result = await new PlanningVaultGarbageCollector(port, {
			retentionMs: 24 * 60 * 60 * 1_000,
			nowMs: () => NOW_MS,
		}).collect();
		expect(result).toMatchObject({
			status: "aborted",
			reason: "referenced-manifest-invalid",
			deletedRecordCount: 0,
		});
		expect(port.deletedRecordIds).toEqual([]);
	});

	test("the production repository maintenance entry shares the optimistic-write lease", async () => {
		const port = new FakePlanningVaultMaintenancePort();
		await sealReference(port, "plan-orphan", 1, "lease-orphan", "current");
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writer = withPlanningVaultExclusiveLease(port, async () => blocked);
		await Promise.resolve();
		const repository = new NativePlanningRepository(
			port as unknown as AgentRuntime,
		);
		const collection = repository.collectVaultGarbage({
			retentionMs: 24 * 60 * 60 * 1_000,
			nowMs: () => NOW_MS,
		});
		await Promise.resolve();
		expect(port.listRecordCalls).toBe(0);
		release();
		await writer;
		await expect(collection).resolves.toMatchObject({ status: "completed" });
		expect(port.listRecordCalls).toBeGreaterThan(0);
	});
});
