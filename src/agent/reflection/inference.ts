import {
	type ActivityLabel,
	type EventWindowV1,
	type FeedbackCode,
	type GoalRelevanceLabel,
	isCountedSemanticEvent,
	REFLECTION_SCHEMA_VERSION,
	type ReflectionV1,
} from "./types";

export const DEFAULT_REFLECTION_TAXONOMY_VERSION =
	"activity-taxonomy.v1" as const;
export const DEFAULT_REMINDER_DEDUPLICATION_MS = 10 * 60 * 1000;

export const ACTIVITY_LABELS = [
	"development",
	"writing",
	"research",
	"communication",
	"planning",
	"data_work",
	"media",
	"gaming",
	"system_file_ops",
	"commerce",
	"idle_transition",
	"other_unknown",
] as const satisfies readonly ActivityLabel[];

export const GOAL_RELEVANCE_LABELS = [
	"direct",
	"supporting",
	"unrelated",
	"uncertain",
] as const satisfies readonly GoalRelevanceLabel[];

export class ReflectionInferenceUnavailableError extends Error {
	readonly retryable: boolean;

	constructor(
		message: string,
		options?: ErrorOptions & { retryable?: boolean },
	) {
		super(message, options);
		this.name = "ReflectionInferenceUnavailableError";
		this.retryable = options?.retryable ?? true;
	}
}

/**
 * Conservative production inference with no model server or network path.
 * It intentionally abstains while still creating a schema-valid journal row,
 * so collection, retry, retention and downstream accounting remain intact.
 */
export class DeterministicReflectionInference {
	readonly modelVersion = "deterministic-reflection.v1";

	async infer(
		window: EventWindowV1,
		signal?: AbortSignal,
	): Promise<ReflectionV1> {
		throwIfInferenceAborted(signal);
		assertWindowGoalInvariant(window);
		const hasGoal = window.goal !== null;
		const activityProbabilities = minimallyBiasedDistribution(
			ACTIVITY_LABELS,
			"other_unknown",
		);
		const goalRelevanceProbabilities = hasGoal
			? minimallyBiasedDistribution(GOAL_RELEVANCE_LABELS, "uncertain")
			: null;
		const confidence = Math.min(
			maximumProbability(activityProbabilities, ACTIVITY_LABELS),
			hasGoal && goalRelevanceProbabilities
				? maximumProbability(goalRelevanceProbabilities, GOAL_RELEVANCE_LABELS)
				: 1,
		);
		const entropy = Math.max(
			normalizedEntropy(activityProbabilities, ACTIVITY_LABELS),
			hasGoal && goalRelevanceProbabilities
				? normalizedEntropy(goalRelevanceProbabilities, GOAL_RELEVANCE_LABELS)
				: 0,
		);
		const embedding = await deterministicEmbedding(window);
		throwIfInferenceAborted(signal);
		return {
			schemaVersion: REFLECTION_SCHEMA_VERSION,
			windowId: window.windowId,
			triggerReason: window.triggerReason,
			eventCount: window.eventCount,
			durationMs: Math.max(0, window.endedAtMs - window.startedAtMs),
			goalVersion: hasGoal ? window.goalVersion : null,
			activity: {
				label: "other_unknown",
				probabilities: activityProbabilities,
			},
			goalRelevance:
				hasGoal && goalRelevanceProbabilities
					? {
							label: "uncertain",
							probabilities: goalRelevanceProbabilities,
						}
					: null,
			embedding,
			confidence,
			entropy,
			abstain: true,
			evidenceEventIds: uniqueEvidenceEventIds(window),
			feedbackCode: "silent",
			modelVersion: this.modelVersion,
			taxonomyVersion: DEFAULT_REFLECTION_TAXONOMY_VERSION,
		};
	}
}

function reflectionInferenceCancelledError(): ReflectionInferenceUnavailableError {
	return new ReflectionInferenceUnavailableError(
		"Reflection inference was cancelled during shutdown.",
		{ retryable: true },
	);
}

function throwIfInferenceAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw reflectionInferenceCancelledError();
}

export type FeedbackSelectionInput = {
	hasGoal: boolean;
	activity: ActivityLabel;
	goalRelevance: GoalRelevanceLabel | null;
	abstain: boolean;
};

export function selectFeedbackCode(
	input: FeedbackSelectionInput,
): FeedbackCode {
	if (!input.hasGoal || input.abstain || input.goalRelevance === null) {
		return "silent";
	}
	if (input.activity === "idle_transition") return "takeBreak";
	switch (input.goalRelevance) {
		case "direct":
		case "supporting":
			return "encourage";
		case "unrelated":
			return "refocus";
		case "uncertain":
			return "clarifyGoal";
	}
}

const CHINESE_FEEDBACK_TEMPLATES: Readonly<
	Record<Exclude<FeedbackCode, "silent">, string>
> = {
	encourage: "你正在推进当前目标，保持这个节奏。",
	refocus: "当前活动可能偏离目标，建议确认下一步并把注意力拉回来。",
	clarifyGoal: "当前活动与目标的关系不够明确，建议先确认现在想推进的事情。",
	takeBreak: "检测到活动中断，可以短暂休息，或确认接下来的步骤。",
};

export function chineseFeedbackTemplate(code: FeedbackCode): string | null {
	return code === "silent" ? null : CHINESE_FEEDBACK_TEMPLATES[code];
}

/** Suppresses only active reminders. Every ReflectionV1 is still persisted. */
export class ReflectionReminderDeduper {
	private readonly lastReminderAtByKey = new Map<string, number>();

	constructor(
		private readonly deduplicationMs = DEFAULT_REMINDER_DEDUPLICATION_MS,
	) {
		if (!Number.isInteger(deduplicationMs) || deduplicationMs < 1) {
			throw new Error("deduplicationMs must be a positive integer.");
		}
	}

	shouldNotify(reflection: ReflectionV1, nowMs: number): boolean {
		if (reflection.feedbackCode === "silent") return false;
		if (!Number.isFinite(nowMs)) throw new Error("nowMs must be finite.");
		const key = [
			reflection.activity.label,
			reflection.goalRelevance?.label ?? "no_goal",
			reflection.feedbackCode,
		].join("\u0000");
		const previous = this.lastReminderAtByKey.get(key);
		if (previous !== undefined && nowMs - previous < this.deduplicationMs) {
			return false;
		}
		this.lastReminderAtByKey.set(key, nowMs);
		this.prune(nowMs);
		return true;
	}

	clear(): void {
		this.lastReminderAtByKey.clear();
	}

	private prune(nowMs: number): void {
		for (const [key, emittedAtMs] of this.lastReminderAtByKey) {
			if (nowMs - emittedAtMs >= this.deduplicationMs) {
				this.lastReminderAtByKey.delete(key);
			}
		}
	}
}

function minimallyBiasedDistribution<L extends string>(
	labels: readonly L[],
	target: L,
): Record<L, number> {
	const result = {} as Record<L, number>;
	const epsilon = 1e-6;
	const base = 1 / labels.length;
	for (const label of labels) {
		result[label] =
			label === target ? base + epsilon * (labels.length - 1) : base - epsilon;
	}
	return result;
}

async function deterministicEmbedding(
	window: EventWindowV1,
): Promise<number[]> {
	const encoder = new TextEncoder();
	const vector: number[] = [];
	for (let block = 0; block < 8; block += 1) {
		const input = encoder.encode(
			`whalehall-reflection-embedding.v1\u0000${window.windowId}\u0000${window.inputHash}\u0000${block}`,
		);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
		for (const byte of digest) vector.push((byte - 127.5) / 127.5);
	}
	const norm = Math.hypot(...vector);
	if (!Number.isFinite(norm) || norm === 0) {
		throw new Error("Could not create the deterministic Reflection embedding.");
	}
	return vector.map((item) => item / norm);
}

function uniqueEvidenceEventIds(window: EventWindowV1): string[] {
	return [
		...new Set(
			window.events
				.filter(isCountedSemanticEvent)
				.map((event) => event.eventId),
		),
	];
}

function assertWindowGoalInvariant(window: EventWindowV1): void {
	if (
		(window.goal === null && window.goalVersion !== null) ||
		(window.goal !== null && window.goalVersion !== window.goal.version)
	) {
		throw new Error("Reflection window has inconsistent goal metadata.");
	}
}

function normalizedEntropy<L extends string>(
	distribution: Record<L, number>,
	labels: readonly L[],
): number {
	let entropy = 0;
	for (const label of labels) {
		const probability = distribution[label];
		if (probability > 0) entropy -= probability * Math.log(probability);
	}
	return Math.max(0, Math.min(1, entropy / Math.log(labels.length)));
}

function maximumProbability<L extends string>(
	distribution: Record<L, number>,
	labels: readonly L[],
): number {
	let maximum = 0;
	for (const label of labels) maximum = Math.max(maximum, distribution[label]);
	return maximum;
}
