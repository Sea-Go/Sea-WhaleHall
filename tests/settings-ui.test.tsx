import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAppearancePreferences } from "../src/views/client/app/appearance";
import { AppUpdateController } from "../src/views/client/features/app-update/public";
import type { AuditExportService } from "../src/views/client/features/audit-export/public";
import {
	MonitoringController,
	type MonitoringService,
	type MonitoringSnapshot,
} from "../src/views/client/features/monitoring/public";
import { ProactiveFeedbackPolicyController } from "../src/views/client/features/proactive-feedback/public";
import { AgentPermissionsController } from "../src/views/client/features/settings/AgentPermissionsController";
import {
	SETTINGS_CATEGORY_IDS,
	type SettingsCategory,
} from "../src/views/client/features/settings/domain";
import { PreferencesController } from "../src/views/client/features/settings/PreferencesController";
import { SettingsPage } from "../src/views/client/features/settings/SettingsPage";
import { ElectrobunAppUpdateService } from "../src/views/client/infrastructure/app-update/ElectrobunAppUpdateService";
import { InMemoryProactiveFeedbackService } from "../src/views/client/infrastructure/proactive-feedback/InMemoryProactiveFeedbackService";
import { MockAgentPermissionsService } from "../src/views/client/infrastructure/settings/MockAgentPermissionsService";
import { MockPreferencesService } from "../src/views/client/infrastructure/settings/MockPreferencesService";
import { ConfirmationDialog } from "../src/views/client/shared/ui/ConfirmationDialog";

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
	const agentPermissionsController = new AgentPermissionsController(
		new MockAgentPermissionsService({ latencyMs: 0 }),
	);
	const proactiveFeedbackPolicyController =
		new ProactiveFeedbackPolicyController(
			new InMemoryProactiveFeedbackService(),
		);
	const appUpdateController = new AppUpdateController(
		new ElectrobunAppUpdateService({
			runtimeAvailable: () => false,
			fallbackCurrentVersion: "0.1.0",
		}),
	);
	await controller.load();
	await appUpdateController.load();
	const monitoringController = await createMonitoringController();
	await agentPermissionsController.load();
	await proactiveFeedbackPolicyController.load();
	const render = (category: SettingsCategory) =>
		renderToStaticMarkup(
			<SettingsPage
				user={user}
				controller={controller}
				monitoringController={monitoringController}
				auditExportService={auditExportService}
				agentPermissionsController={agentPermissionsController}
				proactiveFeedbackPolicyController={proactiveFeedbackPolicyController}
				appUpdateController={appUpdateController}
				category={category}
				onCategoryChange={() => {}}
				onLogout={() => {}}
				onPreferencesApplied={() => {}}
			/>,
		);
	return {
		agentPermissionsController,
		controller,
		proactiveFeedbackPolicyController,
		render,
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
			{
				id: "inputMonitoring",
				state: "granted",
				required: false,
				detail: null,
			},
			{
				id: "browserAutomation",
				state: "granted",
				required: false,
				detail: null,
			},
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
			pet: ["显示桌宠", "跟随工作状态反馈", "登录凭据与 token"],
			notifications: ["允许通知", "计划开始提醒", "每周回顾提醒"],
			calendar: ["默认视图", "显示周末", "每周从周一开始"],
			privacy: [
				"采集、主动反馈与本地数据",
				"五分钟审计包",
				"开始采满五分钟",
				"导出过去五分钟",
				"包含可解密的文本内容",
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
				"启用本地 Agent",
				"允许本地 Agent 读取日历和计划",
				"当前未授权",
				"完整规划窗口内的日历",
				"远端只负责转发模型请求与回答",
				"启用主动反馈",
				"当前系统权限允许采集的活动信息",
				"DataCenter",
				"永久",
				"清除本机主动反馈数据",
				"使用浏览器分类汇总",
				"localStorage 偏好不作为授权来源",
			],
			about: ["A whale falls", "0.1.0", "本地优先"],
		} as const;
		for (const [category, fragments] of Object.entries(expected)) {
			const markup = render(category as SettingsCategory);
			for (const fragment of fragments) expect(markup).toContain(fragment);
		}
	});





});
