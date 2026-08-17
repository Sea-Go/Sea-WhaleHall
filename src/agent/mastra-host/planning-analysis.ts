import { z } from "zod";
import {
	MAX_PLANNING_MODEL_CALENDAR_EVENTS,
	MAX_PLANNING_MODEL_CONTEXT_MESSAGES,
	MAX_PLANNING_MODEL_OBSERVATION_EVIDENCE,
	type PlanningModelAnalysisRequest,
} from "../planning/model";
import {
	PLAN_TASK_PURPOSES,
	PLAN_TASK_STATUSES,
	PLAN_TYPES,
} from "../planning/types";

const boundedIdSchema = z.string().trim().min(1).max(256);
const boundedTimestampSchema = z.string().trim().min(1).max(64);

const planningInputPreferencesSchema = z
	.object({
		weeklyCapacityMinutes: z.number().int().min(15).max(10_080).multipleOf(15),
		sessionMinutes: z.number().int().min(15).max(480).multipleOf(15),
		availableWindows: z
			.array(
				z
					.object({
						dayOfWeek: z.number().int().min(1).max(7),
						startTime: z.string().max(5),
						endTime: z.string().max(5),
					})
					.strict(),
			)
			.min(1)
			.max(28),
	})
	.strict();

/** Strict private-stdio boundary for the durable PlanningRuntime snapshot. */
export const dynamicPlanningInputSchema = z
	.object({
		planId: boundedIdSchema,
		analysisMode: z.enum(["manual-proposal", "automatic-adjustment"]),
		currentGoal: z.string().max(1_000),
		currentType: z.enum(PLAN_TYPES).nullable(),
		trigger: z.enum([
			"initial-analysis",
			"conversation",
			"task-status",
			"observation",
			"calendar-change",
			"daily-summary",
			"resume",
		]),
		effectiveWindow: z
			.object({
				startDate: z.string().max(10),
				endDateExclusive: z.string().max(10),
				timeZone: z.string().trim().min(1).max(100),
			})
			.strict(),
		messages: z
			.array(
				z
					.object({
						id: boundedIdSchema,
						planId: boundedIdSchema,
						role: z.enum(["user", "assistant"]),
						content: z.string().max(64 * 1_024),
						createdAt: boundedTimestampSchema,
						causedByOperationId: boundedIdSchema,
					})
					.strict(),
			)
			.max(MAX_PLANNING_MODEL_CONTEXT_MESSAGES),
		currentTasks: z
			.array(
				z
					.object({
						id: boundedIdSchema,
						planId: boundedIdSchema,
						sourceKey: z.string().trim().min(1).max(100),
						purpose: z.enum(PLAN_TASK_PURPOSES),
						title: z.string().trim().min(1).max(200),
						description: z.string().max(1_000),
						estimatedMinutes: z.number().int().min(15).max(100_000),
						dependencyTaskIds: z.array(boundedIdSchema).max(50),
						status: z.enum(PLAN_TASK_STATUSES),
						statusChangedAt: boundedTimestampSchema.nullable(),
						statusChangedBy: z.literal("user").nullable(),
					})
					.strict(),
			)
			.max(100),
		currentEstimate: z
			.object({
				id: boundedIdSchema,
				estimatedCompletionDate: z.string().max(10),
				confidence: z.number().min(0).max(1),
				assessedAt: boundedTimestampSchema,
				evidenceThrough: boundedTimestampSchema,
				basis: z.string().max(1_000),
				modelVersion: z.string().trim().min(1).max(256),
			})
			.strict()
			.nullable(),
		currentSchedulingPreferences: planningInputPreferencesSchema.nullable(),
		observationEvidence: z
			.array(
				z
					.object({
						id: boundedIdSchema,
						observationId: boundedIdSchema,
						planId: boundedIdSchema,
						taskId: boundedIdSchema,
						startedAt: boundedTimestampSchema,
						endedAt: boundedTimestampSchema,
						relevantMinutes: z.number().int().min(0).max(100_000),
						confidence: z.number().min(0).max(1),
						attribution: z.enum(["unique-observed", "user-confirmed"]),
						recordedAt: boundedTimestampSchema,
					})
					.strict(),
			)
			.max(MAX_PLANNING_MODEL_OBSERVATION_EVIDENCE),
		calendarEvents: z
			.array(
				z
					.object({
						id: boundedIdSchema,
						title: z.string().max(500),
						kind: z.enum(["plan", "manual-block", "external", "break"]),
						state: z.enum(["proposed", "committed"]),
						start: boundedTimestampSchema,
						end: boundedTimestampSchema,
						timeZone: z.string().trim().min(1).max(100),
						planId: boundedIdSchema.nullable(),
						sourceTaskId: boundedIdSchema.nullable(),
						scheduleOrigin: z.enum(["model", "user"]),
						userLocked: z.boolean(),
						version: z.number().int().min(0),
					})
					.strict(),
			)
			.max(MAX_PLANNING_MODEL_CALENDAR_EVENTS),
	})
	.strict();

const planningAvailableWindowSchema = z
	.object({
		dayOfWeek: z.number().int().min(1).max(7),
		startTime: z.string(),
		endTime: z.string(),
	})
	.strict();

const planningPreferencesSchema = z
	.object({
		weeklyCapacityMinutes: z.number().int().min(15).max(10_080).multipleOf(15),
		sessionMinutes: z.number().int().min(15).max(480).multipleOf(15),
		availableWindows: z.array(planningAvailableWindowSchema).min(1).max(28),
	})
	.strict();

const planningTaskSchema = z
	.object({
		// Provider-facing schemas deliberately avoid `pattern`: some compatible
		// upstreams can terminate while compiling it. App-side domain validation
		// still enforces the exact ASCII identifier grammar.
		taskKey: z.string().min(1).max(100),
		purpose: z.enum(PLAN_TASK_PURPOSES),
		title: z.string().trim().min(1).max(200),
		description: z.string().max(1_000),
		estimatedMinutes: z.number().int().min(15).max(100_000).multipleOf(15),
		dependencyKeys: z.array(z.string().max(100)).max(50),
	})
	.strict();

const commonPlanningOutput = {
	recommendedType: z.enum(PLAN_TYPES),
	rationaleSummary: z.string().trim().min(1).max(500),
	assumptions: z.array(z.string().max(300)).max(12),
	assistantMessage: z.string().trim().min(1).max(2_000),
};

const planningQuestionSchema = z.string().trim().min(1).max(300);

const planningProposalPayloadSchema = z
	.object({
		goal: z.string().trim().min(1).max(1_000),
		estimatedCompletionDate: z.string(),
		confidence: z.number().min(0).max(1),
		estimateBasis: z.string().trim().min(1).max(1_000),
		schedulingPreferenceSource: z.enum(["user-provided", "confirmed-reuse"]),
		schedulingPreferences: planningPreferencesSchema,
		tasks: z.array(planningTaskSchema).min(1).max(100),
	})
	.strict();

const planningProposalKeys = [
	"goal",
	"estimatedCompletionDate",
	"confidence",
	"estimateBasis",
	"schedulingPreferenceSource",
	"schedulingPreferences",
	"tasks",
] as const;

const planningProviderCommonKeys = [
	"outcome",
	"recommendedType",
	"rationaleSummary",
	"assumptions",
	"clarificationQuestions",
	"assistantMessage",
] as const;

function claimsConfirmedSchedulingPreferences(value: string): boolean {
	const normalized = value.toLowerCase();
	return (
		(normalized.includes("已确认") && normalized.includes("偏好")) ||
		(normalized.includes("confirmed") && normalized.includes("preference"))
	);
}

/**
 * Provider-facing envelope with one stable object shape. Small compatible
 * models frequently merge `oneOf` branches when the schema is prompt-injected;
 * nesting proposal-only fields behind a nullable key removes that ambiguity.
 */
export const dynamicPlanningProviderOutputSchema = z
	.object({
		outcome: z.enum(["needs-clarification", "proposal"]),
		...commonPlanningOutput,
		clarificationQuestions: z.array(planningQuestionSchema).max(8).optional(),
		proposal: planningProposalPayloadSchema.nullable().optional(),
	})
	// Keep the prompt schema stable while tolerating the one known legacy model
	// failure shape. The decoder below accepts only named proposal fields and
	// rejects every arbitrary extra before the strict domain union sees it.
	.passthrough();

/** Provider-facing structural constraint; domain validation remains authoritative. */
export const dynamicPlanningOutputSchema = z.discriminatedUnion("outcome", [
	z
		.object({
			outcome: z.literal("needs-clarification"),
			...commonPlanningOutput,
			clarificationQuestions: z.array(planningQuestionSchema).min(1).max(8),
		})
		.strict(),
	z
		.object({
			outcome: z.literal("proposal"),
			...commonPlanningOutput,
			clarificationQuestions: z.array(planningQuestionSchema).max(0),
			...planningProposalPayloadSchema.shape,
		})
		.strict(),
]);

/** Converts the model envelope into the strict app/domain union. */
export function decodeDynamicPlanningProviderOutput(
	value: unknown,
	analysis: Pick<
		PlanningModelAnalysisRequest,
		"analysisMode" | "currentSchedulingPreferences"
	>,
): unknown {
	const parsed = dynamicPlanningProviderOutputSchema.safeParse(value);
	if (!parsed.success) return null;
	const allowedKeys = new Set<string>([
		...planningProviderCommonKeys,
		"proposal",
		...planningProposalKeys,
	]);
	if (Object.keys(parsed.data).some((key) => !allowedKeys.has(key)))
		return null;
	const common = {
		outcome: parsed.data.outcome,
		recommendedType: parsed.data.recommendedType,
		rationaleSummary: parsed.data.rationaleSummary,
		assumptions: parsed.data.assumptions,
		// A proposal with no follow-up questions is unambiguous even when a
		// compatible provider omits the empty array. Clarification outcomes still
		// fail closed below because they require at least one concrete question.
		clarificationQuestions: parsed.data.clarificationQuestions ?? [],
		assistantMessage: parsed.data.assistantMessage,
	};
	if (common.outcome === "needs-clarification") {
		if (common.clarificationQuestions.length === 0) return null;
		return common;
	}
	const flatProposalKeys = planningProposalKeys.filter(
		(key) => key in parsed.data,
	);
	if (parsed.data.proposal && flatProposalKeys.length > 0) return null;
	const proposalCandidate =
		parsed.data.proposal ??
		Object.fromEntries(
			planningProposalKeys
				.filter((key) => key in parsed.data)
				.map((key) => [key, parsed.data[key]]),
		);
	const proposal = planningProposalPayloadSchema.safeParse(proposalCandidate);
	if (!proposal.success) {
		if (common.clarificationQuestions.length === 0) return null;
		if (analysis.analysisMode === "automatic-adjustment") return null;
		return { ...common, outcome: "needs-clarification" };
	}
	if (
		common.clarificationQuestions.length !== 0 &&
		analysis.analysisMode === "automatic-adjustment"
	) {
		return null;
	}
	const reclassifiedSchedulingPreferences =
		proposal.data.schedulingPreferenceSource === "confirmed-reuse" &&
		analysis.analysisMode === "manual-proposal" &&
		analysis.currentSchedulingPreferences === null;
	const schedulingPreferenceSource = reclassifiedSchedulingPreferences
		? "user-provided"
		: proposal.data.schedulingPreferenceSource;
	return {
		...common,
		// A complete proposal is still only a user-confirmed draft. Small models
		// sometimes append follow-up questions despite selecting `proposal`; those
		// questions must not trap an otherwise valid draft in an endless clarify
		// loop during a manual request, while every proposal field has already
		// passed the strict schema. Automatic adjustments fail closed above because
		// they do not have the same user-confirmation boundary.
		clarificationQuestions: [],
		...proposal.data,
		// With no confirmed revision, a manual draft can only be user-provided.
		// Reclassifying the provider's bad label is safe because the proposal is
		// still inert until the user reviews and confirms it. Automatic analysis
		// and existing confirmed preferences never use this compatibility path.
		schedulingPreferenceSource,
		assumptions: reclassifiedSchedulingPreferences
			? common.assumptions.filter(
					(item) => !claimsConfirmedSchedulingPreferences(item),
				)
			: common.assumptions,
		assistantMessage: reclassifiedSchedulingPreferences
			? "已生成一版完整提案；请核对排程偏好，确认后才会开始执行。"
			: common.assistantMessage,
		confidence:
			common.recommendedType === "fuzzy"
				? Math.min(proposal.data.confidence, 0.5)
				: proposal.data.confidence,
	};
}
