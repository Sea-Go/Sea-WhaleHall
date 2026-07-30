import { describe, expect, test } from "bun:test";
import type {
	LocalMonitoringConfigure,
	LocalMonitoringStatus,
} from "../src/shared/contracts";
import {
	ElectrobunMonitoringService,
	toMonitoringSnapshot,
	type MonitoringTransport,
} from "../src/views/client/infrastructure/monitoring/ElectrobunMonitoringService";

function nativeStatus(
	overrides: Partial<LocalMonitoringStatus> = {},
): LocalMonitoringStatus {
	return {
		state: "running",
		enabled: true,
		captureContent: true,
		excludedBundleIds: ["com.example.excluded"],
		helperPid: 42,
		helperPathAvailable: true,
		bootId: "boot-1",
		lastSequence: 9,
		lastAckedSequence: 9,
		lastHeartbeatAtMs: 1_800_000_000_000,
		permissions: {
			accessibility: "granted",
			screenRecording: "denied",
			inputMonitoring: "not_determined",
			automation: "unknown",
		},
		permissionCheckState: "current",
		permissionsCheckedAtMs: 1_800_000_000_000,
		coverage: ["metadata", "denied"],
		lastError: null,
		...overrides,
	};
}

describe("ElectrobunMonitoringService", () => {
	test("maps the native contract without exposing observer errors as content", () => {
		const snapshot = toMonitoringSnapshot(
			nativeStatus({ lastError: "private window title must stay native-only" }),
		);
		expect(snapshot).toMatchObject({
			state: "running",
			enabled: true,
			captureContent: true,
			observerConnected: true,
			excludedAppIds: ["com.example.excluded"],
			lastObservationAtMs: null,
		});
		expect(snapshot.permissions.map(({ id, state }) => ({ id, state }))).toEqual([
			{ id: "accessibility", state: "granted" },
			{ id: "screenRecording", state: "denied" },
			{ id: "inputMonitoring", state: "notDetermined" },
			{ id: "browserAutomation", state: "unknown" },
		]);
		expect(snapshot.coverageGaps).toEqual(["denied", "observer_error"]);
		expect(JSON.stringify(snapshot)).not.toContain("private window title");
	});

	test("does not load Electrobun while running in a browser or SSR", async () => {
		let loaded = false;
		const service = new ElectrobunMonitoringService({
			runtimeAvailable: () => false,
			loadTransport: async () => {
				loaded = true;
				throw new Error("must not load");
			},
		});
		const snapshot = await service.status();
		expect(loaded).toBe(false);
		expect(snapshot).toMatchObject({
			state: "unavailable",
			enabled: false,
			observerConnected: false,
		});
		const appModule = await import("../src/views/client/App");
		expect(typeof appModule.App).toBe("function");
	});

	test("forwards explicit configuration and prompts permission refresh", async () => {
		const calls: {
			configured?: LocalMonitoringConfigure;
			refreshPrompt?: boolean;
			openedPermission?: string;
		} = {};
		const transport: MonitoringTransport = {
			async status() {
				return nativeStatus();
			},
			async configure(configuration) {
				calls.configured = configuration;
				return nativeStatus({
					enabled: configuration.enabled,
					captureContent: configuration.captureContent,
					excludedBundleIds: configuration.excludedBundleIds,
				});
			},
			async pause() {
				return nativeStatus({ state: "paused" });
			},
			async resume() {
				return nativeStatus();
			},
			async refreshPermissions(prompt) {
				calls.refreshPrompt = prompt;
				return nativeStatus();
			},
			async openPermissionSettings(permission) {
				calls.openedPermission = permission;
				return { opened: true };
			},
		};
		const service = new ElectrobunMonitoringService({
			runtimeAvailable: () => true,
			loadTransport: async () => transport,
		});
		await service.configure({
			enabled: true,
			captureContent: false,
			excludedAppIds: ["com.example.private"],
		});
		await service.refreshPermissions();
		await service.openPermissionSettings("screenRecording");
		expect(calls.configured).toEqual({
			enabled: true,
			captureContent: false,
			excludedBundleIds: ["com.example.private"],
		});
		expect(calls.refreshPrompt).toBe(true);
		expect(calls.openedPermission).toBe("screenRecording");
	});
});
