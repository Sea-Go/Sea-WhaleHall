import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exportFiveMinuteAuditToFile,
	type AuditExportFileSystem,
} from "../src/bun/five-minute-audit-file-export";
import {
	TIMELINE_AUDIT_SCHEMA_VERSION,
	type TimelineAuditBundleV3,
} from "../src/agent/timeline-v2/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-audit-export-"));
	temporaryDirectories.push(directory);
	return directory;
}

function expectPrivateFile(path: string): void {
	const metadata = statSync(path);
	expect(metadata.isFile()).toBeTrue();
	if (process.platform !== "win32") {
		expect(metadata.mode & 0o777).toBe(0o600);
	}
}

function realFileSystem(
	options: {
		maximumWriteBytes?: number;
		beforeLink?: (existingPath: string, newPath: string) => void;
	} = {},
): AuditExportFileSystem {
	return {
		async open(path, flags, mode) {
			const handle = await open(path, flags, mode);
			return {
				async write(buffer, offset, length, position) {
					const requestedLength =
						options.maximumWriteBytes === undefined
							? length
							: Math.min(length, options.maximumWriteBytes);
					return handle.write(buffer, offset, requestedLength, position);
				},
				async sync() {
					await handle.sync();
				},
				async chmod(fileMode) {
					await handle.chmod(fileMode);
				},
				async close() {
					await handle.close();
				},
			};
		},
		async link(existingPath, newPath) {
			options.beforeLink?.(existingPath, newPath);
			await link(existingPath, newPath);
		},
		unlink,
	};
}

function bundle(
	fromMs: number,
	includeDecryptedContent: boolean,
): TimelineAuditBundleV3 {
	return {
		manifest: {
			schemaVersion: TIMELINE_AUDIT_SCHEMA_VERSION,
			exportedAtMs: 600_000,
			fromMs,
			toMs: fromMs + 300_000,
			decryptedContentIncluded: includeDecryptedContent,
			rawObservationCount: 1,
			semanticEventCount: 0,
			evidenceFactCount: 0,
			sourceEpisodeCount: 0,
			episodeSliceCount: 0,
			sourceTimelineSummaryCount: 0,
			timelineSliceCount: 0,
			lineageEntryCount: 0,
			candidateCounts: {
				rawObservations: 1,
				semanticEvents: 0,
				evidenceFacts: 0,
				sourceEpisodes: 0,
				episodeSlices: 0,
				sourceTimelineSummaries: 0,
				timelineSlices: 0,
			},
			includedCounts: {
				rawObservations: 1,
				semanticEvents: 0,
				evidenceFacts: 0,
				sourceEpisodes: 0,
				episodeSlices: 0,
				sourceTimelineSummaries: 0,
				timelineSlices: 0,
			},
			omittedCounts: {
				rawObservations: 0,
				semanticEvents: 0,
				evidenceFacts: 0,
				sourceEpisodes: 0,
				episodeSlices: 0,
				sourceTimelineSummaries: 0,
				timelineSlices: 0,
			},
			exportWarnings: [],
			rangeBoundaryOmissions: {
				rawObservations: 0,
				semanticEvents: 0,
				evidenceFacts: 0,
				sourceEpisodes: 0,
				episodeSlices: 0,
				sourceTimelineSummaries: 0,
				timelineSlices: 0,
			},
		},
		permissions: {},
		coverage: ["content"],
		rawObservations: [
			{
				observationId: "observation-1",
				content: includeDecryptedContent ? "机密文本 ABC-123" : "[redacted]",
			},
		],
		semanticEvents: [],
		evidenceFacts: [],
		episodes: [],
		episodeSlices: [],
		timelineSummaries: [],
		timelineSlices: [],
		lineage: [],
	};
}

describe("secure five-minute audit file export", () => {
	test("writes a new mode-0600 redacted file without asking for decryption confirmation", async () => {
		const directory = createDirectory();
		let confirmations = 0;
		const calls: Array<{ fromMs: number; decrypted: boolean }> = [];
		const response = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: false },
			{
				nowMs: () => 600_000,
				createId: () => "audit-id-1",
				getExporter: () => ({
					async exportFiveMinutes(fromMs, options) {
						calls.push({
							fromMs,
							decrypted: options.includeDecryptedContent ?? false,
						});
						return bundle(fromMs, options.includeDecryptedContent ?? false);
					},
				}),
				dialogs: {
					async confirmDecryptedContent() {
						confirmations += 1;
						return true;
					},
					async chooseDirectory() {
						return directory;
					},
				},
			},
		);

		expect(response.status).toBe("exported");
		expect(response.basename).toMatch(/^whalehall-audit-/);
		expect(JSON.stringify(response)).not.toContain(directory);
		expect(JSON.stringify(response)).not.toContain("机密文本");
		expect(confirmations).toBe(0);
		expect(calls).toEqual([{ fromMs: 300_000, decrypted: false }]);
		const path = join(directory, response.basename ?? "");
		expectPrivateFile(path);
		const serialized = readFileSync(path, "utf8");
		expect(serialized).toContain("[redacted]");
		expect(serialized).not.toContain("机密文本 ABC-123");
		expect(JSON.parse(serialized)).toEqual(bundle(300_000, false));
		expect(readdirSync(directory)).toEqual([response.basename ?? ""]);
	});

	test("requires native confirmation before creating a decrypted bundle", async () => {
		const directory = createDirectory();
		let chooserCalls = 0;
		let exporterCalls = 0;
		const cancelled = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: true },
			{
				nowMs: () => 600_000,
				getExporter: () => ({
					async exportFiveMinutes() {
						exporterCalls += 1;
						return bundle(300_000, true);
					},
				}),
				dialogs: {
					async confirmDecryptedContent() {
						return false;
					},
					async chooseDirectory() {
						chooserCalls += 1;
						return directory;
					},
				},
			},
		);
		expect(cancelled).toEqual({ status: "cancelled", basename: null });
		expect(chooserCalls).toBe(0);
		expect(exporterCalls).toBe(0);

		const exported = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: true },
			{
				nowMs: () => 600_000,
				createId: () => "decrypted-id",
				getExporter: () => ({
					async exportFiveMinutes(fromMs, options) {
						return bundle(fromMs, options.includeDecryptedContent === true);
					},
				}),
				dialogs: {
					async confirmDecryptedContent() {
						return true;
					},
					async chooseDirectory() {
						return directory;
					},
				},
			},
		);
		expect(exported.status).toBe("exported");
		expect(
			readFileSync(join(directory, exported.basename ?? ""), "utf8"),
		).toContain("机密文本 ABC-123");
		expect(() =>
			JSON.parse(
				readFileSync(join(directory, exported.basename ?? ""), "utf8"),
			),
		).not.toThrow();
	});

	test("rejects invalid ranges and unavailable runtimes before native dialogs", async () => {
		let dialogCalls = 0;
		const dialogs = {
			async confirmDecryptedContent() {
				dialogCalls += 1;
				return true;
			},
			async chooseDirectory() {
				dialogCalls += 1;
				return createDirectory();
			},
		};
		const future = await exportFiveMinuteAuditToFile(
			{ fromMs: 600_001, includeDecryptedContent: false },
			{
				nowMs: () => 600_000,
				getExporter: () => null,
				dialogs,
			},
		);
		expect(future).toEqual({ status: "invalid_range", basename: null });
		const incomplete = await exportFiveMinuteAuditToFile(
			{ fromMs: 500_000, includeDecryptedContent: false },
			{
				nowMs: () => 600_000,
				getExporter: () => null,
				dialogs,
			},
		);
		expect(incomplete).toEqual({
			status: "invalid_range",
			basename: null,
		});
		const misaligned = await exportFiveMinuteAuditToFile(
			{ fromMs: 295_001, includeDecryptedContent: false },
			{
				nowMs: () => 600_000,
				getExporter: () => null,
				dialogs,
			},
		);
		expect(misaligned).toEqual({
			status: "invalid_range",
			basename: null,
		});
		const unavailable = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: false },
			{
				nowMs: () => 600_000,
				getExporter: () => null,
				dialogs,
			},
		);
		expect(unavailable).toEqual({ status: "not_ready", basename: null });
		expect(dialogCalls).toBe(0);
	});

	test("write-all produces valid UTF-8 JSON across partial writes", async () => {
		const directory = createDirectory();
		const exported = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: true },
			{
				nowMs: () => 600_000,
				createId: () => "partial-write",
				fileSystem: realFileSystem({
					maximumWriteBytes: 3,
				}),
				getExporter: () => ({
					async exportFiveMinutes(fromMs) {
						return bundle(fromMs, true);
					},
				}),
				dialogs: {
					async confirmDecryptedContent() {
						return true;
					},
					async chooseDirectory() {
						return directory;
					},
				},
			},
		);
		expect(exported.status).toBe("exported");
		const serialized = readFileSync(
			join(directory, exported.basename ?? ""),
			"utf8",
		);
		expect(JSON.parse(serialized)).toEqual(bundle(300_000, true));
		expect(serialized).toContain("机密文本 ABC-123");
	});

	test("does not expose a final file if publication fails after temp fsync", async () => {
		const directory = createDirectory();
		let inspectedPublication = false;
		const failed = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: false },
			{
				nowMs: () => 600_000,
				createId: () => "crash-before-link",
				fileSystem: realFileSystem({
					beforeLink(existingPath, newPath) {
						inspectedPublication = true;
						expect(
							readdirSync(directory).some(
								(name) => name.endsWith(".json") && !name.startsWith("."),
							),
						).toBeFalse();
						expect(existingPath).toContain("/.");
						expect(newPath.endsWith(".json")).toBeTrue();
						throw new Error("simulated crash before link");
					},
				}),
				getExporter: () => ({
					async exportFiveMinutes(fromMs) {
						return bundle(fromMs, false);
					},
				}),
				dialogs: {
					async confirmDecryptedContent() {
						return true;
					},
					async chooseDirectory() {
						return directory;
					},
				},
			},
		);
		expect(failed).toEqual({ status: "failed", basename: null });
		expect(inspectedPublication).toBeTrue();
		expect(readdirSync(directory)).toEqual([]);
	});

	test("rejects a zero-progress write and removes the temp file", async () => {
		const directory = createDirectory();
		const failed = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: false },
			{
				nowMs: () => 600_000,
				createId: () => "zero-write",
				fileSystem: realFileSystem({ maximumWriteBytes: 0 }),
				getExporter: () => ({
					async exportFiveMinutes(fromMs) {
						return bundle(fromMs, false);
					},
				}),
				dialogs: {
					async confirmDecryptedContent() {
						return true;
					},
					async chooseDirectory() {
						return directory;
					},
				},
			},
		);
		expect(failed).toEqual({ status: "failed", basename: null });
		expect(readdirSync(directory)).toEqual([]);
	});

	test("never overwrites an existing export", async () => {
		const directory = createDirectory();
		const dependencies = {
			nowMs: () => 600_000,
			createId: () => "same-id",
			getExporter: () => ({
				async exportFiveMinutes(fromMs: number) {
					return bundle(fromMs, false);
				},
			}),
			dialogs: {
				async confirmDecryptedContent() {
					return true;
				},
				async chooseDirectory() {
					return directory;
				},
			},
		};
		const first = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: false },
			dependencies,
		);
		expect(first.status).toBe("exported");
		const firstPath = join(directory, first.basename ?? "");
		const original = readFileSync(firstPath, "utf8");
		const second = await exportFiveMinuteAuditToFile(
			{ fromMs: 300_000, includeDecryptedContent: false },
			dependencies,
		);
		expect(second).toEqual({ status: "failed", basename: null });
		expect(readFileSync(firstPath, "utf8")).toBe(original);
		expect(readdirSync(directory)).toEqual([first.basename ?? ""]);
	});
});
