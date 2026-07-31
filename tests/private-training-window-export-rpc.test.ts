import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPrivateTrainingWindowsLocally } from "../src/bun/private-training-window-export";

describe("private training window local RPC boundary", () => {
	test("requires native confirmation and publishes only a private basename", async () => {
		const parent = mkdtempSync(join(tmpdir(), "whalehall-training-rpc-"));
		try {
			const calls: unknown[] = [];
			const response = await exportPrivateTrainingWindowsLocally(
				{
					windowIds: ["timeline_window_1", "timeline_window_2"],
					participantId: "participant-1",
					sessionTimezone: "Asia/Shanghai",
				},
				{
					getExporter: () => ({
						async exportToNewDirectory(options) {
							calls.push(options);
							const { mkdirSync } = await import("node:fs");
							mkdirSync(options.directory, { mode: 0o700 });
							return {} as never;
						},
					}),
					dialogs: {
						async confirmDecryptedTrainingExport(count) {
							expect(count).toBe(2);
							return true;
						},
						async chooseDirectory() {
							return parent;
						},
					},
					nowMs: () => 1_800_000_000_000,
					createId: () => "01234567-89ab-cdef",
				},
			);

			expect(response).toEqual({
				status: "exported",
				basename:
					"whalehall-training-2027-01-15T08-00-00Z-0123456789abcdef",
				windowCount: 2,
			});
			expect(JSON.stringify(response)).not.toContain(parent);
			expect(calls).toEqual([
				expect.objectContaining({
					directory: join(parent, response.basename!),
					includeDecryptedContent: true,
				}),
			]);
			expect(statSync(join(parent, response.basename!)).mode & 0o777).toBe(
				0o700,
			);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("does not choose a path or invoke the exporter without consent", async () => {
		let choseDirectory = false;
		let exported = false;
		const response = await exportPrivateTrainingWindowsLocally(
			{
				windowIds: ["timeline_window_1"],
				participantId: "participant-1",
				sessionTimezone: "Asia/Shanghai",
			},
			{
				getExporter: () => ({
					async exportToNewDirectory() {
						exported = true;
						return {} as never;
					},
				}),
				dialogs: {
					async confirmDecryptedTrainingExport() {
						return false;
					},
					async chooseDirectory() {
						choseDirectory = true;
						return "/tmp";
					},
				},
			},
		);
		expect(response).toEqual({
			status: "cancelled",
			basename: null,
			windowCount: 0,
		});
		expect(choseDirectory).toBeFalse();
		expect(exported).toBeFalse();
	});

	test("rejects invalid renderer input before opening native dialogs", async () => {
		let prompted = false;
		const response = await exportPrivateTrainingWindowsLocally(
			{
				windowIds: ["../not-a-window"],
				participantId: "participant-1",
				sessionTimezone: "Asia/Shanghai",
			},
			{
				getExporter: () => null,
				dialogs: {
					async confirmDecryptedTrainingExport() {
						prompted = true;
						return true;
					},
					async chooseDirectory() {
						prompted = true;
						return null;
					},
				},
			},
		);
		expect(response.status).toBe("invalid_request");
		expect(prompted).toBeFalse();
	});
});
