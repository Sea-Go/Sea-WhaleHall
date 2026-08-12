import { createHash } from "node:crypto";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type AgentHostErrorPayload,
	type ModelRelayAbortParams,
	type ModelRelayEventFrame,
	type ModelRelayOpenParams,
	type ModelRelayOpenResult,
} from "../agent/mastra-host/protocol";
import {
	ModelRelayError,
	type ModelRelayResponseMetadata,
	type ModelRelayTransport,
} from "./model-relay-transport";

const MAX_ENCODED_BODY_CHARACTERS = 16 * 1024 * 1024;

export interface SidecarModelRelayBridgeOptions {
	transport: ModelRelayTransport;
	send(event: ModelRelayEventFrame): Promise<void>;
	modelId: string;
	now?: () => number;
}

interface ActiveRelay {
	requestId: string;
	relayId: string;
	transportRunId: string;
	sequence: number;
}

/** Adapts a reverse Sidecar host call to the authenticated byte-for-byte relay.
 * The open response is returned as soon as upstream headers arrive; response
 * bytes continue on ordered relay-event frames and never cross Renderer RPC. */
export class SidecarModelRelayBridge {
	private readonly active = new Map<string, ActiveRelay>();
	private readonly now: () => number;

	constructor(private readonly options: SidecarModelRelayBridgeOptions) {
		this.now = options.now ?? Date.now;
	}

	async open(
		requestId: string,
		params: Record<string, unknown>,
	): Promise<ModelRelayOpenResult> {
		const input = requireOpenParams(params);
		if (input.modelId !== this.options.modelId) {
			throw new Error(
				"Sidecar requested a model outside the configured allowlist.",
			);
		}
		if (this.active.has(input.relayId))
			throw new Error("Duplicate model relay ID.");
		const body = decodeBody(input.request.bodyBase64);
		if (!isRecord(body))
			throw new Error("Model relay body must be a JSON object.");
		if (body.model !== this.options.modelId) {
			throw new Error(
				"Model relay body requested a model outside the configured allowlist.",
			);
		}
		const transportRunId = input.runId ?? input.relayId;
		const relay: ActiveRelay = {
			requestId,
			relayId: input.relayId,
			transportRunId,
			sequence: 0,
		};
		this.active.set(input.relayId, relay);

		let resolveMetadata!: (value: ModelRelayResponseMetadata) => void;
		let rejectMetadata!: (error: Error) => void;
		let metadataSettled = false;
		const metadata = new Promise<ModelRelayResponseMetadata>(
			(resolve, reject) => {
				resolveMetadata = (value) => {
					metadataSettled = true;
					resolve(value);
				};
				rejectMetadata = (error) => {
					metadataSettled = true;
					reject(error);
				};
			},
		);

		// Give MastraSidecarClient a turn to serialize the open response before
		// any byte events. Its writer is also ordered, so later frames cannot pass it.
		let releaseEvents!: () => void;
		const responseWrittenTurn = new Promise<void>((resolve) => {
			releaseEvents = resolve;
		});

		void this.options.transport
			.open(
				{
					runId: transportRunId,
					body,
					idempotencyKey: relayIdempotencyKey(input.originatingRequestId, body),
				},
				{
					onResponse: (value) => resolveMetadata(value),
					onChunk: async (chunk) => {
						await responseWrittenTurn;
						await this.send(relay, {
							kind: "model/relay.chunk",
							bodyBase64: Buffer.from(chunk).toString("base64"),
						});
					},
				},
			)
			.then(async () => {
				await responseWrittenTurn;
				await this.send(relay, { kind: "model/relay.end" });
			})
			.catch(async (error: unknown) => {
				const failure = relayFailure(error);
				if (!metadataSettled) {
					rejectMetadata(
						error instanceof ModelRelayError
							? error
							: new Error(failure.message),
					);
					return;
				}
				await responseWrittenTurn;
				await this.send(relay, {
					kind: "model/relay.error",
					error: failure,
				}).catch(() => undefined);
			})
			.finally(() => {
				this.active.delete(input.relayId);
			});

		try {
			const response = await metadata;
			setTimeout(releaseEvents, 0);
			return {
				relayId: input.relayId,
				status: response.status,
				headers: response.headers,
				completed: false,
			};
		} catch (error) {
			this.active.delete(input.relayId);
			releaseEvents();
			throw error;
		}
	}

	abort(params: Record<string, unknown>): { aborted: boolean } {
		const input = requireAbortParams(params);
		const active = this.active.get(input.relayId);
		if (!active) return { aborted: false };
		if (input.runId !== null && input.runId !== active.transportRunId) {
			return { aborted: false };
		}
		const aborted = this.options.transport.abort(active.transportRunId);
		return { aborted };
	}

	/** Bun-owned cancellation path. It does not wait for the Sidecar's
	 * model/relay.open host call to receive upstream response headers. */
	abortRun(runId: string): boolean {
		if (!boundedId(runId)) return false;
		return this.options.transport.abort(runId);
	}

	abortAll(): void {
		this.options.transport.abortAll();
		this.active.clear();
	}

	private send(
		relay: ActiveRelay,
		event: ModelRelayEventFrame["event"],
	): Promise<void> {
		relay.sequence += 1;
		return this.options.send({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "relay-event",
			requestId: relay.requestId,
			relayId: relay.relayId,
			sequence: relay.sequence,
			emittedAtMs: this.now(),
			event,
		});
	}
}

function requireOpenParams(
	value: Record<string, unknown>,
): ModelRelayOpenParams {
	if (
		!boundedId(value.relayId) ||
		(value.runId !== null && !boundedId(value.runId)) ||
		(value.originatingRequestId !== null &&
			!boundedId(value.originatingRequestId)) ||
		!boundedId(value.provider) ||
		!boundedId(value.modelId) ||
		!isRecord(value.request) ||
		value.request.method !== "POST" ||
		typeof value.request.url !== "string" ||
		!isRecord(value.request.headers) ||
		(value.request.bodyBase64 !== null &&
			typeof value.request.bodyBase64 !== "string")
	) {
		throw new Error("Invalid model relay open request.");
	}
	return value as unknown as ModelRelayOpenParams;
}

function requireAbortParams(
	value: Record<string, unknown>,
): ModelRelayAbortParams {
	if (
		!boundedId(value.relayId) ||
		(value.runId !== null && !boundedId(value.runId))
	) {
		throw new Error("Invalid model relay abort request.");
	}
	return value as unknown as ModelRelayAbortParams;
}

function decodeBody(value: string | null): unknown {
	if (
		!value ||
		value.length > MAX_ENCODED_BODY_CHARACTERS ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	) {
		throw new Error("Model relay request body is missing or too large.");
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value)
		throw new Error("Model relay request body is not canonical base64.");
	try {
		return JSON.parse(bytes.toString("utf8"));
	} finally {
		bytes.fill(0);
	}
}

function relayFailure(error: unknown): AgentHostErrorPayload {
	if (error instanceof ModelRelayError) {
		return {
			code:
				error.code === "cancelled"
					? "CANCELLED"
					: error.code === "service-unavailable"
						? "MODEL_RELAY_UNAVAILABLE"
						: "MODEL_RELAY_ERROR",
			message: error.message,
			retryable: error.code === "remote-failure" || error.code === "cancelled",
		};
	}
	return {
		code: "MODEL_RELAY_ERROR",
		message: error instanceof Error ? error.message : "模型转发失败。",
		retryable: true,
	};
}

function relayIdempotencyKey(
	originatingRequestId: string | null,
	body: Record<string, unknown>,
): string {
	return `relay-${createHash("sha256")
		.update(originatingRequestId ?? "")
		.update("\0")
		.update(JSON.stringify(body))
		.digest("hex")}`;
}

function boundedId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
