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
		expect(demo).toContain(
			'import { CanvasPetRenderer } from "./CanvasPetRenderer"',
		);
		expect(demo).not.toMatch(
			/new PetAnimator|function draw[A-Z]|drawWhale|drawCat/,
		);
		expect(demo.match(/new CanvasPetRenderer/g)).toHaveLength(1);
	});

	test("production injects the replaceable renderer rather than a species-only class", () => {
		const app = source("src/views/pet/PetApp.tsx");
		expect(app).toContain("new CanvasPetRenderer");
		expect(app).not.toContain("new CanvasWhaleRenderer");
	});

	test("sensitive Agent feedback uses a dedicated Bun-to-pet contract", () => {
		const legacyPresentation = source("src/shared/pet-presentation.ts");
		const activityFeedback = source("src/shared/pet-activity-feedback.ts");
		expect(legacyPresentation).not.toContain("presentationId");
		expect(legacyPresentation).not.toMatch(/\btext\s*:/);
		expect(activityFeedback).toContain("PetActivityFeedbackPresentation");
		expect(activityFeedback).toContain("presentActivityFeedback");
		expect(activityFeedback).toContain("clearActivityFeedback");
		expect(activityFeedback).not.toContain("ClientRPC");
	});

	test("account transitions await pet clearing and quarantine an unacknowledged renderer", () => {
		const main = source("src/bun/index.ts");
		const delivery = source("src/bun/pet-activity-feedback-delivery.ts");
		expect(main).toContain(
			"await petActivityFeedbackDelivery?.clearForAccountTransition()",
		);
		expect(main).toContain("petRPC.request.clearActivityFeedback");
		expect(main).toContain("petActivityFeedbackRendererQuarantined = true");
		expect(main).toContain("petWindowController?.setVisible(false)");
		expect(delivery).toContain("isPetActivityFeedbackClearResponse");
	});

	test("native pet visibility stays fail closed until preferences publish", () => {
		const main = source("src/bun/index.ts");
		const app = source("src/views/client/App.tsx");
		const shell = source("src/views/client/app/AppShell.tsx");
		expect(main).toContain("let petVisible = false");
		expect(main).toContain("petWindowController.setVisible(false)");
		expect(main).toMatch(/petWindowController\?\.setVisible\(petVisible\)/u);
		expect(app).toContain("subscribePetVisibilityPreference");
		expect(shell).not.toContain("petBridge.setVisible");
	});

	test("the bundled pet view keeps an exact resource URL and proves readiness over RPC", () => {
		const main = source("src/bun/index.ts");
		const petRpc = source("src/views/pet/rpc.ts");
		expect(main).toContain("url: null");
		expect(main).toContain('petWindow.webview.loadURL(await viewUrl("pet"))');
		expect(main).toContain('petWindow.webview.on("did-commit-navigation"');
		expect(main).not.toContain("whalehallPetEpoch");
		expect(main).toContain("proveActivityFeedbackRenderer");
		expect(petRpc).toContain("assertRendererMounted");
	});

	test("an optional Timeline failure cannot tear down published Reflection", () => {
		const main = source("src/bun/index.ts");
		expect(main).toContain(
			"timelineLifecycle.ensureStarted({\n\t\t\t\t\tretryOnFailure: true,",
		);
		expect(main).toContain(
			"Timeline v2 is temporarily unavailable; monitoring and Reflection remain available.",
		);
		expect(main).not.toContain(
			"if (!isObservationEncryptionUnavailable(error)) throw error;",
		);
	});
});
