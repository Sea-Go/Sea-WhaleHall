import { describe, expect, test } from "bun:test";
import type {
	LocalMonitoringConfigure,
	LocalMonitoringStatus,
	LocalVaultKeyStatus,
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
		permissionSetupAvailable: true,
		permissionSetupAttempted: true,
		coverage: ["metadata", "denied"],
		lastError: null,
		...overrides,
	};
}

function vaultStatus(
	overrides: Partial<LocalVaultKeyStatus> = {},
): LocalVaultKeyStatus {
	return {
		availability: "available",
		storageMode: "data_protection_keychain",
		keyVersion: "keychain-v1",
		interactiveMigrationAvailable: false,
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
		expect(
			snapshot.permissions.find(({ id }) => id === "browserAutomation")
				?.required,
		).toBe(false);
		expect(
			snapshot.permissions.find(({ id }) => id === "inputMonitoring")?.required,
		).toBe(false);
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

	test("forwards explicit configuration and keeps permission refresh silent", async () => {
		const calls: {
			configured?: LocalMonitoringConfigure;
			refreshes: number;
			setups: number;
			openedPermission?: string;
			migrated?: boolean;
		} = { refreshes: 0, setups: 0 };
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
			async refreshPermissions() {
				calls.refreshes += 1;
				return nativeStatus();
			},
			async setupPermissions() {
				calls.setups += 1;
				return nativeStatus();
			},
			async vaultStatus() {
				return vaultStatus();
			},
			async migrateLegacyVault() {
				calls.migrated = true;
				return {
					status: "completed",
					result: {
						migrated: true,
						status: vaultStatus(),
					},
				};
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
		await service.status();
		await service.pause();
		await service.resume();
		await service.refreshPermissions();
		await service.requestRequiredPermissions();
		await service.migrateContentVault();
		await service.openPermissionSettings("screenRecording");
		expect(calls.configured).toEqual({
			enabled: true,
			captureContent: false,
			excludedBundleIds: ["com.example.private"],
		});
		expect(calls.refreshes).toBe(1);
		expect(calls.setups).toBe(1);
		expect(calls.migrated).toBe(true);
		expect(calls.openedPermission).toBe("screenRecording");
	});
});
