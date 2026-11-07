import { describe, expect, test } from "bun:test";
import type {
	LocalMonitoringConfigure,
	LocalMonitoringStatus,
	LocalVaultKeyStatus,
} from "../src/shared/contracts";
import {
	ElectrobunMonitoringService,
	type MonitoringTransport,
	toMonitoringSnapshot,
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
		tapReady: true,
		lastCallbackAtMs: 1_799_999_999_999,
		lastBucketAtMs: 1_799_999_995_000,
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
			tapReady: true,
			lastCallbackAtMs: 1_799_999_999_999,
			lastBucketAtMs: 1_799_999_995_000,
		});
		expect(
			snapshot.permissions.map(({ id, state }) => ({ id, state })),
		).toEqual([
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

	test("degrades a nominally running observer when input health is not ready", () => {
		const inputUnavailable = toMonitoringSnapshot(
			nativeStatus({
				tapReady: false,
				permissions: {
					accessibility: "granted",
					screenRecording: "granted",
					inputMonitoring: "granted",
					automation: "unsupported",
				},
			}),
			vaultStatus(),
		);
		expect(inputUnavailable).toMatchObject({
			state: "degraded",
			observerConnected: true,
			tapReady: false,
		});
		expect(inputUnavailable.coverageGaps).toContain("input_sensor_unavailable");

		const disconnected = toMonitoringSnapshot(
			nativeStatus({ helperPid: null, bootId: null, tapReady: false }),
			vaultStatus(),
		);
		expect(disconnected).toMatchObject({
			state: "degraded",
			observerConnected: false,
			tapReady: false,
		});
		expect(disconnected.coverageGaps).toContain("observer_disconnected");

		const permissionRevoked = toMonitoringSnapshot(
			nativeStatus({
				tapReady: false,
				permissions: {
					accessibility: "denied",
					screenRecording: "granted",
					inputMonitoring: "denied",
					automation: "unsupported",
				},
			}),
			vaultStatus(),
		);
		expect(permissionRevoked).toMatchObject({
			state: "degraded",
			observerConnected: true,
			tapReady: false,
		});
		expect(permissionRevoked.coverageGaps).toContain(
			"accessibility_permission_revoked",
		);
	});


});
