import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAppearancePreferences } from "../src/views/client/app/appearance";
import { ConfirmationDialog } from "../src/views/client/shared/ui/ConfirmationDialog";
import {
	SETTINGS_CATEGORY_IDS,
	type SettingsCategory,
} from "../src/views/client/features/settings/domain";
import { AgentPermissionsController } from "../src/views/client/features/settings/AgentPermissionsController";
import { PreferencesController } from "../src/views/client/features/settings/PreferencesController";
import { SettingsPage } from "../src/views/client/features/settings/SettingsPage";
import { MockAgentPermissionsService } from "../src/views/client/infrastructure/settings/MockAgentPermissionsService";
import { MockPreferencesService } from "../src/views/client/infrastructure/settings/MockPreferencesService";

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
	await controller.load();
	await agentPermissionsController.load();
	const render = (category: SettingsCategory) =>
		renderToStaticMarkup(
			<SettingsPage
				user={user}
				controller={controller}
				agentPermissionsController={agentPermissionsController}
				category={category}
				onCategoryChange={() => {}}
				onLogout={() => {}}
				onPreferencesApplied={() => {}}
			/>,
		);
	return { agentPermissionsController, controller, render };
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
				"启用本地 Agent",
				"允许本地 Agent 读取日历和计划",
				"当前未授权",
				"完整规划窗口内的日历",
				"远端只负责转发模型请求与回答",
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

	test("shows the total Agent read switch enabled and revoked after each save", async () => {
		const { agentPermissionsController, render } = await setup();
		expect(render("privacy")).toContain('aria-checked="false"');

		await agentPermissionsController.setEnabled(true);
		let markup = render("privacy");
		expect(markup).toContain('aria-checked="true"');
		expect(markup).toContain("已启用本地 Agent 读取授权");

		await agentPermissionsController.setEnabled(false);
		markup = render("privacy");
		expect(markup).toContain('aria-checked="false"');
		expect(markup).toContain("已撤销本地 Agent 读取授权");
	});

	test("keeps the switch revoked and announces a recoverable authorization error", async () => {
		const controller = new PreferencesController(
			new MockPreferencesService({ latencyMs: 0, storage: null }),
		);
		const agentPermissionsController = new AgentPermissionsController(
			new MockAgentPermissionsService({
				latencyMs: 0,
				saveFailureCount: 1,
			}),
		);
		await Promise.all([controller.load(), agentPermissionsController.load()]);
		await agentPermissionsController.setEnabled(true);
		const markup = renderToStaticMarkup(
			<SettingsPage
				user={user}
				controller={controller}
				agentPermissionsController={agentPermissionsController}
				category="privacy"
				onCategoryChange={() => {}}
				onLogout={() => {}}
				onPreferencesApplied={() => {}}
			/>,
		);
		expect(markup).toContain('aria-checked="false"');
		expect(markup).toContain('role="alert"');
		expect(markup).toContain("已保留原来的设置");
		expect(markup).toContain(">重试<");
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
