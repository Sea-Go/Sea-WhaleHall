import type { PlanningPlan, PlanTask } from "./types";

/** 计划记忆提示：从账号内已完成/归档计划推导的校准信号，注入深思上下文。 */
export interface PlanMemoryHints {
	/** 与当前目标相似的历史计划条数。 */
	similarPlanCount: number;
	/** 同类目标的实际/预估时长中位数（>1 表示普遍低估）。 */
	estimateCalibrationRatio: number | null;
	/** 校准样本量（有观测归因的完成任务数）。 */
	calibrationSamples: number;
	/** 弱关联任务的舍弃率（0-1，null 表示无样本）。 */
	weakSkipRate: number | null;
	/** 用户改判过的任务总数。 */
	overrideCount: number;
	/** 最多 3 条相似目标摘要（已完成）。 */
	similarGoals: readonly string[];
}

const MIN_GOAL_TOKENS = 2;
const MAX_SIMILAR_GOALS = 3;
/** 目标相似度：分词后 Jaccard 重叠下限。 */
const SIMILARITY_THRESHOLD = 0.34;

/**
 * 纯读路径的计划记忆：仓库里已完成/归档的计划本身就是经验。
 * 当前计划被排除；无相似先例时返回 null（模型侧明示"无先例"）。
 */
export function planMemoryHints(
	plans: readonly PlanningPlan[],
	currentPlanId: string,
	currentGoal: string,
): PlanMemoryHints | null {
	const finished = plans.filter(
		(plan) =>
			plan.id !== currentPlanId &&
			(plan.status === "completed" || plan.status === "archived"),
	);
	if (finished.length === 0) return null;
	const currentTokens = goalTokens(currentGoal);
	if (currentTokens.size < MIN_GOAL_TOKENS) return null;
	const similar = finished
		.map((plan) => ({
			plan,
			score: jaccard(currentTokens, goalTokens(plan.goal)),
		}))
		.filter((item) => item.score >= SIMILARITY_THRESHOLD)
		.sort((left, right) => right.score - left.score)
		.map((item) => item.plan);
	if (similar.length === 0) return null;

	const estimatedById = new Map<string, number>();
	for (const plan of similar) {
		for (const task of plan.tasks) {
			estimatedById.set(`${plan.id}:${task.id}`, task.estimatedMinutes);
		}
	}
	// 实际/预估比：观测归因分钟数 / 任务预估分钟数（钳到 [0.2, 5]）。
	const ratios: number[] = [];
	let weakCompleted = 0;
	let weakSkipped = 0;
	let overrideCount = 0;
	for (const plan of similar) {
		for (const evidence of plan.observationEvidence) {
			const estimated = estimatedById.get(`${plan.id}:${evidence.taskId}`);
			if (!estimated || estimated <= 0) continue;
			if (evidence.relevantMinutes <= 0) continue;
			const ratio = evidence.relevantMinutes / estimated;
			ratios.push(Math.min(Math.max(ratio, 0.2), 5));
		}
		for (const task of plan.tasks) {
			if (task.relevanceOverride) overrideCount += 1;
			if (isWeakTask(plan, task)) {
				if (task.status === "completed") weakCompleted += 1;
				else if (task.status === "skipped") weakSkipped += 1;
			}
		}
	}
	const weakSamples = weakCompleted + weakSkipped;
	return {
		similarPlanCount: similar.length,
		estimateCalibrationRatio: ratios.length > 0 ? median(ratios) : null,
		calibrationSamples: ratios.length,
		weakSkipRate: weakSamples > 0 ? weakSkipped / weakSamples : null,
		overrideCount,
		similarGoals: similar
			.slice(0, MAX_SIMILAR_GOALS)
			.map((plan) => truncateGoal(plan.goal)),
	};
}

function isWeakTask(plan: PlanningPlan, task: PlanTask): boolean {
	// 改判优先于模型分级；其次看展示修订里的分级。
	const override = task.relevanceOverride;
	if (override) return override === "weak";
	const revision = plan.revisions.find(
		(item) => item.id === (plan.proposedRevisionId ?? plan.activeRevisionId),
	);
	const revisionTask = revision?.tasks.find((item) => item.taskId === task.id);
	return (revisionTask?.relevance ?? "strong") === "weak";
}

function goalTokens(goal: string): Set<string> {
	return new Set(
		goal
			.toLowerCase()
			.split(/[^\p{Script=Han}\p{L}\p{N}]+/u)
			.filter((token) => token.length >= 2)
			// CJK 目标常无分词：长词再按 2-gram 补充重叠信号。
			.flatMap((token) =>
				/^[\p{Script=Han}]+$/u.test(token) && token.length > 2
					? [...bigrams(token), token]
					: [token],
			),
	);
}

function bigrams(token: string): string[] {
	const chars = Array.from(token);
	const grams: string[] = [];
	for (let index = 0; index + 1 < chars.length; index += 1) {
		grams.push(chars.slice(index, index + 2).join(""));
	}
	return grams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection += 1;
	}
	const union = left.size + right.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]!
		: (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function truncateGoal(goal: string): string {
	const chars = Array.from(goal);
	return chars.length <= 24 ? goal : `${chars.slice(0, 24).join("")}…`;
}
