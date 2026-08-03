import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import {
	taskPlanningAnswerSchema,
	taskPlanningDraftSchema,
	taskPlanningQuestionSchema,
} from "./schemas";

export const planningWorkflowInputSchema = z.object({
	sidecarRunId: z.string().trim().min(1).max(256),
	sessionId: z.string().trim().min(1).max(256),
}).strict();

export const planningWorkflowResumeSchema = z.object({
	sessionId: z.string().trim().min(1).max(256),
	answers: z.array(taskPlanningAnswerSchema).min(1).max(3),
	expectedVersion: z.number().int().nonnegative().optional(),
}).strict();

export const planningWorkflowClarificationSchema = z.object({
	kind: z.literal("planning.clarification"),
	sessionId: z.string().trim().min(1).max(256),
	status: z.literal("clarifying"),
	clarificationRounds: z.number().int().min(1).max(3),
	version: z.number().int().nonnegative(),
	questions: z.array(taskPlanningQuestionSchema).min(1).max(3),
}).strict();

const planningValidationIssueSchema = z.object({
	code: z.string().trim().min(1).max(128),
	message: z.string().trim().min(1).max(4_000),
	proposalId: z.string().trim().min(1).max(256).optional(),
	busyEventIds: z.array(z.string().trim().min(1).max(256)).max(1_000).optional(),
}).strict();

export const planningWorkflowCompletionSchema = z.discriminatedUnion("status", [
	z.object({
		sessionId: z.string().trim().min(1).max(256),
		status: z.literal("draft"),
		clarificationRounds: z.number().int().nonnegative().max(3),
		version: z.number().int().nonnegative(),
		draft: taskPlanningDraftSchema,
	}).strict(),
	z.object({
		sessionId: z.string().trim().min(1).max(256),
		status: z.literal("conflict"),
		clarificationRounds: z.number().int().nonnegative().max(3),
		version: z.number().int().nonnegative(),
		draft: taskPlanningDraftSchema,
		validationIssues: z.array(planningValidationIssueSchema).min(1).max(1_000),
	}).strict(),
]);

export type PlanningWorkflowInput = z.infer<typeof planningWorkflowInputSchema>;
export type PlanningWorkflowResume = z.infer<typeof planningWorkflowResumeSchema>;
export type PlanningWorkflowClarification = z.infer<
	typeof planningWorkflowClarificationSchema
>;
export type PlanningWorkflowCompletion = z.infer<
	typeof planningWorkflowCompletionSchema
>;
export type PlanningWorkflowOutcome =
	| PlanningWorkflowClarification
	| PlanningWorkflowCompletion;

export interface PlanningWorkflowDriverInput {
	input: PlanningWorkflowInput;
	resumeData?: PlanningWorkflowResume;
	requestContext: RequestContext;
	abortSignal: AbortSignal;
}

export type PlanningWorkflowDriver = (
	input: PlanningWorkflowDriverInput,
) => Promise<PlanningWorkflowOutcome>;

export const planningWorkflowResumeLabel = "planning.clarification";
export const planningWorkflowStepId = "planning-cycle";

export function createTaskPlanningWorkflow(driver: PlanningWorkflowDriver) {
	const planningCycle = createStep({
		id: planningWorkflowStepId,
		inputSchema: planningWorkflowInputSchema,
		outputSchema: planningWorkflowCompletionSchema,
		resumeSchema: planningWorkflowResumeSchema,
		suspendSchema: planningWorkflowClarificationSchema,
		execute: async ({
			inputData,
			resumeData,
			requestContext,
			abortSignal,
			suspend,
		}) => {
			const outcome = await driver({
				input: inputData,
				resumeData,
				requestContext,
				abortSignal,
			});
			if (outcome.status === "clarifying") {
				return suspend(outcome, { resumeLabel: planningWorkflowResumeLabel });
			}
			return outcome;
		},
	});

	return createWorkflow({
		id: "task-planning",
		inputSchema: planningWorkflowInputSchema,
		outputSchema: planningWorkflowCompletionSchema,
	})
		.then(planningCycle)
		.commit();
}

export type TaskPlanningWorkflow = ReturnType<
	typeof createTaskPlanningWorkflow
>;
