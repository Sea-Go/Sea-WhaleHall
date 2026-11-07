import type { PlanMemoryHints } from "./plan-memory";
import type { PlanTaskStatus } from "./types";

/**
 * 确定性 relevance 第三信号源（纯函数，无 IO、无时钟）。
 *
 * 与既有强弱治理链的关系：用户 relevanceOverride 优先级最高，模型自评是
 * 第二源，本信号只作为输入侧提示（PlanningModelAnalysisRequest.relevanceHints）
 * 注入语义分析；是否参与调度排序（Phase 2）需要产品拍板后另行接线。
 * 不读取任务级截止日期：PlanTask 没有该字段，预计完成日期是计划级估算。
 */

/** 有效基线分级：用户 override ?? 模型分级 ?? strong（与 runtime relevanceOf 同语义）。 */
export type RelevanceSignalBase = "strong" | "weak";

export interface RelevanceSignalTaskInput {
	taskId: string;
	sourceKey: string;
	estimatedMinutes: number;
	dependencyTaskIds: readonly string[];
	status: PlanTaskStatus;
	baseRelevance: RelevanceSignalBase;
}

export interface RelevanceSignalContext {
	/** 当前请求内依赖各任务的 pending 任务数，按 taskId 索引。 */
	dependedOnCountByTaskId: ReadonlyMap<string, number>;
	memoryHints: PlanMemoryHints | null;
	/** 已确认单次会话分钟数；未确认偏好时为 null。 */
	sessionMinutes: number | null;
}

/** 注入语义分析输入的 relevance 提示（单条）。 */
export interface PlanningRelevanceHint {
	taskKey: string;
	suggested: "strong" | "weak";
	reason: string;
}

const STRONG_DEPENDENT_THRESHOLD = 2;
const WEAK_SKIP_RATE_THRESHOLD = 0.5;
const MIN_CALIBRATION_SAMPLES = 5;
const SESSION_SPLIT_FACTOR = 2;

function deriveRelevanceSignal(
	task: RelevanceSignalTaskInput,
	context: RelevanceSignalContext,
): PlanningRelevanceHint {
	const reasons: string[] = [];
	let suggested: RelevanceSignalBase = task.baseRelevance;

	// 历史校准：弱关联任务长期被舍弃 -> 倾向降级。
	const hints = context.memoryHints;
	if (
		hints !== null &&
		hints.weakSkipRate !== null &&
		hints.weakSkipRate >= WEAK_SKIP_RATE_THRESHOLD &&
		hints.calibrationSamples >= MIN_CALIBRATION_SAMPLES
	) {
		suggested = "weak";
		reasons.push(
			`历史弱关联任务舍弃率 ${Math.round(hints.weakSkipRate * 100)}%（样本 ${hints.calibrationSamples}）`,
		);
	}

	// 依赖拓扑：被足够多的未完成任务依赖 -> 升回 strong（优先于降级倾向）。
	const dependedOnCount = context.dependedOnCountByTaskId.get(task.taskId) ?? 0;
	if (dependedOnCount >= STRONG_DEPENDENT_THRESHOLD) {
		suggested = "strong";
		reasons.push(`被 ${dependedOnCount} 个未完成任务依赖`);
	}

	// 拆分提示：只附 reason，不改变分级。
	if (
		context.sessionMinutes !== null &&
		task.estimatedMinutes > context.sessionMinutes * SESSION_SPLIT_FACTOR
	) {
		reasons.push("估时超过单次会话时长两倍，建议拆分");
	}

	if (reasons.length === 0) {
		reasons.push("无确定性信号，沿用基线分级");
	}
	return {
		taskKey: task.sourceKey,
		suggested,
		reason: reasons.join("；"),
	};
}

/**
 * 为一次语义分析请求批量计算 relevance 提示。依赖计数只统计 status=pending
 * 的下游任务（已完成/已跳过的依赖不产生升级信号）。
 */
export function deriveRelevanceHints(
	tasks: readonly RelevanceSignalTaskInput[],
	context: {
		memoryHints: PlanMemoryHints | null;
		sessionMinutes: number | null;
	},
): PlanningRelevanceHint[] {
	const dependedOnCountByTaskId = new Map<string, number>();
	for (const task of tasks) {
		if (task.status !== "pending") continue;
		for (const dependencyTaskId of task.dependencyTaskIds) {
			dependedOnCountByTaskId.set(
				dependencyTaskId,
				(dependedOnCountByTaskId.get(dependencyTaskId) ?? 0) + 1,
			);
		}
	}
	return tasks.map((task) =>
		deriveRelevanceSignal(task, {
			dependedOnCountByTaskId,
			memoryHints: context.memoryHints,
			sessionMinutes: context.sessionMinutes,
		}),
	);
}
