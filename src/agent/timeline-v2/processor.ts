import { canonicalJson, type ReflectionHasher } from "../reflection/hash";
import type { ReflectionClock } from "../reflection/collector";
import { mergeCoverage, DeterministicEvidenceRenderer } from "./evidence";
import { DeterministicEpisodeAssembler } from "./episodes";
import type {
	PersistTimelineResult,
	TimelineV2Repository,
} from "./repository";
import {
	AGENT_INPUT_SCHEMA_VERSION,
	TIMELINE_PROJECTOR_VERSION,
	TIMELINE_SUMMARY_SCHEMA_VERSION,
	TIMELINE_TAXONOMY_VERSION,
	type ActivityEpisodeV2,
	type AgentInputV1,
	type EvidenceFactV2,
	type TimelineSegmentV2,
	type TimelineSummaryV2,
	type TimelineWindowV2,
} from "./types";

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;
const TERMINAL_FAILURE_AFTER_MS = 24 * 60 * 60 * 1000;

export type TimelineProcessorOptions = {
	repository: TimelineV2Repository;
	evidence: DeterministicEvidenceRenderer;
	episodes: DeterministicEpisodeAssembler;
	hasher: ReflectionHasher;
	clock: Pick<ReflectionClock, "nowMs">;
	formatTime?: (timestampMs: number) => string;
};

export class TimelineV2Processor {
	private readonly repository: TimelineV2Repository;
	private readonly evidence: DeterministicEvidenceRenderer;
	private readonly episodes: DeterministicEpisodeAssembler;
	private readonly hasher: ReflectionHasher;
	private readonly clock: Pick<ReflectionClock, "nowMs">;
	private readonly formatTime: (timestampMs: number) => string;

	constructor(options: TimelineProcessorOptions) {
		this.repository = options.repository;
		this.evidence = options.evidence;
		this.episodes = options.episodes;
		this.hasher = options.hasher;
		this.clock = options.clock;
		this.formatTime = options.formatTime ?? localTime;
	}

	async process(window: TimelineWindowV2): Promise<PersistTimelineResult> {
		const facts = await this.evidence.render(window.events);
		const contextOnlyFacts =
			window.contextOnly.length > 0
				? await this.evidence.render(window.contextOnly)
				: [];
		// Cursor order is authoritative, while occurredAtMs can move backwards
		// for delayed AX/OCR observations. Inspect the latest immutable episode
		// even when its end timestamp is newer than this window's first fact so
		// the assembler can create a correction revision.
		const previousEpisode = await this.repository.findLatestEpisode(
			window.deviceId,
			window.sessionId,
			Number.MAX_SAFE_INTEGER,
		);
		const episodes = await this.episodes.assemble(
			window,
			facts,
			previousEpisode,
			contextOnlyFacts,
		);
		const correctedResult = await correctionTarget(
			this.repository,
			window,
			previousEpisode,
		);
		const summaryFacts = await factsForSummary(
			this.repository,
			window,
			facts,
			episodes,
		);
		const summary = await this.buildSummary(
			window,
			summaryFacts,
			episodes,
			correctedResult?.summary ?? null,
		);
		const agentInput = await this.buildAgentInput(window, summary);
		return {
			windowId: window.windowId,
			facts,
			episodes,
			summary,
			agentInput,
		};
	}

	private async buildSummary(
		window: TimelineWindowV2,
		facts: readonly EvidenceFactV2[],
		episodes: readonly ActivityEpisodeV2[],
		corrected: TimelineSummaryV2 | null,
	): Promise<TimelineSummaryV2> {
		const factById = new Map(facts.map((fact) => [fact.factId, fact]));
		const segments: TimelineSegmentV2[] = episodes.map((episode) => ({
			episodeId: episode.episodeId,
			episodeRevisionId: episode.revisionId,
			startedAtMs: episode.startedAtMs,
			endedAtMs: episode.endedAtMs,
			activity: episode.classification.abstain
				? "other_unknown"
				: episode.classification.activity,
			goalRelevance:
				window.goal === null
					? null
					: episode.classification.abstain
						? "uncertain"
						: episode.classification.goalRelevance,
			classification: structuredClone(episode.classification),
			hypothesis: structuredClone(episode.hypothesis),
			evidence: unique([
				...episode.evidenceFactIds,
				...episode.supportingFactIds,
			])
				.map((factId) => factById.get(factId))
				.filter((fact): fact is EvidenceFactV2 => fact !== undefined),
		}));
		const timelineId = `timeline_${await this.hasher.sha256(
			canonicalJson({
				windowId: window.windowId,
				episodeRevisionIds: episodes.map(
					(episode) => episode.revisionId,
				),
				correctsTimelineId: corrected?.timelineId ?? null,
			}),
		)}`;
		const coverage = mergeCoverage(
			facts.map((fact) => fact.coverage),
		);
		const warnings = coverageWarnings(coverage);
		const evidencePeriod = periodFromFacts(facts, window);
		return {
			schemaVersion: TIMELINE_SUMMARY_SCHEMA_VERSION,
			timelineId,
			windowId: window.windowId,
			triggerReason: window.triggerReason,
			triggeredAtMs: window.endedAtMs,
			deadlineAtMs: window.deadlineAtMs,
			period: evidencePeriod,
			goalVersion: window.goalVersion,
			segments,
			coverage,
			coverageWarnings: warnings,
			renderedText: renderTimelineText(
				segments,
				warnings,
				this.formatTime,
			),
			modelVersions: unique([
				...episodes.map(
					(episode) => episode.classification.modelVersion,
				),
				...episodes.map(
					(episode) =>
						`hypothesis:${episode.hypothesis.generator}`,
				),
			]),
			inferenceDiagnostics: uniqueDiagnostics(
				episodes.flatMap(
					(episode) =>
						episode.hypothesis.diagnostics ?? [],
				),
			),
			taxonomyVersion: TIMELINE_TAXONOMY_VERSION,
			projectorVersion: TIMELINE_PROJECTOR_VERSION,
			createdAtMs: this.clock.nowMs(),
			revision: corrected ? corrected.revision + 1 : 1,
			correctsTimelineId: corrected?.timelineId ?? null,
		};
	}

	private async buildAgentInput(
		window: TimelineWindowV2,
		summary: TimelineSummaryV2,
	): Promise<AgentInputV1> {
		const payloadWithoutHash = {
			schemaVersion: AGENT_INPUT_SCHEMA_VERSION,
			timelineId: summary.timelineId,
			windowId: window.windowId,
			triggerReason: window.triggerReason,
			triggeredAtMs: summary.triggeredAtMs,
			deadlineAtMs: summary.deadlineAtMs,
			period: summary.period,
			goal: window.goal,
			segments: summary.segments,
			renderedText: summary.renderedText,
			coverage: summary.coverage,
			modelVersions: summary.modelVersions,
			inferenceDiagnostics: summary.inferenceDiagnostics,
			taxonomyVersion: summary.taxonomyVersion,
			projectorVersion: summary.projectorVersion,
			createdAtMs: summary.createdAtMs,
		};
		const payloadHash = await this.hasher.sha256(
			canonicalJson(payloadWithoutHash),
		);
		const agentInputId = `agent_input_${await this.hasher.sha256(
			canonicalJson({
				deviceId: window.deviceId,
				sessionId: window.sessionId,
				goalVersion: window.goalVersion,
				firstCursor: window.firstCursor,
				lastCursor: window.lastCursor,
				triggerReason: window.triggerReason,
				taxonomyVersion: summary.taxonomyVersion,
				projectorVersion: summary.projectorVersion,
			}),
		)}`;
		return {
			...payloadWithoutHash,
			agentInputId,
			idempotencyKey: agentInputId,
			payloadHash,
		};
	}
}

export type TimelineJobRunnerOptions = {
	repository: TimelineV2Repository;
	processor: TimelineV2Processor;
	clock: Pick<ReflectionClock, "nowMs">;
	leaseDurationMs?: number;
	jitter?: (maximumExclusive: number) => number;
};

export class TimelineV2JobRunner {
	private readonly repository: TimelineV2Repository;
	private readonly processor: TimelineV2Processor;
	private readonly clock: Pick<ReflectionClock, "nowMs">;
	private readonly leaseDurationMs: number;
	private readonly jitter: (maximumExclusive: number) => number;

	constructor(options: TimelineJobRunnerOptions) {
		this.repository = options.repository;
		this.processor = options.processor;
		this.clock = options.clock;
		this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
		this.jitter =
			options.jitter ??
			((maximumExclusive) =>
				Math.floor(Math.random() * maximumExclusive));
	}

	async runNext(): Promise<"idle" | "completed" | "retry" | "terminal"> {
		const nowMs = this.clock.nowMs();
		const job = await this.repository.claimNextWindow(
			nowMs,
			this.leaseDurationMs,
		);
		if (!job) return "idle";
		if (
			job.state === "RESULT_PERSISTED" ||
			job.state === "COMMITTING"
		) {
			await this.repository.finalizeWindowCommit(
				job.windowId,
				this.clock.nowMs(),
			);
			return "completed";
		}
		if (job.state !== "RUNNING") {
			throw new Error(
				`Timeline repository returned non-runnable job state ${job.state}.`,
			);
		}
		const window = await this.repository.getWindow(job.windowId);
		if (!window) {
			await this.repository.recordWindowFailure(job.windowId, {
				nowMs,
				code: "WINDOW_MISSING",
				message: "Encrypted timeline window is unavailable.",
				nextAttemptAtMs: null,
				terminal: true,
			});
			return "terminal";
		}
		try {
			const result = await this.processor.process(window);
			await this.repository.completeWindow(
				result,
				this.clock.nowMs(),
			);
			return "completed";
		} catch (error) {
			const failedAtMs = this.clock.nowMs();
			const durable = await this.repository.getJob(job.windowId);
			if (
				durable?.state === "RESULT_PERSISTED" ||
				durable?.state === "COMMITTING" ||
				durable?.state === "COMMITTED"
			) {
				// Result persistence is the point of no return. Never overwrite
				// it with RETRY_WAIT or rerun inference; the next pump only
				// finalizes the commit state.
				if (durable.state !== "COMMITTED") throw error;
				return "completed";
			}
			const firstAttemptAtMs = job.firstAttemptAtMs ?? failedAtMs;
			const terminal =
				failedAtMs - firstAttemptAtMs >=
					TERMINAL_FAILURE_AFTER_MS ||
				isNonRetryable(error);
			const delay = retryDelay(job.attempt, this.jitter);
			await this.repository.recordWindowFailure(job.windowId, {
				nowMs: failedAtMs,
				code: errorCode(error),
				message: safeErrorMessage(error),
				nextAttemptAtMs: terminal ? null : failedAtMs + delay,
				terminal,
			});
			return terminal ? "terminal" : "retry";
		}
	}

	async runUntilIdle(maxJobs = 100): Promise<number> {
		if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) {
			throw new Error("maxJobs must be between 1 and 10000.");
		}
		let processed = 0;
		for (; processed < maxJobs; processed += 1) {
			if ((await this.runNext()) === "idle") break;
		}
		return processed;
	}
}

async function factsForSummary(
	repository: TimelineV2Repository,
	window: TimelineWindowV2,
	currentFacts: readonly EvidenceFactV2[],
	episodes: readonly ActivityEpisodeV2[],
): Promise<EvidenceFactV2[]> {
	const required = new Set(
		episodes.flatMap((episode) => [
			...episode.evidenceFactIds,
			...episode.supportingFactIds,
		]),
	);
	const byId = new Map(
		currentFacts.map((fact) => [fact.factId, fact] as const),
	);
	const historicalWindowIds = unique(
		episodes.flatMap((episode) => episode.sourceWindowIds),
	).filter((windowId) => windowId !== window.windowId);
	for (const windowId of historicalWindowIds) {
		if ([...required].every((factId) => byId.has(factId))) break;
		const result = await repository.getTimelineResult(windowId);
		for (const fact of result?.facts ?? []) {
			if (required.has(fact.factId) && !byId.has(fact.factId)) {
				byId.set(fact.factId, fact);
			}
		}
	}
	return [...byId.values()].sort(
		(left, right) =>
			left.startedAtMs - right.startedAtMs ||
			left.factId.localeCompare(right.factId),
	);
}

function renderTimelineText(
	segments: readonly TimelineSegmentV2[],
	warnings: readonly string[],
	formatTime: (timestampMs: number) => string,
): string {
	const lines: string[] = [];
	for (const segment of segments) {
		lines.push(
			`- ${formatTime(segment.startedAtMs)}–${formatTime(segment.endedAtMs)}，${segment.hypothesis.text}`,
		);
		for (const fact of segment.evidence) {
			lines.push(
				`  - ${formatTime(fact.startedAtMs)} ${fact.renderedText}`,
			);
		}
	}
	for (const warning of warnings) lines.push(`- 数据覆盖提示：${warning}`);
	return lines.join("\n");
}

function coverageWarnings(
	coverage: readonly string[],
): string[] {
	const warnings: string[] = [];
	if (coverage.includes("redacted")) {
		warnings.push("部分敏感内容已主动遮蔽");
	}
	if (coverage.includes("denied")) {
		warnings.push("部分应用或内容因授权策略未采集");
	}
	if (coverage.includes("unavailable")) {
		warnings.push("部分可见内容在采集或解密时不可用");
	}
	if (!coverage.includes("content")) {
		warnings.push("本时间段只有元数据，活动判断应视为低置信");
	}
	return warnings;
}

async function correctionTarget(
	repository: TimelineV2Repository,
	window: TimelineWindowV2,
	previousEpisode: ActivityEpisodeV2 | null,
): Promise<PersistTimelineResult | null> {
	if (
		!previousEpisode ||
		!window.events.some(
			(event) =>
				explicitlyLate(event) ||
				(event.occurredAtMs < previousEpisode.endedAtMs &&
					event.observedAtMs < previousEpisode.endedAtMs),
		)
	) {
		return null;
	}
	const previousWindowId = previousEpisode.sourceWindowIds.at(-1);
	return previousWindowId
		? repository.getTimelineResult(previousWindowId)
		: null;
}

function explicitlyLate(event: TimelineWindowV2["events"][number]): boolean {
	return (
		event.payload.late === true ||
		event.payload.isLate === true ||
		event.payload.lateObservation === true
	);
}

function periodFromFacts(
	facts: readonly EvidenceFactV2[],
	window: TimelineWindowV2,
): { startedAtMs: number; endedAtMs: number } {
	if (facts.length === 0) {
		return {
			startedAtMs: window.startedAtMs,
			endedAtMs: window.startedAtMs,
		};
	}
	return {
		startedAtMs: Math.min(...facts.map((fact) => fact.startedAtMs)),
		endedAtMs: Math.max(...facts.map((fact) => fact.endedAtMs)),
	};
}

function uniqueDiagnostics(
	diagnostics: readonly TimelineSummaryV2["inferenceDiagnostics"][number][],
): TimelineSummaryV2["inferenceDiagnostics"] {
	const seen = new Set<string>();
	const result: TimelineSummaryV2["inferenceDiagnostics"] = [];
	for (const diagnostic of diagnostics) {
		const key = JSON.stringify(diagnostic);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(structuredClone(diagnostic));
	}
	return result;
}

function retryDelay(
	attempt: number,
	jitter: (maximumExclusive: number) => number,
): number {
	const base =
		RETRY_DELAYS_MS[
			Math.min(Math.max(0, attempt - 1), RETRY_DELAYS_MS.length - 1)
		] ?? RETRY_DELAYS_MS.at(-1)!;
	const maximumJitter = Math.max(1, Math.floor(base * 0.2));
	return base + Math.max(0, Math.min(maximumJitter - 1, jitter(maximumJitter)));
}

function isNonRetryable(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"retryable" in error &&
		error.retryable === false
	);
}

function errorCode(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code;
	}
	return error instanceof Error ? error.name : "TIMELINE_PROCESSING_FAILED";
}

function safeErrorMessage(error: unknown): string {
	const value =
		error instanceof Error
			? error.message
			: "Timeline processing failed.";
	return value
		.replace(/https?:\/\/[^\s]+/gu, "[url]")
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.slice(0, 512);
}

function localTime(timestampMs: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(timestampMs));
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
