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
				required: true,
				detail: null,
			},
			{
				id: "browserAutomation",
				state: "granted",
				required: false,
				detail: null,
			},
		],
		excludedAppIds: [],
		lastObservationAtMs: 1_800_000_000_000,
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
			async refreshPermissions() {
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
			async refreshPermissions() {
				throw new Error("system settings unavailable");
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

	test("deduplicates concurrent native operations", async () => {
		let resolveStatus: (value: MonitoringSnapshot) => void = () => {};
		const service: MonitoringService = {
			status() {
				return new Promise((resolve) => {
					resolveStatus = resolve;
				});
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
			async refreshPermissions() {
				return snapshot();
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		const first = controller.load();
		const second = controller.load();
		expect(first).toBe(second);
		resolveStatus(snapshot());
		await first;
	});

	test("enables a disabled observer only through explicit configure", async () => {
		let configured = false;
		const service: MonitoringService = {
			async status() {
				return snapshot({
					state: "disabled",
					enabled: false,
					paused: false,
					captureContent: false,
				});
			},
			async configure(configuration) {
				configured = true;
				expect(configuration).toEqual({
					enabled: true,
					captureContent: false,
					excludedAppIds: [],
				});
				return snapshot();
			},
			async pause() {
				throw new Error("disabled observer cannot pause");
			},
			async resume() {
				throw new Error("disabled observer cannot resume");
			},
			async refreshPermissions() {
				throw new Error("disabled observer cannot refresh");
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		expect(configured).toBe(false);
		await controller.enable();
		expect(configured).toBe(true);
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			snapshot: { state: "running", enabled: true },
		});
	});
});
