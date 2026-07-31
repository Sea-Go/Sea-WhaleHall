import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	MonitoringController,
	parseExcludedAppIds,
	MonitoringStatusControl,
	type MonitoringService,
	type MonitoringSnapshot,
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
				state: "granted",
				required: true,
				detail: null,
			},
			{
				id: "browserAutomation",
				state: "notDetermined",
				required: false,
				detail: null,
			},
		],
		excludedAppIds: [],
		lastObservationAtMs: null,
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
			async refreshPermissions() {
				return monitoringSnapshot();
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(markup).toContain("权限不完整");
		expect(markup).toContain("缺少 1 项系统权限");
		expect(markup).toContain("查看权限详情");
		expect(markup).toContain("暂停观察");
		expect(markup).not.toContain("screen_recording_denied");
	});

	test("offers an explicit enable action without treating mock privacy preferences as consent", async () => {
		const service: MonitoringService = {
			async status() {
				return {
					...monitoringSnapshot(),
					state: "disabled",
					enabled: false,
					observerConnected: false,
				};
			},
			async configure() {
				return monitoringSnapshot();
			},
			async pause() {
				throw new Error("must not pause while disabled");
			},
			async resume() {
				throw new Error("must not resume while disabled");
			},
			async refreshPermissions() {
				throw new Error("must not refresh while disabled");
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(markup).toContain("未启用");
		expect(markup).toContain("启用本机观察");
		expect(markup).toContain("数据与隐私");
		expect(markup).not.toContain("暂停观察");
		expect(markup).not.toContain("恢复观察");
	});

	test("does not report unchecked permission values as missing", async () => {
		const unchecked = {
			...monitoringSnapshot(),
			permissionCheckState: "unchecked" as const,
			permissionsCheckedAtMs: null,
			permissions: monitoringSnapshot().permissions.map((permission) => ({
				...permission,
				state: "unknown" as const,
			})),
		};
		const service: MonitoringService = {
			async status() {
				return unchecked;
			},
			async configure() {
				return unchecked;
			},
			async pause() {
				return unchecked;
			},
			async resume() {
				return unchecked;
			},
			async refreshPermissions() {
				return unchecked;
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(markup).not.toContain("缺少 4 项系统权限");
	});
});
