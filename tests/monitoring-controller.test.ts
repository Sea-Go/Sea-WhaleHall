import { describe, expect, test } from "bun:test";
import {
	MonitoringController,
	type MonitoringService,
	type MonitoringSnapshot,
} from "../src/views/client/features/monitoring/public";

function snapshot(
	overrides: Partial<MonitoringSnapshot> = {},
): MonitoringSnapshot {
	return {
		schemaVersion: "monitoring-status.v2",
		state: "running",
		enabled: true,
		captureContent: true,
		paused: false,
		observerConnected: true,
		permissionCheckState: "current",
		permissionsCheckedAtMs: 1_800_000_000_000,
		permissionSetupAvailable: true,
		permissionSetupAttempted: true,
		permissions: [
			{
				id: "accessibility",
				state: "granted",
				required: true,
				detail: null,
			},
			{
				id: "screenRecording",
				state: "granted",
				required: true,
				detail: null,
			},
			{
				id: "inputMonitoring",
				state: "granted",
				required: false,
				detail: null,
			},
			{
				id: "browserAutomation",
				state: "granted",
				required: false,
				detail: null,
			},
		],
		contentVault: {
			availability: "available",
			storageMode: "data_protection_keychain",
			interactiveMigrationAvailable: false,
		},
		excludedAppIds: [],
		lastObservationAtMs: 1_800_000_000_000,
		tapReady: true,
		lastCallbackAtMs: 1_799_999_999_999,
		lastBucketAtMs: 1_799_999_995_000,
		coverageGaps: [],
		...overrides,
	};
}

describe("MonitoringController", () => {
	test("loads, pauses, and resumes through the native service", async () => {
		let current = snapshot();
		const service: MonitoringService = {
			async status() {
				return current;
			},
			async configure(configuration) {
				current = snapshot({
					state: configuration.enabled ? "running" : "disabled",
					enabled: configuration.enabled,
					captureContent: configuration.captureContent,
					excludedAppIds: configuration.excludedAppIds,
				});
				return current;
			},
			async pause() {
				current = snapshot({ state: "paused", paused: true });
				return current;
			},
			async resume() {
				current = snapshot();
				return current;
			},
			async requestRequiredPermissions() {
				return current;
			},
			async refreshPermissions() {
				return current;
			},
			async migrateContentVault() {
				return current;
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			snapshot: { state: "running" },
		});
		await controller.pause();
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			snapshot: { state: "paused", paused: true },
		});
		await controller.resume();
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			snapshot: { state: "running", paused: false },
		});
	});

	test("preserves the last status when a refresh fails", async () => {
		let fail = false;
		const service: MonitoringService = {
			async status() {
				if (fail) throw new Error("native unavailable");
				return snapshot();
			},
			async configure() {
				return snapshot();
			},
			async pause() {
				return snapshot({ state: "paused", paused: true });
			},
			async resume() {
				return snapshot();
			},
			async requestRequiredPermissions() {
				return snapshot();
			},
			async refreshPermissions() {
				throw new Error("system settings unavailable");
			},
			async migrateContentVault() {
				return snapshot();
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		fail = true;
		await controller.load({ background: true });
		expect(controller.getSnapshot()).toMatchObject({
			status: "error",
			retryable: true,
			snapshot: { state: "running" },
		});
	});





});
