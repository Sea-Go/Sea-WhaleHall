import type { ActivityAnalysisWorkerResult } from "./activity-analysis-contract";
import type { ProactiveFeedbackItem } from "./proactive-feedback";

export const MAXIMUM_ACTIVITY_SUPPORT_OBSERVATIONS = 40;
export const MAXIMUM_ACTIVITY_SUPPORT_RECENT_APPROACHES = 2;
export const ACTIVITY_SUPPORT_CONTEXT_SCHEMA_VERSION =
	"activity-support-context.v1" as const;

export const ACTIVITY_SUPPORT_ACTIVITIES = [
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
] as const;
export const ACTIVITY_SUPPORT_GOAL_RELATIONS = [
	"direct",
	"supporting",
	"unrelated",
	"uncertain",
] as const;
export const ACTIVITY_SUPPORT_SIGNALS = [
	"goal_progress",
	"possible_blocker",
	"goal_unrelated",
	"recovery",
	"uncertain",
] as const;
export const ACTIVITY_SUPPORT_APPROACHES = [
	"small_step",
	"problem_breakdown",
	"gentle_refocus",
	"rest_and_resume",
	"open_check_in",
] as const;

export type ActivitySupportActivity =
	(typeof ACTIVITY_SUPPORT_ACTIVITIES)[number];
export type ActivitySupportGoalRelation =
	(typeof ACTIVITY_SUPPORT_GOAL_RELATIONS)[number];
export type ActivitySupportSignal = (typeof ACTIVITY_SUPPORT_SIGNALS)[number];
export type ActivitySupportApproach =
	(typeof ACTIVITY_SUPPORT_APPROACHES)[number];

export type ActivitySupportEvidenceStrength = "strong" | "moderate" | "weak";

/**
 * The only activity data allowed to cross into the proactive-support Agent
 * team. Scores, request/source IDs, timestamps, and score explanations are
 * deliberately absent: they belong to Bun's trigger and durable ledger only.
 */
export interface ActivitySupportObservation {
	activity: ActivitySupportActivity;
	goalRelation: ActivitySupportGoalRelation;
	evidenceStrength: ActivitySupportEvidenceStrength;
	signals: readonly ActivitySupportSignal[];
}

export interface ActivitySupportContext {
	schemaVersion: typeof ACTIVITY_SUPPORT_CONTEXT_SCHEMA_VERSION;
	activeGoal: string | null;
	recentApproaches: readonly ActivitySupportApproach[];
	observations: readonly ActivitySupportObservation[];
}

/**
 * Encrypted with the first-stage archive so every transport retry reuses the
 * exact goal/support-approach view that existed when the source window was
 * sealed. Historical feedback text never crosses this boundary.
 */
export interface ActivitySupportPersonalization {
	activeGoal: string | null;
	recentApproaches: readonly ActivitySupportApproach[];
}

export function createActivitySupportPersonalization<
	TGoal extends { text: string },
>(input: {
	activeGoal: TGoal | null;
	recentFeedback: readonly ProactiveFeedbackItem[];
}): ActivitySupportPersonalization {
	return {
		activeGoal: input.activeGoal?.text ?? null,
		recentApproaches: uniqueApproaches(
			input.recentFeedback.map((item) => feedbackApproach(item.message)),
		).slice(0, MAXIMUM_ACTIVITY_SUPPORT_RECENT_APPROACHES),
	};
}

export function createActivitySupportContext<
	TGoal extends { text: string },
>(input: {
	activeGoal: TGoal | null;
	recentFeedback: readonly ProactiveFeedbackItem[];
	analyses: readonly ActivityAnalysisWorkerResult[];
}): ActivitySupportContext {
	return createActivitySupportContextFromPersonalization(
		createActivitySupportPersonalization(input),
		input.analyses,
	);
}

export function createActivitySupportContextFromPersonalization(
	personalization: ActivitySupportPersonalization,
	analyses: readonly ActivityAnalysisWorkerResult[],
): ActivitySupportContext {
	if (!isActivitySupportPersonalization(personalization)) {
		throw new Error("Activity support personalization is invalid.");
	}
	// Worker jobs are ordered from oldest to newest. When a score threshold
	// collects more than this bounded context can carry, retain the most recent
	// observations so the support team does not react to stale activity.
	const observations = analyses
		.flatMap((analysis) => analysis.events.map(projectSupportObservation))
		.slice(-MAXIMUM_ACTIVITY_SUPPORT_OBSERVATIONS);
	return {
		schemaVersion: ACTIVITY_SUPPORT_CONTEXT_SCHEMA_VERSION,
		activeGoal: personalization.activeGoal,
		recentApproaches: [...personalization.recentApproaches],
		observations,
	};
}

export function isActivitySupportPersonalization(
	value: unknown,
): value is ActivitySupportPersonalization {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["activeGoal", "recentApproaches"]) ||
		(value.activeGoal !== null &&
			!isBoundedText(value.activeGoal, 1_000, false))
	) {
		return false;
	}
	return (
		Array.isArray(value.recentApproaches) &&
		value.recentApproaches.length <=
			MAXIMUM_ACTIVITY_SUPPORT_RECENT_APPROACHES &&
		value.recentApproaches.every(isActivitySupportApproach) &&
		new Set(value.recentApproaches).size === value.recentApproaches.length
	);
}

export function isActivitySupportContext(
	value: unknown,
): value is ActivitySupportContext {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"activeGoal",
			"recentApproaches",
			"observations",
		]) ||
		value.schemaVersion !== ACTIVITY_SUPPORT_CONTEXT_SCHEMA_VERSION
	) {
		return false;
	}
	if (
		value.activeGoal !== null &&
		!isBoundedText(value.activeGoal, 1_000, false)
	) {
		return false;
	}
	if (
		!Array.isArray(value.recentApproaches) ||
		value.recentApproaches.length >
			MAXIMUM_ACTIVITY_SUPPORT_RECENT_APPROACHES ||
		!value.recentApproaches.every(isActivitySupportApproach) ||
		new Set(value.recentApproaches).size !== value.recentApproaches.length
	) {
		return false;
	}
	return (
		Array.isArray(value.observations) &&
		value.observations.length >= 1 &&
		value.observations.length <= MAXIMUM_ACTIVITY_SUPPORT_OBSERVATIONS &&
		value.observations.every(isActivitySupportObservation)
	);
}

export function containsScoringLanguage(value: string): boolean {
	return /(?:分数|评分|得分|贡献度|置信度|证据强度|满分|零分|[一二三四五六七八九十百两]+分(?:[，。！？、\s]|$)|score(?:_reason)?|consumedScore|[%％]|\d+(?:\.\d+)?\s*分(?!钟)|\b(?:0?\.\d+|1\.0+)\b)/iu.test(
		value,
	);
}

function isActivitySupportObservation(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"activity",
			"goalRelation",
			"evidenceStrength",
			"signals",
		]) &&
		isActivitySupportActivity(value.activity) &&
		isActivitySupportGoalRelation(value.goalRelation) &&
		(value.evidenceStrength === "strong" ||
			value.evidenceStrength === "moderate" ||
			value.evidenceStrength === "weak") &&
		Array.isArray(value.signals) &&
		value.signals.length >= 1 &&
		value.signals.length <= 3 &&
		value.signals.every(isActivitySupportSignal) &&
		new Set(value.signals).size === value.signals.length &&
		isConsistentSignalSet(value.goalRelation, value.signals)
	);
}

function projectSupportObservation(
	event: ActivityAnalysisWorkerResult["events"][number],
): ActivitySupportObservation {
	const activity = isActivitySupportActivity(event.activity)
		? event.activity
		: "other_unknown";
	const goalRelation = isActivitySupportGoalRelation(event.goal_relevance)
		? event.goal_relevance
		: "uncertain";
	return {
		activity,
		goalRelation,
		evidenceStrength: evidenceStrength(event.confidence),
		signals: supportSignals(event.action, goalRelation),
	};
}

function supportSignals(
	action: string | undefined,
	goalRelation: ActivitySupportGoalRelation,
): readonly ActivitySupportSignal[] {
	if (!action || action.startsWith("不确定：")) return ["uncertain"];
	const signals: ActivitySupportSignal[] = [];
	const aligned = goalRelation === "direct" || goalRelation === "supporting";
	if (aligned) signals.push("goal_progress");
	if (goalRelation === "unrelated") signals.push("goal_unrelated");
	if (
		aligned &&
		(/(?:卡住|卡点|受阻|失败|报错|错误)/u.test(action) ||
			/(?:(?:反复|重试).*(?:排查|调试|尝试|验证|修复)|(?:排查|调试|尝试|验证|修复).*(?:反复|重试))/u.test(
				action,
			))
	) {
		signals.push("possible_blocker");
	}
	if (/(?:休息|放松|恢复|暂停|缓一缓|降低负荷)/u.test(action)) {
		signals.push("recovery");
	}
	return signals.length > 0 ? signals : ["uncertain"];
}

function feedbackApproach(message: string): ActivitySupportApproach | null {
	if (/(?:验证|排查|拆|不确定|问题)/u.test(message)) {
		return "problem_breakdown";
	}
	if (/(?:休息|歇|放松|恢复|缓一缓)/u.test(message)) {
		return "rest_and_resume";
	}
	if (/(?:回来|回到|重新进入|回归)/u.test(message)) {
		return "gentle_refocus";
	}
	if (/(?:最小|一小步|下一步|眼前一步)/u.test(message)) {
		return "small_step";
	}
	if (/(?:你更想|你需要|哪一种|怎么帮)/u.test(message)) {
		return "open_check_in";
	}
	return null;
}

function uniqueApproaches(
	values: readonly (ActivitySupportApproach | null)[],
): ActivitySupportApproach[] {
	return [...new Set(values.filter(isActivitySupportApproach))];
}

function isActivitySupportActivity(
	value: unknown,
): value is ActivitySupportActivity {
	return ACTIVITY_SUPPORT_ACTIVITIES.some((candidate) => candidate === value);
}

function isActivitySupportGoalRelation(
	value: unknown,
): value is ActivitySupportGoalRelation {
	return ACTIVITY_SUPPORT_GOAL_RELATIONS.some(
		(candidate) => candidate === value,
	);
}

function isActivitySupportSignal(
	value: unknown,
): value is ActivitySupportSignal {
	return ACTIVITY_SUPPORT_SIGNALS.some((candidate) => candidate === value);
}

function isActivitySupportApproach(
	value: unknown,
): value is ActivitySupportApproach {
	return ACTIVITY_SUPPORT_APPROACHES.some((candidate) => candidate === value);
}

function isConsistentSignalSet(
	goalRelation: ActivitySupportGoalRelation,
	signals: readonly ActivitySupportSignal[],
): boolean {
	if (signals.includes("uncertain")) return signals.length === 1;
	if (
		signals.includes("goal_progress") &&
		goalRelation !== "direct" &&
		goalRelation !== "supporting"
	) {
		return false;
	}
	if (
		signals.includes("possible_blocker") &&
		goalRelation !== "direct" &&
		goalRelation !== "supporting"
	) {
		return false;
	}
	return !signals.includes("goal_unrelated") || goalRelation === "unrelated";
}

function evidenceStrength(confidence: number): ActivitySupportEvidenceStrength {
	if (confidence >= 0.8) return "strong";
	if (confidence >= 0.55) return "moderate";
	return "weak";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === expected.length && expected.every((key) => key in value)
	);
}

function isBoundedText(
	value: unknown,
	maximum: number,
	allowEmpty: boolean,
): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.trim().length > 0) &&
		value.length <= maximum &&
		!containsDisallowedControlCharacter(value)
	);
}

function containsDisallowedControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		if (
			codePoint <= 0x08 ||
			(codePoint >= 0x0b && codePoint <= 0x1f) ||
			(codePoint >= 0x7f && codePoint <= 0x9f)
		) {
			return true;
		}
	}
	return false;
}
