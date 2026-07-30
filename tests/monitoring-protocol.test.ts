import { describe, expect, test } from "bun:test";
import { LocalToolClient } from "../src/agent/local-tool-client";
import {
	isLocalMonitoringConfigure,
	isLocalMonitoringRefreshPermissions,
	isLocalMonitoringStatus,
	type LocalMonitoringStatus,
} from "../src/agent/local-protocol";

function status(
	overrides: Partial<LocalMonitoringStatus> = {},
): LocalMonitoringStatus {
	return {
		state: "running",
		enabled: true,
		captureContent: true,
		excludedBundleIds: ["com.example.private"],
		helperPid: 7002,
		helperPathAvailable: true,
		bootId: "boot-ABC-123",
		lastSequence: 9,
		lastAckedSequence: 9,
		lastHeartbeatAtMs: 1_800_000_000_000,
		permissions: {
			accessibility: "granted",
			screenRecording: "granted",
			inputMonitoring: "granted",
			automation: "not_determined",
		},
		permissionCheckState: "current",
		permissionsCheckedAtMs: 1_800_000_000_000,
		coverage: ["content", "metadata"],
		lastError: null,
		...overrides,
	};
}

describe("monitoring local protocol", () => {
	test("accepts the exact Rust status and rejects widened responses", () => {
		expect(isLocalMonitoringStatus(status())).toBeTrue();
		expect(
			isLocalMonitoringStatus({
				...status(),
				unexpected: true,
			}),
		).toBeFalse();
		expect(
			isLocalMonitoringStatus(
				status({
					excludedBundleIds: [
						"com.example.duplicate",
						"com.example.duplicate",
					],
				}),
			),
		).toBeFalse();
		expect(
			isLocalMonitoringStatus(status({ bootId: "boot/id" })),
		).toBeFalse();
		expect(
			isLocalMonitoringStatus(
				status({
					permissionCheckState: "unchecked",
					permissionsCheckedAtMs: 1,
				}),
			),
		).toBeFalse();
		expect(
			isLocalMonitoringStatus(
				status({
					permissionCheckState: "current",
					permissionsCheckedAtMs: null,
				}),
			),
		).toBeFalse();
		expect(
			isLocalMonitoringStatus(
				status({ coverage: ["metadata", "metadata"] }),
			),
		).toBeFalse();
	});

	test("mirrors Rust configure and refresh parameter constraints", () => {
		expect(
			isLocalMonitoringConfigure({
				enabled: true,
				captureContent: false,
				excludedBundleIds: [],
			}),
		).toBeTrue();
		expect(
			isLocalMonitoringConfigure({
				enabled: true,
				captureContent: false,
				excludedBundleIds: ["a", "a"],
			}),
		).toBeFalse();
		expect(
			isLocalMonitoringConfigure({
				enabled: true,
				captureContent: false,
				excludedBundleIds: ["é".repeat(129)],
			}),
		).toBeFalse();
		expect(isLocalMonitoringRefreshPermissions({})).toBeTrue();
		expect(
			isLocalMonitoringRefreshPermissions({ prompt: true }),
		).toBeTrue();
		expect(
			isLocalMonitoringRefreshPermissions({
				prompt: true,
				unexpected: true,
			}),
		).toBeFalse();
	});

	test("fails malformed calls before writing to the native process", async () => {
		const client = new LocalToolClient("/missing/whalehall-local");
		await expect(
			client.configureMonitoring({
				enabled: true,
				captureContent: true,
				excludedBundleIds: ["duplicate", "duplicate"],
			}),
		).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
		await expect(
			client.refreshMonitoringPermissions({
				prompt: "yes",
			} as never),
		).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
	});
});
