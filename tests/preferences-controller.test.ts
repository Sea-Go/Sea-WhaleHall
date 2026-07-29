import { describe, expect, test } from "bun:test";
import {
	createDefaultPreferences,
	type PreferenceValues,
} from "../src/views/client/features/settings/domain";
import { PreferencesController } from "../src/views/client/features/settings/PreferencesController";
import type { PreferencesService } from "../src/views/client/features/settings/preferences-service";
import { MockPreferencesService } from "../src/views/client/infrastructure/settings/MockPreferencesService";

function compactAppearance(values: PreferenceValues): PreferenceValues["appearance"] {
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
			theme: "orange",
			density: "compact",
			reduceMotion: true,
		});
		expect(state.dirty).toBe(false);
	});

	test("rolls back every draft field when a save fails", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({
				latencyMs: 0,
				storage: null,
				saveFailureCount: 1,
			}),
		);
		await controller.load();
		const loaded = controller.getSnapshot();
		if (!("draft" in loaded)) throw new Error("Expected preferences");
		controller.update("appearance", compactAppearance(loaded.draft));
		controller.update("pet", {
			visible: false,
			reactionsEnabled: false,
		});

		expect(await controller.save()).toBeNull();
		const state = controller.getSnapshot();
		expect(state).toMatchObject({
			status: "error",
			stage: "save",
			dirty: false,
			message: "未能保存设置，已恢复到上次保存的内容。",
		});
		if (!("draft" in state)) return;
		expect(state.draft).toEqual(createDefaultPreferences());
		expect(state.snapshot.version).toBe(0);
	});

	test("restores defaults through the same persistent and rollback-safe path", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({ latencyMs: 0, storage: null }),
		);
		await controller.load();
		const loaded = controller.getSnapshot();
		if (!("draft" in loaded)) throw new Error("Expected preferences");
		controller.update("appearance", compactAppearance(loaded.draft));
		await controller.save();
		await controller.restoreDefaults();

		const state = controller.getSnapshot();
		expect(state.status).toBe("success");
		if (state.status !== "success") return;
		expect(state.message).toBe("已恢复默认设置。");
		expect(state.snapshot.values).toEqual(createDefaultPreferences());
		expect(state.snapshot.version).toBe(2);
	});

	test("renders a retryable load error without inventing stale values", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({
				latencyMs: 0,
				storage: null,
				loadFailure: "offline",
			}),
		);
		expect(await controller.load()).toBeNull();
		expect(controller.getSnapshot()).toEqual({
			status: "error",
			stage: "load",
			message: "当前设备离线，暂时无法读取本机设置。",
			retryable: true,
		});
	});

	test("deduplicates repeated saves while persistent storage is pending", async () => {
		let resolveSave: (value: Awaited<ReturnType<PreferencesService["save"]>>) => void =
			() => {};
		const defaults = createDefaultPreferences();
		const service: PreferencesService = {
			async load() {
				return { values: defaults, version: 0, savedAtMs: null };
			},
			save(values) {
				return new Promise((resolve) => {
					resolveSave = resolve;
					expect(values.appearance.density).toBe("compact");
				});
			},
		};
		const controller = new PreferencesController(service);
		await controller.load();
		const loaded = controller.getSnapshot();
		if (!("draft" in loaded)) throw new Error("Expected preferences");
		controller.update("appearance", compactAppearance(loaded.draft));

		const first = controller.save();
		const second = controller.save();
		expect(first).toBe(second);
		resolveSave({
			values: {
				...defaults,
				appearance: compactAppearance(defaults),
			},
			version: 1,
			savedAtMs: 10,
		});
		await Promise.all([first, second]);
		expect(controller.getSnapshot().status).toBe("success");
	});

	test("does not retain an in-memory write when browser storage rejects it", async () => {
		const service = new MockPreferencesService({
			latencyMs: 0,
			storage: {
				getItem() {
					return null;
				},
				setItem() {
					throw new Error("quota unavailable");
				},
				removeItem() {},
			},
		});
		const controller = new PreferencesController(service);
		await controller.load();
		const loaded = controller.getSnapshot();
		if (!("draft" in loaded)) throw new Error("Expected preferences");
		controller.update("appearance", compactAppearance(loaded.draft));
		expect(await controller.save()).toBeNull();

		const reloaded = new PreferencesController(service);
		await reloaded.load();
		const state = reloaded.getSnapshot();
		expect(state.status).toBe("ready");
		if (state.status !== "ready") return;
		expect(state.snapshot.values).toEqual(createDefaultPreferences());
		expect(state.snapshot.version).toBe(0);
	});

	test("persists the selected theme and restores it in a fresh service", async () => {
		let serialized: string | null = null;
		const storage = {
			getItem() {
				return serialized;
			},
			setItem(_key: string, value: string) {
				serialized = value;
			},
			removeItem() {
				serialized = null;
			},
		};
		const controller = new PreferencesController(
			new MockPreferencesService({ latencyMs: 0, storage }),
		);
		await controller.load();
		const loaded = controller.getSnapshot();
		if (!("draft" in loaded)) throw new Error("Expected preferences");
		controller.update("appearance", {
			...loaded.draft.appearance,
			theme: "firefly",
		});
		await controller.save();

		const reloaded = new PreferencesController(
			new MockPreferencesService({ latencyMs: 0, storage }),
		);
		await reloaded.load();
		const state = reloaded.getSnapshot();
		if (!("snapshot" in state)) throw new Error("Expected preferences");
		expect(state.snapshot.values.appearance.theme).toBe("firefly");
	});

	test("migrates theme-less preferences to orange without losing other values", async () => {
		const defaults = createDefaultPreferences();
		const legacySnapshot = JSON.stringify({
			values: {
				appearance: {
					density: "compact",
					reduceMotion: true,
				},
				pet: defaults.pet,
				notifications: defaults.notifications,
				calendar: defaults.calendar,
				privacy: {
					...defaults.privacy,
					retentionDays: 90,
				},
			},
			version: 4,
			savedAtMs: 1_800_000_000_000,
		});
		const controller = new PreferencesController(
			new MockPreferencesService({
				latencyMs: 0,
				storage: {
					getItem() {
						return legacySnapshot;
					},
					setItem() {},
					removeItem() {
						throw new Error("Valid legacy settings must not be removed");
					},
				},
			}),
		);

		await controller.load();
		const state = controller.getSnapshot();
		if (!("snapshot" in state)) throw new Error("Expected preferences");
		expect(state.snapshot.version).toBe(4);
		expect(state.snapshot.values.appearance).toEqual({
			theme: "orange",
			density: "compact",
			reduceMotion: true,
		});
		expect(state.snapshot.values.privacy.retentionDays).toBe(90);
	});
});
