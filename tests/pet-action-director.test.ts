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







});
