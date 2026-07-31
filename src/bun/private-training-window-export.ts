import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { PrivateTrainingWindowExporter } from "../agent/timeline-v2/training-window-export";
import type {
	PrivateTrainingWindowExportRequest,
	PrivateTrainingWindowExportResult,
} from "../shared/contracts";

const MAX_EXPORT_WINDOWS = 10_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/u;

export type NativePrivateTrainingExportDialogs = {
	confirmDecryptedTrainingExport(windowCount: number): Promise<boolean>;
	chooseDirectory(): Promise<string | null>;
};

export type PrivateTrainingWindowExportDependencies = {
	getExporter(): Pick<
		PrivateTrainingWindowExporter,
		"exportToNewDirectory"
	> | null;
	dialogs: NativePrivateTrainingExportDialogs;
	nowMs?: () => number;
	createId?: () => string;
};

/**
 * Native-only local export boundary. Sensitive records and the selected path
 * never cross back into the renderer; it receives only a status and basename.
 */
export async function exportPrivateTrainingWindowsLocally(
	request: PrivateTrainingWindowExportRequest,
	dependencies: PrivateTrainingWindowExportDependencies,
): Promise<PrivateTrainingWindowExportResult> {
	if (!validRequest(request)) return result("invalid_request");
	const exporter = dependencies.getExporter();
	if (exporter === null) return result("not_ready");

	try {
		if (
			!(await dependencies.dialogs.confirmDecryptedTrainingExport(
				request.windowIds.length,
			))
		) {
			return result("cancelled");
		}
		const selected = await dependencies.dialogs.chooseDirectory();
		if (selected === null) return result("cancelled");
		const parent = selected.trim();
		if (!(await isPrivateDirectory(parent))) return result("failed");

		const nowMs = dependencies.nowMs?.() ?? Date.now();
		if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
			return result("failed");
		}
		const packageName = privatePackageName(
			nowMs,
			(dependencies.createId ?? randomUUID)(),
		);
		await exporter.exportToNewDirectory({
			directory: join(parent, packageName),
			windowIds: request.windowIds,
			participantId: request.participantId,
			sessionTimezone: request.sessionTimezone,
			includeDecryptedContent: true,
		});
		return {
			status: "exported",
			basename: packageName,
			windowCount: request.windowIds.length,
		};
	} catch {
		// Do not expose filesystem paths, decrypted text, or repository errors to
		// the renderer boundary.
		return result("failed");
	}
}

function validRequest(request: PrivateTrainingWindowExportRequest): boolean {
	if (
		typeof request !== "object" ||
		request === null ||
		!Array.isArray(request.windowIds) ||
		request.windowIds.length < 1 ||
		request.windowIds.length > MAX_EXPORT_WINDOWS ||
		new Set(request.windowIds).size !== request.windowIds.length ||
		request.windowIds.some(
			(value) =>
				typeof value !== "string" ||
				value.length < 1 ||
				value.length > 256 ||
				!SAFE_IDENTIFIER.test(value),
		) ||
		typeof request.participantId !== "string" ||
		request.participantId.length < 1 ||
		request.participantId.length > 160 ||
		!SAFE_IDENTIFIER.test(request.participantId) ||
		typeof request.sessionTimezone !== "string" ||
		request.sessionTimezone.length < 1 ||
		request.sessionTimezone.length > 160
	) {
		return false;
	}
	try {
		new Intl.DateTimeFormat("en-US", {
			timeZone: request.sessionTimezone,
		}).format(0);
		return true;
	} catch {
		return false;
	}
}

async function isPrivateDirectory(path: string): Promise<boolean> {
	if (!isAbsolute(path)) return false;
	try {
		const metadata = await lstat(path);
		const currentUserId = process.geteuid?.();
		return (
			metadata.isDirectory() &&
			!metadata.isSymbolicLink() &&
			(currentUserId === undefined || metadata.uid === currentUserId) &&
			(metadata.mode & 0o022) === 0
		);
	} catch {
		return false;
	}
}

function privatePackageName(nowMs: number, id: string): string {
	const timestamp = new Date(nowMs)
		.toISOString()
		.replaceAll(":", "-")
		.replace(".000Z", "Z");
	const suffix = id
		.toLowerCase()
		.replaceAll(/[^a-z0-9]/gu, "")
		.slice(0, 16);
	if (suffix.length < 8) {
		throw new Error("Private training export id is invalid.");
	}
	const name = `whalehall-training-${timestamp}-${suffix}`;
	if (basename(name) !== name) {
		throw new Error("Private training export name is invalid.");
	}
	return name;
}

function result(
	status: Exclude<PrivateTrainingWindowExportResult["status"], "exported">,
): PrivateTrainingWindowExportResult {
	return { status, basename: null, windowCount: 0 };
}
