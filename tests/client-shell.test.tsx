import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "../src/views/client/app/AppShell";
import {
	PAGE_IDS,
	PAGE_LABELS,
	isPageId,
} from "../src/views/client/app/navigation";
import { CalendarPage } from "../src/views/client/features/calendar/CalendarPage";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import { PlanningPage } from "../src/views/client/features/planning/PlanningPage";
import { ReportsPage } from "../src/views/client/features/reports/ReportsPage";
import { ReportController } from "../src/views/client/features/reports/ReportController";
import { MockCalendarService } from "../src/views/client/infrastructure/calendar/MockCalendarService";
import { CalendarPlanningGateway } from "../src/views/client/infrastructure/planning/CalendarPlanningGateway";
import { MockPlanningGenerationService } from "../src/views/client/infrastructure/planning/MockPlanningGenerationService";
import { MockReportService } from "../src/views/client/infrastructure/reports/MockReportService";
import { PreferencesController } from "../src/views/client/features/settings/PreferencesController";
import type { PetPresentationBridge } from "../src/views/client/features/pet-bridge/public";
import {
	MonitoringController,
	type MonitoringService,
	type MonitoringSnapshot,
} from "../src/views/client/features/monitoring/public";
import {
	CloudSyncController,
	type CloudSyncService,
} from "../src/views/client/features/settings/public";
import { MockPreferencesService } from "../src/views/client/infrastructure/settings/MockPreferencesService";
import type { AuditExportService } from "../src/views/client/features/audit-export/public";

const notify = () => {};
const shellUser = {
	id: "user-test",
	displayName: "王一鸣",
	email: "demo@whalehall.local",
	initials: "鸣",
};
const calendarService = new MockCalendarService({ latencyMs: 0 });
const planningController = new PlanningController(
	new MockPlanningGenerationService({ latencyMs: 0 }),
	new CalendarPlanningGateway(calendarService),
	() => "2026-07-29",
	() => "Asia/Shanghai",
);
const planningPageProps = {
	controller: planningController,
	onNotify: notify,
	onOpenCalendar: () => {},
	renderSchedulePreview: () => <div>计划草案周视图</div>,
};
const reportController = new ReportController(
	new MockReportService({ latencyMs: 0 }),
	() => "2026-07-29",
);
const preferencesController = new PreferencesController(
	new MockPreferencesService({ latencyMs: 0, storage: null }),
);
const petBridge: PetPresentationBridge = {
	async present() {},
	async setVisible() {},
};
const monitoringSnapshot: MonitoringSnapshot = {
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
	excludedAppIds: [],
	lastObservationAtMs: null,
	tapReady: true,
	lastCallbackAtMs: 1_799_999_999_999,
	lastBucketAtMs: 1_799_999_995_000,
	coverageGaps: [],
};
const monitoringService: MonitoringService = {
	async status() {
		return monitoringSnapshot;
	},
	async configure() {
		return monitoringSnapshot;
	},
	async pause() {
		return monitoringSnapshot;
	},
	async resume() {
		return monitoringSnapshot;
	},
	async requestRequiredPermissions() {
		return monitoringSnapshot;
	},
	async refreshPermissions() {
		return monitoringSnapshot;
	},
	async migrateContentVault() {
		return monitoringSnapshot;
	},
	async openPermissionSettings() {},
};
const monitoringController = new MonitoringController(monitoringService);
const cloudSyncService: CloudSyncService = {
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
const cloudSyncController = new CloudSyncController(cloudSyncService);
await monitoringController.load();
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

describe("client app shell", () => {
	test("defines the stable product destinations including settings", () => {
		expect(PAGE_IDS).toEqual(["planning", "calendar", "reports", "settings"]);
		expect(PAGE_LABELS).toEqual({
			planning: "计划",
			calendar: "日程",
			reports: "成长报告",
			settings: "设置",
		});
		expect(isPageId("calendar")).toBe(true);
		expect(isPageId("settings")).toBe(true);
	});

	test("renders compact navigation and the required user menu trigger", () => {
		const markup = renderToStaticMarkup(
			<AppShell
				user={shellUser}
				onLogout={() => {}}
				calendarService={calendarService}
				planningController={planningController}
				reportController={reportController}
				preferencesController={preferencesController}
				petBridge={petBridge}
				monitoringController={monitoringController}
				cloudSyncController={cloudSyncController}
				auditExportService={auditExportService}
			/>,
		);

		expect(markup).toContain("WhaleHall");
		expect(markup).toContain("工作空间");
		expect(markup).toContain("计划");
		expect(markup).toContain("日程");
		expect(markup).toContain("成长报告");
		expect(markup).toContain('aria-haspopup="menu"');
		expect(markup).toContain("王一鸣");
		expect(markup).toContain("已登录 · 本地就绪");
		expect(markup).toContain("观察中");
		expect(markup).toContain("暂停观察");
		expect(markup).not.toContain("Local tool control room");
	});
});

describe("client page shells", () => {
	test("planning offers a clear first action and an honest empty state", () => {
		planningController.reset();
		const markup = renderToStaticMarkup(<PlanningPage {...planningPageProps} />);

		expect(markup).toContain("制定计划");
		expect(markup).toContain("制定第一个计划");
		expect(markup).toContain("确认后才进入日历");
	});

	test("calendar contains its toolbar, mini month, source controls, and production grid adapter", () => {
		const markup = renderToStaticMarkup(
			<CalendarPage onNotify={notify} service={calendarService} />,
		);

		expect(markup).toContain("2026年7月");
		expect(markup).toContain("创建日程");
		expect(markup).toContain("我的计划");
		expect(markup).toContain("拖选创建");
		expect(markup).toContain("whale-fullcalendar");
		expect(markup).toContain('aria-label="日历视图"');
		expect(markup).not.toContain("视图数据");
	});

	test("calendar exposes deterministic fixtures only through an explicit QA control", () => {
		const markup = renderToStaticMarkup(
			<CalendarPage
				onNotify={notify}
				service={calendarService}
				showScenarioControl
			/>,
		);

		expect(markup).toContain("视图数据");
		expect(markup).toContain("密集日程");
	});

	test("reports share period switching and data-honest quality copy", async () => {
		await reportController.load();
		const markup = renderToStaticMarkup(
			<ReportsPage controller={reportController} />,
		);

		expect(markup).toContain("日报");
		expect(markup).toContain("周报");
		expect(markup).toContain("月报");
		expect(markup).toContain("未采集与未来日期不会计为零");
	});
});
