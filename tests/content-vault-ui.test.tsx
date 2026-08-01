import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	MonitoringController,
	MonitoringPermissionsControl,
	monitoringSetupStatus,
	type MonitoringService,
	type MonitoringSnapshot,
} from "../src/views/client/features/monitoring/public";

function snapshot(
	interactiveMigrationAvailable: boolean,
	availability: "available" | "migration_required" = "migration_required",
): MonitoringSnapshot {
	return {
		schemaVersion: "monitoring-status.v2",
		state: "running",
		enabled: true,
		captureContent: true,
		paused: false,
		observerConnected: true,
		permissionCheckState: "current",
		permissionsCheckedAtMs: 1_800_000_000_000,
		permissionSetupAvailable: interactiveMigrationAvailable,
		permissionSetupAttempted: interactiveMigrationAvailable,
		permissions: [
			{ id: "accessibility", state: "granted", required: true, detail: null },
			{ id: "screenRecording", state: "granted", required: true, detail: null },
			{ id: "inputMonitoring", state: "granted", required: false, detail: null },
			{
				id: "browserAutomation",
				state: "unavailable",
				required: false,
				detail: null,
			},
		],
		contentVault: {
			availability,
			storageMode:
				availability === "available"
					? "data_protection_keychain"
					: "legacy_development_keychain",
			interactiveMigrationAvailable,
		},
		excludedAppIds: [],
		lastObservationAtMs: null,
		coverageGaps: [],
	};
}

async function renderVault(
	interactiveMigrationAvailable: boolean,
	availability: "available" | "migration_required" = "migration_required",
): Promise<string> {
	let current = snapshot(interactiveMigrationAvailable, availability);
	const service: MonitoringService = {
		async status() {
			return current;
		},
		async configure() {
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
			current = {
				...current,
				contentVault: {
					availability: "available",
					storageMode: "local_login_keychain",
					interactiveMigrationAvailable: false,
				},
			};
			return current;
		},
		async openPermissionSettings() {},
	};
	const controller = new MonitoringController(service);
	await controller.load();
	return renderToStaticMarkup(
		<MonitoringPermissionsControl controller={controller} />,
	);
}

describe("one-time content-vault setup UI", () => {
	test("offers one explicit migration only under a stable signing identity", async () => {
		const markup = await renderVault(true);
		expect(markup).toContain("完成旧版本加密迁移");
		expect(markup).toContain("不会自动执行或删除旧密钥");
		expect((markup.match(/<button/g) ?? []).length).toBe(1);
	});

	test("keeps ad-hoc builds metadata-only without offering a doomed prompt", async () => {
		expect(monitoringSetupStatus(snapshot(false)).phase).toBe("unavailable");
		const markup = await renderVault(false);
		expect(markup).toContain("当前应用没有稳定签名");
		expect(markup).toContain("现阶段只记录不含文本的元数据");
		expect(markup).not.toContain("<button");
		expect(markup).not.toContain("开始一次性设置");
	});

	test("shows a compact button-free state once encrypted storage is ready", async () => {
		const markup = await renderVault(false, "available");
		expect(markup).toContain("本机监测已设置");
		expect(markup).toContain("2/2 项完成");
		expect(markup).not.toContain("<ol");
		expect(markup).not.toContain("<button");
	});
});
