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
				required: true,
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
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(markup).toContain("权限不完整");
		expect(markup).toContain("缺少 2 项系统权限");
		expect(markup).toContain("打开隐私设置");
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
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(markup).toContain("未启用");
		expect(markup).toContain("启用本机观察");
		expect(markup).toContain("隐私设置");
		expect(markup).not.toContain("暂停观察");
		expect(markup).not.toContain("恢复观察");
	});
});
