import { describe, expect, test } from "bun:test";
import type { ActiveGoalContextV1 } from "../src/shared/goal-context";
import {
	ActiveGoalSyncCoordinator,
	beginAccountTransition,
} from "../src/views/client/goal-sync";

function goal(
	overrides: Partial<ActiveGoalContextV1> = {},
): ActiveGoalContextV1 {
	return {
		schemaVersion: "active-goal.v1",
		goalId: "goal-1",
		planId: "plan-1",
		version: 1,
		text: "完成 WhaleHall",
		activatedAtMs: 1_000,
		...overrides,
	};
}

describe("ActiveGoalSyncCoordinator", () => {
	test("continues retrying beyond five failures until the runtime acknowledges", async () => {
		let calls = 0;
		const retries: number[] = [];
		const synchronizer = new ActiveGoalSyncCoordinator({
			send: async (requested) => {
				calls += 1;
				if (calls <= 7) throw new Error("runtime unavailable");
				return requested;
			},
			delay: async () => {},
			onRetry: (attempt) => retries.push(attempt),
		});

		await synchronizer.waitForAcknowledgement(goal());

		expect(calls).toBe(8);
		expect(retries).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	test("requires an ACK for the requested context instead of any successful response", async () => {
		let calls = 0;
		const requested = goal();
		const stale = goal({
			goalId: "old-goal",
			planId: "old-plan",
			text: "旧目标",
			activatedAtMs: 500,
		});
		const synchronizer = new ActiveGoalSyncCoordinator({
			send: async () => {
				calls += 1;
				return calls === 1 ? stale : requested;
			},
			delay: async () => {},
		});

		await synchronizer.waitForAcknowledgement(requested);

		expect(calls).toBe(2);
	});

});

describe("account transition ordering", () => {

});

async function spinUntil(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 100; index += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition was not reached");
}
