import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

function source(path: string): string {
	return readFileSync(resolve(projectRoot, path), "utf8");
}

describe("desktop-pet architecture boundaries", () => {
	test("the semantic animator has no concrete model dependency", () => {
		const animator = source("src/views/pet/animations.ts");
		expect(animator).not.toMatch(/models\//);
		expect(animator).not.toMatch(/CanvasPetRenderer/);
		expect(animator).not.toMatch(/WHALE_MODEL|CAT_MODEL/);
	});

	test("the action lab uses the production renderer without copied draw code", () => {
		const demo = source("src/views/pet/demo-main.ts");
		expect(demo).toContain('import { CanvasPetRenderer } from "./CanvasPetRenderer"');
		expect(demo).not.toMatch(/new PetAnimator|function draw[A-Z]|drawWhale|drawCat/);
		expect(demo.match(/new CanvasPetRenderer/g)).toHaveLength(1);
	});

	test("production injects the replaceable renderer rather than a species-only class", () => {
		const app = source("src/views/pet/PetApp.tsx");
		expect(app).toContain("new CanvasPetRenderer");
		expect(app).not.toContain("new CanvasWhaleRenderer");
	});
});
