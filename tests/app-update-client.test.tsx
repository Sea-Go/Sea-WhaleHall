import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
	type AppUpdateReleaseSummary,
	type AppUpdateSnapshot,
} from "../src/shared/app-update";
import {
	AppUpdateController,
	type AppUpdateService,
	releaseNotesToPlainText,
	UpdateStatusControl,
} from "../src/views/client/features/app-update/public";
import {
	ElectrobunAppUpdateService,
	parseAppUpdateSnapshot,
} from "../src/views/client/infrastructure/app-update/ElectrobunAppUpdateService";

const release: AppUpdateReleaseSummary = {
	version: "0.2.0",
	minimumSupportedVersion: "0.1.0",
	mandatory: false,
	publishedAt: "2026-08-13T08:00:00.000Z",
	releaseNotes: "修复桌宠反馈\n提升客户端稳定性",
};

function snapshot(
	state: "idle" | "checking" | "up_to_date" = "up_to_date",
): AppUpdateSnapshot {
	return {
		schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
		state,
		currentVersion: "0.1.0",
		checkedAtMs: 1_786_588_800_000,
	};
}

function available(
	overrides: Partial<AppUpdateReleaseSummary> = {},
): AppUpdateSnapshot {
	return {
		schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
		state: "available",
		currentVersion: "0.1.0",
		checkedAtMs: 1_786_588_800_000,
		release: { ...release, ...overrides },
	};
}

class FakeAppUpdateService implements AppUpdateService {
	current: AppUpdateSnapshot;
	getStatusCalls = 0;
	checkCalls = 0;
	downloadCalls = 0;
	installCalls = 0;
	private readonly listeners = new Set<(snapshot: AppUpdateSnapshot) => void>();

	constructor(initial: AppUpdateSnapshot) {
		this.current = initial;
	}

	async getStatus() {
		this.getStatusCalls += 1;
		return this.current;
	}

	async check() {
		this.checkCalls += 1;
		return this.current;
	}

	async download() {
		this.downloadCalls += 1;
		this.current = {
			schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
			state: "ready",
			currentVersion: "0.1.0",
			checkedAtMs: 1_786_588_800_000,
			release: { ...release },
		};
		return this.current;
	}

	async installAndRestart() {
		this.installCalls += 1;
		this.current = {
			schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
			state: "installing",
			currentVersion: "0.1.0",
			checkedAtMs: 1_786_588_800_000,
			release: { ...release },
		};
		return this.current;
	}

	subscribe(listener: (snapshot: AppUpdateSnapshot) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(next: AppUpdateSnapshot) {
		this.current = next;
		for (const listener of this.listeners) listener(next);
	}
}

describe("app update client controller", () => {
	test("loads and subscribes without owning background checks or mandatory policy", async () => {
		const service = new FakeAppUpdateService(
			available({ mandatory: true, minimumSupportedVersion: "0.2.0" }),
		);
		const controller = new AppUpdateController(service);
		controller.start();
		await Bun.sleep(0);

		expect(service.getStatusCalls).toBe(1);
		expect(service.checkCalls).toBe(0);
		expect(service.downloadCalls).toBe(0);
		expect(service.installCalls).toBe(0);

		service.emit({
			schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
			state: "downloading",
			currentVersion: "0.1.0",
			checkedAtMs: 1_786_588_800_000,
			release: { ...release, mandatory: true },
			progress: { receivedBytes: 25, totalBytes: 100, percent: 25 },
		});
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			snapshot: { state: "downloading" },
		});
		controller.stop();
	});

	test("keeps download and install as explicit single-flight actions", async () => {
		const service = new FakeAppUpdateService(available());
		const controller = new AppUpdateController(service);
		await controller.load();
		await Promise.all([controller.download(), controller.download()]);
		expect(service.downloadCalls).toBe(1);
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			snapshot: { state: "ready" },
		});

		await controller.installAndRestart();
		expect(service.installCalls).toBe(1);
		expect(controller.getSnapshot()).toMatchObject({
			snapshot: { state: "installing" },
		});
	});
});

describe("app update client UI", () => {
	test("renders a persistent optional update banner with a download action", async () => {
		const controller = new AppUpdateController(
			new FakeAppUpdateService(available()),
		);
		await controller.load();
		const markup = renderToStaticMarkup(
			<UpdateStatusControl controller={controller} />,
		);

		expect(markup).toContain("WhaleHall v0.2.0 可以下载");
		expect(markup).toContain("下载更新");
		expect(markup).toContain('role="status"');
	});

	test("shows dynamic versions, release notes and download progress in About", async () => {
		const service = new FakeAppUpdateService({
			schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
			state: "downloading",
			currentVersion: "0.1.7",
			checkedAtMs: 1_786_588_800_000,
			release: { ...release, version: "0.3.0" },
			progress: {
				receivedBytes: 25 * 1024 * 1024,
				totalBytes: 100 * 1024 * 1024,
				percent: 25,
			},
		});
		const controller = new AppUpdateController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<UpdateStatusControl controller={controller} variant="settings" />,
		);

		expect(markup).toContain("v0.1.7");
		expect(markup).toContain("v0.3.0");
		expect(markup).toContain("Stable");
		expect(markup).toContain("修复桌宠反馈");
		expect(markup).toContain('aria-valuenow="25"');
		expect(markup).toContain("25 MB");
		expect(markup).toContain("100 MB");
	});

	test("projects release-note Markdown to inert readable text", async () => {
		const markdown = [
			"# 重点更新",
			"",
			"- **修复桌宠反馈**",
			"- 查看 [更新详情](javascript:alert(1))",
			"- ![远程图片](https://invalid.example/tracking.png)",
			"<b>HTML 保持普通文字</b>",
			"**未闭合标记",
			"\\**转义标记也不泄漏",
		].join("\n");
		const service = new FakeAppUpdateService(
			available({ releaseNotes: markdown }),
		);
		const controller = new AppUpdateController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<UpdateStatusControl controller={controller} variant="settings" />,
		);

		expect(releaseNotesToPlainText(markdown)).toBe(
			[
				"重点更新",
				"",
				"• 修复桌宠反馈",
				"• 查看 更新详情",
				"• 远程图片",
				"<b>HTML 保持普通文字</b>",
				"未闭合标记",
				"转义标记也不泄漏",
			].join("\n"),
		);
		expect(markup).not.toContain("**");
		expect(markup).not.toContain("javascript:");
		expect(markup).not.toContain("tracking.png");
		expect(markup).not.toContain("<b>");
		expect(markup).not.toContain("<a");
		expect(markup).not.toContain("<img");
		expect(markup).toContain("修复桌宠反馈");
		expect(markup).toContain("&lt;b&gt;HTML 保持普通文字&lt;/b&gt;");
	});

	test("marks mandatory ready-to-install updates as non-dismissible", async () => {
		const service = new FakeAppUpdateService({
			schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
			state: "ready",
			currentVersion: "0.1.0",
			checkedAtMs: 1_786_588_800_000,
			release: {
				...release,
				mandatory: true,
				minimumSupportedVersion: "0.2.0",
			},
		});
		const controller = new AppUpdateController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<UpdateStatusControl controller={controller} variant="settings" />,
		);

		expect(markup).toContain("必须更新");
		expect(markup).toContain("立即重启安装");
		expect(markup).not.toContain("稍后");
		expect(markup).not.toContain("跳过");
	});
});

describe("Electrobun app update adapter", () => {
	test("maps the four RPC actions and status subscription", async () => {
		let listener: ((value: AppUpdateSnapshot) => void) | null = null;
		const calls: string[] = [];
		const service = new ElectrobunAppUpdateService({
			runtimeAvailable: () => false,
			client: {
				async getAppUpdateStatus() {
					calls.push("status");
					return snapshot();
				},
				async checkForAppUpdate() {
					calls.push("check");
					return available();
				},
				async downloadAppUpdate() {
					calls.push("download");
					return available();
				},
				async installAppUpdateAndRestart() {
					calls.push("install");
					return available();
				},
				onAppUpdateStatus(next) {
					listener = next;
					return () => {
						listener = null;
					};
				},
			},
		});

		const pushed: AppUpdateSnapshot[] = [];
		const unsubscribe = service.subscribe((value) => pushed.push(value));
		await Bun.sleep(0);
		await service.getStatus();
		await service.check();
		await service.download();
		await service.installAndRestart();
		const emitStatus = listener as ((value: AppUpdateSnapshot) => void) | null;
		emitStatus?.(available({ version: "0.4.0" }));

		expect(calls).toEqual(["status", "check", "download", "install"]);
		expect(pushed[0]).toMatchObject({
			state: "available",
			release: { version: "0.4.0" },
		});
		unsubscribe();
	});

	test("rejects malformed bridge snapshots", () => {
		expect(() =>
			parseAppUpdateSnapshot({
				schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
				state: "downloading",
				currentVersion: "0.1.0",
				checkedAtMs: 1,
				release,
				progress: { receivedBytes: 5, totalBytes: 4, percent: 140 },
			}),
		).toThrow("invalid snapshot");
	});

	test("requires exact state, release, progress and failure shapes", () => {
		expect(() =>
			parseAppUpdateSnapshot({ ...available(), unexpected: true }),
		).toThrow("invalid snapshot");
		expect(() =>
			parseAppUpdateSnapshot({
				...available(),
				progress: { receivedBytes: 1, totalBytes: 2, percent: 50 },
			}),
		).toThrow("invalid snapshot");
		expect(() =>
			parseAppUpdateSnapshot({
				...available(),
				release: { ...release, internal: "must-not-cross" },
			}),
		).toThrow("invalid snapshot");
		expect(() =>
			parseAppUpdateSnapshot({
				schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
				state: "failed",
				currentVersion: "0.1.0",
				checkedAtMs: 1,
				release: null,
				failure: {
					code: "network_unavailable",
					operation: "check",
					message: "untrusted bridge detail",
					retryable: true,
				},
			}),
		).toThrow("invalid snapshot");
	});

	test("enforces stable versions, canonical timestamps and signed release policy", () => {
		for (const malformed of [
			{ ...available(), currentVersion: "0.1.0-beta.1" },
			{
				...available(),
				release: { ...release, version: "0.2.0-beta.1" },
			},
			{
				...available(),
				release: {
					...release,
					minimumSupportedVersion: "0.3.0",
				},
			},
			{
				...available(),
				release: {
					...release,
					publishedAt: "2026-08-13T08:00:00Z",
				},
			},
			{
				...available(),
				release: { ...release, mandatory: true },
			},
			{
				...available(),
				release: { ...release, version: "0.1.0" },
			},
		]) {
			expect(() => parseAppUpdateSnapshot(malformed)).toThrow(
				"invalid snapshot",
			);
		}
	});

	test("accepts only internally consistent integer download progress", () => {
		const downloading = {
			schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
			state: "downloading",
			currentVersion: "0.1.0",
			checkedAtMs: 1,
			release,
		};
		expect(
			parseAppUpdateSnapshot({
				...downloading,
				progress: { receivedBytes: 1, totalBytes: 3, percent: 33 },
			}),
		).toMatchObject({ state: "downloading", progress: { percent: 33 } });
		for (const progress of [
			{ receivedBytes: 4, totalBytes: 3, percent: 100 },
			{ receivedBytes: 1, totalBytes: 3, percent: 34 },
			{ receivedBytes: 1.5, totalBytes: 3, percent: 50 },
			{ receivedBytes: 0, totalBytes: 0, percent: 0 },
		]) {
			expect(() =>
				parseAppUpdateSnapshot({ ...downloading, progress }),
			).toThrow("invalid snapshot");
		}
	});
});
