import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
	activityReflectionActivitySchema,
	activityReflectionModelOutputSchema,
	MAX_ACTIVITY_REFLECTION_PROMPT_CHARACTERS,
} from "../activity-reflection-prompt";

/**
 * The input is a complete prompt built by the desktop client. It remains in
 * local Bun/Sidecar memory only; the remote relay receives the resulting
 * OpenAI-compatible model request and owns no prompt policy or aggregation.
 */
export const activityReflectionWorkflowInputSchema = z
	.object({
		invocationId: z.string().trim().min(1).max(256),
		requestId: z.string().trim().min(1).max(128),
		userPrompt: z
			.string()
			.min(1)
			.max(MAX_ACTIVITY_REFLECTION_PROMPT_CHARACTERS),
		signalSegmentIds: z
			.array(z.string().regex(/^segment-[1-9][0-9]*$/u))
			.min(1)
			.max(64),
		candidateActivities: z
			.array(activityReflectionActivitySchema)
			.min(1)
			.max(12),
	})
	.strict();

export const activityReflectionWorkflowOutcomeSchema = z.discriminatedUnion(
	"kind",
	[
		z
			.object({
				kind: z.literal("completed"),
				modelOutput: activityReflectionModelOutputSchema,
			})
			.strict(),
		z.object({ kind: z.literal("invalid-output") }).strict(),
	],
);

export type ActivityReflectionWorkflowInput = z.infer<
	typeof activityReflectionWorkflowInputSchema
>;
export type ActivityReflectionWorkflowOutcome = z.infer<
	typeof activityReflectionWorkflowOutcomeSchema
>;

export interface ActivityReflectionWorkflowDriverInput
	extends ActivityReflectionWorkflowInput {
	abortSignal: AbortSignal;
}

export type ActivityReflectionWorkflowDriver = (
	input: ActivityReflectionWorkflowDriverInput,
) => Promise<ActivityReflectionWorkflowOutcome>;

export const activityReflectionWorkflowId = "activity-reflection";
export const activityReflectionWorkflowStepId = "invoke-reflection-model";

/**
 * A no-persistence Mastra workflow that performs one structured model call.
 * It has no Tools, Memory, Agent run, or snapshot. Prompt construction and
 * final result normalization both stay in the desktop client.
 */
export function createActivityReflectionWorkflow(
	driver: ActivityReflectionWorkflowDriver,
) {
	const invokeReflectionModel = createStep({
		id: activityReflectionWorkflowStepId,
		inputSchema: activityReflectionWorkflowInputSchema,
		outputSchema: activityReflectionWorkflowOutcomeSchema,
		execute: async ({ inputData, abortSignal }) =>
			driver({ ...inputData, abortSignal }),
	});

	return createWorkflow({
		id: activityReflectionWorkflowId,
		inputSchema: activityReflectionWorkflowInputSchema,
		outputSchema: activityReflectionWorkflowOutcomeSchema,
		options: {
			// The raw-data-bearing prompt and model output are live-only client
			// data. The durable activity receipt is written later by Bun after
			// deterministic validation.
			shouldPersistSnapshot: () => false,
		},
	})
		.then(invokeReflectionModel)
		.commit();
}

export type ActivityReflectionWorkflow = ReturnType<
	typeof createActivityReflectionWorkflow
>;
