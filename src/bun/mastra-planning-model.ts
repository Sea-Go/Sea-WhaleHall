import { randomUUID } from "node:crypto";
import type { AgentHostMethod } from "../agent/mastra-host/protocol";
import {
	assertPlanningModelOutputForRequest,
	type PlanningModelAnalysisRequest,
	type PlanningModelInvocation,
	PlanningModelInvocationError,
	type PlanningModelOutput,
	type PlanningModelPort,
} from "../agent/planning/model";
import { MastraSidecarError } from "./mastra-sidecar-client";

/** Model deadline plus bounded private-stdio and Mastra structured-output overhead. */
export const DEFAULT_MASTRA_PLANNING_ANALYSIS_TIMEOUT_MS = 130_000;

export interface PlanningAnalysisSidecar {
	request<TResult = unknown>(
		method: AgentHostMethod,
		params: Record<string, unknown>,
		options?: { requestId?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<TResult>;
}

export interface MastraPlanningModelOptions {
	sidecar: PlanningAnalysisSidecar;
	modelVersion: string;
	timeoutMs?: number;
	/** Cancels the matching authenticated relay stream when the call is stopped. */
	onInvocationAbort?: (invocationId: string) => void;
}

interface PendingPlanningInvocation {
	controller: AbortController;
}

/**
 * Narrow Bun adapter for Dynamic Planning. It sends one strict semantic input
 * to the no-persistence Mastra entry; all durable state and deterministic
 * scheduling remain inside PlanningRuntime.
 */
export class MastraPlanningModel implements PlanningModelPort {
	readonly modelVersion: string;
	private readonly timeoutMs: number;
	private readonly pending = new Map<string, PendingPlanningInvocation>();
	private closed = false;

	constructor(private readonly options: MastraPlanningModelOptions) {
		this.modelVersion = boundedVersion(options.modelVersion);
		this.timeoutMs = positiveSafeInteger(
			options.timeoutMs ?? DEFAULT_MASTRA_PLANNING_ANALYSIS_TIMEOUT_MS,
		);
	}

	async analyze(
		request: PlanningModelAnalysisRequest,
		invocation?: PlanningModelInvocation,
	): Promise<PlanningModelOutput> {
		if (this.closed) {
			throw new PlanningModelInvocationError("model-unavailable", true);
		}
		const requestId = boundedRequestId(invocation?.requestId);
		const invocationId = `planning-analysis-${randomUUID()}`;
		const controller = new AbortController();
		let timedOut = false;
		const abort = (): void => {
			if (controller.signal.aborted) return;
			controller.abort();
			this.options.onInvocationAbort?.(invocationId);
		};
		const onExternalAbort = (): void => abort();
		if (invocation?.signal?.aborted) abort();
		else
			invocation?.signal?.addEventListener("abort", onExternalAbort, {
				once: true,
			});
		if (controller.signal.aborted) {
			invocation?.signal?.removeEventListener("abort", onExternalAbort);
			throw new PlanningModelInvocationError("cancelled", true);
		}
		this.pending.set(invocationId, { controller });
		const timeout = setTimeout(() => {
			timedOut = true;
			abort();
		}, this.timeoutMs);
		try {
			const output = await this.options.sidecar.request<unknown>(
				"planning.analyze",
				{ invocationId, requestId, analysis: request },
				{
					requestId: `dynamic:${requestId}`,
					timeoutMs: this.timeoutMs,
					signal: controller.signal,
				},
			);
			if (controller.signal.aborted) {
				throw new PlanningModelInvocationError(
					timedOut ? "request-timeout" : "cancelled",
					true,
				);
			}
			try {
				assertPlanningModelOutputForRequest(output, request);
			} catch (error) {
				throw new PlanningModelInvocationError("invalid-output", true, {
					cause: error,
				});
			}
			return output;
		} catch (error) {
			if (error instanceof PlanningModelInvocationError) throw error;
			if (controller.signal.aborted) {
				throw new PlanningModelInvocationError(
					timedOut ? "request-timeout" : "cancelled",
					true,
					{ cause: error },
				);
			}
			if (error instanceof MastraSidecarError) {
				if (error.code === "PLANNING_OUTPUT_INVALID") {
					throw new PlanningModelInvocationError("invalid-output", true, {
						cause: error,
					});
				}
				if (error.code === "TIMEOUT") {
					throw new PlanningModelInvocationError("request-timeout", true, {
						cause: error,
					});
				}
				if (error.code === "CANCELLED") {
					throw new PlanningModelInvocationError("cancelled", true, {
						cause: error,
					});
				}
			}
			throw new PlanningModelInvocationError("model-unavailable", true, {
				cause: error,
			});
		} finally {
			clearTimeout(timeout);
			this.pending.delete(invocationId);
			controller.abort();
			invocation?.signal?.removeEventListener("abort", onExternalAbort);
		}
	}

	/** Exact pending-state capability check before Bun accepts a planning relay. */
	hasPendingInvocation(invocationId: string): boolean {
		return this.pending.has(invocationId);
	}

	close(): void {
		this.closed = true;
		for (const [invocationId, pending] of this.pending) {
			if (!pending.controller.signal.aborted) {
				pending.controller.abort();
				this.options.onInvocationAbort?.(invocationId);
			}
		}
		this.pending.clear();
	}
}

function boundedRequestId(value: string | undefined): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 240 ||
		/[\r\n\0]/u.test(value)
	) {
		throw new PlanningModelInvocationError("model-unavailable", false);
	}
	return value;
}

function boundedVersion(value: string): string {
	if (value.trim().length < 1 || value.length > 256) {
		throw new Error("Planning model version is invalid.");
	}
	return value;
}

function positiveSafeInteger(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Planning analysis timeout is invalid.");
	}
	return value;
}
