import { describe, expect, test } from "bun:test";
import {
	CLICK_REACTION_DURATION_SECONDS,
	getClickMotion,
	isPointInsideWhale,
} from "../src/views/pet/PetRenderer";
import { canvasPointToLocal } from "../src/views/pet/pet-math";

describe("desktop pet interaction geometry", () => {
	test("accepts the whale body and both tail fins", () => {
		expect(isPointInsideWhale(0, 0)).toBe(true);
		expect(isPointInsideWhale(95, 0)).toBe(true);
		expect(isPointInsideWhale(-125, -28)).toBe(true);
		expect(isPointInsideWhale(-125, 28)).toBe(true);
		expect(isPointInsideWhale(58, 67)).toBe(true);
	});

	test("rejects transparent canvas areas", () => {
		expect(isPointInsideWhale(150, -90)).toBe(false);
		expect(isPointInsideWhale(0, 90)).toBe(false);
		expect(isPointInsideWhale(-170, 0)).toBe(false);
	});

	test("allows a small release tolerance after the press squash", () => {
		expect(isPointInsideWhale(4, -73)).toBe(false);
		expect(isPointInsideWhale(4, -73, 12)).toBe(true);
	});
});

describe("desktop pet coordinate transforms", () => {
	test("maps the rendered canvas origin to model-local zero", () => {
		expect(
			canvasPointToLocal(
				{ x: 194.4, y: 168 },
				{ x: 194.4, y: 168, rotation: 0, scaleX: 1, scaleY: 1 },
			),
		).toEqual({ x: 0, y: 0 });
	});

	test("inverts translation, rotation, and scale", () => {
		const local = canvasPointToLocal(
			{ x: 100, y: 120 },
			{ x: 100, y: 100, rotation: Math.PI / 2, scaleX: 2, scaleY: 4 },
		);
		expect(local.x).toBeCloseTo(10, 5);
		expect(local.y).toBeCloseTo(0, 5);
	});
});

describe("desktop pet click motion", () => {
	test("squashes before jumping", () => {
		const squash = getClickMotion(CLICK_REACTION_DURATION_SECONDS * 0.09);
		expect(squash.active).toBe(true);
		expect(squash.scaleX).toBeGreaterThan(1);
		expect(squash.scaleY).toBeLessThan(1);
		expect(squash.jump).toBe(0);
	});

	test("jumps and returns to rest", () => {
		const leap = getClickMotion(CLICK_REACTION_DURATION_SECONDS * 0.58);
		expect(leap.active).toBe(true);
		expect(leap.jump).toBeGreaterThan(20);

		const settled = getClickMotion(CLICK_REACTION_DURATION_SECONDS);
		expect(settled.active).toBe(false);
		expect(settled.jump).toBe(0);
		expect(settled.scaleX).toBe(1);
		expect(settled.scaleY).toBe(1);
	});

	test("keeps a visible but stationary reduced-motion response", () => {
		const pulse = getClickMotion(CLICK_REACTION_DURATION_SECONDS / 2, true);
		expect(pulse.active).toBe(true);
		expect(pulse.jump).toBe(0);
		expect(pulse.scaleX).toBeGreaterThan(1);
		expect(pulse.scaleY).toBe(pulse.scaleX);
	});
});
