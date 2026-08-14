import { describe, expect, test } from "bun:test";
import { subscribePetVisibilityPreference } from "../src/views/client/app/pet-visibility-preference";
import type { PetPresentationBridge } from "../src/views/client/features/pet-bridge/public";
import {
	createDefaultPreferences,
	type PreferenceValues,
} from "../src/views/client/features/settings/domain";
import { PreferencesController } from "../src/views/client/features/settings/PreferencesController";
import { MockPreferencesService } from "../src/views/client/infrastructure/settings/MockPreferencesService";

describe("persisted pet visibility synchronization", () => {
	test("keeps startup fail closed until a saved hidden preference loads", async () => {
		const values = createDefaultPreferences();
		values.pet.visible = false;
		const controller = controllerWith(values);
		const visible: boolean[] = [];
		const unsubscribe = subscribePetVisibilityPreference(
			controller,
			bridgeRecording(visible),
		);

		expect(visible).toEqual([]);
		await controller.load();
		await waitFor(() => visible.length === 1);
		expect(visible).toEqual([false]);
		unsubscribe();
	});

	test("shows a first-install pet after authoritative defaults load", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({ latencyMs: 0, storage: null }),
		);
		const visible: boolean[] = [];
		const unsubscribe = subscribePetVisibilityPreference(
			controller,
			bridgeRecording(visible),
		);

		expect(visible).toEqual([]);
		await controller.load();
		await waitFor(() => visible.length === 1);
		expect(visible).toEqual([true]);
		unsubscribe();
	});

	test("applies later persisted changes without mounting the settings page", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({ latencyMs: 0, storage: null }),
		);
		const visible: boolean[] = [];
		const unsubscribe = subscribePetVisibilityPreference(
			controller,
			bridgeRecording(visible),
		);
		await controller.load();
		await waitFor(() => visible.length === 1);
		const state = controller.getSnapshot();
		if (!("draft" in state)) throw new Error("Expected loaded preferences");
		controller.update("pet", { ...state.draft.pet, visible: false });
		await controller.save();
		await waitFor(() => visible.length === 2);
		expect(visible).toEqual([true, false]);
		unsubscribe();
	});
});

function controllerWith(values: PreferenceValues): PreferencesController {
	const serialized = JSON.stringify({
		values,
		version: 4,
		savedAtMs: 1_800_000_000_000,
	});
	return new PreferencesController(
		new MockPreferencesService({
			latencyMs: 0,
			storage: {
				getItem: () => serialized,
				setItem: () => {},
				removeItem: () => {},
			},
		}),
	);
}

function bridgeRecording(visible: boolean[]): PetPresentationBridge {
	return {
		async present() {},
		async setVisible(value) {
			visible.push(value);
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await Promise.resolve();
		if (predicate()) return;
	}
	throw new Error("Condition was not met");
}
