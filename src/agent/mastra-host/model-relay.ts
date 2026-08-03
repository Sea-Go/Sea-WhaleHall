import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import {
	MAX_MODEL_RELAY_CHUNK_BYTES,
	isRecord,
	type AgentHostErrorPayload,
	type ModelRelayEventFrame,
	type ModelRelayOpenResult,
} from "./protocol";
import { AgentHostRuntimeError, type HostRequestPeer } from "./transport";

export interface ModelRelayContext {
	runId: string;
	originatingRequestId: string;
}

interface RelayStreamState {
	controller: ReadableStreamDefaultController<Uint8Array>;
	lastSequence: number;
	closed: boolean;
}

type RelayEventDisposition = "continue" | "complete" | "abort-upstream";

export class ModelRelay {
	private readonly context = new AsyncLocalStorage<ModelRelayContext>();
	readonly fetch: NonNullable<OpenAICompatibleProviderSettings["fetch"]>;

	constructor(
		private readonly peer: HostRequestPeer,
		private readonly provider: string,
		private readonly modelId: string,
	) {
		this.fetch = this.performFetch.bind(this) as unknown as NonNullable<
			OpenAICompatibleProviderSettings["fetch"]
		>;
	}

	private async performFetch(
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		const request = new Request(input, init);
		const relayId = `relay:${randomUUID()}`;
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		const streamState: RelayStreamState = { controller, lastSequence: 0, closed: false };
		const activeContext = this.context.getStore();
		const requestAbort = (reason: string | undefined): void => {
			void this.peer
				.requestHost("model/relay.abort", {
					relayId,
					runId: activeContext?.runId ?? null,
					reason,
				}, activeContext ? { ownerRunId: activeContext.runId } : undefined)
				.catch(() => undefined);
		};
		let removeAbortListener = (): void => undefined;
		let unsubscribe = (): void => undefined;
		unsubscribe = this.peer.subscribeRelay(relayId, (event) => {
			const disposition = acceptRelayEvent(streamState, event);
			if (disposition === "abort-upstream") {
				requestAbort("Model relay event sequence or payload validation failed.");
			}
			if (disposition !== "continue") {
				unsubscribe();
				removeAbortListener();
			}
		});
		const requestBody = request.body
			? Buffer.from(await request.arrayBuffer()).toString("base64")
			: null;

		const abort = (): void => {
			requestAbort(abortReason(request.signal.reason));
			if (!streamState.closed) {
				streamState.closed = true;
				streamState.controller.error(
					new DOMException("The model relay was aborted.", "AbortError"),
				);
			}
			unsubscribe();
		};
		request.signal.addEventListener("abort", abort, { once: true });
		removeAbortListener = () => request.signal.removeEventListener("abort", abort);

		let metadata: ModelRelayOpenResult;
		try {
			metadata = await this.peer.requestHost<ModelRelayOpenResult>(
				"model/relay.open",
				{
					relayId,
					runId: activeContext?.runId ?? null,
					originatingRequestId: activeContext?.originatingRequestId ?? null,
					provider: this.provider,
					modelId: this.modelId,
					request: {
						url: request.url,
						method: request.method,
						headers: Object.fromEntries(request.headers.entries()),
						bodyBase64: requestBody,
					},
				},
				{
					requestId: relayId,
					signal: request.signal,
					...(activeContext ? { ownerRunId: activeContext.runId } : {}),
				},
			);
			validateOpenResult(metadata, relayId);
		} catch (error) {
			request.signal.removeEventListener("abort", abort);
			unsubscribe();
			if (!streamState.closed) {
				streamState.closed = true;
				streamState.controller.error(error);
			}
			throw error;
		}

		if (metadata.bodyBase64 !== undefined && !streamState.closed) {
			streamState.controller.enqueue(Buffer.from(metadata.bodyBase64, "base64"));
		}
		if ((metadata.completed || metadata.bodyBase64 !== undefined) && !streamState.closed) {
			streamState.closed = true;
			streamState.controller.close();
			unsubscribe();
			request.signal.removeEventListener("abort", abort);
		}

		return new Response(body, {
			status: metadata.status,
			statusText: metadata.statusText,
			headers: metadata.headers,
		});
	}

	runInContext<T>(context: ModelRelayContext, operation: () => T): T {
		return this.context.run(context, operation);
	}
}

function acceptRelayEvent(
	state: RelayStreamState,
	frame: ModelRelayEventFrame,
): RelayEventDisposition {
	if (state.closed) return "complete";
	const expectedSequence = state.lastSequence + 1;
	if (
		!Number.isSafeInteger(frame.sequence) ||
		frame.sequence !== expectedSequence
	) {
		state.closed = true;
		state.controller.error(
			new AgentHostRuntimeError({
				code: "MODEL_RELAY_ERROR",
				message: "Model relay event sequence is not strictly contiguous.",
				retryable: true,
			}),
		);
		return "abort-upstream";
	}
	state.lastSequence = frame.sequence;
	if (frame.event.kind === "model/relay.chunk") {
		const chunk = Buffer.from(frame.event.bodyBase64, "base64");
		if (chunk.byteLength > MAX_MODEL_RELAY_CHUNK_BYTES) {
			state.closed = true;
			state.controller.error(
				new AgentHostRuntimeError({
					code: "MODEL_RELAY_ERROR",
					message: `Model relay chunks cannot exceed ${MAX_MODEL_RELAY_CHUNK_BYTES} bytes.`,
					retryable: false,
				}),
			);
			return "abort-upstream";
		}
		state.controller.enqueue(chunk);
		return "continue";
	}
	state.closed = true;
	if (frame.event.kind === "model/relay.end") state.controller.close();
	else state.controller.error(new AgentHostRuntimeError(frame.event.error));
	return "complete";
}

function validateOpenResult(value: unknown, relayId: string): asserts value is ModelRelayOpenResult {
	if (
		!isRecord(value) ||
		value.relayId !== relayId ||
		typeof value.status !== "number" ||
		!Number.isInteger(value.status) ||
		value.status < 100 ||
		value.status > 599 ||
		!isRecord(value.headers) ||
		!Object.values(value.headers).every((header) => typeof header === "string") ||
		(value.bodyBase64 !== undefined && typeof value.bodyBase64 !== "string")
	) {
		throw new AgentHostRuntimeError({
			code: "MODEL_RELAY_ERROR",
			message: "The host returned invalid model relay metadata.",
			retryable: true,
		});
	}
}

function abortReason(reason: unknown): string | undefined {
	if (typeof reason === "string" && reason.trim()) return reason;
	if (reason instanceof Error && reason.message.trim()) return reason.message;
	return undefined;
}

export function relayError(message: string, retryable = true): AgentHostErrorPayload {
	return { code: "MODEL_RELAY_ERROR", message, retryable };
}
