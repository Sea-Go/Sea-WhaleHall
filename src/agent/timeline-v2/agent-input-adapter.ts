import type { TimelineV2Service } from "./service";
import type { AgentInputEnvelopeV1 } from "./types";

export const AGENT_INPUT_QUERY_REQUEST_VERSION =
	"agent-input.query.v1" as const;
export const AGENT_INPUT_QUERY_RESPONSE_VERSION =
	"agent-input.query-result.v1" as const;
export const AGENT_INPUT_COMMIT_REQUEST_VERSION =
	"agent-input.commit.v1" as const;
export const AGENT_INPUT_COMMIT_RESPONSE_VERSION =
	"agent-input.commit-result.v1" as const;
export const AGENT_INPUT_REPLAY_REQUEST_VERSION =
	"agent-input.replay.v1" as const;
export const AGENT_INPUT_REPLAY_RESPONSE_VERSION =
	"agent-input.replay-result.v1" as const;
export const AGENT_INPUT_QUERY_METHOD = "agent.input.query" as const;
export const AGENT_INPUT_COMMIT_METHOD = "agent.input.commit" as const;
export const AGENT_INPUT_REPLAY_METHOD = "agent.input.replay" as const;

export const AGENT_INPUT_DEFAULT_QUERY_LIMIT = 32;
export const AGENT_INPUT_MAX_QUERY_LIMIT = 100;
export const AGENT_INPUT_DEFAULT_LEASE_MS = 30_000;
export const AGENT_INPUT_MIN_LEASE_MS = 5_000;
export const AGENT_INPUT_MAX_LEASE_MS = 5 * 60_000;

const MAX_REPLAY_IDS = 100;
const MIN_OPAQUE_VALUE_LENGTH = 8;
const MAX_OPAQUE_VALUE_LENGTH = 128;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type AgentInputQueryRequestV1 = {
	schemaVersion: typeof AGENT_INPUT_QUERY_REQUEST_VERSION;
	limit?: number;
	leaseDurationMs?: number;
};

export type AgentInputQueryResponseV1 = {
	schemaVersion: typeof AGENT_INPUT_QUERY_RESPONSE_VERSION;
	inputs: AgentInputEnvelopeV1[];
};

export type AgentInputCommitRequestV1 = {
	schemaVersion: typeof AGENT_INPUT_COMMIT_REQUEST_VERSION;
	agentInputId: string;
	leaseToken: string;
};

export type AgentInputCommitResponseV1 = {
	schemaVersion: typeof AGENT_INPUT_COMMIT_RESPONSE_VERSION;
	input: AgentInputEnvelopeV1;
};

export type AgentInputReplayRequestV1 = {
	schemaVersion: typeof AGENT_INPUT_REPLAY_REQUEST_VERSION;
	agentInputIds: string[];
};

export type AgentInputReplayResponseV1 = {
	schemaVersion: typeof AGENT_INPUT_REPLAY_RESPONSE_VERSION;
	requestedCount: number;
	releasedCount: number;
};

export type AgentInputAdapterErrorCode =
	| "INVALID_REQUEST"
	| "QUERY_FAILED"
	| "COMMIT_REJECTED"
	| "REPLAY_FAILED";

export type AgentInputAdapterMethod =
	| typeof AGENT_INPUT_QUERY_METHOD
	| typeof AGENT_INPUT_COMMIT_METHOD
	| typeof AGENT_INPUT_REPLAY_METHOD;

export type AgentInputAdapterResponseV1 =
	| AgentInputQueryResponseV1
	| AgentInputCommitResponseV1
	| AgentInputReplayResponseV1;

/**
 * Sanitized protocol error. It intentionally carries neither request values,
 * AgentInput content, nor repository error details.
 */
export class AgentInputAdapterError extends Error {
	constructor(readonly code: AgentInputAdapterErrorCode) {
		super(errorMessage(code));
		this.name = "AgentInputAdapterError";
	}
}

type AgentInputServiceBoundary = Pick<
	TimelineV2Service,
	"queryAgentInputs" | "commitAgentInput" | "releaseAgentInputs"
>;

/**
 * Local-only delivery boundary for the durable AgentInput outbox.
 *
 * This adapter has no transport or dispatcher. A future local Agent host may
 * call it, but wiring it into a renderer or network surface is deliberately
 * outside this protocol.
 */
export class TimelineAgentInputAdapterV1 {
	constructor(private readonly service: AgentInputServiceBoundary) {}

	async handle(
		method: unknown,
		request: unknown,
	): Promise<AgentInputAdapterResponseV1> {
		switch (method) {
			case AGENT_INPUT_QUERY_METHOD:
				return this.query(request);
			case AGENT_INPUT_COMMIT_METHOD:
				return this.commit(request);
			case AGENT_INPUT_REPLAY_METHOD:
				return this.replay(request);
			default:
				throw new AgentInputAdapterError("INVALID_REQUEST");
		}
	}

	async query(request: unknown): Promise<AgentInputQueryResponseV1> {
		const parsed = parseQueryRequest(request);
		try {
			const result = await this.service.queryAgentInputs({
				limit: parsed.limit ?? AGENT_INPUT_DEFAULT_QUERY_LIMIT,
				leaseDurationMs:
					parsed.leaseDurationMs ?? AGENT_INPUT_DEFAULT_LEASE_MS,
				includeHeldLocal: false,
			});
			if (
				result.inputs.length >
					(parsed.limit ?? AGENT_INPUT_DEFAULT_QUERY_LIMIT) ||
				!validLeasedResult(result.inputs)
			) {
				throw new AgentInputAdapterError("QUERY_FAILED");
			}
			return {
				schemaVersion: AGENT_INPUT_QUERY_RESPONSE_VERSION,
				inputs: result.inputs,
			};
		} catch {
			throw new AgentInputAdapterError("QUERY_FAILED");
		}
	}

	async commit(request: unknown): Promise<AgentInputCommitResponseV1> {
		const parsed = parseCommitRequest(request);
		try {
			const input = await this.service.commitAgentInput(
				parsed.agentInputId,
				parsed.leaseToken,
			);
			if (
				input.state !== "ACKED" ||
				input.input.agentInputId !== parsed.agentInputId ||
				!isOpaqueValue(input.input.idempotencyKey) ||
				input.leaseToken !== null ||
				input.leaseExpiresAtMs !== null
			) {
				throw new AgentInputAdapterError("COMMIT_REJECTED");
			}
			return {
				schemaVersion: AGENT_INPUT_COMMIT_RESPONSE_VERSION,
				input,
			};
		} catch {
			throw new AgentInputAdapterError("COMMIT_REJECTED");
		}
	}

	async replay(request: unknown): Promise<AgentInputReplayResponseV1> {
		const parsed = parseReplayRequest(request);
		try {
			// Never pass null: replay is an explicit selection, not release-all.
			const releasedCount = await this.service.releaseAgentInputs(
				parsed.agentInputIds,
			);
			if (
				!Number.isSafeInteger(releasedCount) ||
				releasedCount < 0 ||
				releasedCount > parsed.agentInputIds.length
			) {
				throw new AgentInputAdapterError("REPLAY_FAILED");
			}
			return {
				schemaVersion: AGENT_INPUT_REPLAY_RESPONSE_VERSION,
				requestedCount: parsed.agentInputIds.length,
				releasedCount,
			};
		} catch {
			throw new AgentInputAdapterError("REPLAY_FAILED");
		}
	}
}

function parseQueryRequest(value: unknown): AgentInputQueryRequestV1 {
	if (
		!hasExactKeys(
			value,
			["schemaVersion"],
			["limit", "leaseDurationMs"],
		) ||
		value.schemaVersion !== AGENT_INPUT_QUERY_REQUEST_VERSION ||
		(hasOwn(value, "limit") &&
			!isBoundedInteger(
				value.limit,
				1,
				AGENT_INPUT_MAX_QUERY_LIMIT,
			)) ||
		(hasOwn(value, "leaseDurationMs") &&
			!isBoundedInteger(
				value.leaseDurationMs,
				AGENT_INPUT_MIN_LEASE_MS,
				AGENT_INPUT_MAX_LEASE_MS,
			))
	) {
		throw new AgentInputAdapterError("INVALID_REQUEST");
	}
	return {
		schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
		...(hasOwn(value, "limit") ? { limit: value.limit as number } : {}),
		...(hasOwn(value, "leaseDurationMs")
			? { leaseDurationMs: value.leaseDurationMs as number }
			: {}),
	};
}

function parseCommitRequest(value: unknown): AgentInputCommitRequestV1 {
	if (
		!hasExactKeys(
			value,
			["schemaVersion", "agentInputId", "leaseToken"],
			[],
		) ||
		value.schemaVersion !== AGENT_INPUT_COMMIT_REQUEST_VERSION ||
		!isOpaqueValue(value.agentInputId) ||
		!isOpaqueValue(value.leaseToken)
	) {
		throw new AgentInputAdapterError("INVALID_REQUEST");
	}
	return {
		schemaVersion: AGENT_INPUT_COMMIT_REQUEST_VERSION,
		agentInputId: value.agentInputId,
		leaseToken: value.leaseToken,
	};
}

function parseReplayRequest(value: unknown): AgentInputReplayRequestV1 {
	if (
		!hasExactKeys(value, ["schemaVersion", "agentInputIds"], []) ||
		value.schemaVersion !== AGENT_INPUT_REPLAY_REQUEST_VERSION ||
		!Array.isArray(value.agentInputIds) ||
		value.agentInputIds.length < 1 ||
		value.agentInputIds.length > MAX_REPLAY_IDS ||
		!value.agentInputIds.every(isOpaqueValue) ||
		new Set(value.agentInputIds).size !== value.agentInputIds.length
	) {
		throw new AgentInputAdapterError("INVALID_REQUEST");
	}
	return {
		schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
		agentInputIds: [...value.agentInputIds],
	};
}

function validLeasedResult(
	inputs: readonly AgentInputEnvelopeV1[],
): boolean {
	if (inputs.length > AGENT_INPUT_MAX_QUERY_LIMIT) return false;
	return inputs.every(
		(envelope) =>
			envelope.state === "LEASED" &&
			isOpaqueValue(envelope.input.agentInputId) &&
			isOpaqueValue(envelope.input.idempotencyKey) &&
			isOpaqueValue(envelope.leaseToken) &&
			Number.isSafeInteger(envelope.leaseExpiresAtMs) &&
			(envelope.leaseExpiresAtMs ?? -1) >= 0 &&
			Number.isSafeInteger(envelope.attempt) &&
			envelope.attempt >= 1,
	);
}

function hasExactKeys(
	value: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[],
): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const allowed = new Set([...requiredKeys, ...optionalKeys]);
	const keys = Object.keys(value);
	return (
		requiredKeys.every((key) => hasOwn(value, key)) &&
		keys.every((key) => allowed.has(key))
	);
}

function hasOwn(
	value: Record<string, unknown>,
	key: string,
): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function isOpaqueValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= MIN_OPAQUE_VALUE_LENGTH &&
		value.length <= MAX_OPAQUE_VALUE_LENGTH &&
		OPAQUE_VALUE_PATTERN.test(value)
	);
}

function isBoundedInteger(
	value: unknown,
	minimum: number,
	maximum: number,
): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= minimum &&
		(value as number) <= maximum
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(code: AgentInputAdapterErrorCode): string {
	switch (code) {
		case "INVALID_REQUEST":
			return "AgentInput request is invalid.";
		case "QUERY_FAILED":
			return "AgentInput query failed.";
		case "COMMIT_REJECTED":
			return "AgentInput commit was rejected.";
		case "REPLAY_FAILED":
			return "AgentInput replay failed.";
	}
}
