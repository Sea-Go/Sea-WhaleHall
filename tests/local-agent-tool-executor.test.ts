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

		await expect(
			executor.execute({
				accountId: "account-b",
				runId: "run-goal-1",
				toolCallId: "tool-goal-1",
				name: "planning.get_active_goal",
				arguments: {},
			}),
		).resolves.toEqual({ goal: null });
		expect(requestedAccounts).toEqual(["account-b"]);
	});

	test("creates a draft with a Bun-generated id instead of trusting the model id", async () => {
		const writes: Array<{
			record: Parameters<EncryptedAgentRepository["compareAndSetWorkflow"]>[0];
			expectedVersion: number | null;
		}> = [];
		const repository = {
			async compareAndSetWorkflow(
				record: Parameters<
					EncryptedAgentRepository["compareAndSetWorkflow"]
				>[0],
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
});
