import { describe, expect, test } from "bun:test";
import {
	AccountScopedActiveGoalStore,
	ActiveGoalSessionChangedError,
	type ActiveGoalWrite,
} from "../src/bun/account-scoped-active-goal";
import type { LocalTestSessionIdentity } from "../src/bun/local-test-auth-session";
import type { ActiveGoalContextV1 } from "../src/shared/goal-context";

const identityA: LocalTestSessionIdentity = {
	accountId: "account-a",
	sessionId: "session-a-1",
	generation: 1,
};

const goal: ActiveGoalContextV1 = {
	schemaVersion: "active-goal.v1",
	goalId: "goal-1",
	planId: "plan-1",
	version: 3,
	text: "完成本地 Agent 重构",
	activatedAtMs: 1_700_000_000_000,
};

describe("AccountScopedActiveGoalStore", () => {
	test("returns a goal only to the exact account session generation", async () => {
		let current: LocalTestSessionIdentity | null = { ...identityA };
		const store = new AccountScopedActiveGoalStore({
			currentSession: () => current && { ...current },
			writeRuntimeGoal: async () => ({ ...goal }),
		});

		await store.setForCurrentSession({
			goalId: goal.goalId,
			planId: goal.planId,
			text: goal.text,
			activatedAtMs: goal.activatedAtMs,
		});
		expect(store.getForAccount("account-a")).toEqual(goal);
		expect(store.getForAccount("account-b")).toBeNull();

		current = { ...identityA, sessionId: "session-a-2", generation: 2 };
		expect(store.getForAccount("account-a")).toBeNull();
	});

	test("clears a late runtime write when logout changes the session during await", async () => {
		let current: LocalTestSessionIdentity | null = { ...identityA };
		let releaseFirst!: (value: ActiveGoalContextV1) => void;
		const firstWrite = new Promise<ActiveGoalContextV1>((resolve) => {
			releaseFirst = resolve;
		});
		const writes: ActiveGoalWrite[] = [];
		const firstWriteStarted = Promise.withResolvers<void>();
		const store = new AccountScopedActiveGoalStore({
			currentSession: () => current && { ...current },
			writeRuntimeGoal: async (next) => {
				writes.push(next ? { ...next } : null);
				if (writes.length === 1) {
					firstWriteStarted.resolve();
					return firstWrite;
				}
				return null;
			},
		});

		const setting = store.setForCurrentSession({
			goalId: goal.goalId,
			planId: goal.planId,
			text: goal.text,
			activatedAtMs: goal.activatedAtMs,
		});
		await firstWriteStarted.promise;
		current = null;
		store.invalidateSynchronously();
		releaseFirst({ ...goal });

		await expect(setting).rejects.toBeInstanceOf(ActiveGoalSessionChangedError);
		expect(writes).toHaveLength(2);
		expect(writes[1]).toBeNull();
		expect(store.getForAccount("account-a")).toBeNull();
	});

	test("runs the persistent clear even after synchronous invalidation", async () => {
		let current: LocalTestSessionIdentity | null = { ...identityA };
		const writes: ActiveGoalWrite[] = [];
		const store = new AccountScopedActiveGoalStore({
			currentSession: () => current && { ...current },
			writeRuntimeGoal: async (next) => {
				writes.push(next ? { ...next } : null);
				return next ? { ...goal } : null;
			},
		});
		await store.setForCurrentSession(goal);
		current = null;
		store.invalidateSynchronously();
		await store.clearForAccountTransition();

		expect(writes.at(-1)).toBeNull();
		expect(store.getForAccount("account-a")).toBeNull();
	});
});
