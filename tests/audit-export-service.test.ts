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
		expect(calls).toEqual([
			"start",
			"status",
			`cancel:${capture.captureId}`,
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
		await expect(service.startCapture()).rejects.toThrow("not ready");
	});
});
