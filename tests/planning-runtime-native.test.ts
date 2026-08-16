import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import type {
	LocalPlanningCalendarEvent,
	LocalPlanningMutationResult,
	LocalPlanningOutboxEntry,
	LocalPlanningPlanSnapshot,
	LocalVaultOpenResultRecord,
} from "../src/agent/local-protocol";
import {
	type CalendarChangeSet,
	isPlanningPlan,
	NativePlanningCalendar,
	NativePlanningRepository,
	type PlanningPlan,
	PlanVersionConflictError,
} from "../src/agent/planning";
import { PlanningVaultPersistenceError } from "../src/agent/planning/native-vault";

interface FakeVaultRecord extends LocalVaultOpenResultRecord {
	contentJson: string;
}

class FakeNativePlanningAgent {
	readonly sealBatches: Array<Parameters<AgentRuntime["sealVaultBatch"]>[0]> =
		[];
	readonly openBatches: Array<Parameters<AgentRuntime["openVaultBatch"]>[0]> =
		[];
	readonly calendarMutations: Array<
		Parameters<AgentRuntime["mutatePlanningCalendar"]>[0]
	> = [];
	private readonly plans = new Map<string, LocalPlanningPlanSnapshot>();
	private readonly operations = new Map<string, LocalPlanningPlanSnapshot>();
	private readonly vaultByRef = new Map<string, FakeVaultRecord>();
	private readonly vaultByRecordId = new Map<string, FakeVaultRecord>();
	private openRecordMutation:
		| ((record: LocalVaultOpenResultRecord) => LocalVaultOpenResultRecord)
		| null = null;

	seedPlan(snapshot: LocalPlanningPlanSnapshot): void {
		this.plans.set(snapshot.planId, structuredClone(snapshot));
	}

	storedPlan(planId: string): LocalPlanningPlanSnapshot {
		const snapshot = this.plans.get(planId);
		if (!snapshot) throw new Error("Fake native plan is missing.");
		return structuredClone(snapshot);
	}

	replaceStoredPlan(snapshot: LocalPlanningPlanSnapshot): void {
		this.plans.set(snapshot.planId, structuredClone(snapshot));
	}

	mutateVaultContent(
		contentRef: string,
		mutation: (content: unknown) => unknown,
	): void {
		const record = this.vaultByRef.get(contentRef);
		if (!record) throw new Error("Fake vault record is missing.");
		const content = mutation(structuredClone(record.content));
		const next = {
			...record,
			content,
			contentJson: JSON.stringify(content),
		};
		this.vaultByRef.set(contentRef, next);
		this.vaultByRecordId.set(record.recordId, next);
	}

	mutateNextOpen(
		mutation: (
			record: LocalVaultOpenResultRecord,
		) => LocalVaultOpenResultRecord,
	): void {
		this.openRecordMutation = mutation;
	}

	async sealVaultBatch(
		batch: Parameters<AgentRuntime["sealVaultBatch"]>[0],
	): ReturnType<AgentRuntime["sealVaultBatch"]> {
		this.sealBatches.push(structuredClone(batch));
		let batchBytes = 0;
		const records = batch.records.map((request) => {
			const contentJson = JSON.stringify(request.content);
			const contentBytes = Buffer.byteLength(contentJson, "utf8");
			if (contentBytes > 512 * 1024) {
				throw new Error("fake vault record limit exceeded");
			}
			batchBytes += contentBytes;
			const existing = this.vaultByRecordId.get(request.recordId);
			if (existing) {
				if (
					existing.schemaVersion !== request.schemaVersion ||
					existing.contentJson !== contentJson
				) {
					throw new Error("fake vault record conflict");
				}
				return {
					recordId: existing.recordId,
					contentRef: existing.contentRef,
					contentHash: existing.contentHash,
					keyVersion: "test-key-v1",
					inserted: false,
				};
			}
			const contentRef = `vault.${request.recordId}`;
			const record: FakeVaultRecord = {
				recordId: request.recordId,
				schemaVersion: request.schemaVersion,
				contentRef,
				contentHash: `hash.${request.recordId}`,
				content: structuredClone(request.content),
				contentJson,
				createdAtMs: 1_786_579_200_000,
				expiresAtMs: null,
			};
			this.vaultByRef.set(contentRef, record);
			this.vaultByRecordId.set(request.recordId, record);
			return {
				recordId: request.recordId,
				contentRef,
				contentHash: record.contentHash,
				keyVersion: "test-key-v1",
				inserted: true,
			};
		});
		if (batchBytes > 768 * 1024) {
			throw new Error("fake vault batch limit exceeded");
		}
		return { records };
	}

	async openVaultBatch(
		batch: Parameters<AgentRuntime["openVaultBatch"]>[0],
	): ReturnType<AgentRuntime["openVaultBatch"]> {
		this.openBatches.push(structuredClone(batch));
		const mutation = this.openRecordMutation;
		this.openRecordMutation = null;
		return {
			records: batch.contentRefs.map((contentRef) => {
				const record = this.vaultByRef.get(contentRef);
				if (!record) throw new Error("fake vault content reference is missing");
				const opened: LocalVaultOpenResultRecord = {
					recordId: record.recordId,
					schemaVersion: record.schemaVersion,
					contentRef: record.contentRef,
					contentHash: record.contentHash,
					content: structuredClone(record.content),
					createdAtMs: record.createdAtMs,
					expiresAtMs: record.expiresAtMs,
				};
				return mutation ? mutation(opened) : opened;
			}),
		};
	}

	async listPlanningPlans(
		_query: Parameters<AgentRuntime["listPlanningPlans"]>[0],
	): ReturnType<AgentRuntime["listPlanningPlans"]> {
		return {
			plans: [...this.plans.values()].map((plan) => structuredClone(plan)),
		};
	}

	async getPlanningPlan(
		planId: string,
	): ReturnType<AgentRuntime["getPlanningPlan"]> {
		return structuredClone(this.plans.get(planId) ?? null);
	}

	async getPlanningOperationResult(
		operationId: string,
	): ReturnType<AgentRuntime["getPlanningOperationResult"]> {
		return structuredClone(this.operations.get(operationId) ?? null);
	}

	async upsertPlanningPlan(
		mutation: Parameters<AgentRuntime["upsertPlanningPlan"]>[0],
	): ReturnType<AgentRuntime["upsertPlanningPlan"]> {
		const replay = this.operations.get(mutation.operationId);
		if (replay) return planningMutationResult(replay);
		const snapshot = structuredClone(mutation.plan);
		this.plans.set(snapshot.planId, snapshot);
		this.operations.set(mutation.operationId, snapshot);
		return planningMutationResult(snapshot);
	}

	async mutatePlanningPlan(
		mutation: Parameters<AgentRuntime["mutatePlanningPlan"]>[0],
	): ReturnType<AgentRuntime["mutatePlanningPlan"]> {
		const replay = this.operations.get(mutation.operationId);
		if (replay) return planningMutationResult(replay);
		const current = this.plans.get(mutation.plan.planId);
		if (!current || current.version !== mutation.expectedVersion) {
			throw Object.assign(new Error("stale fake plan"), {
				code: "BUSY",
				details: {
					reason: "stale-version",
					actualVersion: current?.version ?? null,
				},
			});
		}
		const snapshot = structuredClone(mutation.plan);
		this.plans.set(snapshot.planId, snapshot);
		this.operations.set(mutation.operationId, snapshot);
		return planningMutationResult(snapshot);
	}

	async listAllPlanningCalendar(): ReturnType<
		AgentRuntime["listAllPlanningCalendar"]
	> {
		return [];
	}

	async mutatePlanningCalendar(
		mutation: Parameters<AgentRuntime["mutatePlanningCalendar"]>[0],
	): ReturnType<AgentRuntime["mutatePlanningCalendar"]> {
		this.calendarMutations.push(structuredClone(mutation));
		return {
			outcomes: mutation.mutations.map((item) =>
				item.action === "delete"
					? { eventId: item.eventId, event: null }
					: {
							eventId: item.event.eventId,
							event: structuredClone(item.event),
						},
			),
			outbox: [],
		};
	}
}

function planningMutationResult(
	plan: LocalPlanningPlanSnapshot,
): LocalPlanningMutationResult {
	return {
		plan: structuredClone(plan),
		calendarEvents: [] satisfies LocalPlanningCalendarEvent[],
		outbox: [] satisfies LocalPlanningOutboxEntry[],
	};
}

function activePlan(): PlanningPlan {
	const plan: PlanningPlan = {
		id: "plan-secure-1",
		goal: "机密目标：完成本地规划密封",
		requestedStartToday: false,
		timeZone: "Asia/Shanghai",
		effectiveStartDate: "2026-08-14",
		type: "short-term",
		status: "active",
		analysisState: "ready",
		analysisDiagnostic: null,
		pendingAnalysis: null,
		autoAdjustAuthorized: true,
		version: 3,
		createdAt: "2026-08-13T02:00:00Z",
		updatedAt: "2026-08-13T02:05:00Z",
		activeRevisionId: "revision-secure-1",
		proposedRevisionId: null,
		revisions: [
			{
				id: "revision-secure-1",
				planId: "plan-secure-1",
				number: 1,
				parentRevisionId: null,
				trigger: "confirmation",
				goal: "机密目标：完成本地规划密封",
				type: "short-term",
				rationaleSummary: "机密理由：正文不能进入 planning.sqlite",
				assumptions: ["机密假设"],
				estimateId: "estimate-secure-1",
				schedulingPreferences: {
					weeklyCapacityMinutes: 60,
					sessionMinutes: 60,
					availableWindows: [
						{ dayOfWeek: 5, startTime: "09:00", endTime: "10:00" },
					],
				},
				tasks: [
					{
						taskId: "task-secure-1",
						sourceKey: "secret-task-key",
						purpose: "execution",
						title: "机密任务标题",
						description: "机密任务正文",
						estimatedMinutes: 60,
						dependencyTaskIds: [],
					},
				],
				scheduleWindow: {
					startDate: "2026-08-14",
					endDateExclusive: "2026-08-21",
				},
				schedule: [
					{
						id: "schedule-secure-1",
						planId: "plan-secure-1",
						taskId: "task-secure-1",
						title: "机密日历标题",
						start: "2026-08-14T01:00:00Z",
						end: "2026-08-14T02:00:00Z",
						timeZone: "Asia/Shanghai",
					},
				],
				unscheduledTaskIds: [],
				createdAt: "2026-08-13T02:04:00Z",
			},
		],
		estimates: [
			{
				id: "estimate-secure-1",
				estimatedCompletionDate: "2026-08-14",
				confidence: 0.85,
				assessedAt: "2026-08-13T02:04:00Z",
				evidenceThrough: "2026-08-13",
				basis: "机密估时依据：容量与日历冲突",
				modelVersion: "deterministic-short-term.v1",
			},
		],
		tasks: [
			{
				id: "task-secure-1",
				planId: "plan-secure-1",
				sourceKey: "secret-task-key",
				purpose: "execution",
				title: "机密任务标题",
				description: "机密任务正文",
				estimatedMinutes: 60,
				dependencyTaskIds: [],
				status: "pending",
				statusChangedAt: null,
				statusChangedBy: null,
			},
		],
		messages: [
			{
				id: "message-secure-1",
				planId: "plan-secure-1",
				role: "user",
				content: "机密对话正文：每天可以投入一小时",
				createdAt: "2026-08-13T02:00:00Z",
				causedByOperationId: "create-secure-1",
			},
		],
		observationEvidence: [],
		pendingObservationAttributions: [],
		adjustments: [],
		dailySummaryDates: [],
	};
	if (!isPlanningPlan(plan)) throw new Error("Secure plan fixture is invalid.");
	return plan;
}

function largePlan(targetBytes: number): PlanningPlan {
	const plan = activePlan();
	const messages = [...plan.messages];
	const makeMessage = (index: number) => ({
		id: `large-message-${index}`,
		planId: plan.id,
		role: "user" as const,
		content: `敏感大正文-${index}-${"x".repeat(3_800)}`,
		createdAt: "2026-08-13T02:00:00Z",
		causedByOperationId: "large-snapshot",
	});
	const sampleBytes =
		Buffer.byteLength(JSON.stringify(makeMessage(0)), "utf8") + 1;
	const baseBytes = Buffer.byteLength(JSON.stringify(plan), "utf8");
	const initialCount = Math.max(
		0,
		Math.floor((targetBytes - baseBytes) / sampleBytes) - 2,
	);
	for (let index = 0; index < initialCount; index += 1) {
		messages.push(makeMessage(index));
	}
	for (let index = initialCount; ; index += 1) {
		const next = makeMessage(index);
		const candidate = { ...plan, messages: [...messages, next] };
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > targetBytes)
			break;
		messages.push(next);
	}
	const result = { ...plan, messages };
	if (!isPlanningPlan(result))
		throw new Error("Large plan fixture is invalid.");
	return result;
}

function plaintext(snapshot: LocalPlanningPlanSnapshot): string {
	return JSON.stringify(snapshot);
}

describe("NativePlanningRepository encrypted persistence", () => {
	test("writes only safe indexes and restores the full plan through the vault", async () => {
		const agent = new FakeNativePlanningAgent();
		const repository = new NativePlanningRepository(agent);
		const plan = activePlan();

		const written = await repository.createPlan(plan, "native-create-secure");
		expect(written.plan).toEqual(plan);
		const snapshot = agent.storedPlan(plan.id);
		const raw = plaintext(snapshot);
		expect(snapshot.goal).toBeNull();
		expect(snapshot.sealedContentRef).toBeString();
		expect(snapshot.runtimePayload).toMatchObject({
			schemaVersion: "planning.runtime.reference.v1",
			namespace: "planning.runtime.v1",
			manifestSchemaVersion: "planning.runtime.manifest.v1",
			manifestRecordId: expect.stringMatching(/^planning-manifest-/),
		});
		for (const secret of [
			plan.goal,
			plan.messages[0]?.content,
			plan.tasks[0]?.title,
			plan.tasks[0]?.description,
			plan.estimates[0]?.basis,
			plan.revisions[0]?.rationaleSummary,
		]) {
			expect(raw).not.toContain(secret ?? "missing-secret");
		}
		expect(snapshot.conversation).toEqual([]);
		expect(snapshot.estimateSnapshots).toEqual([]);
		expect(snapshot.tasks).toEqual([
			expect.objectContaining({ title: "sealed", description: "" }),
		]);
		expect(snapshot.currentEstimate).toMatchObject({
			basis: "sealed",
			modelVersion: "sealed",
		});
		expect(
			agent.sealBatches.every(
				(batch) => batch.namespace === "planning.runtime.v1",
			),
		).toBeTrue();
		expect(
			agent.openBatches.every(
				(batch) => batch.namespace === "planning.runtime.v1",
			),
		).toBeTrue();
		expect(await repository.getPlan(plan.id)).toEqual(plan);
	});

	test("supports a near-8 MiB plan with encrypted manifest and bounded chunks", async () => {
		const agent = new FakeNativePlanningAgent();
		const repository = new NativePlanningRepository(agent);
		const plan = largePlan(8 * 1024 * 1024 - 16 * 1024);
		const bytes = Buffer.byteLength(JSON.stringify(plan), "utf8");
		expect(bytes).toBeGreaterThan(7.9 * 1024 * 1024);
		expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);

		await expect(
			repository.createPlan(plan, "native-create-large"),
		).resolves.toMatchObject({
			plan,
		});
		const chunkBatches = agent.sealBatches.filter(
			(batch) =>
				batch.records[0]?.schemaVersion === "planning.runtime.chunk.v1",
		);
		expect(chunkBatches).toHaveLength(Math.ceil(bytes / (360 * 1024)));
		expect(
			agent.sealBatches.every((batch) => batch.records.length === 1),
		).toBeTrue();
		for (const batch of agent.sealBatches) {
			const size = Buffer.byteLength(
				JSON.stringify(batch.records[0]?.content),
				"utf8",
			);
			expect(size).toBeLessThanOrEqual(512 * 1024);
			expect(size).toBeLessThanOrEqual(768 * 1024);
		}
		expect(await repository.getPlan(plan.id)).toEqual(plan);
	}, 60_000);

	test("rejects payloads above 8 MiB before writing SQLite", async () => {
		const agent = new FakeNativePlanningAgent();
		const repository = new NativePlanningRepository(agent);
		const plan = largePlan(8 * 1024 * 1024 + 128 * 1024);
		expect(Buffer.byteLength(JSON.stringify(plan), "utf8")).toBeGreaterThan(
			8 * 1024 * 1024,
		);
		await expect(
			repository.createPlan(plan, "native-create-oversize"),
		).rejects.toMatchObject({
			name: "PlanningVaultPersistenceError",
			code: "payload-too-large",
		});
		expect(agent.sealBatches).toEqual([]);
	}, 60_000);

	test("rejects identifiers that native SQLite cannot index before sealing", async () => {
		const agent = new FakeNativePlanningAgent();
		const repository = new NativePlanningRepository(agent);
		await expect(
			repository.createPlan(activePlan(), "operation with spaces"),
		).rejects.toMatchObject({
			name: "PlanningVaultPersistenceError",
			code: "invalid-reference",
		});
		expect(agent.sealBatches).toEqual([]);
	});

	test("strictly rejects reference, schema, identity, manifest, and ref mismatches", async () => {
		const cases: Array<{
			name: string;
			mutate(
				agent: FakeNativePlanningAgent,
				snapshot: LocalPlanningPlanSnapshot,
			): void;
		}> = [
			{
				name: "namespace",
				mutate(agent, snapshot) {
					agent.replaceStoredPlan({
						...snapshot,
						runtimePayload: {
							...(snapshot.runtimePayload as Record<string, unknown>),
							namespace: "planning.runtime.other",
						},
					});
				},
			},
			{
				name: "schema",
				mutate(agent, snapshot) {
					agent.replaceStoredPlan({
						...snapshot,
						runtimePayload: {
							...(snapshot.runtimePayload as Record<string, unknown>),
							schemaVersion: "planning.runtime.reference.v0",
						},
					});
				},
			},
			{
				name: "plan identity",
				mutate(agent, snapshot) {
					agent.mutateVaultContent(
						String(snapshot.sealedContentRef),
						(content) => ({
							...(content as Record<string, unknown>),
							planId: "plan-wrong",
						}),
					);
				},
			},
			{
				name: "version identity",
				mutate(agent, snapshot) {
					agent.mutateVaultContent(
						String(snapshot.sealedContentRef),
						(content) => ({
							...(content as Record<string, unknown>),
							planVersion: 999,
						}),
					);
				},
			},
			{
				name: "manifest shape",
				mutate(agent, snapshot) {
					agent.mutateVaultContent(
						String(snapshot.sealedContentRef),
						(content) => ({
							...(content as Record<string, unknown>),
							chunks: [],
						}),
					);
				},
			},
			{
				name: "content reference",
				mutate(agent) {
					agent.mutateNextOpen((record) => ({
						...record,
						contentRef: `wrong.${record.contentRef}`,
					}));
				},
			},
		];

		for (const testCase of cases) {
			const agent = new FakeNativePlanningAgent();
			const repository = new NativePlanningRepository(agent);
			const plan = activePlan();
			await repository.createPlan(
				plan,
				`strict-${testCase.name.replaceAll(" ", "-")}`,
			);
			const snapshot = agent.storedPlan(plan.id);
			testCase.mutate(agent, snapshot);
			await expect(repository.getPlan(plan.id)).rejects.toBeInstanceOf(
				PlanningVaultPersistenceError,
			);
		}
	});

	test("reads a legacy plaintext payload only for migration and seals the next write", async () => {
		const agent = new FakeNativePlanningAgent();
		const repository = new NativePlanningRepository(agent);
		const legacy = activePlan();
		agent.seedPlan({
			schemaVersion: "planning.v1",
			planId: legacy.id,
			version: legacy.version,
			goal: legacy.goal,
			runtimePayload: structuredClone(legacy),
		});
		expect(await repository.getPlan(legacy.id)).toEqual(legacy);
		expect(agent.openBatches).toEqual([]);

		const migrated = {
			...legacy,
			version: legacy.version + 1,
			updatedAt: "2026-08-13T02:06:00Z",
		};
		await repository.savePlan(migrated, {
			operationId: "migrate-legacy-plan",
			expectedVersion: legacy.version,
		});
		const snapshot = agent.storedPlan(legacy.id);
		expect(snapshot.sealedContentRef).toBeString();
		expect(plaintext(snapshot)).not.toContain(legacy.goal);
		expect(await repository.getPlan(legacy.id)).toEqual(migrated);
	});

	test("preserves the native actual version in optimistic conflicts", async () => {
		const agent = new FakeNativePlanningAgent();
		const repository = new NativePlanningRepository(agent);
		const plan = activePlan();
		await repository.createPlan(plan, "native-create-before-stale");
		const changed = {
			...plan,
			version: plan.version + 1,
			updatedAt: "2026-08-13T02:06:00Z",
		};
		try {
			await repository.savePlan(changed, {
				operationId: "native-stale-save",
				expectedVersion: plan.version - 1,
			});
			throw new Error("Expected a native planning version conflict.");
		} catch (error) {
			expect(error).toBeInstanceOf(PlanVersionConflictError);
			expect(error).toMatchObject({
				expectedVersion: plan.version - 1,
				actualVersion: plan.version,
			});
		}
	});

	test("never downgrades a broken sealed snapshot to its plaintext runtime payload", async () => {
		const agent = new FakeNativePlanningAgent();
		const repository = new NativePlanningRepository(agent);
		const plan = activePlan();
		agent.seedPlan({
			schemaVersion: "planning.v1",
			planId: plan.id,
			version: plan.version,
			sealedContentRef: "missing.sealed.reference",
			runtimePayload: structuredClone(plan),
		});
		await expect(repository.getPlan(plan.id)).rejects.toBeInstanceOf(
			PlanningVaultPersistenceError,
		);
	});

	test("binds vault record IDs to operation and rejects same-operation content reuse", async () => {
		const firstAgent = new FakeNativePlanningAgent();
		const secondAgent = new FakeNativePlanningAgent();
		const plan = activePlan();
		await new NativePlanningRepository(firstAgent).createPlan(
			plan,
			"operation-a",
		);
		await new NativePlanningRepository(secondAgent).createPlan(
			plan,
			"operation-b",
		);
		const firstReference = firstAgent.storedPlan(plan.id)
			.runtimePayload as Record<string, unknown>;
		const secondReference = secondAgent.storedPlan(plan.id)
			.runtimePayload as Record<string, unknown>;
		expect(firstReference.manifestRecordId).not.toBe(
			secondReference.manifestRecordId,
		);

		const changed = { ...plan, goal: "同版本但不同的机密目标" };
		await expect(
			new NativePlanningRepository(firstAgent).createPlan(
				changed,
				"operation-a",
			),
		).rejects.toThrow("fake vault record conflict");
	});

	test("redacts model calendar titles before native persistence", async () => {
		const agent = new FakeNativePlanningAgent();
		const calendar = new NativePlanningCalendar(agent);
		const changeSet: CalendarChangeSet = {
			id: "calendar-change-secure",
			planId: "plan-secure-1",
			operationId: "calendar-operation-secure",
			createdAt: "2026-08-13T02:05:00Z",
			changes: [
				{
					kind: "create",
					eventId: "calendar-event-secure",
					expectedVersion: null,
					before: null,
					after: {
						id: "calendar-event-secure",
						title: "机密任务标题绝不能进入 calendar_events",
						kind: "plan",
						state: "committed",
						start: "2026-08-14T01:00:00Z",
						end: "2026-08-14T02:00:00Z",
						timeZone: "Asia/Shanghai",
						planId: "plan-secure-1",
						sourceTaskId: "task-secure-1",
						scheduleOrigin: "model",
						userLocked: false,
						version: 1,
					},
				},
			],
		};

		const result = await calendar.applyChangeSet(changeSet);
		expect(result.ok).toBeTrue();
		expect(agent.calendarMutations[0]?.actor).toBe("planning-runtime");
		const mutation = agent.calendarMutations[0]?.mutations[0];
		expect(mutation?.action).toBe("upsert");
		if (mutation?.action !== "upsert") {
			throw new Error("Expected an upsert calendar mutation.");
		}
		expect(mutation.event).toMatchObject({
			title: "计划任务",
			sealedContentRef: null,
			redactedContent: true,
		});
		expect(JSON.stringify(mutation)).not.toContain(
			"机密任务标题绝不能进入 calendar_events",
		);
		if (!result.ok) throw new Error("Calendar mutation unexpectedly failed.");
		expect(result.events[0]?.title).toBe("计划任务");
	});

	test("does not call native calendar.mutate for an empty change set", async () => {
		const agent = new FakeNativePlanningAgent();
		const calendar = new NativePlanningCalendar(agent);
		const result = await calendar.applyChangeSet({
			id: "calendar-change-noop",
			planId: "plan-secure-1",
			operationId: "calendar-operation-noop",
			createdAt: "2026-08-13T02:05:00Z",
			changes: [],
		});

		expect(result).toEqual({
			ok: true,
			changeSetId: "calendar-change-noop",
			events: [],
			replayed: false,
		});
		expect(agent.calendarMutations).toEqual([]);
	});
});
