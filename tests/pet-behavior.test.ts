import { expect, test } from "bun:test";
import type { PetActionId } from "../src/shared/pet-actions";
import type { PetAutonomousRoutine } from "../src/views/pet/action-director";
import {
	environmentActionFor,
	PetBehaviorController,
	timeActionFor,
} from "../src/views/pet/behavior";

const SHORT_SELF_PLAY_ROUTINE: PetAutonomousRoutine = {
	id: "short-self-play",
	label: "test self play",
	weight: 1,
	cooldownMs: 0,
	minQuietMs: 0,
	steps: [{ action: "idleSelfEntertainment", holdMs: 1_000 }],
};

test("maps the local day into contextual actions", () => {
	expect(timeActionFor(new Date(2026, 6, 22, 7))).toBe("morningWakeUp");
	expect(timeActionFor(new Date(2026, 6, 22, 12))).toBe("lunchTime");
	expect(timeActionFor(new Date(2026, 6, 22, 20))).toBe("eveningSleepy");
	expect(timeActionFor(new Date(2026, 6, 22, 23))).toBe(
		"lateNightRestReminder",
	);
	expect(timeActionFor(new Date(2026, 6, 22, 16))).toBe("idle");
});

test("prioritizes birthday, holiday, weather, and temperature signals", () => {
	const now = new Date(2026, 6, 22, 12);
	expect(
		environmentActionFor({ birthday: "07-22", weather: "rain" }, now),
	).toBe("birthdayCelebrate");
	expect(
		environmentActionFor({ holiday: "海洋日", weather: "rain" }, now),
	).toBe("holidayAction");
	expect(environmentActionFor({ weather: "rain", temperatureC: 35 }, now)).toBe(
		"rainUmbrella",
	);
	expect(environmentActionFor({ temperatureC: 2 }, now)).toBe("winterShiver");
	expect(environmentActionFor({ temperatureC: 35 }, now)).toBe("summerFan");
});

test("does not replay an unchanged environment episode", () => {
	const actions: PetActionId[] = [];
	const behavior = new PetBehaviorController({
		play: (action) => actions.push(action),
		now: () => new Date(2026, 6, 22, 12),
	});

	behavior.setEnvironment({ weather: "rain", temperatureC: 24 });
	behavior.setEnvironment({ weather: "rain", temperatureC: 24 });

	expect(actions).toEqual(["rainUmbrella"]);
	behavior.dispose();
});

test("emits idle, welcome-back, and overwork actions only when due", () => {
	let nowMs = new Date(2026, 6, 22, 12).getTime();
	const actions: PetActionId[] = [];
	const behavior = new PetBehaviorController({
		play: (action) => actions.push(action),
		now: () => new Date(nowMs),
		idleAfterMs: 1_000,
		routines: [SHORT_SELF_PLAY_ROUTINE],
		overworkAfterMs: 60_000,
		welcomeBackAfterMs: 1_000,
		tickIntervalMs: 60_000,
	});

	nowMs += 1_100;
	behavior.tick();
	behavior.tick();
	expect(actions).toEqual(["idleSelfEntertainment"]);

	behavior.markInteraction();
	behavior.setPresent(false);
	nowMs += 1_100;
	behavior.setPresent(true);
	expect(actions.at(-1)).toBe("welcomeUserBack");

	nowMs += 60_000;
	behavior.tick();
	expect(actions.at(-1)).toBe("overworkRestReminder");
	behavior.dispose();
});

test("detects contextual time boundaries while the app keeps running", () => {
	let nowMs = new Date(2026, 6, 22, 17, 59, 59).getTime();
	const actions: PetActionId[] = [];
	const behavior = new PetBehaviorController({
		play: (action) => actions.push(action),
		now: () => new Date(nowMs),
		idleAfterMs: 60_000,
		overworkAfterMs: 3_600_000,
		tickIntervalMs: 60_000,
	});

	behavior.start(false);
	nowMs += 2_000;
	behavior.tick();
	expect(actions).toEqual(["eveningSleepy"]);

	nowMs = new Date(2026, 6, 22, 22, 0, 1).getTime();
	behavior.tick();
	expect(actions).toEqual(["eveningSleepy", "lateNightRestReminder"]);
	behavior.dispose();
});

test("pauses contextual behavior while production state is busy or degraded", () => {
	let nowMs = new Date(2026, 6, 22, 17, 59, 59).getTime();
	const actions: PetActionId[] = [];
	const behavior = new PetBehaviorController({
		play: (action) => actions.push(action),
		now: () => new Date(nowMs),
		idleAfterMs: 1_000,
		routines: [SHORT_SELF_PLAY_ROUTINE],
		overworkAfterMs: 60_000,
		tickIntervalMs: 60_000,
	});

	behavior.setEnabled(false);
	behavior.start(true);
	behavior.setEnvironment({ weather: "rain" });
	nowMs += 2_000;
	behavior.tick();
	expect(actions).toEqual([]);

	behavior.setEnabled(true);
	nowMs += 1_100;
	behavior.tick();
	expect(actions).toEqual(["idleSelfEntertainment"]);
	behavior.dispose();
});

test("a temporary runtime pause does not reset the overwork session", () => {
	let nowMs = new Date(2026, 6, 22, 16).getTime();
	const actions: PetActionId[] = [];
	const behavior = new PetBehaviorController({
		play: (action) => actions.push(action),
		now: () => new Date(nowMs),
		idleAfterMs: 10 * 60_000,
		overworkAfterMs: 60_000,
	});

	nowMs += 59_000;
	behavior.setEnabled(false);
	nowMs += 500;
	behavior.setEnabled(true);
	nowMs += 600;
	behavior.tick();

	expect(actions).toEqual(["overworkRestReminder"]);
	behavior.dispose();
});

test("defers an overwork reminder until direct interaction ends", () => {
	let nowMs = new Date(2026, 6, 22, 16).getTime();
	const actions: PetActionId[] = [];
	const behavior = new PetBehaviorController({
		play: (action) => actions.push(action),
		now: () => new Date(nowMs),
		idleAfterMs: 10 * 60_000,
		overworkAfterMs: 60_000,
	});

	behavior.setEngaged(true);
	nowMs += 60_100;
	behavior.tick();
	expect(actions).toEqual([]);

	behavior.setEngaged(false);
	behavior.tick();
	expect(actions).toEqual(["overworkRestReminder"]);
	behavior.dispose();
});
