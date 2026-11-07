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
