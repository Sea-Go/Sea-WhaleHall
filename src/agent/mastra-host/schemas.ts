import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(256);
const shortTextSchema = z.string().trim().min(1).max(1_000);
const longTextSchema = z.string().trim().min(1).max(4_000);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeZoneSchema = z.string().trim().min(1).max(128);

export const taskPlanningInputSchema = z.object({
	goal: z.string().trim().min(1).max(1_000),
	planType: z.enum(["short-term", "long-term"]),
	deadline: dateSchema,
	priority: z.enum(["low", "medium", "high"]),
	weeklyCapacityHours: z.number().finite().min(1).max(40),
	unavailableDays: z.array(z.enum([
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
		"sunday",
	])).max(7),
	preferredSessionMinutes: z.union([
		z.literal(30),
		z.literal(45),
		z.literal(60),
		z.literal(90),
	]),
	preferredDayPart: z.enum([
		"morning",
		"afternoon",
		"evening",
		"flexible",
	]),
	timeZone: timeZoneSchema,
}).strict();

export const taskPlanningQuestionKeySchema = z.enum([
	"task_type",
	"brief_extraction_confirmation",
	"expected_outcome",
	"deadline",
	"current_progress",
	"scope",
	"capacity",
	"constraints",
	"skill_context",
	"risks",
]);

export const taskPlanningQuestionSchema = z.object({
	key: taskPlanningQuestionKeySchema,
	text: shortTextSchema,
	required: z.boolean(),
}).strict();

export const taskPlanningAnswerSchema = z.object({
	questionKey: taskPlanningQuestionKeySchema,
	answerText: longTextSchema,
}).strict();

export const taskPlanningDraftSchema = z.object({
	id: identifierSchema,
	title: shortTextSchema,
	assumptions: z.array(shortTextSchema).max(100),
	calendarRevision: z.number().int().nonnegative(),
	phases: z.array(
		z.object({
			id: identifierSchema,
			title: shortTextSchema,
			objective: longTextSchema,
			order: z.number().int().nonnegative(),
		}).strict(),
	).min(1).max(100),
	milestones: z.array(
		z.object({
			id: identifierSchema,
			phaseId: identifierSchema,
			title: shortTextSchema,
			description: longTextSchema,
			targetDate: dateSchema.optional(),
			acceptanceCriteria: z.array(shortTextSchema).max(100),
		}).strict(),
	).max(500),
	schedule: z.array(
		z.object({
			id: identifierSchema,
			taskId: identifierSchema,
			title: shortTextSchema,
			start: z.string().datetime({ offset: true }),
			end: z.string().datetime({ offset: true }),
			timeZone: timeZoneSchema,
		}).strict(),
	).max(1_000),
	unscheduledTaskIds: z.array(identifierSchema).max(1_000),
	tasks: z.array(
		z.object({
			id: identifierSchema,
			milestoneId: identifierSchema,
			title: shortTextSchema,
			description: longTextSchema,
			estimatedMinutes: z.number().int().min(1).max(525_600),
			importance: z.enum(["low", "medium", "high"]),
			dependencies: z.array(identifierSchema).max(1_000),
			completionCriteria: z.array(shortTextSchema).max(100),
		}).strict(),
	).max(1_000),
}).strict();

export const taskPlanningResultSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("clarifying"),
		questions: z.array(taskPlanningQuestionSchema).min(1).max(3),
	}).strict(),
	z.object({
		status: z.literal("draft"),
		draft: taskPlanningDraftSchema,
	}).strict(),
]);

export type TaskPlanningResult = z.infer<typeof taskPlanningResultSchema>;
export type TaskPlanningDraft = z.infer<typeof taskPlanningDraftSchema>;
