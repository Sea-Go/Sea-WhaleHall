import { describe, expect, test } from "bun:test";
import type { PetActionId } from "../src/shared/pet-actions";
import {
	PET_AUTONOMOUS_ROUTINES,
	PetActionDirector,
	type PetAutonomousRoutine,
} from "../src/views/pet/action-director";

function testRoutine(
	id: string,
	action: PetActionId,
	holdMs = 250,
): PetAutonomousRoutine {
	return {
		id,
		label: id,
		weight: 1,
		cooldownMs: 0,
		minQuietMs: 0,
		steps: [{ action, holdMs }],
	};
}

describe("PetActionDirector autonomous routines", () => {
	test("ships only finite, bounded, non-empty authored routines", () => {
		const ids = new Set<string>();
		for (const routine of PET_AUTONOMOUS_ROUTINES) {
			expect(ids.has(routine.id)).toBe(false);
			ids.add(routine.id);
			expect(routine.steps.length).toBeGreaterThan(0);
			expect(routine.weight).toBeGreaterThan(0);
			expect(routine.cooldownMs).toBeGreaterThan(0);
			const totalDuration = routine.steps.reduce((total, step) => {
				expect(Number.isFinite(step.holdMs)).toBe(true);
				expect(step.holdMs).toBeGreaterThanOrEqual(250);
				expect(step.holdMs).toBeLessThanOrEqual(12_000);
				return total + step.holdMs;
			}, 0);
			expect(totalDuration).toBeLessThanOrEqual(20_000);
		}
	});

	test("plays every step in a routine and releases looping actions to idle", () => {
		const actions: PetActionId[] = [];
		const routine: PetAutonomousRoutine = {
			id: "two-step",
			label: "two step",
			weight: 1,
			cooldownMs: 0,
			minQuietMs: 0,
			steps: [
				{ action: "lookAround", holdMs: 500 },
				{ action: "playToy", holdMs: 500 },
			],
		};
		const director = new PetActionDirector({
			play: (action) => actions.push(action),
			initialNowMs: 0,
			firstRoutineAfterMs: 1_000,
			ambientDelayMs: [1_000, 1_000],
			routines: [routine],
			random: () => 0,
		});

		director.tick(999, 12);
		director.tick(1_000, 12);
		director.tick(1_499, 12);
		director.tick(1_500, 12);
		director.tick(2_000, 12);

		expect(actions).toEqual(["lookAround", "playToy", "idle"]);
		expect(director.getSnapshot().activePlan).toBeNull();
	});

	test("uses recent-history exclusion so equal routines do not repeat", () => {
		const actions: PetActionId[] = [];
		const director = new PetActionDirector({
			play: (action) => actions.push(action),
			initialNowMs: 0,
			firstRoutineAfterMs: 500,
			ambientDelayMs: [500, 500],
			routines: [
				testRoutine("a", "lookAround"),
				testRoutine("b", "stretch"),
				testRoutine("c", "groom"),
			],
			random: () => 0,
		});

		for (const now of [500, 750, 1_250, 1_500, 2_000]) {
			director.tick(now, 12);
		}

		expect(actions.filter((action) => action !== "idle")).toEqual([
			"lookAround",
			"stretch",
			"groom",
		]);
	});

	test("turns sleep into a bounded rest plan that wakes itself", () => {
		const actions: PetActionId[] = [];
		const director = new PetActionDirector({
			play: (action) => actions.push(action),
			initialNowMs: 0,
			firstRoutineAfterMs: 500,
			ambientDelayMs: [500, 500],
			routines: [],
			sleepAfterMs: 10_000,
			sleepDurationMs: 5_000,
			random: () => 0,
		});

		director.tick(9_999, 14);
		director.tick(10_000, 14);
		director.tick(13_199, 14);
		director.tick(13_200, 14);
		director.tick(18_200, 14);

		expect(actions).toEqual(["sleepy", "sleepIn", "idle"]);
		expect(director.getSnapshot().activePlan).toBeNull();
		expect(director.getSnapshot().nextSleepAt).toBe(28_200);
	});

	test("interaction, invisibility, and higher-priority state cancel autonomy", () => {
		const actions: PetActionId[] = [];
		const director = new PetActionDirector({
			play: (action) => actions.push(action),
			initialNowMs: 0,
			firstRoutineAfterMs: 1_000,
			ambientDelayMs: [500, 500],
			routines: [testRoutine("play", "playToy", 10_000)],
			random: () => 0,
		});

		director.tick(1_000, 12);
		director.markInteraction(1_100);
		director.tick(2_099, 12);
		director.setPresent(false, 2_100);
		director.tick(20_000, 12);
		director.setPresent(true, 20_000);
		director.setEnabled(false, 20_100);
		director.tick(30_000, 12);
		director.setEnabled(true, 30_000);
		director.setEngaged(true, 30_100);
		director.tick(40_000, 12);
		director.setEngaged(false, 40_000);
		director.tick(41_000, 12);

		expect(actions).toEqual(["playToy", "playToy"]);
	});

	test("bounds looping contextual actions instead of leaving them permanent", () => {
		const actions: PetActionId[] = [];
		const director = new PetActionDirector({
			play: (action) => actions.push(action),
			initialNowMs: 0,
			routines: [],
			random: () => 0,
		});

		director.presentAction("eveningSleepy", 0);
		director.tick(5_199, 20);
		director.tick(5_200, 20);

		expect(actions).toEqual(["eveningSleepy", "idle"]);
	});

	test("queues contextual reminders during direct interaction and replays them", () => {
		const actions: PetActionId[] = [];
		const director = new PetActionDirector({
			play: (action) => actions.push(action),
			initialNowMs: 0,
			routines: [],
			random: () => 0,
		});

		director.setEngaged(true, 1_000);
		director.presentAction("overworkRestReminder", 2_000);
		expect(actions).toEqual([]);
		expect(director.getSnapshot().pendingContextCount).toBe(1);

		director.setEngaged(false, 3_000);
		director.tick(3_000, 12);
		expect(actions).toEqual(["overworkRestReminder"]);
		expect(director.getSnapshot().pendingContextCount).toBe(0);
	});

	test("releases an active looping plan before the page becomes hidden", () => {
		const actions: PetActionId[] = [];
		const director = new PetActionDirector({
			play: (action) => actions.push(action),
			initialNowMs: 0,
			firstRoutineAfterMs: 1_000,
			routines: [testRoutine("play", "playToy", 10_000)],
			random: () => 0,
		});

		director.tick(1_000, 12);
		director.setPresent(false, 1_100);

		expect(actions).toEqual(["playToy", "idle"]);
		expect(director.getSnapshot().activePlan).toBeNull();
	});

	test("keeps producing varied activity over a long unattended timeline", () => {
		let simulatedNow = 0;
		let seed = 0x51f15e;
		const events: Array<{ at: number; action: PetActionId }> = [];
		const director = new PetActionDirector({
			play: (action) => events.push({ at: simulatedNow, action }),
			initialNowMs: 0,
			random: () => {
				seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
				return seed / 0x1_0000_0000;
			},
		});

		for (simulatedNow = 0; simulatedNow <= 20 * 60_000; simulatedNow += 250) {
			director.tick(simulatedNow, 14);
		}

		const distinctActions = new Set(
			events.map(({ action }) => action).filter((action) => action !== "idle"),
		);
		expect(distinctActions.size).toBeGreaterThanOrEqual(12);
		expect(distinctActions.has("walkRight")).toBe(true);
		expect(distinctActions.has("playToy")).toBe(true);
		expect(distinctActions.has("groom")).toBe(true);

		const sleepIn = events.find(({ action }) => action === "sleepIn");
		expect(sleepIn).toBeDefined();
		const wakeToIdle = events.find(
			({ action, at }) =>
				action === "idle" && at > (sleepIn?.at ?? Number.POSITIVE_INFINITY),
		);
		expect(wakeToIdle).toBeDefined();
		expect((wakeToIdle?.at ?? 0) - (sleepIn?.at ?? 0)).toBeLessThanOrEqual(
			35_250,
		);
	});
});
