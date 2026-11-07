import { expect, test } from "bun:test";
import {
	PetWindowController,
	clampWindowPosition,
	displayForPoint,
} from "../src/bun/pet-window-controller";
import type {
	NativeDragEvent,
	PetDisplay,
	PetWindowFrame,
} from "../src/bun/pet-window-controller";

const primary: PetDisplay = {
	id: 1,
	isPrimary: true,
	workArea: { x: 0, y: 24, width: 1440, height: 876 },
};
const secondary: PetDisplay = {
	id: 2,
	isPrimary: false,
	workArea: { x: -1280, y: -120, width: 1280, height: 1024 },
};

test("chooses the cursor display including negative secondary coordinates", () => {
	expect(displayForPoint([primary, secondary], { x: -640, y: 100 }, primary).id).toBe(2);
	expect(displayForPoint([primary, secondary], { x: 700, y: 300 }, primary).id).toBe(1);
	expect(displayForPoint([], { x: 700, y: 300 }, primary).id).toBe(1);
});

test("clamps the full pet window to the display work area", () => {
	expect(
		clampWindowPosition({ x: 1400, y: 880 }, { width: 320, height: 250 }, primary.workArea),
	).toEqual({ x: 1120, y: 650 });
	expect(
		clampWindowPosition(
			{ x: -1500, y: -400 },
			{ width: 320, height: 250 },
			secondary.workArea,
		),
	).toEqual({ x: -1280, y: -120 });
});




