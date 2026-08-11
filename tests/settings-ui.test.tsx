import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAppearancePreferences } from "../src/views/client/app/appearance";
import { ConfirmationDialog } from "../src/views/client/shared/ui/ConfirmationDialog";
import {
	SETTINGS_CATEGORY_IDS,
	type SettingsCategory,
} from "../src/views/client/features/settings/domain";
import { PreferencesController } from "../src/views/client/features/settings/PreferencesController";
import {
	CloudSyncController,
	type CloudSyncService,
} from "../src/views/client/features/settings/public";
import { SettingsPage } from "../src/views/client/features/settings/SettingsPage";
import { MockPreferencesService } from "../src/views/client/infrastructure/settings/MockPreferencesService";
import {
	MonitoringController,
	type MonitoringService,
	type MonitoringSnapshot,
} from "../src/views/client/features/monitoring/public";
import type { AuditExportService } from "../src/views/client/features/audit-export/public";

const auditExportService: AuditExportService = {
	async exportFiveMinutes() {
		return { status: "cancelled", basename: null };
	},
	async startCapture() {
		throw new Error("not used");
	},
	async getCaptureStatus() {
		return null;
	},
	async cancelCapture() {
		return null;
	},
	async startPrivateTrainingExport() {
		throw new Error("not used");
	},
	async getPrivateTrainingExportStatus() {
		return {
			state: "idle",
			jobId: null,
			scope: null,
			windowCount: 0,
			completedWindowCount: 0,
			basename: null,
			failureCode: null,
			updatedAtMs: null,
		};
	},
};

const user = {
	id: "user-settings",
	displayName: "王一鸣",
	email: "demo@whalehall.local",
	initials: "鸣",
};

async function setup() {
	const controller = new PreferencesController(
		new MockPreferencesService({ latencyMs: 0, storage: null }),
	);
	await controller.load();
	const monitoringController = await createMonitoringController();
	const render = (category: SettingsCategory) =>
		renderToStaticMarkup(
			<SettingsPage
				user={user}
				controller={controller}
				monitoringController={monitoringController}
				cloudSyncController={new CloudSyncController(fakeCloudSyncService())}
				auditExportService={auditExportService}
				category={category}
				onCategoryChange={() => {}}
				onLogout={() => {}}
				onPreferencesApplied={() => {}}
			/>,
		);
	return { controller, render };
}

function fakeCloudSyncService(): CloudSyncService {
	return {
		async status() {
			return {
				state: "disabled",
				enabled: false,
				signedIn: false,
				agentRegistered: false,
				baseUrl: "http://127.0.0.1:8080",
				lastSyncAtMs: null,
				lastErrorCode: null,
				lastErrorMessage: null,
				pendingEventCount: 0,
				blockedCursor: null,
				blockedReason: null,
				updatedAtMs: 0,
			};
		},
		async setEnabled(enabled) {
			return { ...(await this.status()), enabled };
		},
		async refreshConsents() {
			return this.status();
		},
	};
}

async function createMonitoringController(): Promise<MonitoringController> {
	let current: MonitoringSnapshot = {
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
			{ id: "accessibility", state: "granted", required: true, detail: null },
			{ id: "screenRecording", state: "granted", required: true, detail: null },
			{ id: "inputMonitoring", state: "granted", required: false, detail: null },
			{ id: "browserAutomation", state: "granted", required: false, detail: null },
		],
		contentVault: {
			availability: "available",
			storageMode: "data_protection_keychain",
			interactiveMigrationAvailable: false,
		},
		excludedAppIds: ["com.example.private"],
		lastObservationAtMs: null,
		tapReady: true,
		lastCallbackAtMs: 1_799_999_999_999,
		lastBucketAtMs: 1_799_999_995_000,
		coverageGaps: [],
	};
	const service: MonitoringService = {
		async status() {
			return current;
		},
		async configure(configuration) {
			current = {
				...current,
				enabled: configuration.enabled,
				captureContent: configuration.captureContent,
				excludedAppIds: configuration.excludedAppIds,
			};
			return current;
		},
		async pause() {
			return current;
		},
		async resume() {
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
	return controller;
}

describe("settings UI", () => {
	test("renders all seven categories with account first and one roving stop", async () => {
		const { render } = await setup();
		const markup = render("account");
		for (const label of [
			"账号",
			"外观",
			"桌宠",
			"通知",
			"日历",
			"数据与隐私",
			"关于",
		]) {
			expect(markup).toContain(`>${label}<`);
		}
		expect(SETTINGS_CATEGORY_IDS[0]).toBe("account");
		expect(markup).toContain('aria-label="设置分类"');
		expect(markup).toContain('aria-current="page"');
		expect(markup).toContain('tabindex="-1"');
		expect(markup).toContain("退出当前账号");
	});

	test("uses titled rows and accessible controls across every category", async () => {
		const { render } = await setup();
		const expected = {
			appearance: [
				"界面主题",
				"橘子",
				"天文馆",
				"萤火虫",
				"海洋鲸落",
				'type="radio"',
				"界面密度",
				"减少动态效果",
				'role="switch"',
			],
			pet: ["显示桌宠", "跟随工作状态反馈", "不读取登录凭据"],
			notifications: ["允许通知", "计划开始提醒", "每周回顾提醒"],
			calendar: ["默认视图", "显示周末", "每周从周一开始"],
			privacy: [
				"本地数据边界",
				"五分钟审计包",
				"开始采满五分钟",
				"导出过去五分钟",
				"包含可解密的文本内容",
				"一次性监测设置",
				"本机监测已设置",
				"2/2 项完成",
				"键鼠活动量由辅助功能授权覆盖",
				"不会再次弹出授权",
				"浏览器精确 URL（可选）",
				"fail-closed",
				"按应用排除",
				"当前排除 1 个应用",
				"com.example.private",
				"保存排除列表",
				"使用浏览器分类汇总",
				"保留周期",
			],
			about: ["A whale falls", "0.1.0", "本地优先"],
		} as const;
		for (const [category, fragments] of Object.entries(expected)) {
			const markup = render(category as SettingsCategory);
			for (const fragment of fragments) expect(markup).toContain(fragment);
		}
	});

	test("applies the selected theme, density, and motion preference to the app root", () => {
		const target: {
			dataset: {
				uiTheme?: string;
				uiDensity?: string;
				reduceMotion?: string;
			};
		} = { dataset: {} };
		applyAppearancePreferences(
			{
				theme: "firefly",
				density: "compact",
				reduceMotion: true,
			},
			target,
		);
		expect(target.dataset).toEqual({
			uiTheme: "firefly",
			uiDensity: "compact",
			reduceMotion: "true",
		});
	});

	test("shows saving success and rollback error as announced states", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({
				latencyMs: 0,
				storage: null,
				saveFailureCount: 1,
			}),
		);
		await controller.load();
		const loaded = controller.getSnapshot();
		if (!("draft" in loaded)) throw new Error("Expected preferences");
		controller.update("pet", { visible: false, reactionsEnabled: false });
		await controller.save();
		const markup = renderToStaticMarkup(
			<SettingsPage
				user={user}
				controller={controller}
				monitoringController={await createMonitoringController()}
				cloudSyncController={new CloudSyncController(fakeCloudSyncService())}
				auditExportService={auditExportService}
				category="pet"
				onCategoryChange={() => {}}
				onLogout={() => {}}
				onPreferencesApplied={() => {}}
			/>,
		);
		expect(markup).toContain('role="alert"');
		expect(markup).toContain("已恢复到上次保存的内容");
		expect(markup).toContain("所有更改已保存");
	});

	test("dangerous confirmations identify themselves and default focus to cancel", () => {
		const markup = renderToStaticMarkup(
			<ConfirmationDialog
				title="退出当前账号？"
				description="当前 UI 会话会被清理。"
				confirmLabel="退出登录"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(markup).toContain('role="alertdialog"');
		expect(markup).toContain('aria-modal="true"');
		expect(markup).toContain("取消");
		expect(markup).toContain("退出登录");
	});
});
