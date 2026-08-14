import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	isLocalPlanningCalendarEvent,
	isLocalPlanningOutboxEntry,
	parseLocalMessage,
} from "../src/agent/local-protocol";

function fixture(name: string) {
	return readFileSync(
		resolve(import.meta.dir, "fixtures/local-protocol", name),
		"utf8",
	)
		.trim()
		.split("\n")
		.map(parseLocalMessage);
}

describe("shared local protocol fixtures", () => {
	test("parses the success response", () => {
		expect(fixture("success.jsonl")[0]).toMatchObject({
			id: "call-1",
			ok: true,
		});
	});

	test("parses the failure response", () => {
		expect(fixture("failure.jsonl")[0]).toMatchObject({
			id: "call-1",
			ok: false,
			error: { code: "TOOL_NOT_FOUND" },
		});
	});

	test("parses every event kind", () => {
		expect(
			fixture("events.jsonl").map((message) =>
				"event" in message ? message.event : null,
			),
		).toEqual([
			"tool.started",
			"tool.progress",
			"tool.completed",
			"tool.failed",
			"tool.cancelled",
		]);
	});
});

describe("planning local protocol validation", () => {
	const event = {
		schemaVersion: "calendar.v1",
		eventId: "event-1",
		title: "计划任务",
		sealedContentRef: null,
		redactedContent: true,
		kind: "plan",
		state: "committed",
		schedule: {
			allDay: false,
			start: "2026-08-14T01:00:00Z",
			end: "2026-08-14T02:00:00Z",
			timeZone: "Asia/Shanghai",
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: "plan-1",
		sourceTaskId: "task-1",
		scheduleOrigin: "model",
		userLocked: false,
		editable: true,
		version: 1,
	};

	test("accepts only complete protected model calendar projections", () => {
		expect(isLocalPlanningCalendarEvent(event)).toBeTrue();
		expect(
			isLocalPlanningCalendarEvent({
				...event,
				title: "sensitive task title",
				redactedContent: false,
			}),
		).toBeFalse();
		expect(
			isLocalPlanningCalendarEvent({ ...event, sourceTaskId: null }),
		).toBeFalse();
		expect(isLocalPlanningCalendarEvent({ ...event, version: 0 })).toBeFalse();
		expect(
			isLocalPlanningCalendarEvent({ ...event, unexpected: true }),
		).toBeFalse();
	});

	test("rejects outbox content outside the native allowlist", () => {
		const entry = {
			entryId: "plan:operation-1",
			kind: "plan-changed",
			aggregateId: "plan-1",
			payload: { planId: "plan-1", version: 2 },
			status: "pending",
			createdAtMs: 1,
			deliveredAtMs: null,
		};
		expect(isLocalPlanningOutboxEntry(entry)).toBeTrue();
		expect(
			isLocalPlanningOutboxEntry({
				...entry,
				payload: {
					planId: "plan-1",
					version: 2,
					goal: "must remain sealed",
				},
			}),
		).toBeFalse();
		expect(
			isLocalPlanningOutboxEntry({
				...entry,
				status: "delivered",
			}),
		).toBeFalse();
	});
});
