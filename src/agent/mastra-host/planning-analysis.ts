import { z } from "zod";
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
			.max(256),
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
			.max(1_000),
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
			.max(2_000),
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

/** Provider-facing structural constraint; domain validation remains authoritative. */
export const dynamicPlanningOutputSchema = z.discriminatedUnion("outcome", [
	z
		.object({
			outcome: z.literal("needs-clarification"),
			...commonPlanningOutput,
			clarificationQuestions: z.array(z.string().max(300)).min(1).max(8),
		})
		.strict(),
	z
		.object({
			outcome: z.literal("proposal"),
			...commonPlanningOutput,
			clarificationQuestions: z.array(z.string().max(300)).max(0),
			goal: z.string().trim().min(1).max(1_000),
			estimatedCompletionDate: z.string(),
			confidence: z.number().min(0).max(1),
			estimateBasis: z.string().trim().min(1).max(1_000),
			schedulingPreferenceSource: z.enum(["user-provided", "confirmed-reuse"]),
			schedulingPreferences: planningPreferencesSchema,
			tasks: z.array(planningTaskSchema).min(1).max(100),
		})
		.strict(),
]);
