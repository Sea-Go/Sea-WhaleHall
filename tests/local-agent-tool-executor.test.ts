import { describe, expect, test } from "bun:test";
import type { CalendarRepository } from "../src/bun/calendar-repository";
import type { EncryptedAgentRepository } from "../src/bun/encrypted-agent-repository";
import { WhaleHallAgentToolExecutor } from "../src/bun/local-agent-tool-executor";
import type {
	CalendarBatchMutationResult,
	CalendarMutation,
	CalendarMutationResult,
} from "../src/shared/calendar";

function executorWithCalendar(
	calendar: Partial<CalendarRepository>,
	repository: Partial<EncryptedAgentRepository> = {},
	now?: () => number,
): WhaleHallAgentToolExecutor {
	return new WhaleHallAgentToolExecutor({
		calendar: calendar as CalendarRepository,
		repository: repository as EncryptedAgentRepository,
		activeGoal: () => null,
		now,
	});
}

describe("WhaleHallAgentToolExecutor", () => {
	test("scopes active-goal reads to the executor account", async () => {
		const requestedAccounts: string[] = [];
		const executor = new WhaleHallAgentToolExecutor({
			calendar: {} as CalendarRepository,
			repository: {} as EncryptedAgentRepository,
			activeGoal: (accountId) => {
				requestedAccounts.push(accountId);
				return null;
			},
		});

		await expect(executor.execute({
			accountId: "account-b",
			runId: "run-goal-1",
			toolCallId: "tool-goal-1",
			name: "planning.get_active_goal",
			arguments: {},
		})).resolves.toEqual({ goal: null });
		expect(requestedAccounts).toEqual(["account-b"]);
	});

	test("creates a draft with a Bun-generated id instead of trusting the model id", async () => {
		const writes: Array<{
			record: Parameters<EncryptedAgentRepository["compareAndSetWorkflow"]>[0];
			expectedVersion: number | null;
		}> = [];
		const repository = {
			async compareAndSetWorkflow(
				record: Parameters<EncryptedAgentRepository["compareAndSetWorkflow"]>[0],
				expectedVersion: number | null,
			): Promise<boolean> {
				writes.push({ record: structuredClone(record), expectedVersion });
				return true;
			},
		};
		const executor = executorWithCalendar({}, repository, () => 1_000);

		const result = await executor.execute({
			accountId: "account-a",
			runId: "run-draft-1",
			toolCallId: "tool-draft-1",
			name: "planning.save_draft",
			arguments: {
				draft: { id: "model-selected-id", title: "季度计划" },
			},
		});

		expect(writes).toHaveLength(1);
		const write = writes[0]!;
		expect(write.expectedVersion).toBeNull();
		expect(write.record.id).toStartWith("draft-");
		expect(write.record.id).not.toBe("model-selected-id");
		expect(write.record.name).toBe("agent-saved-draft");
		expect(write.record.definition).toEqual({
			id: write.record.id,
			title: "季度计划",
		});
		expect(result).toEqual({
			saved: true,
			operation: "created",
			draftId: write.record.id,
			version: 1_000,
		});
	});

	test("updates only the same agent draft at its exact optimistic version", async () => {
		const writes: Array<{ expectedVersion: number | null; updatedAtMs: number }> = [];
		const repository = {
			async getWorkflow() {
				return {
					accountId: "account-a",
					id: "draft-1",
					name: "agent-saved-draft",
					definition: { id: "draft-1", title: "旧标题" },
					enabled: true,
					createdAtMs: 5,
					updatedAtMs: 9,
				};
			},
			async compareAndSetWorkflow(
				record: Parameters<EncryptedAgentRepository["compareAndSetWorkflow"]>[0],
				expectedVersion: number | null,
			): Promise<boolean> {
				writes.push({ expectedVersion, updatedAtMs: record.updatedAtMs });
				return true;
			},
		};
		const executor = executorWithCalendar({}, repository, () => 9);

		const result = await executor.execute({
			accountId: "account-a",
			runId: "run-draft-2",
			toolCallId: "tool-draft-2",
			name: "planning.save_draft",
			arguments: {
				expectedVersion: 9,
				draft: { id: "draft-1", title: "新标题" },
			},
		});

		expect(writes).toEqual([{ expectedVersion: 9, updatedAtMs: 10 }]);
		expect(result).toEqual({
			saved: true,
			operation: "updated",
			draftId: "draft-1",
			version: 10,
		});
	});

	test("rejects stale or non-Agent draft updates without writing", async () => {
		let writes = 0;
		const existing = {
			accountId: "account-a",
			id: "draft-1",
			name: "agent-saved-draft",
			definition: { id: "draft-1" },
			enabled: true,
			createdAtMs: 5,
			updatedAtMs: 11,
		};
		const repository = {
			async getWorkflow() {
				return structuredClone(existing);
			},
			async compareAndSetWorkflow() {
				writes += 1;
				return true;
			},
		};
		const executor = executorWithCalendar({}, repository, () => 20);
		const input = {
			accountId: "account-a",
			runId: "run-draft-3",
			toolCallId: "tool-draft-3",
			name: "planning.save_draft" as const,
			arguments: {
				expectedVersion: 10,
				draft: { id: "draft-1", title: "覆盖" },
			},
		};

		await expect(executor.execute(input)).rejects.toThrow("草案版本已变化");
		expect(writes).toBe(0);

		existing.updatedAtMs = 10;
		existing.name = "task-planning";
		await expect(executor.execute(input)).rejects.toThrow("只能更新已存在的 Agent 本地草案");
		expect(writes).toBe(0);
	});

	test("rejects an update when the repository CAS loses a race", async () => {
		const repository = {
			async getWorkflow() {
				return {
					accountId: "account-a",
					id: "draft-1",
					name: "agent-saved-draft",
					definition: {},
					enabled: true,
					createdAtMs: 1,
					updatedAtMs: 3,
				};
			},
			async compareAndSetWorkflow() {
				return false;
			},
		};
		const executor = executorWithCalendar({}, repository, () => 4);

		await expect(executor.execute({
			accountId: "account-a",
			runId: "run-draft-4",
			toolCallId: "tool-draft-4",
			name: "planning.save_draft",
			arguments: {
				expectedVersion: 3,
				draft: { id: "draft-1", title: "更新" },
			},
		})).rejects.toThrow("草案版本已变化");
	});

	test("commits the current sidecar plan-schedule schema as one atomic calendar batch", async () => {
		const batchCalls: Array<{
			accountId: string;
			batchId: string;
			mutations: readonly CalendarMutation[];
			expectedRevision: number | undefined;
		}> = [];
		const calendar = {
			async mutateBatch(
				accountId: string,
				batchId: string,
				mutations: readonly CalendarMutation[],
				expectedRevision?: number,
			): Promise<CalendarBatchMutationResult> {
				batchCalls.push({ accountId, batchId, mutations: structuredClone(mutations), expectedRevision });
				return {
					ok: true,
					batchId,
					events: mutations.flatMap((mutation) => mutation.after ? [mutation.after] : []),
					warnings: [],
					calendarRevision: 18,
				};
			},
		};
		const executor = executorWithCalendar(calendar);

		const result = await executor.execute({
			accountId: "account-a",
			runId: "run-1",
			toolCallId: "tool-1",
			name: "calendar.commit_plan_schedule",
			arguments: {
				planId: "plan-7",
				calendarRevision: 17,
				schedule: [
					{
						id: "event-1",
						taskId: "task-1",
						title: "完成方案",
						start: "2026-08-03T01:00:00.000Z",
						end: "2026-08-03T02:00:00.000Z",
						timeZone: "Asia/Shanghai",
					},
					{
						id: "event-2",
						taskId: "task-2",
						title: "复盘",
						start: "2026-08-03T03:00:00.000Z",
						end: "2026-08-03T03:30:00.000Z",
						timeZone: "Asia/Shanghai",
					},
				],
			},
		});

		expect(result).toEqual({ committed: 2, revision: 18 });
		expect(batchCalls).toHaveLength(1);
		const batch = batchCalls[0]!;
		expect(batch.accountId).toBe("account-a");
		expect(batch.batchId).toStartWith("tool-batch-");
		expect(batch.expectedRevision).toBe(17);
		expect(batch.mutations).toHaveLength(2);
		expect(batch.mutations.map((mutation) => mutation.after)).toEqual([
			{
				id: "event-1",
				title: "完成方案",
				kind: "plan",
				state: "committed",
				schedule: {
					allDay: false,
					start: "2026-08-03T01:00:00.000Z",
					end: "2026-08-03T02:00:00.000Z",
					timeZone: "Asia/Shanghai",
				},
				recurrence: null,
				occurrenceId: null,
				sourcePlanId: "plan-7",
				editable: true,
				version: 0,
			},
			{
				id: "event-2",
				title: "复盘",
				kind: "plan",
				state: "committed",
				schedule: {
					allDay: false,
					start: "2026-08-03T03:00:00.000Z",
					end: "2026-08-03T03:30:00.000Z",
					timeZone: "Asia/Shanghai",
				},
				recurrence: null,
				occurrenceId: null,
				sourcePlanId: "plan-7",
				editable: true,
				version: 0,
			},
		]);
		for (const mutation of batch.mutations) {
			expect(mutation).toEqual(expect.objectContaining({
				kind: "create",
				eventId: mutation.after?.id,
				expectedVersion: null,
				before: null,
				recurrenceScope: null,
			}));
		}
	});

	test("passes a stale expected calendar revision once and does not replay the batch", async () => {
		let calls = 0;
		const calendar = {
			async mutateBatch(
				_accountId: string,
				batchId: string,
				_mutations: readonly CalendarMutation[],
				expectedRevision?: number,
			): Promise<CalendarBatchMutationResult> {
				calls += 1;
				expect(expectedRevision).toBe(4);
				return {
					ok: false,
					batchId,
					conflicts: [{
						reason: "stale-revision",
						severity: "error",
						affectedEventIds: [],
						message: "日历已更新，请重试。",
						nextAction: "retry",
					}],
				};
			},
		};
		const executor = executorWithCalendar(calendar);

		await expect(executor.execute({
			accountId: "account-a",
			runId: "run-2",
			toolCallId: "tool-2",
			name: "calendar.commit_plan_schedule",
			arguments: {
				planId: "plan-1",
				calendarRevision: 4,
				schedule: [{
					id: "event-1",
					taskId: "task-1",
					title: "任务",
					start: "2026-08-03T01:00:00.000Z",
					end: "2026-08-03T02:00:00.000Z",
					timeZone: "Asia/Shanghai",
				}],
			},
		})).rejects.toThrow("日历已更新，请重试。");
		expect(calls).toBe(1);
	});

	test("rejects update_event when the top-level and nested event ids differ", async () => {
		let mutations = 0;
		const calendar = {
			async mutate(): Promise<CalendarMutationResult> {
				mutations += 1;
				throw new Error("must not be called");
			},
		};
		const executor = executorWithCalendar(calendar);

		await expect(executor.execute({
			accountId: "account-a",
			runId: "run-3",
			toolCallId: "tool-3",
			name: "calendar.update_event",
			arguments: {
				eventId: "approved-event",
				expectedVersion: 2,
				event: {
					id: "different-event",
					title: "被替换的日程",
					kind: "plan",
					state: "committed",
					schedule: {
						allDay: false,
						start: "2026-08-03T01:00:00.000Z",
						end: "2026-08-03T02:00:00.000Z",
						timeZone: "Asia/Shanghai",
					},
					recurrence: null,
					occurrenceId: null,
					sourcePlanId: "plan-1",
					editable: true,
					version: 2,
				},
			},
		})).rejects.toThrow("eventId does not match the event being updated.");
		expect(mutations).toBe(0);
	});
});
