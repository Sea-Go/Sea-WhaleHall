import { expect, test } from "bun:test";
import { runAccountSessionCleanup } from "../src/bun/account-session-cleanup";

test("account cleanup attempts every barrier even when one fails", async () => {
	const attempted: string[] = [];
	const cleanup = runAccountSessionCleanup([
		() => {
			attempted.push("cancel-runs");
			throw new Error("cancel failed");
		},
		async () => {
			attempted.push("clear-active-goal");
		},
	]);

	await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
	expect(attempted).toEqual(["cancel-runs", "clear-active-goal"]);
});
