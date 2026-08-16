import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import type {
	LocalPlanningOutboxAck,
	LocalPlanningOutboxEntry,
} from "../src/agent/local-protocol";
import type { PlanningModelPort } from "../src/agent/planning";
import { WhaleHallPlanningRuntime } from "../src/bun/planning-runtime";
import type { PlanningChangeProjection } from "../src/shared/planning";

function outboxEntry(
	overrides: Partial<LocalPlanningOutboxEntry>,
): LocalPlanningOutboxEntry {
	return {
		entryId: "entry-1",
		kind: "plan-changed",
		aggregateId: "plan-1",
		payload: { planId: "plan-1", version: 3 },
		createdAtMs: 1,
		status: "pending",
		deliveredAtMs: null,
		...overrides,
	};
}

describe("WhaleHallPlanningRuntime durable invalidations", () => {
	test("publishes only content-free invalidations before acknowledging the outbox", async () => {
		let pending = [
			outboxEntry({}),
			outboxEntry({
				entryId: "entry-2",
				kind: "calendar-changed",
				aggregateId: "calendar",
				payload: {
					batchId: "batch-1",
					mutationCount: 1,
					planIds: [],
					requiresPlanningReestimate: false,
				},
			}),
		];
		const acknowledgements: LocalPlanningOutboxAck[] = [];
		const agent = {
			async listPlanningOutbox() {
				return { entries: pending };
			},
			async ackPlanningOutbox(command: LocalPlanningOutboxAck) {
				acknowledgements.push(command);
				pending = [];
				return { entries: [] };
			},
		} as unknown as AgentRuntime;
		const planChanges: PlanningChangeProjection[] = [];
		const calendarVersions: number[] = [];
		const unusedModel: PlanningModelPort = {
			modelVersion: "test-planning.v1",
			async analyze() {
				throw new Error("The outbox test must not invoke Planning analysis.");
			},
		};
		const runtime = new WhaleHallPlanningRuntime(
			agent,
			{
				planChanged: (change) => planChanges.push(change),
				calendarChanged: (version) => calendarVersions.push(version),
			},
			"Asia/Shanghai",
			unusedModel,
		);

		await runtime.flushOutbox();
		await runtime.flushOutbox();

		expect(planChanges).toEqual([
			{ planId: "plan-1", version: 3, kind: "adjusted" },
		]);
		expect(Object.keys(planChanges[0] ?? {}).sort()).toEqual([
			"kind",
			"planId",
			"version",
		]);
		expect(calendarVersions).toEqual([1]);
		const acknowledgement = acknowledgements[0];
		if (!acknowledgement) throw new Error("Outbox was not acknowledged");
		expect(acknowledgement.entryIds).toEqual(["entry-1", "entry-2"]);
		expect(acknowledgement.operationId.startsWith("planning-outbox-ack:")).toBe(
			true,
		);
	});
});
