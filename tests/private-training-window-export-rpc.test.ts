import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateTrainingWindowExportCoordinator } from "../src/bun/private-training-window-export";

function expectPrivateDirectory(path: string): void {
	const metadata = statSync(path);
	expect(metadata.isDirectory()).toBeTrue();
	if (process.platform !== "win32") {
		expect(metadata.mode & 0o777).toBe(0o700);
	}
}

describe("private training window local RPC boundary", () => {
	test("selects COMMITTED ids in Bun and returns immediately with content-free progress", async () => {
		const parent = mkdtempSync(join(tmpdir(), "whalehall-training-rpc-"));
		try {
			const exportCalls: unknown[] = [];
			const listCalls: unknown[] = [];
			const ids = ["timeline_window_1", "timeline_window_2"];
			const createdIds = ["job-01234567", "package-0123456789abcdef"];
			const coordinator = new PrivateTrainingWindowExportCoordinator({
				getExporter: () => ({
					async exportToNewDirectory(options) {
						exportCalls.push(options);
						options.onProgress?.({
							completedWindows: 1,
							totalWindows: 2,
						});
						options.onProgress?.({
							completedWindows: 2,
							totalWindows: 2,
						});
						mkdirSync(options.directory, { mode: 0o700 });
						return {} as never;
					},
				}),
				async listCommittedWindowIds(options) {
					listCalls.push(options);
					return ids;
				},
				dialogs: {
					async confirmDecryptedTrainingExport(count) {
						expect(count).toBe(2);
						return true;
					},
					async chooseDirectory() {
						return parent;
					},
				},
				participantId: "participant-internal",
				sessionTimezone: "Asia/Shanghai",
				nowMs: () => 1_800_000_000_000,
				createId: () => createdIds.shift()!,
			});

			const request = { scope: "all_committed" as const };
			const started = coordinator.start(request);
			expect(started.state).toBe("preparing");
			expect(started.windowCount).toBe(0);
			expect(JSON.stringify(request)).not.toContain("window");
			expect(JSON.stringify(started)).not.toContain("timeline_window");
			expect(JSON.stringify(started)).not.toContain(parent);

			const completed = await waitForTerminal(coordinator);
			expect(completed).toEqual({
				state: "exported",
				jobId: "training_export_job-01234567",
				scope: "all_committed",
				windowCount: 2,
				completedWindowCount: 2,
				basename:
					"whalehall-training-2027-01-15T08-00-00Z-package012345678",
				failureCode: null,
				updatedAtMs: 1_800_000_000_000,
			});
			expect(JSON.stringify(completed)).not.toContain(parent);
			expect(listCalls).toEqual([
				{
					endedAtOrAfterMs: null,
					availableAtMs: 1_800_000_000_000,
					order: "oldest_first",
					limit: 10_001,
				},
			]);
			expect(exportCalls).toEqual([
				expect.objectContaining({
					directory: join(parent, completed.basename!),
					windowIds: ids,
					participantId: "participant-internal",
					sessionTimezone: "Asia/Shanghai",
					includeDecryptedContent: true,
				}),
			]);
			expectPrivateDirectory(join(parent, completed.basename!));
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

		test("uses a 24-hour cutoff and does not choose a path without consent", async () => {
			let choseDirectory = false;
			let exported = false;
			let listOptions: unknown;
		const coordinator = new PrivateTrainingWindowExportCoordinator({
			getExporter: () => ({
				async exportToNewDirectory() {
					exported = true;
					return {} as never;
				},
			}),
				async listCommittedWindowIds(options) {
					listOptions = options;
				return ["timeline_window_1"];
			},
			dialogs: {
				async confirmDecryptedTrainingExport() {
					return false;
				},
				async chooseDirectory() {
					choseDirectory = true;
					return "/tmp";
				},
			},
			participantId: "participant-internal",
			sessionTimezone: "Asia/Shanghai",
			nowMs: () => 200_000_000,
			createId: () => "job-01234567",
		});

		coordinator.start({ scope: "last_24_hours" });
		const completed = await waitForTerminal(coordinator);
		expect(completed.state).toBe("cancelled");
			expect(listOptions).toEqual({
				endedAtOrAfterMs: 113_600_000,
				availableAtMs: 200_000_000,
				order: "oldest_first",
				limit: 10_001,
			});
		expect(choseDirectory).toBeFalse();
		expect(exported).toBeFalse();
	});

	test("asks the repository for exactly the newest still-open committed window", async () => {
		const parent = mkdtempSync(join(tmpdir(), "whalehall-training-latest-"));
		try {
			const exportCalls: Array<{ windowIds: string[] }> = [];
			const listCalls: unknown[] = [];
			const createdIds = ["job-01234567", "package-0123456789abcdef"];
			const coordinator = new PrivateTrainingWindowExportCoordinator({
				getExporter: () => ({
					async exportToNewDirectory(options) {
						exportCalls.push({ windowIds: [...options.windowIds] });
						mkdirSync(options.directory, { mode: 0o700 });
						return {} as never;
					},
				}),
				async listCommittedWindowIds(options) {
					listCalls.push(options);
					return ["timeline_window_latest"];
				},
				dialogs: {
					async confirmDecryptedTrainingExport(count) {
						expect(count).toBe(1);
						return true;
					},
					async chooseDirectory() {
						return parent;
					},
				},
				participantId: "participant-internal",
				sessionTimezone: "Asia/Shanghai",
				nowMs: () => 200_000_000,
				createId: () => createdIds.shift()!,
			});

			coordinator.start({ scope: "latest_committed" });
			const completed = await waitForTerminal(coordinator);
			expect(completed).toMatchObject({
				state: "exported",
				scope: "latest_committed",
				windowCount: 1,
				completedWindowCount: 1,
			});
			expect(listCalls).toEqual([
				{
					endedAtOrAfterMs: null,
					availableAtMs: 200_000_000,
					order: "newest_first",
					limit: 1,
				},
			]);
			expect(exportCalls).toEqual([
				{ windowIds: ["timeline_window_latest"] },
			]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("rejects invalid renderer scope before selecting ids or opening dialogs", () => {
		let touchedNativeState = false;
		const coordinator = new PrivateTrainingWindowExportCoordinator({
			getExporter: () => {
				touchedNativeState = true;
				return null;
			},
			async listCommittedWindowIds() {
				touchedNativeState = true;
				return [];
			},
			dialogs: {
				async confirmDecryptedTrainingExport() {
					touchedNativeState = true;
					return true;
				},
				async chooseDirectory() {
					touchedNativeState = true;
					return null;
				},
			},
			participantId: "participant-internal",
			sessionTimezone: "Asia/Shanghai",
			createId: () => "job-01234567",
		});

		const response = coordinator.start({ scope: "invalid" } as never);
		expect(response.state).toBe("failed");
		expect(response.failureCode).toBe("invalid_request");
		expect(touchedNativeState).toBeFalse();
	});
});

async function waitForTerminal(
	coordinator: PrivateTrainingWindowExportCoordinator,
) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const status = coordinator.getStatus();
		if (
			status.state === "exported" ||
			status.state === "cancelled" ||
			status.state === "failed"
		) {
			return status;
		}
		await Bun.sleep(1);
	}
	throw new Error("private training export did not reach a terminal state");
}
