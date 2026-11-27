import type { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { encodeContentLengthFrame } from "./framing";
import {
	AGENT_HOST_ERROR_CODES,
	AGENT_HOST_PROTOCOL_VERSION,
	errorResponse,
	isAgentHostRequest,
	isModelRelayEventFrame,
	isProtocolResponse,
	isRecord,
	successResponse,
	type AgentHostErrorPayload,
	type AgentHostRequest,
	type ModelRelayEventFrame,
	type ProtocolMessage,
	type SidecarHostMethod,
} from "./protocol";

const HOST_ERROR_CODES: readonly string[] = AGENT_HOST_ERROR_CODES;

export interface ProtocolWriter {
	write(message: ProtocolMessage): Promise<void>;
}

export class NodeProtocolWriter implements ProtocolWriter {
	private tail = Promise.resolve();

	constructor(private readonly output: Writable) {}

	write(message: ProtocolMessage): Promise<void> {
		const frame = encodeContentLengthFrame(message);
		const operation = this.tail.catch(() => undefined).then(
			() =>
				new Promise<void>((resolve, reject) => {
					this.output.write(frame, (error) => {
						if (error) reject(error);
						else resolve();
					});
				}),
		);
		this.tail = operation;
		return operation;
	}
}

export interface HostRequestOptions {
	requestId?: string;
	signal?: AbortSignal;
	/** Internal capability binding used when an abort callback runs outside ALS. */
	ownerRunId?: string;
}

export interface HostRequestPeer {
	requestHost<TResult = unknown>(
		method: SidecarHostMethod,
		params: Record<string, unknown>,
		options?: HostRequestOptions,
	): Promise<TResult>;
	subscribeRelay(
		relayId: string,
		listener: (event: ModelRelayEventFrame) => void,
	): () => void;
}

export type AgentHostRequestHandler = (
	request: AgentHostRequest,
) => Promise<unknown> | unknown;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	removeAbortListener(): void;
}

export class DuplexProtocolPeer implements HostRequestPeer {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly relayListeners = new Map<
		string,
		Set<(event: ModelRelayEventFrame) => void>
	>();
	private handler: AgentHostRequestHandler | null = null;
	private closedError: Error | null = null;

	constructor(private readonly writer: ProtocolWriter) {}

	setRequestHandler(handler: AgentHostRequestHandler): void {
		this.handler = handler;
	}

	async requestHost<TResult = unknown>(
		method: SidecarHostMethod,
		params: Record<string, unknown>,
		options: HostRequestOptions = {},
	): Promise<TResult> {
		if (this.closedError) throw this.closedError;
		if (options.signal?.aborted) throw abortError(options.signal.reason);
		const requestId = options.requestId ?? `sidecar:${randomUUID()}`;
		if (this.pending.has(requestId)) {
			throw new Error(`Duplicate sidecar request ID: ${requestId}`);
		}

		const result = new Promise<TResult>((resolve, reject) => {
			const onAbort = (): void => {
				this.pending.delete(requestId);
				reject(abortError(options.signal?.reason));
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(requestId, {
				resolve: (value) => resolve(value as TResult),
				reject,
				removeAbortListener: () =>
					options.signal?.removeEventListener("abort", onAbort),
			});
		});

		try {
			await this.writer.write({
				protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
				type: "request",
				requestId,
				method,
				params,
			} as ProtocolMessage);
		} catch (error) {
			const pending = this.pending.get(requestId);
			if (pending) {
				this.pending.delete(requestId);
				pending.removeAbortListener();
				pending.reject(asError(error));
			}
		}
		return result;
	}

	subscribeRelay(
		relayId: string,
		listener: (event: ModelRelayEventFrame) => void,
	): () => void {
		const listeners = this.relayListeners.get(relayId) ?? new Set();
		listeners.add(listener);
		this.relayListeners.set(relayId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.relayListeners.delete(relayId);
		};
	}

	async accept(message: unknown): Promise<void> {
		if (isProtocolResponse(message)) {
			this.acceptResponse(message);
			return;
		}
		if (isModelRelayEventFrame(message)) {
			for (const listener of this.relayListeners.get(message.relayId) ?? []) {
				listener(message);
			}
			return;
		}
		if (isAgentHostRequest(message)) {
			await this.acceptRequest(message);
			return;
		}

		const requestId =
			isRecord(message) && typeof message.requestId === "string"
				? message.requestId
				: "invalid-request";
		await this.writer.write(
			errorResponse(requestId, {
				code: "INVALID_REQUEST",
				message: "The sidecar received an invalid protocol message.",
				retryable: false,
			}),
		);
	}

	close(reason: Error): void {
		if (this.closedError) return;
		this.closedError = reason;
		for (const [requestId, pending] of this.pending) {
			this.pending.delete(requestId);
			pending.removeAbortListener();
			pending.reject(reason);
		}
		this.relayListeners.clear();
	}

	private acceptResponse(response: ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>): void {
		const pending = this.pending.get(response.requestId);
		if (!pending) return;
		this.pending.delete(response.requestId);
		pending.removeAbortListener();
		if (response.ok) pending.resolve(response.result);
		else pending.reject(new HostCallError(response.error));
	}

	private async acceptRequest(request: AgentHostRequest): Promise<void> {
		if (!this.handler) {
			await this.writer.write(
				errorResponse(request.requestId, {
					code: "NOT_INITIALIZED",
					message: "The sidecar request handler is not ready.",
					retryable: true,
				}),
			);
			return;
		}
		try {
			const result = await this.handler(request);
			await this.writer.write(successResponse(request.requestId, result));
		} catch (error) {
			await this.writer.write(errorResponse(request.requestId, protocolError(error)));
		}
	}
}

export class HostCallError extends Error {
	constructor(readonly payload: AgentHostErrorPayload) {
		super(payload.message);
		this.name = "HostCallError";
	}
}

/**
 * A Workflow that re-throws a HostCallError or an AgentHostRuntimeError hands
 * back a plain copy of it. Both classes are constructed in this host, and the
 * host-call text is written by the Bun side (relay, auth, tool host), so they
 * are the only failures that may leave the sidecar verbatim. Model and
 * provider failures keep their opaque generic text and yield null.
 */
export function relayedProtocolError(
	error: unknown,
): HostCallError | AgentHostRuntimeError | null {
	if (typeof error !== "object" || error === null || Array.isArray(error)) {
		return null;
	}
	const candidate = error as {
		name?: unknown;
		message?: unknown;
		payload?: unknown;
	};
	const payload = candidate.payload;
	if (
		(candidate.name !== "HostCallError" &&
			candidate.name !== "AgentHostRuntimeError") ||
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return null;
	}
	const { code, retryable } = payload as {
		code?: unknown;
		retryable?: unknown;
	};
	const message = candidate.message;
	if (
		typeof code !== "string" ||
		!HOST_ERROR_CODES.includes(code) ||
		typeof retryable !== "boolean" ||
		typeof message !== "string" ||
		message.length === 0 ||
		message.length > 200
	) {
		return null;
	}
	for (const character of message) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return null;
	}
	const rebuilt = { code, message, retryable } as AgentHostErrorPayload;
	return candidate.name === "HostCallError"
		? new HostCallError(rebuilt)
		: new AgentHostRuntimeError(rebuilt);
}

/**
 * The class and HTTP status of a model or provider failure, which reaches this
 * host as the plain copy a Workflow hands back. Its message may echo a private
 * prompt and stays in the sidecar log; the class and the status are enough to
 * tell a quota, an authentication failure and a timeout apart.
 */
export function failureOrigin(error: unknown): string | null {
	if (typeof error !== "object" || error === null || Array.isArray(error)) {
		return null;
	}
	const { name, statusCode } = error as {
		name?: unknown;
		statusCode?: unknown;
	};
	const kind =
		typeof name === "string" &&
		name !== "Error" &&
		/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)
			? name
			: null;
	const status =
		typeof statusCode === "number" &&
		Number.isInteger(statusCode) &&
		statusCode >= 100 &&
		statusCode <= 599
			? ` status=${statusCode}`
			: "";
	if (kind === null && status === "") return null;
	return `${kind ?? "Error"}${status}`;
}

export class AgentHostRuntimeError extends Error {
	constructor(readonly payload: AgentHostErrorPayload) {
		super(payload.message);
		this.name = "AgentHostRuntimeError";
	}
}

export function protocolError(error: unknown): AgentHostErrorPayload {
	if (error instanceof AgentHostRuntimeError || error instanceof HostCallError) {
		return error.payload;
	}
	if (error instanceof DOMException && error.name === "AbortError") {
		return {
			code: "CANCELLED",
			message: error.message || "The operation was cancelled.",
			retryable: false,
		};
	}
	return {
		code: "INTERNAL_ERROR",
		message: error instanceof Error ? error.message : String(error),
		retryable: false,
	};
}

function abortError(reason: unknown): DOMException {
	return new DOMException(
		typeof reason === "string" && reason.length > 0 ? reason : "The operation was aborted.",
		"AbortError",
	);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
