import { expect, test } from "bun:test";
import { PetSurfaceRouter } from "../src/bun/pet-surface-router";
import type { PetInteractionMessage } from "../src/shared/contracts";

function interaction(kind: PetInteractionMessage["kind"]): PetInteractionMessage {
	return { kind, action: "idle", modelId: "whale" };
}

test("opens the task panel after the single-click window expires", () => {
	const pending: { callback: (() => void) | null } = { callback: null };
	let panelCount = 0;
	const router = new PetSurfaceRouter({
		schedule: (callback) => {
			pending.callback = callback;
			return 1 as unknown as ReturnType<typeof setTimeout>;
		},
		cancel: () => {
			pending.callback = null;
		},
		onOpenPanel: () => {
			panelCount += 1;
		},
		onOpenMain: () => {},
	});

	router.handle(interaction("click"));
	expect(panelCount).toBe(0);
	pending.callback?.();
	expect(panelCount).toBe(1);
});

test("double click cancels the pending panel and opens the main window", () => {
	const pending: { callback: (() => void) | null } = { callback: null };
	let mainCount = 0;
	const router = new PetSurfaceRouter({
		schedule: (callback) => {
			pending.callback = callback;
			return 1 as unknown as ReturnType<typeof setTimeout>;
		},
		cancel: () => {
			pending.callback = null;
		},
		onOpenPanel: () => {
			throw new Error("single-click panel should be cancelled");
		},
		onOpenMain: () => {
			mainCount += 1;
		},
	});

	router.handle(interaction("click"));
	router.handle(interaction("doubleClick"));
	pending.callback?.();
	expect(mainCount).toBe(1);
});
