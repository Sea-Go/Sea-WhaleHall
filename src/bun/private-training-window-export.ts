import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { PrivateTrainingWindowExporter } from "../agent/timeline-v2/training-window-export";
import type {
	PrivateTrainingWindowExportRequest,
	PrivateTrainingWindowExportScope,
	PrivateTrainingWindowExportStatus,
} from "../shared/contracts";

const MAX_EXPORT_WINDOWS = 10_000;
const RECENT_EXPORT_DURATION_MS = 24 * 60 * 60 * 1000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/u;

const ACTIVE_STATES = new Set<PrivateTrainingWindowExportStatus["state"]>([
	"preparing",
	"awaiting_confirmation",
	"choosing_directory",
	"exporting",
]);

export type NativePrivateTrainingExportDialogs = {
	confirmDecryptedTrainingExport(windowCount: number): Promise<boolean>;
	chooseDirectory(): Promise<string | null>;
};

export type PrivateTrainingWindowExportCoordinatorDependencies = {
	getExporter(): Pick<PrivateTrainingWindowExporter, "exportToNewDirectory"> | null;
	listCommittedWindowIds(options: {
		endedAtOrAfterMs: number | null;
		availableAtMs: number;
		order: "oldest_first" | "newest_first";
		limit: number;
	}): Promise<string[]>;
	dialogs: NativePrivateTrainingExportDialogs;
	participantId: string;
	sessionTimezone: string;
	nowMs?: () => number;
	createId?: () => string;
	schedule?: (run: () => void) => void;
};

/**
 * Content-free renderer boundary for a potentially long local export.
 *
 * The renderer selects only a time scope. Window ids, participant identity,
 * timezone, decrypted records, and the chosen absolute path remain Bun-owned.
 */
export class PrivateTrainingWindowExportCoordinator {
	private readonly nowMs: () => number;
	private readonly createId: () => string;
	private readonly schedule: (run: () => void) => void;
	private status: PrivateTrainingWindowExportStatus = idleStatus();

	constructor(
		private readonly dependencies: PrivateTrainingWindowExportCoordinatorDependencies,
	) {
		this.nowMs = dependencies.nowMs ?? Date.now;
		this.createId = dependencies.createId ?? randomUUID;
		this.schedule =
			dependencies.schedule ?? ((run) => void globalThis.setTimeout(run, 0));
	}

	start(
		request: PrivateTrainingWindowExportRequest,
	): PrivateTrainingWindowExportStatus {
		if (ACTIVE_STATES.has(this.status.state)) return this.getStatus();
		if (!validScope(request?.scope)) {
			this.status = this.nextStatus({
				state: "failed",
				jobId: safeJobId(this.createId()),
				scope: null,
				windowCount: 0,
				completedWindowCount: 0,
				basename: null,
				failureCode: "invalid_request",
			});
			return this.getStatus();
		}
		const jobId = safeJobId(this.createId());
		this.status = this.nextStatus({
			state: "preparing",
			jobId,
			scope: request.scope,
			windowCount: 0,
			completedWindowCount: 0,
			basename: null,
			failureCode: null,
		});
		try {
			this.schedule(() => void this.run(jobId, request.scope));
		} catch {
			this.fail(jobId, "export_failed");
		}
		return this.getStatus();
	}

	getStatus(): PrivateTrainingWindowExportStatus {
		return structuredClone(this.status);
	}

	private async run(
		jobId: string,
		scope: PrivateTrainingWindowExportScope,
	): Promise<void> {
		const exporter = this.dependencies.getExporter();
		if (exporter === null) {
			this.fail(jobId, "not_ready");
			return;
		}
		try {
			const startedAtMs = this.checkedNowMs();
			const candidateWindowIds =
				await this.dependencies.listCommittedWindowIds({
					endedAtOrAfterMs:
						scope === "last_24_hours"
							? Math.max(0, startedAtMs - RECENT_EXPORT_DURATION_MS)
							: null,
					availableAtMs: startedAtMs,
					order:
						scope === "latest_committed"
							? "newest_first"
							: "oldest_first",
					limit:
						scope === "latest_committed" ? 1 : MAX_EXPORT_WINDOWS + 1,
				});
			if (!this.isCurrent(jobId)) return;
			if (candidateWindowIds.length === 0) {
				this.fail(jobId, "no_committed_windows");
				return;
			}
			if (candidateWindowIds.length > MAX_EXPORT_WINDOWS) {
				this.fail(jobId, "too_many_windows");
				return;
			}
			if (!validSelectedWindowIds(candidateWindowIds)) {
				this.fail(jobId, "export_failed");
				return;
			}
			const windowIds = candidateWindowIds;

			this.update(jobId, {
				state: "awaiting_confirmation",
				windowCount: windowIds.length,
			});
			if (
				!(await this.dependencies.dialogs.confirmDecryptedTrainingExport(
					windowIds.length,
				))
			) {
				this.finish(jobId, "cancelled");
				return;
			}

			this.update(jobId, { state: "choosing_directory" });
			const selected = await this.dependencies.dialogs.chooseDirectory();
			if (selected === null) {
				this.finish(jobId, "cancelled");
				return;
			}
			const parent = selected.trim();
			if (!(await isPrivateDirectory(parent))) {
				this.fail(jobId, "invalid_destination");
				return;
			}

			const packageName = privatePackageName(
				this.checkedNowMs(),
				this.createId(),
			);
			this.update(jobId, {
				state: "exporting",
				completedWindowCount: 0,
			});
			await exporter.exportToNewDirectory({
				directory: join(parent, packageName),
				windowIds,
				participantId: this.dependencies.participantId,
				sessionTimezone: this.dependencies.sessionTimezone,
				includeDecryptedContent: true,
				onProgress: ({ completedWindows, totalWindows }) => {
					if (totalWindows !== windowIds.length) return;
					this.update(jobId, {
						completedWindowCount: Math.min(
							windowIds.length,
							Math.max(0, completedWindows),
						),
					});
				},
			});
			if (!this.isCurrent(jobId)) return;
			this.status = this.nextStatus({
				...this.status,
				state: "exported",
				completedWindowCount: windowIds.length,
				basename: packageName,
				failureCode: null,
			});
		} catch {
			// Never expose filesystem paths, decrypted text, window ids, or
			// repository errors across the renderer boundary.
			this.fail(jobId, "export_failed");
		}
	}

	private checkedNowMs(): number {
		const value = this.nowMs();
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error("Private training export time is invalid.");
		}
		return value;
	}

	private isCurrent(jobId: string): boolean {
		return this.status.jobId === jobId;
	}

	private update(
		jobId: string,
		change: Partial<PrivateTrainingWindowExportStatus>,
	): void {
		if (!this.isCurrent(jobId)) return;
		this.status = this.nextStatus({ ...this.status, ...change });
	}

	private finish(
		jobId: string,
		state: Extract<PrivateTrainingWindowExportStatus["state"], "cancelled">,
	): void {
		this.update(jobId, {
			state,
			completedWindowCount: 0,
			basename: null,
			failureCode: null,
		});
	}

	private fail(
		jobId: string,
		failureCode: NonNullable<
			PrivateTrainingWindowExportStatus["failureCode"]
		>,
	): void {
		this.update(jobId, {
			state: "failed",
			basename: null,
			failureCode,
		});
	}

	private nextStatus(
		status: Omit<PrivateTrainingWindowExportStatus, "updatedAtMs"> & {
			updatedAtMs?: number | null;
		},
	): PrivateTrainingWindowExportStatus {
		let updatedAtMs: number | null;
		try {
			updatedAtMs = this.checkedNowMs();
		} catch {
			updatedAtMs = null;
		}
		return { ...status, updatedAtMs };
	}
}

function idleStatus(): PrivateTrainingWindowExportStatus {
	return {
		state: "idle",
		jobId: null,
		scope: null,
		windowCount: 0,
		completedWindowCount: 0,
		basename: null,
		failureCode: null,
		updatedAtMs: null,
	};
}

function validScope(value: unknown): value is PrivateTrainingWindowExportScope {
	return (
		value === "latest_committed" ||
		value === "last_24_hours" ||
		value === "all_committed"
	);
}

function validSelectedWindowIds(windowIds: readonly string[]): boolean {
	return (
		new Set(windowIds).size === windowIds.length &&
		windowIds.every(
			(value) =>
				typeof value === "string" &&
				value.length >= 1 &&
				value.length <= 256 &&
				SAFE_IDENTIFIER.test(value),
		)
	);
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
			(process.platform === "win32" || (metadata.mode & 0o777) === 0o700)
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

function safeJobId(value: string): string {
	const normalized = value.replaceAll(/[^A-Za-z0-9_-]/gu, "").slice(0, 128);
	if (normalized.length < 8) {
		throw new Error("Private training export job id is invalid.");
	}
	return `training_export_${normalized}`;
}
