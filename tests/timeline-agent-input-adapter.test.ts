import { describe, expect, test } from "bun:test";
import {
	AGENT_INPUT_COMMIT_REQUEST_VERSION,
	AGENT_INPUT_COMMIT_RESPONSE_VERSION,
	AGENT_INPUT_MAX_LEASE_MS,
	AGENT_INPUT_QUERY_METHOD,
	AGENT_INPUT_QUERY_REQUEST_VERSION,
	AGENT_INPUT_QUERY_RESPONSE_VERSION,
	AGENT_INPUT_REPLAY_REQUEST_VERSION,
	AGENT_INPUT_REPLAY_RESPONSE_VERSION,
	AgentInputAdapterError,
	TimelineAgentInputAdapterV1,
} from "../src/agent/timeline/agent-input-adapter";
import type {
	AgentInputEnvelopeV1,
	AgentInputV1,
} from "../src/agent/timeline/types";

class FakeAgentInputService {
	nowMs = 10_000;
	private leaseSequence = 0;
	readonly outbox = new Map<string, AgentInputEnvelopeV1>();
	readonly ackedLeaseTokens = new Map<string, string>();
	readonly queries: Array<{
		limit?: number;
		leaseDurationMs?: number;
		includeHeldLocal?: boolean;
	}> = [];
	readonly releaseSelections: Array<readonly string[] | null> = [];
	failQueryWith: Error | null = null;

	addHeld(id: string, idempotencyKey = `idem_${id}`): void {
		this.outbox.set(id, {
			input: inputFixture(id, idempotencyKey),
			state: "HELD_LOCAL",
			leaseToken: null,
			leaseExpiresAtMs: null,
			attempt: 0,
			ackedAtMs: null,
		});
	}

	async queryAgentInputs(query: {
		limit?: number;
		leaseDurationMs?: number;
		includeHeldLocal?: boolean;
	}): Promise<{ inputs: AgentInputEnvelopeV1[] }> {
		this.queries.push(structuredClone(query));
		if (this.failQueryWith) throw this.failQueryWith;
		const limit = query.limit ?? 32;
		const leaseDurationMs = query.leaseDurationMs ?? 30_000;
		const candidates = [...this.outbox.values()]
			.filter(
				(envelope) =>
					envelope.state === "READY" ||
					(envelope.state === "LEASED" &&
						(envelope.leaseExpiresAtMs ?? Number.POSITIVE_INFINITY) <=
							this.nowMs) ||
					(query.includeHeldLocal === true && envelope.state === "HELD_LOCAL"),
			)
			.slice(0, limit);
		const inputs = candidates.map((candidate) => {
			if (candidate.state === "HELD_LOCAL") return candidate;
			const leased: AgentInputEnvelopeV1 = {
				...candidate,
				state: "LEASED",
				leaseToken: `lease_token_${++this.leaseSequence}`,
				leaseExpiresAtMs: this.nowMs + leaseDurationMs,
				attempt: candidate.attempt + 1,
			};
			this.outbox.set(candidate.input.agentInputId, leased);
			return structuredClone(leased);
		});
		return { inputs };
	}

	async commitAgentInput(
		agentInputId: string,
		leaseToken: string,
	): Promise<AgentInputEnvelopeV1> {
		const current = this.outbox.get(agentInputId);
		if (!current) throw new Error(`secret unknown id ${agentInputId}`);
		if (current.state === "ACKED") {
			if (this.ackedLeaseTokens.get(agentInputId) !== leaseToken) {
				throw new Error(`secret bad ACK token ${leaseToken}`);
			}
			return structuredClone(current);
		}
		if (
			current.state !== "LEASED" ||
			current.leaseToken !== leaseToken ||
			(current.leaseExpiresAtMs ?? -1) < this.nowMs
		) {
			throw new Error(`secret bad token ${leaseToken}`);
		}
		const acked: AgentInputEnvelopeV1 = {
			...current,
			state: "ACKED",
			leaseToken: null,
			leaseExpiresAtMs: null,
			ackedAtMs: this.nowMs,
		};
		this.outbox.set(agentInputId, acked);
		this.ackedLeaseTokens.set(agentInputId, leaseToken);
		return structuredClone(acked);
	}

	async releaseAgentInputs(
		agentInputIds: readonly string[] | null,
	): Promise<number> {
		this.releaseSelections.push(
			agentInputIds === null ? null : [...agentInputIds],
		);
		const selected = agentInputIds ? new Set(agentInputIds) : null;
		let released = 0;
		for (const [id, envelope] of this.outbox) {
			if (
				envelope.state !== "HELD_LOCAL" ||
				(selected !== null && !selected.has(id))
			) {
				continue;
			}
			this.outbox.set(id, { ...envelope, state: "READY" });
			released += 1;
		}
		return released;
	}
}

describe("TimelineAgentInputAdapterV1", () => {
	test("keeps HELD_LOCAL history invisible until an explicit replay", async () => {
		const service = new FakeAgentInputService();
		const firstId = opaqueId("first");
		const secondId = opaqueId("second");
		service.addHeld(firstId);
		service.addHeld(secondId);
		const adapter = new TimelineAgentInputAdapterV1(service);

		const hidden = await adapter.query({
			schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
		});
		expect(hidden).toEqual({
			schemaVersion: AGENT_INPUT_QUERY_RESPONSE_VERSION,
			inputs: [],
		});
		expect(service.queries[0]?.includeHeldLocal).toBeFalse();

		const replayed = await adapter.replay({
			schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
			agentInputIds: [secondId],
		});
		expect(replayed).toEqual({
			schemaVersion: AGENT_INPUT_REPLAY_RESPONSE_VERSION,
			requestedCount: 1,
			releasedCount: 1,
		});
		expect(service.releaseSelections).toEqual([[secondId]]);

		const visible = await adapter.query({
			schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
		});
		expect(visible.inputs).toHaveLength(1);
		expect(visible.inputs[0]?.input.agentInputId).toBe(secondId);
		expect(service.outbox.get(firstId)?.state).toBe("HELD_LOCAL");
		expect(
			visible.inputs.some((input) => input.state === "HELD_LOCAL"),
		).toBeFalse();
	});

	test("routes only the three explicit local protocol method names", async () => {
		const adapter = new TimelineAgentInputAdapterV1(
			new FakeAgentInputService(),
		);
		const response = await adapter.handle(AGENT_INPUT_QUERY_METHOD, {
			schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
		});
		expect(response.schemaVersion).toBe(AGENT_INPUT_QUERY_RESPONSE_VERSION);
		const error = await captureError(() =>
			adapter.handle("agent.input.releaseAll", {
				schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
			}),
		);
		expect(error.code).toBe("INVALID_REQUEST");
	});
});

function inputFixture(
	agentInputId: string,
	idempotencyKey: string,
): AgentInputV1 {
	return {
		schemaVersion: "agent-input.v1",
		agentInputId,
		idempotencyKey,
		timelineId: "timeline_adapter_fixture",
		windowId: "window_adapter_fixture",
		triggerReason: "max_wait",
		triggeredAtMs: 9_000,
		deadlineAtMs: 9_000,
		period: { startedAtMs: 1_000, endedAtMs: 9_000 },
		goal: null,
		segments: [
			{
				episodeId: "episode_adapter_fixture",
				episodeRevisionId: "episode_revision_adapter_fixture",
				startedAtMs: 1_000,
				endedAtMs: 9_000,
				activity: "research",
				goalRelevance: null,
				classification: {
					activity: "research",
					goalRelevance: null,
					confidence: 0.8,
					entropy: 0.3,
					oodScore: 0.1,
					abstain: false,
					modelVersion: "modernbert-adapter-fixture",
				},
				hypothesis: {
					text: "可能在查阅和研究资料",
					citedFactIds: ["fact_adapter_fixture"],
					generator: "deterministic-template.v2",
				},
				evidence: [],
			},
		],
		renderedText: "local-only summary",
		coverage: ["metadata"],
		modelVersions: ["deterministic"],
		inferenceDiagnostics: [],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
		payloadHash: "hash_adapter_fixture",
		createdAtMs: 9_000,
	};
}

function opaqueId(label: string): string {
	return `agent_input_${label.replaceAll("-", "_")}_0123456789abcdef`;
}

async function captureError(
	operation: () => Promise<unknown>,
): Promise<AgentInputAdapterError> {
	try {
		await operation();
		throw new Error("Expected operation to fail.");
	} catch (error) {
		if (!(error instanceof AgentInputAdapterError)) throw error;
		return error;
	}
}
