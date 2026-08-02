import { constants } from "node:fs";
import { link, open, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { FIVE_MINUTE_AUDIT_DURATION_MS } from "../agent/timeline-v2/audit";
import type { TimelineAuditBundleV3 } from "../agent/timeline-v2/types";
import type {
	FiveMinuteAuditFileExportRequest,
	FiveMinuteAuditFileExportResult,
} from "../shared/contracts";

const MAX_FILENAME_ATTEMPTS = 4;
const INPUT_ACTIVITY_BUCKET_MS = 5_000;

export type AuditExportFileHandle = {
	write(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number | null,
	): Promise<{ bytesWritten: number }>;
	sync(): Promise<void>;
	chmod(mode: number): Promise<void>;
	close(): Promise<void>;
};

export type AuditExportFileSystem = {
	open(
		path: string,
		flags: number,
		mode?: number,
	): Promise<AuditExportFileHandle>;
	link(existingPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
};

const NODE_AUDIT_FILE_SYSTEM: AuditExportFileSystem = {
	open: async (path, flags, mode) => open(path, flags, mode),
	link,
	unlink,
};

export type NativeAuditExportDialogs = {
	confirmDecryptedContent(): Promise<boolean>;
	chooseDirectory(): Promise<string | null>;
};

export type FiveMinuteAuditFileExportDependencies = {
	getExporter(): {
		exportFiveMinutes(
			fromMs: number,
			options: { includeDecryptedContent?: boolean },
		): Promise<TimelineAuditBundleV3>;
	} | null;
	dialogs: NativeAuditExportDialogs;
	nowMs?: () => number;
	createId?: () => string;
	fileSystem?: AuditExportFileSystem;
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
		const exportedBasename = await writeNewPrivateFile({
			directory,
			bundle,
			fromMs: request.fromMs,
			includeDecryptedContent: request.includeDecryptedContent,
			createId: dependencies.createId ?? randomUUID,
			fileSystem: dependencies.fileSystem ?? NODE_AUDIT_FILE_SYSTEM,
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
		request.fromMs % INPUT_ACTIVITY_BUCKET_MS !== 0 ||
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
	bundle: TimelineAuditBundleV3;
	fromMs: number;
	includeDecryptedContent: boolean;
	createId: () => string;
	fileSystem: AuditExportFileSystem;
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
		const temporaryName = `.${name}.${attempt}.tmp`;
		const temporaryPath = join(options.directory, temporaryName);
		let handle: AuditExportFileHandle | null = null;
		let temporaryCreated = false;
		let published = false;
		try {
			handle = await options.fileSystem.open(
				temporaryPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
				0o600,
			);
			temporaryCreated = true;
			await writeJsonObject(handle, options.bundle);
			await handle.chmod(0o600);
			await handle.sync();
			await handle.close();
			handle = null;
			await options.fileSystem.link(temporaryPath, path);
			published = true;
			await options.fileSystem.unlink(temporaryPath);
			temporaryCreated = false;
			await syncDirectory(options.directory, options.fileSystem);
			return name;
		} catch (error) {
			if (handle !== null) {
				await handle.close().catch(() => {});
				handle = null;
			}
			if (published) {
				await options.fileSystem.unlink(path).catch(() => {});
			}
			if (temporaryCreated) {
				await options.fileSystem.unlink(temporaryPath).catch(() => {});
			}
			if (errorCode(error) === "EEXIST") continue;
			throw error;
		} finally {
			await handle?.close().catch(() => {});
		}
	}
	throw new Error("Could not allocate a new audit filename.");
}

async function writeJsonObject(
	handle: AuditExportFileHandle,
	value: object,
): Promise<void> {
	await writeAll(handle, "{\n");
	const entries = Object.entries(value as Record<string, unknown>);
	for (let index = 0; index < entries.length; index += 1) {
		const [key, child] = entries[index]!;
		await writeAll(handle, `  ${serializeJson(key)}: `);
		if (Array.isArray(child)) {
			await writeJsonArray(handle, child, "  ");
		} else {
			await writeAll(handle, serializeJson(child, 2));
		}
		await writeAll(handle, index === entries.length - 1 ? "\n" : ",\n");
	}
	await writeAll(handle, "}\n");
}

async function writeJsonArray(
	handle: AuditExportFileHandle,
	values: readonly unknown[],
	indent: string,
): Promise<void> {
	if (values.length === 0) {
		await writeAll(handle, "[]");
		return;
	}
	await writeAll(handle, "[\n");
	for (let index = 0; index < values.length; index += 1) {
		await writeAll(handle, `${indent}  ${serializeJson(values[index])}`);
		await writeAll(handle, index === values.length - 1 ? "\n" : ",\n");
	}
	await writeAll(handle, `${indent}]`);
}

async function writeAll(
	handle: AuditExportFileHandle,
	value: string,
): Promise<void> {
	const buffer = Buffer.from(value, "utf8");
	let offset = 0;
	while (offset < buffer.byteLength) {
		const { bytesWritten } = await handle.write(
			buffer,
			offset,
			buffer.byteLength - offset,
			null,
		);
		if (
			!Number.isSafeInteger(bytesWritten) ||
			bytesWritten <= 0 ||
			bytesWritten > buffer.byteLength - offset
		) {
			throw new Error("Audit file write did not make valid progress.");
		}
		offset += bytesWritten;
	}
}

async function syncDirectory(
	directory: string,
	fileSystem: AuditExportFileSystem,
): Promise<void> {
	const handle = await fileSystem.open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close().catch(() => {});
	}
}

function serializeJson(value: unknown, space?: number): string {
	const serialized = JSON.stringify(value, null, space);
	if (serialized === undefined) {
		throw new Error("Audit bundle contains a non-JSON value.");
	}
	return serialized;
}

function errorCode(error: unknown): string | null {
	return error instanceof Error &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: null;
}

function safeId(value: string): string {
	const normalized = value
		.toLowerCase()
		.replaceAll(/[^a-z0-9]/g, "")
		.slice(0, 12);
	return normalized || randomUUID().replaceAll("-", "").slice(0, 12);
}

function result(
	status: Exclude<FiveMinuteAuditFileExportResult["status"], "exported">,
): FiveMinuteAuditFileExportResult {
	return { status, basename: null };
}
