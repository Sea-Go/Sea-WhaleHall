import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TimelineCursorAuthority } from "../agent/timeline-v2/repository";
import type { SemanticEventV2 } from "../agent/timeline-v2/types";
import type {
	FiveMinuteAuditCaptureFailureCode,
	FiveMinuteAuditCaptureState,
	FiveMinuteAuditCaptureStatus,
} from "../shared/contracts";

export const AUDIT_CAPTURE_DURATION_MS = 5 * 60 * 1_000;
export const AUDIT_CAPTURE_BUCKET_MS = 5_000;
export const AUDIT_CAPTURE_SETTLE_DELAY_MS = 12_000;
export const AUDIT_CAPTURE_SETTLE_POLL_MS = 5_000;
export const AUDIT_CAPTURE_JOB_GRACE_MS = 60_000;

const CAPTURE_SCHEMA_VERSION = "audit-capture-session.v2";
const LEGACY_CAPTURE_SCHEMA_VERSION = "audit-capture-session.v1";
const MAX_CAPTURE_FILE_BYTES = 64 * 1_024;
const CAPTURE_ID_PATTERN = /^ac1_[A-Za-z0-9_-]{16,128}$/;
const CAPTURE_KEYS = [
	"captureId",
	"state",
	"fromMs",
	"toMs",
	"createdAtMs",
	"updatedAtMs",
	"settleNotBeforeMs",
	"settleAttemptedAtMs",
	"failureCode",
] as const;
const LEGACY_CAPTURE_KEYS = CAPTURE_KEYS.filter((key) => key !== "failureCode");

export type PersistedAuditCaptureState = {
	captureId: string;
	state: FiveMinuteAuditCaptureState;
	fromMs: number;
	toMs: number;
	createdAtMs: number;
	updatedAtMs: number;
	settleNotBeforeMs: number;
	settleAttemptedAtMs: number | null;
	failureCode: FiveMinuteAuditCaptureFailureCode | null;
};

type PersistedCaptureDocument = {
	schemaVersion: typeof CAPTURE_SCHEMA_VERSION;
	capture: PersistedAuditCaptureState | null;
};

export interface AuditCaptureStore {
	load(): Promise<PersistedAuditCaptureState | null>;
	save(capture: PersistedAuditCaptureState): Promise<void>;
}

export interface AuditCaptureScheduler {
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

export type AuditCaptureSettlementResult =
	| { state: "ready" }
	| { state: "pending" }
	| {
			state: "failed";
			failureCode:
				| "timeline_job_terminal_failure"
				| "timeline_result_inconsistent";
	  };

export type FiveMinuteAuditCaptureDependencies = {
	store: AuditCaptureStore;
	settleRange(
		fromMs: number,
		toMs: number,
	): Promise<AuditCaptureSettlementResult>;
	nowMs?: () => number;
	createCaptureId?: () => string;
	scheduler?: AuditCaptureScheduler;
	onError?: (error: unknown) => void;
};

const SYSTEM_SCHEDULER: AuditCaptureScheduler = {
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Coordinates a bounded, asynchronous request to observe the next exact
 * five-minute range. It never stores or returns captured content.
 */
export class FiveMinuteAuditCaptureCoordinator {
	private readonly store: AuditCaptureStore;
	private readonly settleRange: (
		fromMs: number,
		toMs: number,
	) => Promise<AuditCaptureSettlementResult>;
	private readonly nowMs: () => number;
	private readonly createCaptureId: () => string;
	private readonly scheduler: AuditCaptureScheduler;
	private readonly onError: (error: unknown) => void;
	private capture: PersistedAuditCaptureState | null = null;
	private timer: unknown | null = null;
	private operationTail: Promise<void> = Promise.resolve();
	private initialized = false;
	private available = true;
	private disposed = false;
	private settlingCaptureId: string | null = null;
	private readonly settlements = new Set<Promise<void>>();

	constructor(dependencies: FiveMinuteAuditCaptureDependencies) {
		this.store = dependencies.store;
		this.settleRange = dependencies.settleRange;
		this.nowMs = dependencies.nowMs ?? Date.now;
		this.createCaptureId =
			dependencies.createCaptureId ??
			(() => `ac1_${randomUUID().replaceAll("-", "")}`);
		this.scheduler = dependencies.scheduler ?? SYSTEM_SCHEDULER;
		this.onError = dependencies.onError ?? (() => {});
	}

	async initialize(): Promise<void> {
		await this.enqueue(async () => {
			if (this.initialized || this.disposed) return;
			this.initialized = true;
			try {
				this.capture = await this.store.load();
				await this.restoreSchedule();
			} catch (error) {
				this.available = false;
				this.capture = null;
				this.onError(error);
			}
		});
	}

	async start(): Promise<FiveMinuteAuditCaptureStatus> {
		return this.enqueue(async () => {
			this.assertAvailable();
			const active = this.capture;
			if (active && isActive(active.state)) {
				return publicStatus(active);
			}

			const nowMs = validNow(this.nowMs());
			const fromMs = alignToCurrentOrNextBucket(nowMs);
			const toMs = fromMs + AUDIT_CAPTURE_DURATION_MS;
			if (
				!Number.isSafeInteger(toMs) ||
				!Number.isSafeInteger(settleDeadlineMs(toMs))
			) {
				throw new Error("The audit capture range exceeds safe time bounds.");
			}
			const captureId = this.createCaptureId();
			if (!CAPTURE_ID_PATTERN.test(captureId)) {
				throw new Error("The audit capture id is invalid.");
			}
			if (active?.captureId === captureId) {
				throw new Error("The audit capture id was already used.");
			}
			if (this.settlingCaptureId !== null) {
				throw new Error(
					"The cancelled audit range is still finishing locally.",
				);
			}
			const next: PersistedAuditCaptureState = {
				captureId,
				state: "collecting",
				fromMs,
				toMs,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				settleNotBeforeMs: toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS,
				settleAttemptedAtMs: null,
				failureCode: null,
			};
			await this.store.save(next);
			this.capture = next;
			this.scheduleCollectionEnd(next);
			return publicStatus(next);
		});
	}

	async status(): Promise<FiveMinuteAuditCaptureStatus | null> {
		return this.enqueue(async () => {
			this.assertAvailable();
			return this.capture ? publicStatus(this.capture) : null;
		});
	}

	async cancel(
		captureId: string,
	): Promise<FiveMinuteAuditCaptureStatus | null> {
		return this.enqueue(async () => {
			this.assertAvailable();
			const current = this.capture;
			if (!current || current.captureId !== captureId) {
				return current ? publicStatus(current) : null;
			}
			if (!isActive(current.state)) return publicStatus(current);

			const cancelled: PersistedAuditCaptureState = {
				...current,
				state: "cancelled",
				updatedAtMs: validNow(this.nowMs()),
				failureCode: null,
			};
			await this.store.save(cancelled);
			this.capture = cancelled;
			this.clearScheduledTimer();
			return publicStatus(cancelled);
		});
	}

	dispose(): void {
		this.disposed = true;
		this.clearScheduledTimer();
	}

	async shutdown(): Promise<void> {
		this.dispose();
		for (;;) {
			const tail = this.operationTail;
			const settlements = [...this.settlements];
			await Promise.allSettled([tail, ...settlements]);
			if (
				this.operationTail === tail &&
				settlements.length === this.settlements.size &&
				settlements.every((operation) => this.settlements.has(operation))
			) {
				return;
			}
		}
	}

	private async restoreSchedule(): Promise<void> {
		const current = this.capture;
		if (!current || !isActive(current.state)) return;

		const nowMs = validNow(this.nowMs());
		if (current.state === "collecting" && nowMs < current.toMs) {
			this.scheduleCollectionEnd(current);
			return;
		}

		let settling = current;
		if (current.state === "collecting") {
			settling = {
				...current,
				state: "settling",
				updatedAtMs: nowMs,
			};
			await this.store.save(settling);
			this.capture = settling;
		}

		if (nowMs < settling.settleNotBeforeMs) {
			this.scheduleSettlement(settling);
			return;
		}
		queueMicrotask(() => this.launchSettlement(settling.captureId));
	}

	private scheduleCollectionEnd(capture: PersistedAuditCaptureState): void {
		this.clearScheduledTimer();
		const delayMs = Math.max(0, capture.toMs - validNow(this.nowMs()));
		this.timer = this.scheduler.setTimer(() => {
			this.timer = null;
			void this.transitionToSettling(capture.captureId).catch((error) =>
				this.onError(error),
			);
		}, delayMs);
	}

	private async transitionToSettling(captureId: string): Promise<void> {
		let shouldSettleNow = false;
		await this.enqueue(async () => {
			if (this.disposed) return;
			const current = this.capture;
			if (
				!current ||
				current.captureId !== captureId ||
				current.state !== "collecting"
			) {
				return;
			}
			const nowMs = validNow(this.nowMs());
			if (nowMs < current.toMs) {
				this.scheduleCollectionEnd(current);
				return;
			}
			const settling: PersistedAuditCaptureState = {
				...current,
				state: "settling",
				updatedAtMs: nowMs,
				failureCode: null,
			};
			await this.store.save(settling);
			this.capture = settling;
			if (nowMs >= settling.settleNotBeforeMs) {
				shouldSettleNow = true;
			} else {
				this.scheduleSettlement(settling);
			}
		});
		if (shouldSettleNow) {
			this.launchSettlement(captureId);
		}
	}

	private scheduleSettlement(capture: PersistedAuditCaptureState): void {
		this.clearScheduledTimer();
		const delayMs = Math.max(
			0,
			capture.settleNotBeforeMs - validNow(this.nowMs()),
		);
		this.timer = this.scheduler.setTimer(() => {
			this.timer = null;
			this.launchSettlement(capture.captureId);
		}, delayMs);
	}

	private launchSettlement(captureId: string): void {
		if (this.disposed) return;
		const operation = this.beginSettlement(captureId).catch((error) => {
			this.onError(error);
		});
		this.settlements.add(operation);
		void operation.finally(() => this.settlements.delete(operation));
	}

	private async beginSettlement(captureId: string): Promise<void> {
		const range = await this.enqueue(
			async (): Promise<{
				fromMs: number;
				toMs: number;
			} | null> => {
				if (this.disposed || this.settlingCaptureId !== null) return null;
				const current = this.capture;
				if (
					!current ||
					current.captureId !== captureId ||
					current.state !== "settling"
				) {
					return null;
				}
				const nowMs = validNow(this.nowMs());
				if (nowMs < current.settleNotBeforeMs) {
					this.scheduleSettlement(current);
					return null;
				}
				const attempted: PersistedAuditCaptureState = {
					...current,
					updatedAtMs: nowMs,
					settleAttemptedAtMs: nowMs,
				};
				await this.store.save(attempted);
				this.capture = attempted;
				this.settlingCaptureId = captureId;
				return { fromMs: attempted.fromMs, toMs: attempted.toMs };
			},
		);
		if (range === null) return;

		let result: AuditCaptureSettlementResult = { state: "pending" };
		try {
			result = await this.settleRange(range.fromMs, range.toMs);
		} catch (error) {
			this.onError(error);
		}

		await this.enqueue(async () => {
			if (this.settlingCaptureId === captureId) {
				this.settlingCaptureId = null;
			}
			if (this.disposed) return;
			const current = this.capture;
			if (
				!current ||
				current.captureId !== captureId ||
				current.state !== "settling"
			) {
				return;
			}
			const nowMs = validNow(this.nowMs());
			if (result.state === "ready") {
				const completed: PersistedAuditCaptureState = {
					...current,
					state: "ready",
					updatedAtMs: nowMs,
					failureCode: null,
				};
				await this.store.save(completed);
				this.capture = completed;
				return;
			}
			if (result.state === "failed") {
				const failed: PersistedAuditCaptureState = {
					...current,
					state: "failed",
					updatedAtMs: nowMs,
					failureCode: result.failureCode,
				};
				await this.store.save(failed);
				this.capture = failed;
				return;
			}
			if (nowMs >= settleDeadlineMs(current.toMs)) {
				const timedOut: PersistedAuditCaptureState = {
					...current,
					state: "failed",
					updatedAtMs: nowMs,
					failureCode: "authoritative_coverage_timeout",
				};
				await this.store.save(timedOut);
				this.capture = timedOut;
				return;
			}
			const pending: PersistedAuditCaptureState = {
				...current,
				updatedAtMs: nowMs,
				settleNotBeforeMs: Math.min(
					nowMs + AUDIT_CAPTURE_SETTLE_POLL_MS,
					settleDeadlineMs(current.toMs),
				),
				failureCode: null,
			};
			await this.store.save(pending);
			this.capture = pending;
			this.scheduleSettlement(pending);
		});
	}

	private clearScheduledTimer(): void {
		if (this.timer === null) return;
		this.scheduler.clearTimer(this.timer);
		this.timer = null;
	}

	private assertAvailable(): void {
		if (!this.initialized) {
			throw new Error("The audit capture coordinator is not initialized.");
		}
		if (!this.available || this.disposed) {
			throw new Error("The audit capture coordinator is unavailable.");
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation, operation);
		this.operationTail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

export class FileAuditCaptureStore implements AuditCaptureStore {
	constructor(private readonly path: string) {}

	async load(): Promise<PersistedAuditCaptureState | null> {
		try {
			const metadata = await lstat(this.path);
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new Error("Audit capture state must be a regular file.");
			}
			if (metadata.size > MAX_CAPTURE_FILE_BYTES) {
				throw new Error("Audit capture state exceeds its size limit.");
			}
			const noFollow = constants.O_NOFOLLOW ?? 0;
			const handle = await open(this.path, constants.O_RDONLY | noFollow);
			try {
				const text = await handle.readFile("utf8");
				const document = parseDocument(text);
				return document.capture;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (errorCode(error) === "ENOENT") return null;
			throw error;
		}
	}

	async save(capture: PersistedAuditCaptureState): Promise<void> {
		validateCapture(capture);
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = join(directory, `.audit-capture-${randomUUID()}.tmp`);
		let temporaryCreated = false;
		try {
			const noFollow = constants.O_NOFOLLOW ?? 0;
			const handle = await open(
				temporaryPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
				0o600,
			);
			temporaryCreated = true;
			try {
				const document: PersistedCaptureDocument = {
					schemaVersion: CAPTURE_SCHEMA_VERSION,
					capture,
				};
				await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
				await handle.chmod(0o600);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, this.path);
			temporaryCreated = false;
			// Windows does not expose a directory handle that Bun can flush with
			// FlushFileBuffers. The temporary file itself is synced before the
			// atomic rename; POSIX additionally syncs the containing directory so
			// the renamed entry is crash-durable.
			if (process.platform === "win32") return;
			const directoryHandle = await open(directory, constants.O_RDONLY);
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} finally {
			if (temporaryCreated) {
				await unlink(temporaryPath).catch(() => {});
			}
		}
	}
}

export function alignToCurrentOrNextBucket(nowMs: number): number {
	const valid = validNow(nowMs);
	const remainder = valid % AUDIT_CAPTURE_BUCKET_MS;
	if (remainder === 0) return valid;
	const aligned = valid + (AUDIT_CAPTURE_BUCKET_MS - remainder);
	if (!Number.isSafeInteger(aligned)) {
		throw new Error("The aligned audit capture time exceeds safe bounds.");
	}
	return aligned;
}

export function lastEffectiveAuditCursor(
	events: readonly Pick<
		SemanticEventV2,
		"countClass" | "cursor" | "occurredAtMs"
	>[],
	fromMs: number,
	toMs: number,
): string | null {
	if (
		!Number.isSafeInteger(fromMs) ||
		!Number.isSafeInteger(toMs) ||
		fromMs < 0 ||
		toMs <= fromMs
	) {
		throw new Error("The audit authority range is invalid.");
	}
	let latest: string | null = null;
	for (const event of events) {
		if (
			event.countClass !== "effective" ||
			event.occurredAtMs < fromMs ||
			event.occurredAtMs >= toMs
		) {
			continue;
		}
		if (latest === null || compareSemanticCursors(event.cursor, latest) > 0) {
			latest = event.cursor;
		}
	}
	return latest;
}

/**
 * Proves authority for every effective semantic event in the exact audit
 * range. A later COMMITTED window cannot hide an earlier pending, failed, or
 * inconsistent window.
 */
export async function settleEffectiveAuditAuthorities(
	events: readonly Pick<
		SemanticEventV2,
		"countClass" | "cursor" | "occurredAtMs"
	>[],
	fromMs: number,
	toMs: number,
	readAuthority: (cursor: string) => Promise<TimelineCursorAuthority>,
): Promise<AuditCaptureSettlementResult> {
	// Reuse the range validation and cursor parser before doing any repository
	// work, including for an empty range.
	lastEffectiveAuditCursor(events, fromMs, toMs);
	const cursors = [
		...new Set(
			events
				.filter(
					(event) =>
						event.countClass === "effective" &&
						event.occurredAtMs >= fromMs &&
						event.occurredAtMs < toMs,
				)
				.map((event) => event.cursor),
		),
	].sort(compareSemanticCursors);
	if (cursors.length === 0) return { state: "ready" };

	const authorities = await Promise.all(cursors.map(readAuthority));
	if (authorities.some((authority) => authority.state === "inconsistent")) {
		return {
			state: "failed",
			failureCode: "timeline_result_inconsistent",
		};
	}
	if (authorities.some((authority) => authority.state === "terminal_failed")) {
		return {
			state: "failed",
			failureCode: "timeline_job_terminal_failure",
		};
	}
	if (authorities.some((authority) => authority.state === "pending")) {
		return { state: "pending" };
	}
	return { state: "ready" };
}

function publicStatus(
	capture: PersistedAuditCaptureState,
): FiveMinuteAuditCaptureStatus {
	return {
		captureId: capture.captureId,
		state: capture.state,
		fromMs: capture.fromMs,
		toMs: capture.toMs,
		updatedAtMs: capture.updatedAtMs,
		analysisCompleteness: "natural_windows_only",
		authoritativeCoverage:
			capture.state === "ready"
				? "complete"
				: capture.state === "failed"
					? "unavailable"
					: "pending",
		failureCode: capture.failureCode,
	};
}

function isActive(state: FiveMinuteAuditCaptureState): boolean {
	return state === "collecting" || state === "settling";
}

function validNow(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("The audit capture clock returned an invalid time.");
	}
	return value;
}

function parseDocument(text: string): PersistedCaptureDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Audit capture state is not valid JSON.");
	}
	if (
		!isRecord(parsed) ||
		(parsed.schemaVersion !== CAPTURE_SCHEMA_VERSION &&
			parsed.schemaVersion !== LEGACY_CAPTURE_SCHEMA_VERSION)
	) {
		throw new Error("Audit capture state has an unsupported schema.");
	}
	if (Object.keys(parsed).length !== 2 || !("capture" in parsed)) {
		throw new Error("Audit capture state has unexpected fields.");
	}
	if (parsed.capture === null) {
		return {
			schemaVersion: CAPTURE_SCHEMA_VERSION,
			capture: null,
		};
	}
	if (parsed.schemaVersion === LEGACY_CAPTURE_SCHEMA_VERSION) {
		validateLegacyCapture(parsed.capture);
		const legacy = parsed.capture;
		return {
			schemaVersion: CAPTURE_SCHEMA_VERSION,
			capture: {
				...legacy,
				state:
					legacy.state === "ready" || legacy.state === "failed"
						? "settling"
						: legacy.state,
				failureCode: null,
			},
		};
	}
	validateCapture(parsed.capture);
	return {
		schemaVersion: CAPTURE_SCHEMA_VERSION,
		capture: parsed.capture,
	};
}

function validateCapture(
	value: unknown,
): asserts value is PersistedAuditCaptureState {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== CAPTURE_KEYS.length ||
		CAPTURE_KEYS.some((key) => !(key in value)) ||
		typeof value.captureId !== "string" ||
		!CAPTURE_ID_PATTERN.test(value.captureId) ||
		!isCaptureState(value.state) ||
		!isSafeTime(value.fromMs) ||
		value.fromMs % AUDIT_CAPTURE_BUCKET_MS !== 0 ||
		!isSafeTime(value.toMs) ||
		value.toMs - value.fromMs !== AUDIT_CAPTURE_DURATION_MS ||
		!Number.isSafeInteger(settleDeadlineMs(value.toMs)) ||
		!isSafeTime(value.createdAtMs) ||
		!isSafeTime(value.updatedAtMs) ||
		value.createdAtMs > value.fromMs ||
		value.updatedAtMs < value.createdAtMs ||
		!isSafeTime(value.settleNotBeforeMs) ||
		value.settleNotBeforeMs < value.toMs ||
		value.settleNotBeforeMs > settleDeadlineMs(value.toMs) ||
		!(
			value.settleAttemptedAtMs === null ||
			isSafeTime(value.settleAttemptedAtMs)
		) ||
		(value.settleAttemptedAtMs !== null &&
			value.settleAttemptedAtMs > value.updatedAtMs) ||
		!isCaptureFailureCodeOrNull(value.failureCode) ||
		(value.state === "collecting" && value.settleAttemptedAtMs !== null) ||
		((value.state === "ready" || value.state === "failed") &&
			value.settleAttemptedAtMs === null) ||
		(value.state === "failed" && value.failureCode === null) ||
		(value.state !== "failed" && value.failureCode !== null)
	) {
		throw new Error("Audit capture state is invalid.");
	}
}

function validateLegacyCapture(
	value: unknown,
): asserts value is Omit<PersistedAuditCaptureState, "failureCode"> {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== LEGACY_CAPTURE_KEYS.length ||
		LEGACY_CAPTURE_KEYS.some((key) => !(key in value)) ||
		typeof value.captureId !== "string" ||
		!CAPTURE_ID_PATTERN.test(value.captureId) ||
		!isCaptureState(value.state) ||
		!isSafeTime(value.fromMs) ||
		value.fromMs % AUDIT_CAPTURE_BUCKET_MS !== 0 ||
		!isSafeTime(value.toMs) ||
		value.toMs - value.fromMs !== AUDIT_CAPTURE_DURATION_MS ||
		!isSafeTime(value.createdAtMs) ||
		!isSafeTime(value.updatedAtMs) ||
		value.createdAtMs > value.fromMs ||
		value.updatedAtMs < value.createdAtMs ||
		!isSafeTime(value.settleNotBeforeMs) ||
		value.settleNotBeforeMs !== value.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS ||
		!(
			value.settleAttemptedAtMs === null ||
			isSafeTime(value.settleAttemptedAtMs)
		) ||
		(value.settleAttemptedAtMs !== null &&
			(value.settleAttemptedAtMs < value.settleNotBeforeMs ||
				value.settleAttemptedAtMs > value.updatedAtMs)) ||
		(value.state === "collecting" && value.settleAttemptedAtMs !== null) ||
		((value.state === "ready" || value.state === "failed") &&
			value.settleAttemptedAtMs === null)
	) {
		throw new Error("Audit capture state is invalid.");
	}
}

function isCaptureState(value: unknown): value is FiveMinuteAuditCaptureState {
	return (
		value === "collecting" ||
		value === "settling" ||
		value === "ready" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function isCaptureFailureCodeOrNull(
	value: unknown,
): value is FiveMinuteAuditCaptureFailureCode | null {
	return (
		value === null ||
		value === "authoritative_coverage_timeout" ||
		value === "timeline_job_terminal_failure" ||
		value === "timeline_result_inconsistent"
	);
}

function settleDeadlineMs(toMs: number): number {
	return toMs + AUDIT_CAPTURE_DURATION_MS + AUDIT_CAPTURE_JOB_GRACE_MS;
}

function compareSemanticCursors(left: string, right: string): number {
	const leftSequence = semanticCursorSequence(left);
	const rightSequence = semanticCursorSequence(right);
	if (leftSequence !== null && rightSequence !== null) {
		return leftSequence === rightSequence
			? 0
			: leftSequence > rightSequence
				? 1
				: -1;
	}
	return left.localeCompare(right);
}

function semanticCursorSequence(value: string): bigint | null {
	const match = /^sec2_[0-9a-f]{16}$/u.exec(value);
	return match ? BigInt(`0x${value.slice(value.lastIndexOf("_") + 1)}`) : null;
}

function isSafeTime(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code;
	}
	return null;
}
