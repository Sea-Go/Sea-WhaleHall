import { expect, test } from "bun:test";
import {
	PetBehaviorController,
	environmentActionFor,
	timeActionFor,
} from "../src/views/pet/behavior";
import type { PetActionId } from "../src/shared/pet-actions";

test("maps the local day into contextual actions", () => {
	expect(timeActionFor(new Date(2026, 6, 22, 7))).toBe("morningWakeUp");
	expect(timeActionFor(new Date(2026, 6, 22, 12))).toBe("lunchTime");
	expect(timeActionFor(new Date(2026, 6, 22, 20))).toBe("eveningSleepy");
	expect(timeActionFor(new Date(2026, 6, 22, 23))).toBe("lateNightRestReminder");
	expect(timeActionFor(new Date(2026, 6, 22, 16))).toBe("idle");
});

test("prioritizes birthday, holiday, weather, and temperature signals", () => {
	const now = new Date(2026, 6, 22, 12);
	expect(environmentActionFor({ birthday: "07-22", weather: "rain" }, now)).toBe(
		"birthdayCelebrate",
	);
	expect(environmentActionFor({ holiday: "海洋日", weather: "rain" }, now)).toBe(
		"holidayAction",
	);
	expect(environmentActionFor({ weather: "rain", temperatureC: 35 }, now)).toBe(
		"rainUmbrella",
	);
	expect(environmentActionFor({ temperatureC: 2 }, now)).toBe("winterShiver");
	expect(environmentActionFor({ temperatureC: 35 }, now)).toBe("summerFan");
});

test("emits idle, welcome-back, and overwork actions only when due", () => {
	let nowMs = new Date(2026, 6, 22, 12).getTime();
	const actions: PetActionId[] = [];
	const behavior = new PetBehaviorController({
		play: (action) => actions.push(action),
		now: () => new Date(nowMs),
		idleAfterMs: 1_000,
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
