import { describe, expect, test } from "bun:test";
import { completeLegacyActivityPolicyCutover } from "../src/bun/activity-window-policy-cutover";

describe("legacy activity policy cutover", () => {
	test("retries both cleanup phases without exposing a pending ledger", async () => {
		let state: "pending" | "complete" = "pending";
		let workerClears = 0;
		let archiveClears = 0;
		let reflectionClears = 0;
		let markerCommits = 0;
		let resetPending = false;
		let resetBegins = 0;
		let resetCompletes = 0;
		let failReflectionOnce = true;
		const readState = (): "pending" | "complete" => state;
		const store = {
			getLegacyPolicyCutoverStatus: () => ({ state }),
			clearLegacyPolicyCutoverWorkerData: () => {
				workerClears += 1;
			},
			markLegacyPolicyCutoverComplete: () => {
				markerCommits += 1;
				state = "complete";
				return true;
			},
		};
		const source = {
			clearWindowsForAccount: async () => {
				reflectionClears += 1;
				if (failReflectionOnce) {
					failReflectionOnce = false;
					throw new Error("injected reflection cleanup failure");
				}
			},
		};
		const archive = {
			beginProactiveFeedbackPendingReset: async () => {
				resetBegins += 1;
				resetPending = true;
			},
			isProactiveFeedbackPendingReset: async () => resetPending,
			clearPendingProactiveFeedbackData: async () => {
				if (!resetPending) throw new Error("reset marker missing");
				archiveClears += 1;
			},
			completeProactiveFeedbackPendingReset: async () => {
				resetCompletes += 1;
				resetPending = false;
			},
		};

		await expect(
			completeLegacyActivityPolicyCutover(store, source, archive, "account-a"),
		).rejects.toThrow("reflection cleanup failure");
		expect(readState()).toBe("pending");
		expect(markerCommits).toBe(0);

		await completeLegacyActivityPolicyCutover(
			store,
			source,
			archive,
			"account-a",
		);
		expect({
			workerClears,
			archiveClears,
			reflectionClears,
			markerCommits,
			resetBegins,
			resetCompletes,
		}).toEqual({
			workerClears: 2,
			archiveClears: 2,
			reflectionClears: 2,
			markerCommits: 1,
			resetBegins: 1,
			resetCompletes: 1,
		});
		expect(readState()).toBe("complete");

		await completeLegacyActivityPolicyCutover(
			store,
			source,
			archive,
			"account-a",
		);
		expect(workerClears).toBe(2);
	});

	test("fails closed when the durable completion marker is not committed", async () => {
		const store = {
			getLegacyPolicyCutoverStatus: () => ({ state: "pending" as const }),
			clearLegacyPolicyCutoverWorkerData: () => undefined,
			markLegacyPolicyCutoverComplete: () => false,
		};
		await expect(
			completeLegacyActivityPolicyCutover(
				store,
				{ clearWindowsForAccount: async () => undefined },
				{
					beginProactiveFeedbackPendingReset: async () => undefined,
					isProactiveFeedbackPendingReset: async () => false,
					clearPendingProactiveFeedbackData: async () => undefined,
					completeProactiveFeedbackPendingReset: async () => undefined,
				},
				"account-a",
			),
		).rejects.toThrow("marker was not committed");
	});
});
