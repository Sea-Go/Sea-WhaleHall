import { expect, test } from "bun:test";
import {
	PetWindowController,
	clampWindowPosition,
	clampWindowPositionToVisibleBounds,
	clampPetPositionForBelowWindow,
	displayForPoint,
	positionWindowBelowPet,
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
		clampWindowPosition({ x: 1400, y: 880 }, { width: 360, height: 300 }, primary.workArea),
	).toEqual({ x: 1080, y: 600 });
	expect(
		clampWindowPosition(
			{ x: -1500, y: -400 },
			{ width: 360, height: 300 },
			secondary.workArea,
		),
	).toEqual({ x: -1280, y: -120 });
});

test("clamps transparent pet windows by their visible body instead of their full frame", () => {
	const visibleWhale = { x: 34, y: 94, width: 267, height: 139 };
	expect(
		clampWindowPositionToVisibleBounds(
			{ x: -500, y: -500 },
			visibleWhale,
			primary.workArea,
			6,
		),
	).toEqual({ x: -28, y: -64 });
	expect(
		clampWindowPositionToVisibleBounds(
			{ x: 5_000, y: 5_000 },
			visibleWhale,
			primary.workArea,
			6,
		),
	).toEqual({ x: 1133, y: 661 });
});

test("keeps an attached companion panel below the visible pet", () => {
	const panel = { width: 360, height: 430 };
	const whale = { x: 34, y: 94, width: 267, height: 139 };
	expect(
		clampPetPositionForBelowWindow(
			{ x: 1_133, y: 661 },
			whale,
			panel,
			primary.workArea,
		),
	).toEqual({ x: 1_080, y: 265 });
	expect(
		positionWindowBelowPet({ x: 1_080, y: 265, width: 360, height: 300 }, whale),
	).toEqual({ x: 1_080, y: 470 });
});

test("native drag preserves grab offset, crosses displays, and ends on release", () => {
	let cursor = { x: 1050, y: 500 };
	let buttons = 1n;
	let frame: PetWindowFrame = { x: 900, y: 350, width: 360, height: 300 };
	const events: NativeDragEvent[] = [];
	const positions: Array<{ x: number; y: number }> = [];
	const controller = new PetWindowController(
		{
			getFrame: () => frame,
			setPosition: (x, y) => {
				frame = { ...frame, x, y };
			},
			showInactive: () => {},
			hide: () => {},
		},
		{
			getCursorScreenPoint: () => cursor,
			getMouseButtons: () => buttons,
			getAllDisplays: () => [primary, secondary],
			getPrimaryDisplay: () => primary,
		},
		{
			pollIntervalMs: 60_000,
			onDragStateChange: (event) => events.push(event),
			onPositionChange: (position) => positions.push(position),
		},
	);

	controller.beginDrag({ x: 8, y: 4 });
	cursor = { x: -640, y: 160 };
	controller.updateDrag();
	expect(frame).toMatchObject({ x: -782, y: 14 });
	expect(positions).toEqual([{ x: -782, y: 14 }]);

	buttons = 0n;
	controller.updateDrag();
	expect(controller.isDragging).toBe(false);
	expect(events.map(({ dragging, reason }) => ({ dragging, reason }))).toEqual([
		{ dragging: true, reason: undefined },
		{ dragging: false, reason: "pointerup" },
	]);
});

test("hiding ends an active drag before hiding the window", () => {
	let hidden = false;
	const controller = new PetWindowController(
		{
			getFrame: () => ({ x: 10, y: 20, width: 360, height: 300 }),
			setPosition: () => {},
			showInactive: () => {},
			hide: () => {
				hidden = true;
			},
		},
		{
			getCursorScreenPoint: () => ({ x: 20, y: 30 }),
			getMouseButtons: () => 1n,
			getAllDisplays: () => [primary],
			getPrimaryDisplay: () => primary,
		},
		{ pollIntervalMs: 60_000 },
	);
	controller.beginDrag();
	controller.setVisible(false);
	expect(controller.isDragging).toBe(false);
	expect(hidden).toBe(true);
});
