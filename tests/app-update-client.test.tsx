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



});

describe("Electrobun app update adapter", () => {




});
