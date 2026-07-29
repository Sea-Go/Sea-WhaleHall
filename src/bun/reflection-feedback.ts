import {
	DEFAULT_DRAINING_EVENT_THRESHOLD,
	DEFAULT_DRAINING_JOB_THRESHOLD,
	DEFAULT_REMINDER_DEDUPLICATION_MS,
	type FeedbackCode,
	type TelemetryEnvelopeV1,
	type TelemetrySink,
} from "../agent/reflection";
import type { SqliteReflectionRepository } from "../agent/reflection/sqlite-repository";

export type ActiveReflectionFeedbackCode = Exclude<FeedbackCode, "silent">;

export type ReflectionFeedbackSinkOptions = {
	repository: SqliteReflectionRepository;
	present: (code: ActiveReflectionFeedbackCode) => void | Promise<void>;
	canPresent?: () => boolean;
	nowMs?: () => number;
	deduplicationMs?: number;
	drainingJobThreshold?: number;
	drainingEventThreshold?: number;
};

/**
 * Presents only fixed, categorical feedback. Event evidence and model text stay
 * in ReflectionJournal and are never passed to the pet/UI callback.
 */
export class ReflectionFeedbackSink implements TelemetrySink {
	private readonly repository: SqliteReflectionRepository;
	private readonly present: ReflectionFeedbackSinkOptions["present"];
	private readonly canPresent: () => boolean;
	private readonly nowMs: () => number;
	private readonly deduplicationMs: number;
	private readonly drainingJobThreshold: number;
	private readonly drainingEventThreshold: number;

	constructor(options: ReflectionFeedbackSinkOptions) {
		this.repository = options.repository;
		this.present = options.present;
		this.canPresent = options.canPresent ?? (() => true);
		this.nowMs = options.nowMs ?? Date.now;
		this.deduplicationMs =
			options.deduplicationMs ?? DEFAULT_REMINDER_DEDUPLICATION_MS;
		this.drainingJobThreshold =
			options.drainingJobThreshold ?? DEFAULT_DRAINING_JOB_THRESHOLD;
		this.drainingEventThreshold =
			options.drainingEventThreshold ?? DEFAULT_DRAINING_EVENT_THRESHOLD;
	}

	async emit(envelope: TelemetryEnvelopeV1): Promise<void> {
		const reflection = envelope.reflection;
		if (reflection.feedbackCode === "silent" || reflection.abstain) return;
		if (!this.canPresent()) return;
		const pressure = await this.repository.getQueueStats();
		if (
			pressure.pendingJobs >= this.drainingJobThreshold ||
			pressure.pendingEvents >= this.drainingEventThreshold
		) {
			return;
		}
		const claim = await this.repository.claimReminder(
			reflection,
			this.nowMs(),
			this.deduplicationMs,
		);
		if (!claim) return;
		await this.present(reflection.feedbackCode);
	}
}
