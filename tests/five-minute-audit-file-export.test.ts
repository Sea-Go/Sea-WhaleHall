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
} from "../src/agent/timeline/types";

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





});
