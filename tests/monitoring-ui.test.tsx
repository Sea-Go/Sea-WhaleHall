import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	MonitoringController,
	MonitoringPermissionsControl,
	type MonitoringService,
	type MonitoringSnapshot,
	MonitoringStatusControl,
	monitoringSetupStatus,
	parseExcludedAppIds,
} from "../src/views/client/features/monitoring/public";

function monitoringSnapshot(): MonitoringSnapshot {
	return {
		schemaVersion: "monitoring-status.v2",
		state: "degraded",
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
				state: "denied",
				required: true,
				detail: "需要在系统设置中开启",
			},
			{
				id: "inputMonitoring",
				state: "denied",
				required: false,
				detail: null,
			},
			{
				id: "browserAutomation",
				state: "notDetermined",
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
		lastObservationAtMs: null,
		tapReady: true,
		lastCallbackAtMs: 1_799_999_999_999,
		lastBucketAtMs: 1_799_999_995_000,
		coverageGaps: ["screen_recording_denied"],
	};
}

describe("monitoring status UI", () => {
	test("normalizes a user-entered bundle id exclusion list", () => {
		expect(
			parseExcludedAppIds(
				"com.apple.Passwords, com.example.private\ncom.example.private",
			),
		).toEqual({
			ok: true,
			appIds: ["com.apple.Passwords", "com.example.private"],
		});
		expect(parseExcludedAppIds("invalid/bundle")).toMatchObject({
			ok: false,
		});
	});

	test("shows explicit missing permission count without exposing event content", async () => {
		const service: MonitoringService = {
			async status() {
				return monitoringSnapshot();
			},
			async configure() {
				return monitoringSnapshot();
			},
			async pause() {
				return monitoringSnapshot();
			},
			async resume() {
				return monitoringSnapshot();
			},
			async requestRequiredPermissions() {
				return monitoringSnapshot();
			},
			async refreshPermissions() {
				return monitoringSnapshot();
			},
			async migrateContentVault() {
				return monitoringSnapshot();
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringStatusControl
				controller={controller}
				onOpenPrivacy={() => {}}
			/>,
		);
		expect(markup).toContain("权限不完整");
		expect(markup).toContain("还有 1 项系统权限待完成");
		expect(markup).toContain("修复监测设置");
		expect(markup).not.toContain("暂停观察");
		expect(markup).not.toContain("screen_recording_denied");
	});








});
