import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	MonitoringController,
	MonitoringPermissionsControl,
	parseExcludedAppIds,
	MonitoringStatusControl,
	monitoringSetupStatus,
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
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(markup).toContain("权限不完整");
		expect(markup).toContain("还有 1 项系统权限待完成");
		expect(markup).toContain("修复监测设置");
		expect(markup).not.toContain("暂停观察");
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
			async requestRequiredPermissions() {
				return monitoringSnapshot();
			},
			async refreshPermissions() {
				throw new Error("must not refresh while disabled");
			},
			async migrateContentVault() {
				throw new Error("must not migrate while disabled");
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(markup).toContain("未启用");
		expect(markup).toContain("设置本机监测");
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
			async requestRequiredPermissions() {
				return unchecked;
			},
			async refreshPermissions() {
				return unchecked;
			},
			async migrateContentVault() {
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

	test("after the one-time request, directs missing permissions to System Settings", async () => {
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
			<MonitoringPermissionsControl controller={controller} />,
		);
		expect(markup).toContain("一次性监测设置");
		expect(markup).toContain("辅助功能");
		expect(markup).toContain("屏幕录制");
		expect(markup).toContain(
			"键鼠活动量由辅助功能授权覆盖，不再单独请求输入监控权限",
		);
		expect(markup).not.toContain("<strong>输入监控</strong>");
		expect(markup).toContain("已经请求过一次");
		expect(markup).toContain("打开屏幕录制设置");
		expect((markup.match(/<button/g) ?? []).length).toBe(1);
		expect(markup).toContain("<details");
		expect(markup).not.toContain("<details open");
		expect(markup).toContain("fail-closed");
		expect(markup).not.toContain("重新检查");
		expect(markup).not.toContain("在系统设置中查看");
	});

	test("offers the dedicated setup action only before the identity marker exists", async () => {
		const firstRun = {
			...monitoringSnapshot(),
			permissionSetupAvailable: true,
			permissionSetupAttempted: false,
		};
		const service: MonitoringService = {
			async status() {
				return firstRun;
			},
			async configure() {
				return firstRun;
			},
			async pause() {
				return firstRun;
			},
			async resume() {
				return firstRun;
			},
			async requestRequiredPermissions() {
				return {
					...firstRun,
					permissionSetupAttempted: true,
				};
			},
			async refreshPermissions() {
				return firstRun;
			},
			async migrateContentVault() {
				return firstRun;
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringPermissionsControl controller={controller} />,
		);
		expect(markup).toContain("开始一次性设置");
		expect(markup).not.toContain("已经请求过一次");
	});

	test("collapses completed setup to a button-free ready state", async () => {
		const ready = {
			...monitoringSnapshot(),
			state: "running" as const,
			permissions: monitoringSnapshot().permissions.map((permission) => ({
				...permission,
				state:
					permission.id === "inputMonitoring" ||
					permission.id === "browserAutomation"
						? ("denied" as const)
						: ("granted" as const),
			})),
			coverageGaps: [],
		};
		const service: MonitoringService = {
			async status() {
				return ready;
			},
			async configure() {
				return ready;
			},
			async pause() {
				return ready;
			},
			async resume() {
				return ready;
			},
			async requestRequiredPermissions() {
				return ready;
			},
			async refreshPermissions() {
				return ready;
			},
			async migrateContentVault() {
				return ready;
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<MonitoringPermissionsControl controller={controller} />,
		);
		expect(monitoringSetupStatus(ready).phase).toBe("ready");
		expect(monitoringSetupStatus(ready).permissions.map(({ id }) => id)).toEqual([
			"accessibility",
			"screenRecording",
		]);
		expect(markup).toContain("本机监测已设置");
		expect(markup).toContain("2/2 项完成");
		expect(markup).not.toContain("<ol");
		expect(markup).not.toContain("本地内容加密</strong>");
		expect(markup).not.toContain("<button");
		expect(markup).toContain("浏览器精确 URL（可选）");
	});

	test("does not offer setup when an ad-hoc build cannot safely open the vault", async () => {
		const adHoc = {
			...monitoringSnapshot(),
			state: "disabled" as const,
			enabled: false,
			captureContent: false,
			permissionSetupAvailable: false,
			permissionSetupAttempted: false,
			contentVault: {
				availability: "migration_required" as const,
				storageMode: "legacy_development_keychain" as const,
				interactiveMigrationAvailable: false,
			},
		};
		const service: MonitoringService = {
			async status() {
				return adHoc;
			},
			async configure() {
				throw new Error("must not configure an unsafe build");
			},
			async pause() {
				return adHoc;
			},
			async resume() {
				return adHoc;
			},
			async requestRequiredPermissions() {
				throw new Error("must not request TCC consent for an unsafe build");
			},
			async refreshPermissions() {
				return adHoc;
			},
			async migrateContentVault() {
				return adHoc;
			},
			async openPermissionSettings() {},
		};
		const controller = new MonitoringController(service);
		await controller.load();
		expect(monitoringSetupStatus(adHoc).phase).toBe("unavailable");
		const settingsMarkup = renderToStaticMarkup(
			<MonitoringPermissionsControl controller={controller} />,
		);
		const sidebarMarkup = renderToStaticMarkup(
			<MonitoringStatusControl controller={controller} onOpenPrivacy={() => {}} />,
		);
		expect(settingsMarkup).toContain("当前应用没有稳定签名");
		expect(settingsMarkup).not.toContain("<button");
		expect(sidebarMarkup).not.toContain("设置本机监测");
		expect(sidebarMarkup).not.toContain("修复监测设置");
		expect(sidebarMarkup).not.toContain("<button");
	});
});
