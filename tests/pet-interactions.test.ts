import { describe, expect, test } from "bun:test";
import type { PetActionId } from "../src/shared/pet-actions";
import {
	CanvasPetRenderer,
	type PetInteractionEvent,
} from "../src/views/pet/CanvasPetRenderer";
import type { PetHitZone, PetModel } from "../src/views/pet/core/types";

type InteractionInternals = {
	canvas: HTMLCanvasElement | null;
	activePointerId: number | null;
	pressStart: { x: number; y: number } | null;
	pressedZone: PetHitZone | null;
	hoverZone: PetHitZone | null;
	dragging: boolean;
	petting: boolean;
	clickTimes: number[];
	handlePointerUp(event: PointerEvent): void;
	handlePointerCancel(event: PointerEvent): void;
	handlePointerLeave(event: PointerEvent): void;
	handleClick(pointerId: number, zone: PetHitZone): void;
	animator: {
		getCurrentAction(): PetActionId;
		setMoodOrAnimation(
			mood: "idle" | "happy" | "busy" | "error",
			action: PetActionId | undefined,
			now: number,
		): void;
	} | null;
};

function makeCanvas(): HTMLCanvasElement {
	return {
		clientWidth: 300,
		clientHeight: 200,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		hasPointerCapture: () => false,
		releasePointerCapture: () => undefined,
		style: {},
		dataset: {},
	} as unknown as HTMLCanvasElement;
}

function makeHarness(hitZone: PetHitZone | null = "head") {
	const events: PetInteractionEvent[] = [];
	const played: PetActionId[] = [];
	const model = {
		id: "test-model",
		hitTest: () => hitZone,
	} as unknown as PetModel;
	const renderer = new CanvasPetRenderer({
		model,
		onInteract: (event) => events.push(event),
	});
	renderer.play = (action) => played.push(action);
	const internals = renderer as unknown as InteractionInternals;
	internals.canvas = makeCanvas();
	return { renderer, internals, events, played };
}

function pointerEvent(pointerId: number): PointerEvent {
	return {
		pointerId,
		clientX: 150,
		clientY: 100,
	} as PointerEvent;
}

describe("desktop pet pointer state machine", () => {
	test("petting exits its loop on release and returns to hover feedback", () => {
		const { internals, events, played } = makeHarness("head");
		internals.activePointerId = 7;
		internals.pressStart = { x: 140, y: 100 };
		internals.pressedZone = "head";
		internals.petting = true;

		internals.handlePointerUp(pointerEvent(7));

		expect(played).toEqual(["hoverLookAtPointer"]);
		expect(events.map(({ kind }) => kind)).toEqual(["petEnd"]);
		expect(internals.activePointerId).toBeNull();
		expect(internals.petting).toBe(false);
	});

	test("pointer cancellation exits petting and safely drops dragging", () => {
		const petting = makeHarness();
		petting.internals.activePointerId = 3;
		petting.internals.petting = true;
		petting.internals.handlePointerCancel(pointerEvent(3));
		expect(petting.played).toEqual(["idle"]);

		const dragging = makeHarness("body");
		dragging.internals.activePointerId = 4;
		dragging.internals.pressedZone = "body";
		dragging.internals.dragging = true;
		dragging.internals.handlePointerCancel(pointerEvent(4));
		expect(dragging.played).toEqual(["drop"]);
		expect(dragging.events.map(({ kind }) => kind)).toEqual(["dragEnd"]);
	});

	test("classifies double and rapid clicks inside their timing windows", () => {
		const doubleClick = makeHarness("body");
		doubleClick.internals.clickTimes = [performance.now() - 100];
		doubleClick.internals.handleClick(1, "body");
		expect(doubleClick.played).toEqual(["doubleClick"]);
		expect(doubleClick.events.map(({ kind }) => kind)).toEqual(["doubleClick"]);

		const rapidClick = makeHarness("body");
		const now = performance.now();
		rapidClick.internals.clickTimes = [now - 300, now - 200, now - 100];
		rapidClick.internals.handleClick(2, "body");
		expect(rapidClick.played).toEqual(["rapidClickAnnoyed"]);
		expect(rapidClick.events.map(({ kind }) => kind)).toEqual(["rapidClick"]);
	});

	test("a body click emits both click and poke semantics", () => {
		const { internals, events, played } = makeHarness("body");
		internals.handleClick(9, "body");
		expect(played).toEqual(["pokeBody"]);
		expect(events.map(({ kind }) => kind)).toEqual(["click", "poke"]);
	});

	test("hover exit cannot overwrite a newer runtime action", () => {
		const runtime = makeHarness("head");
		runtime.internals.hoverZone = "head";
		runtime.internals.animator = {
			getCurrentAction: () => "networkDisconnected",
			setMoodOrAnimation: (_mood, action) => {
				if (action) runtime.played.push(action);
			},
		};
		runtime.internals.handlePointerLeave(pointerEvent(5));
		expect(runtime.played).toEqual([]);

		const hover = makeHarness("head");
		hover.internals.hoverZone = "head";
		hover.internals.animator = {
			getCurrentAction: () => "hoverLookAtPointer",
			setMoodOrAnimation: (mood, action) => {
				hover.played.push(action ?? (mood === "idle" ? "idle" : "happy"));
			},
		};
		hover.internals.handlePointerLeave(pointerEvent(6));
		expect(hover.played).toEqual(["idle"]);
	});
});
