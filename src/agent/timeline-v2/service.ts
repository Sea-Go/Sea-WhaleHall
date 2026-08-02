import type { AgentRuntime } from "../agent-runtime";
import type {
	LocalSemanticCommitResult,
	LocalSemanticQuery,
	LocalSemanticQueryResult,
} from "../local-protocol";
import type { ReflectionClock } from "../reflection/collector";
import { WebCryptoReflectionHasher } from "../reflection/hash";
import type { ActiveGoalContextV1 } from "../reflection/types";
import {
	TIMELINE_EFFECTIVE_EVENT_THRESHOLD,
	TIMELINE_MAX_WAIT_MS,
	TimelineV2Collector,
} from "./collector";
import { DeterministicEvidenceRenderer } from "./evidence";
import {
	DeterministicEpisodeAssembler,
	type EpisodeSemanticSimilarity,
	type TimelineEpisodeClassifier,
} from "./episodes";
import type { TimelineHypothesisGenerator } from "./hypothesis";
import {
	TimelineV2JobRunner,
	TimelineV2Processor,
} from "./processor";
import type {
	AgentInputQuery,
	AgentInputQueryResult,
	TimelineV2Repository,
} from "./repository";
import {
	DisabledTrainingDatasetSink,
	type TrainingDatasetSink,
} from "./training-sink";
import type {
	AgentInputEnvelopeV1,
	SemanticEventV2,
	TimelineCollectorState,
} from "./types";

export const TIMELINE_V2_SEMANTIC_CONSUMER_ID =
	"whalehall.timeline.v2";
export const TIMELINE_V2_PULL_LIMIT = 256;
export const TIMELINE_V2_EVENT_POLL_MS = 5_000;
export const TIMELINE_V2_JOB_POLL_MS = 1_000;

export interface SemanticEventTransport {
	start(): Promise<void>;
	querySemanticEvents(
		query: LocalSemanticQuery,
	): Promise<LocalSemanticQueryResult>;
	commitSemanticEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalSemanticCommitResult>;
	onSemanticEvent(listener: (event: SemanticEventV2) => void): () => void;
}

export type TimelineV2ServiceIdentity = {
	collectorId: string;
	deviceId: string;
	sessionId: string;
};

export type TimelineV2ServiceOptions = {
	transport: SemanticEventTransport;
	repository: TimelineV2Repository;
	identity: TimelineV2ServiceIdentity;
	hypotheses: TimelineHypothesisGenerator;
	classifier?: TimelineEpisodeClassifier;
	similarity?: EpisodeSemanticSimilarity;
	clock?: ReflectionClock;
	consumerId?: string;
	pullLimit?: number;
	eventPollMs?: number;
	jobPollMs?: number;
	effectiveEventThreshold?: number;
	maxWaitMs?: number;
	/**
	 * Authoritative goal already materialized by the v1 startup gate. This is
	 * used only when the v2 collector has no durable snapshot yet; recovered
	 * collector state and replayed goal boundaries remain authoritative.
	 */
	initialGoal?: ActiveGoalContextV1 | null;
	trainingSink?: TrainingDatasetSink;
	onError?: (error: unknown) => void;
};

/**
 * Durable semantic consumer and Timeline v2 orchestration boundary.
 *
 * Push events are wake-ups only. Every event is pulled with
 * includeContent=true from Rust and its cursor advances only after the
 * encrypted collector/window write succeeds.
 */
export class TimelineV2Service {
	private readonly transport: SemanticEventTransport;
	private readonly repository: TimelineV2Repository;
	private readonly identity: TimelineV2ServiceIdentity;
	private readonly clock: ReflectionClock;
	private readonly consumerId: string;
	private readonly pullLimit: number;
	private readonly eventPollMs: number;
	private readonly jobPollMs: number;
	private readonly collector: TimelineV2Collector;
	private readonly jobs: TimelineV2JobRunner;
	private readonly trainingSink: TrainingDatasetSink;
	private readonly onError: (error: unknown) => void;

	private started = false;
	private acceptingPush = false;
	private pushGeneration = 0;
	private operationTail: Promise<void> = Promise.resolve();
	private unsubscribe: (() => void) | null = null;
	private eventTimer: ReturnType<typeof setTimeout> | null = null;
	private jobTimer: ReturnType<typeof setTimeout> | null = null;
	private lastCommittedCursor: string | null = null;

	constructor(options: TimelineV2ServiceOptions) {
		this.transport = options.transport;
		this.repository = options.repository;
		this.identity = structuredClone(options.identity);
		this.clock = options.clock ?? {
			nowMs: Date.now,
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (handle) => clearTimeout(handle),
		};
		this.consumerId =
			options.consumerId ?? TIMELINE_V2_SEMANTIC_CONSUMER_ID;
		this.pullLimit = boundedInteger(
			options.pullLimit ?? TIMELINE_V2_PULL_LIMIT,
			1,
			1_000,
			"pullLimit",
		);
		this.eventPollMs = positiveDuration(
			options.eventPollMs ?? TIMELINE_V2_EVENT_POLL_MS,
			"eventPollMs",
		);
		this.jobPollMs = positiveDuration(
			options.jobPollMs ?? TIMELINE_V2_JOB_POLL_MS,
			"jobPollMs",
		);
		this.trainingSink =
			options.trainingSink ?? new DisabledTrainingDatasetSink();
		if (this.trainingSink.enabled) {
			throw new Error(
				"TrainingDatasetSink is disabled in Timeline v2 phase one; no upload adapter may be enabled.",
			);
		}
		this.onError =
			options.onError ??
			((error) =>
				console.error(
					"[timeline-v2]",
					safeErrorMessage(error),
				));
		const hasher = new WebCryptoReflectionHasher();
		const evidence = new DeterministicEvidenceRenderer(hasher);
		const episodes = new DeterministicEpisodeAssembler({
			hasher,
			classifier: options.classifier,
			hypotheses: options.hypotheses,
			similarity: options.similarity,
		});
		const processor = new TimelineV2Processor({
			repository: this.repository,
			evidence,
			episodes,
			hasher,
			clock: this.clock,
		});
		this.jobs = new TimelineV2JobRunner({
			repository: this.repository,
			processor,
			clock: this.clock,
		});
		this.collector = new TimelineV2Collector({
			...this.identity,
			repository: this.repository,
			hasher,
			clock: this.clock,
			initialGoal: options.initialGoal,
			effectiveEventThreshold:
				options.effectiveEventThreshold ??
				TIMELINE_EFFECTIVE_EVENT_THRESHOLD,
			maxWaitMs: options.maxWaitMs ?? TIMELINE_MAX_WAIT_MS,
			onDeadlineReady: () => this.coordinateDeadline(),
			onCountReady: () => this.coordinateCount(),
			onBackgroundError: this.onError,
		});
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.acceptingPush = false;
		this.unsubscribe = this.transport.onSemanticEvent(() => {
			this.pushGeneration += 1;
			if (!this.acceptingPush) return;
			void this.enqueue(async () => {
				if (!this.started) return;
				await this.pullBacklog();
				await this.collector.flushCountDue();
				await this.collector.flushDue();
			}).catch(this.onError);
		});
		try {
			await this.collector.recover({ deferDeadline: true });
			await this.transport.start();
			for (;;) {
				const generation = this.pushGeneration;
				await this.pullBacklog();
				if (generation === this.pushGeneration) break;
			}
			await this.collector.resumeDeadlines();
			this.acceptingPush = true;
			this.armEventPoll(this.eventPollMs);
			this.armJobPoll(0);
		} catch (error) {
			this.started = false;
			this.acceptingPush = false;
			this.unsubscribe?.();
			this.unsubscribe = null;
			this.cancelTimers();
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.started = false;
		this.acceptingPush = false;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.cancelTimers();
		await this.operationTail;
		this.collector.dispose();
	}

	async pullNow(): Promise<void> {
		await this.enqueue(async () => {
			await this.pullBacklog();
			await this.collector.flushCountDue();
			await this.collector.flushDue();
		});
	}

	async runJobsNow(maxJobs = 100): Promise<number> {
		return this.jobs.runUntilIdle(maxJobs);
	}

	async getStatus(): Promise<{
		collectorState: TimelineCollectorState;
		lastCommittedCursor: string | null;
		trainingUploadEnabled: false;
	}> {
		return {
			collectorState: this.collector.getState(),
			lastCommittedCursor: this.lastCommittedCursor,
			trainingUploadEnabled: false,
		};
	}

	async releaseAgentInputs(
		agentInputIds: readonly string[] | null = null,
	): Promise<number> {
		return this.repository.releaseAgentInputs(
			agentInputIds,
			this.clock.nowMs(),
		);
	}

	async queryAgentInputs(
		query: Omit<AgentInputQuery, "nowMs"> = {},
	): Promise<AgentInputQueryResult> {
		return this.repository.queryAgentInputs({
			...query,
			nowMs: this.clock.nowMs(),
		});
	}

	async commitAgentInput(
		agentInputId: string,
		leaseToken: string,
	): Promise<AgentInputEnvelopeV1> {
		return this.repository.commitAgentInput(
			agentInputId,
			leaseToken,
			this.clock.nowMs(),
		);
	}

	async discardForAuthorizationRevocation(
		cursor: string | null = null,
	): Promise<void> {
		await this.collector.discardForAuthorizationRevocation(cursor);
	}

	private async pullBacklog(): Promise<void> {
		for (;;) {
			const page = await this.transport.querySemanticEvents({
				consumerId: this.consumerId,
				limit: this.pullLimit,
				includeContent: true,
			});
			for (const rawEvent of page.events) {
				await this.ingest(rawEvent);
			}
			if (page.events.length === 0 || !page.hasMore) return;
		}
	}

	private async ingest(rawEvent: SemanticEventV2): Promise<void> {
		if (
			this.lastCommittedCursor !== null &&
			compareSemanticCursors(
				rawEvent.cursor,
				this.lastCommittedCursor,
			) <= 0
		) {
			return;
		}
		if (
			rawEvent.deviceId !== this.identity.deviceId ||
			rawEvent.sessionId !== this.identity.sessionId
		) {
			throw new Error(
				`Semantic event identity mismatch for ${rawEvent.eventId}: `
					+ `expected ${this.identity.deviceId}/${this.identity.sessionId}, `
					+ `received ${rawEvent.deviceId}/${rawEvent.sessionId}.`,
			);
		}
		const event = structuredClone(rawEvent);
		await this.collector.ingest(event);
		await this.transport.commitSemanticEventCursor(
			this.consumerId,
			rawEvent.cursor,
		);
		this.lastCommittedCursor = rawEvent.cursor;
	}

	private coordinateDeadline(): void {
		if (!this.started || !this.acceptingPush) return;
		void this.enqueue(async () => {
			await this.pullBacklog();
			await this.collector.flushDue();
		}).catch(this.onError);
	}

	private coordinateCount(): void {
		if (!this.started || !this.acceptingPush) return;
		void this.enqueue(async () => {
			await this.pullBacklog();
			await this.collector.flushCountDue();
		}).catch(this.onError);
	}

	private armEventPoll(delayMs: number): void {
		if (!this.started || this.eventTimer !== null) return;
		this.eventTimer = this.clock.setTimer(() => {
			this.eventTimer = null;
			void this.pullNow()
				.catch(this.onError)
				.finally(() => this.armEventPoll(this.eventPollMs));
		}, delayMs);
	}

	private armJobPoll(delayMs: number): void {
		if (!this.started || this.jobTimer !== null) return;
		this.jobTimer = this.clock.setTimer(() => {
			this.jobTimer = null;
			void this.jobs
				.runUntilIdle()
				.catch(this.onError)
				.finally(() => this.armJobPoll(this.jobPollMs));
		}, delayMs);
	}

	private cancelTimers(): void {
		if (this.eventTimer !== null) {
			this.clock.clearTimer(this.eventTimer);
			this.eventTimer = null;
		}
		if (this.jobTimer !== null) {
			this.clock.clearTimer(this.jobTimer);
			this.jobTimer = null;
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export function asSemanticEventTransport(
	runtime: AgentRuntime,
): SemanticEventTransport {
	return runtime;
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

function boundedInteger(
	value: number,
	minimum: number,
	maximum: number,
	field: string,
): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
	}
	return value;
}

function positiveDuration(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive safe integer.`);
	}
	return value;
}

function safeErrorMessage(error: unknown): string {
	const message =
		error instanceof Error ? error.message : "Timeline v2 operation failed.";
	return message
		.replace(/https?:\/\/[^\s]+/gu, "[url]")
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.slice(0, 512);
}
