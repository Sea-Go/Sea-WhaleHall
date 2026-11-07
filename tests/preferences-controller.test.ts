import { describe, expect, test } from "bun:test";
import {
	createDefaultPreferences,
	type PreferenceValues,
} from "../src/views/client/features/settings/domain";
import { PreferencesController } from "../src/views/client/features/settings/PreferencesController";
import type { PreferencesService } from "../src/views/client/features/settings/preferences-service";
import { MockPreferencesService } from "../src/views/client/infrastructure/settings/MockPreferencesService";

function compactAppearance(
	values: PreferenceValues,
): PreferenceValues["appearance"] {
	return {
		...values.appearance,
		density: "compact",
		reduceMotion: true,
	};
}

describe("PreferencesController", () => {
	test("loads deterministic defaults before exposing editable settings", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({ latencyMs: 0, storage: null }),
		);
		const request = controller.load();
		expect(controller.getSnapshot()).toEqual({ status: "loading" });
		await request;

		const state = controller.getSnapshot();
		expect(state.status).toBe("ready");
		if (state.status !== "ready") return;
		expect(state.snapshot.values).toEqual(createDefaultPreferences());
		expect(state.dirty).toBe(false);
	});

	test("saves local preferences and increments their persistent version", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({
				latencyMs: 0,
				storage: null,
				now: () => 1_800_000_000_000,
			}),
		);
		await controller.load();
		const loaded = controller.getSnapshot();
		expect("draft" in loaded).toBe(true);
		if (!("draft" in loaded)) return;
		controller.update("appearance", compactAppearance(loaded.draft));
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			dirty: true,
		});

		await controller.save();
		const state = controller.getSnapshot();
		expect(state.status).toBe("success");
		if (state.status !== "success") return;
		expect(state.snapshot.version).toBe(1);
		expect(state.snapshot.savedAtMs).toBe(1_800_000_000_000);
		expect(state.snapshot.values.appearance).toEqual({
			theme: "observatory",
			density: "compact",
			reduceMotion: true,
		});
		expect(state.dirty).toBe(false);
	});








});
