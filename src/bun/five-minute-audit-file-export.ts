import { constants } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	FIVE_MINUTE_AUDIT_DURATION_MS,
} from "../agent/timeline-v2/audit";
import type { TimelineAuditBundleV2 } from "../agent/timeline-v2/types";
import type {
	FiveMinuteAuditFileExportRequest,
	FiveMinuteAuditFileExportResult,
} from "../shared/contracts";

const MAX_FILENAME_ATTEMPTS = 4;

export type NativeAuditExportDialogs = {
	confirmDecryptedContent(): Promise<boolean>;
	chooseDirectory(): Promise<string | null>;
};

export type FiveMinuteAuditFileExportDependencies = {
	getExporter(): {
		exportFiveMinutes(
			fromMs: number,
			options: { includeDecryptedContent?: boolean },
		): Promise<TimelineAuditBundleV2>;
	} | null;
	dialogs: NativeAuditExportDialogs;
	nowMs?: () => number;
	createId?: () => string;
};

/**
 * Runs exclusively in Bun. The renderer supplies only a range and a redaction
 * choice; native dialogs establish user intent and the bundle never crosses
 * the renderer RPC boundary.
 */
export async function exportFiveMinuteAuditToFile(
	request: FiveMinuteAuditFileExportRequest,
	dependencies: FiveMinuteAuditFileExportDependencies,
): Promise<FiveMinuteAuditFileExportResult> {
	const nowMs = dependencies.nowMs ?? Date.now;
	if (!validRequest(request, nowMs())) {
		return result("invalid_range");
	}

	const exporter = dependencies.getExporter();
	if (exporter === null) return result("not_ready");

	try {
		if (
			request.includeDecryptedContent &&
			!(await dependencies.dialogs.confirmDecryptedContent())
		) {
			return result("cancelled");
		}

		const directory = await dependencies.dialogs.chooseDirectory();
		if (directory === null) return result("cancelled");
		if (!isAbsolute(directory) || !(await isDirectory(directory))) {
			return result("failed");
		}

		const bundle = await exporter.exportFiveMinutes(request.fromMs, {
			includeDecryptedContent: request.includeDecryptedContent,
		});
		const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
		const exportedBasename = await writeNewPrivateFile({
			directory,
			serialized,
			fromMs: request.fromMs,
			includeDecryptedContent: request.includeDecryptedContent,
			createId: dependencies.createId ?? randomUUID,
		});
		return { status: "exported", basename: exportedBasename };
	} catch {
		// Never pass filesystem errors, selected paths, or decrypted snippets to
		// an untrusted renderer.
		return result("failed");
	}
}

function validRequest(
	request: FiveMinuteAuditFileExportRequest,
	nowMs: number,
): boolean {
	if (
		typeof request !== "object" ||
		request === null ||
		!Number.isSafeInteger(request.fromMs) ||
		request.fromMs < 0 ||
		typeof request.includeDecryptedContent !== "boolean" ||
		!Number.isSafeInteger(nowMs) ||
		nowMs < 0
	) {
		return false;
	}
	const toMs = request.fromMs + FIVE_MINUTE_AUDIT_DURATION_MS;
	return Number.isSafeInteger(toMs) && toMs <= nowMs;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function writeNewPrivateFile(options: {
	directory: string;
	serialized: string;
	fromMs: number;
	includeDecryptedContent: boolean;
	createId: () => string;
}): Promise<string> {
	const timestamp = new Date(options.fromMs)
		.toISOString()
		.replaceAll(":", "-")
		.replace(".000Z", "Z");
	const contentMode = options.includeDecryptedContent
		? "decrypted"
		: "redacted";

	for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt += 1) {
		const suffix = safeId(options.createId());
		const name = `whalehall-audit-${timestamp}-${contentMode}-${suffix}.json`;
		if (basename(name) !== name) continue;
		const path = join(options.directory, name);
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(
				path,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
				0o600,
			);
			await handle.writeFile(options.serialized, { encoding: "utf8" });
			await handle.sync();
			await handle.chmod(0o600);
			return name;
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "EEXIST"
			) {
				continue;
			}
			if (handle !== null) {
				await handle.close().catch(() => {});
				handle = null;
				await unlink(path).catch(() => {});
			}
			throw error;
		} finally {
			await handle?.close().catch(() => {});
		}
	}
	throw new Error("Could not allocate a new audit filename.");
}

function safeId(value: string): string {
	const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 12);
	return normalized || randomUUID().replaceAll("-", "").slice(0, 12);
}

function result(
	status: Exclude<FiveMinuteAuditFileExportResult["status"], "exported">,
): FiveMinuteAuditFileExportResult {
	return { status, basename: null };
}
