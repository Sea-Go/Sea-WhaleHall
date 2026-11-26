import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDesktopEvent } from "../src/agent/local-protocol";

type MirroredEvent = {
	kind: string;
	source: string;
	sensitivity: "metadata" | "content";
	payload: Record<string, unknown>;
};

type Contract = {
	cases: Array<{
		name: string;
		projection: {
			occurredAtMs: number;
			observedAtMs: number;
		};
		expected: (MirroredEvent & { deduplicationKey: string }) | null;
	}>;
	rejectedShapes: Array<{
		name: string;
	} & MirroredEvent>;
};

// The same file drives a Rust test that asserts what the local host's bridge
// emits, so neither side can drift away from the other.
const contract = JSON.parse(
	readFileSync(resolve(import.meta.dir, "fixtures/legacy-event-mirror.json"), "utf8"),
) as Contract;

function desktopEvent(
	shape: MirroredEvent,
	occurredAtMs: number,
	observedAtMs: number,
): unknown {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: "de1_contract",
		cursor: "ec1_0000000000000001",
		deviceId: "device-contract",
		sessionId: "session-contract",
		kind: shape.kind,
		source: shape.source,
		occurredAtMs,
		observedAtMs,
		goalVersion: null,
		sensitivity: shape.sensitivity,
		payload: shape.payload,
	};
}

describe("legacy event mirror contract", () => {
	test("every event the local host mirrors passes the desktop-event validator", () => {
		const mirrored = contract.cases.filter((entry) => entry.expected !== null);
		expect(mirrored.length).toBeGreaterThan(0);

		for (const entry of mirrored) {
			expect(
				isDesktopEvent(
					desktopEvent(
						entry.expected as MirroredEvent,
						entry.projection.occurredAtMs,
						entry.projection.observedAtMs,
					),
				),
				entry.name,
			).toBeTrue();
		}
	});

	test("the validator rejects the shapes the bridge must never emit", () => {
		for (const shape of contract.rejectedShapes) {
			expect(
				isDesktopEvent(desktopEvent(shape, 1_000, 5_000)),
				shape.name,
			).toBeFalse();
		}
	});

	test("the mirrored kinds are the ones the reflection signal index scores", () => {
		const kinds = new Set(
			contract.cases.flatMap((entry) =>
				entry.expected === null ? [] : [entry.expected.kind],
			),
		);

		expect([...kinds].sort()).toEqual([
			"accessibility.documentChanged",
			"application.foregroundChanged",
			"browser.tabNavigated",
			"input.activityAggregated",
		]);
	});
});
