import { describe, expect, test } from "bun:test";
import type { FiveMinuteAuditCaptureStatus } from "../src/shared/contracts";
import {
	ElectrobunAuditExportService,
	type AuditExportTransport,
} from "../src/views/client/infrastructure/audit-export/ElectrobunAuditExportService";

const capture: FiveMinuteAuditCaptureStatus = {
	captureId: "ac1_0123456789abcdef",
	state: "collecting",
	fromMs: 5_000,
	toMs: 305_000,
	updatedAtMs: 1,
	analysisCompleteness: "natural_windows_only",
	authoritativeCoverage: "complete",
	failureCode: null,
};

const trainingStatus = {
	state: "preparing" as const,
	jobId: "training_export_01234567",
	scope: "last_24_hours" as const,
	windowCount: 0,
	completedWindowCount: 0,
	basename: null,
	failureCode: null,
	updatedAtMs: 1,
};

describe("Electrobun audit capture service", () => {
	test("routes bounded start, status, and cancel calls without audit content", async () => {
		const calls: string[] = [];
		const transport: AuditExportTransport = {
			async exportFiveMinuteAuditToFile() {
				return { status: "cancelled", basename: null };
			},
			async startFiveMinuteAuditCapture() {
				calls.push("start");
				return capture;
			},
			async getFiveMinuteAuditCaptureStatus() {
				calls.push("status");
				return { capture };
			},
			async cancelFiveMinuteAuditCapture(captureId) {
				calls.push(`cancel:${captureId}`);
				return { capture: { ...capture, state: "cancelled" } };
			},
			async exportPrivateTrainingWindows(request) {
				calls.push(`training:${request.scope}`);
				return trainingStatus;
			},
			async getPrivateTrainingWindowExportStatus() {
				calls.push("training-status");
				return trainingStatus;
			},
		};
		const service = new ElectrobunAuditExportService({
			runtimeAvailable: () => true,
			loadTransport: async () => transport,
		});

		expect(await service.startCapture()).toEqual(capture);
		expect(await service.getCaptureStatus()).toEqual(capture);
		expect(
			(await service.cancelCapture(capture.captureId))?.state,
		).toBe("cancelled");
		expect(
			await service.startPrivateTrainingExport("last_24_hours"),
		).toEqual(trainingStatus);
		expect(await service.getPrivateTrainingExportStatus()).toEqual(
			trainingStatus,
		);
		expect(calls).toEqual([
			"start",
			"status",
			`cancel:${capture.captureId}`,
			"training:last_24_hours",
			"training-status",
		]);
		expect(JSON.stringify(capture)).not.toContain("raw");
		expect(JSON.stringify(capture)).not.toContain("text");
		expect(JSON.stringify(capture)).not.toContain("path");
	});

	test("fails closed when no native runtime is available", async () => {
		const service = new ElectrobunAuditExportService({
			runtimeAvailable: () => false,
			loadTransport: async () => {
				throw new Error("must not load");
			},
		});

		expect(await service.getCaptureStatus()).toBeNull();
		expect(await service.cancelCapture(capture.captureId)).toBeNull();
		expect(
			(await service.startPrivateTrainingExport("all_committed")).failureCode,
		).toBe("not_ready");
		expect((await service.getPrivateTrainingExportStatus()).state).toBe(
			"idle",
		);
		await expect(service.startCapture()).rejects.toThrow("not ready");
	});
});
