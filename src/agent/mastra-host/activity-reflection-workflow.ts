import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
	activityReflectionModelOutputSchema,
	MAX_ACTIVITY_REFLECTION_PROMPT_CHARACTERS,
	type ActivityReflectionModelOutput,
} from "../activity-reflection-prompt";
import { z } from "zod";

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
	})
	.strict();

export const activityReflectionWorkflowOutcomeSchema = z
	.object({
		modelOutput: activityReflectionModelOutputSchema,
	})
	.strict();

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
) => Promise<ActivityReflectionModelOutput>;

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
		execute: async ({ inputData, abortSignal }) => ({
			modelOutput: await driver({ ...inputData, abortSignal }),
		}),
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
