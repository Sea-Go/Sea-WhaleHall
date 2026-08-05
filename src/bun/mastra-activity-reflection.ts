import { randomUUID } from "node:crypto";
import {
	type ActivityEventAnalyzer,
	ActivityEventWorkerClientError,
	type ActivityEventWorkerRequest,
	type ActivityEventWorkerResponse,
} from "../agent/activity-event-worker";
import {
	activityReflectionOutputToWorkerResponse,
	createActivityReflectionPrompt,
} from "../agent/activity-reflection-prompt";
import type { AgentHostMethod } from "../agent/mastra-host/protocol";

/** The model timeout plus bounded private-stdio and workflow overhead. */
export const DEFAULT_MASTRA_ACTIVITY_REFLECTION_TIMEOUT_MS = 210_000;

export interface ActivityReflectionSidecar {
	request<TResult = unknown>(
		method: AgentHostMethod,
		params: Record<string, unknown>,
		options?: { requestId?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<TResult>;
}

export interface MastraActivityReflectionAnalyzerOptions {
	sidecar: ActivityReflectionSidecar;
	timeoutMs?: number;
	/** Cancels the matching relay stream when an outbox delivery is stopped. */
	onInvocationAbort?: (invocationId: string) => void;
}

interface PendingActivityReflection {
	request: ActivityEventWorkerRequest;
	controller: AbortController;
}

/**
 * The production bridge for a sealed raw activity window. Bun constructs the
 * complete prompt locally, then asks the no-persistence Mastra Workflow to
 * make one structured model call. The remote relay never receives a Worker
 * contract, prompt policy, aggregation rule, or score-ledger responsibility.
 */
export class MastraActivityReflectionAnalyzer implements ActivityEventAnalyzer {
	private readonly timeoutMs: number;
	private readonly pending = new Map<string, PendingActivityReflection>();

	constructor(
		private readonly options: MastraActivityReflectionAnalyzerOptions,
	) {
		this.timeoutMs = positiveSafeInteger(
			options.timeoutMs ?? DEFAULT_MASTRA_ACTIVITY_REFLECTION_TIMEOUT_MS,
		);
	}

	async analyze(
		request: ActivityEventWorkerRequest,
		options: { signal?: AbortSignal } = {},
	): Promise<ActivityEventWorkerResponse> {
		const invocationId = `activity-reflection-${randomUUID()}`;
		const prompt = createActivityReflectionPrompt(request);
		const controller = new AbortController();
		const abort = (): void => {
			if (controller.signal.aborted) return;
			controller.abort();
			this.options.onInvocationAbort?.(invocationId);
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		if (controller.signal.aborted) {
			options.signal?.removeEventListener("abort", abort);
			throw new ActivityEventWorkerClientError("request_timeout", true);
		}
		this.pending.set(invocationId, {
			request: structuredClone(request),
			controller,
		});
		const timeout = setTimeout(abort, this.timeoutMs);
		try {
			const modelOutput = await this.options.sidecar.request<unknown>(
				"reflection.analyze",
				{
					invocationId,
					requestId: prompt.requestId,
					userPrompt: prompt.userPrompt,
					signalSegmentIds: prompt.signalSegmentIds,
					candidateActivities: prompt.candidateActivities,
				},
				{
					requestId: `reflection:${request.request_id}`,
					timeoutMs: this.timeoutMs,
					signal: controller.signal,
				},
			);
			if (controller.signal.aborted) {
				throw new ActivityEventWorkerClientError("request_timeout", true);
			}
			return activityReflectionOutputToWorkerResponse(modelOutput, request);
		} finally {
			clearTimeout(timeout);
			this.pending.delete(invocationId);
			controller.abort();
			options.signal?.removeEventListener("abort", abort);
		}
	}

	/** Exact pending-state check used by Bun before it opens a reflection relay. */
	hasPendingInvocation(invocationId: string): boolean {
		return this.pending.has(invocationId);
	}

	/** Stops live calls; the durable outbox keeps their windows retryable. */
	close(): void {
		for (const [invocationId, pending] of this.pending) {
			if (!pending.controller.signal.aborted) {
				pending.controller.abort();
				this.options.onInvocationAbort?.(invocationId);
			}
		}
		this.pending.clear();
	}
}

function positiveSafeInteger(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Activity reflection timeout is invalid.");
	}
	return value;
}
