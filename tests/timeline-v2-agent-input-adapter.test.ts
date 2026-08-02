import { describe, expect, test } from "bun:test";
import {
	AGENT_INPUT_COMMIT_REQUEST_VERSION,
	AGENT_INPUT_COMMIT_RESPONSE_VERSION,
	AGENT_INPUT_QUERY_METHOD,
	AGENT_INPUT_MAX_LEASE_MS,
	AGENT_INPUT_QUERY_REQUEST_VERSION,
	AGENT_INPUT_QUERY_RESPONSE_VERSION,
	AGENT_INPUT_REPLAY_REQUEST_VERSION,
	AGENT_INPUT_REPLAY_RESPONSE_VERSION,
	AgentInputAdapterError,
	TimelineAgentInputAdapterV1,
} from "../src/agent/timeline-v2/agent-input-adapter";
import type {
	AgentInputEnvelopeV1,
	AgentInputV1,
} from "../src/agent/timeline-v2/types";

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
					(query.includeHeldLocal === true &&
						envelope.state === "HELD_LOCAL"),
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
		expect(response.schemaVersion).toBe(
			AGENT_INPUT_QUERY_RESPONSE_VERSION,
		);
		const error = await captureError(() =>
			adapter.handle("agent.input.releaseAll", {
				schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
			}),
		);
		expect(error.code).toBe("INVALID_REQUEST");
	});

	test("leases READY input for at-least-once retry after expiry", async () => {
		const service = new FakeAgentInputService();
		const id = opaqueId("retry");
		service.addHeld(id);
		const adapter = new TimelineAgentInputAdapterV1(service);
		await adapter.replay({
			schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
			agentInputIds: [id],
		});

		const first = await adapter.query({
			schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
			limit: 1,
			leaseDurationMs: 5_000,
		});
		expect(first.inputs[0]).toMatchObject({
			state: "LEASED",
			attempt: 1,
		});
		const firstToken = first.inputs[0]?.leaseToken;

		service.nowMs += 4_999;
		expect(
			(
				await adapter.query({
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					leaseDurationMs: 5_000,
				})
			).inputs,
		).toHaveLength(0);

		service.nowMs += 1;
		const retried = await adapter.query({
			schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
			leaseDurationMs: 5_000,
		});
		expect(retried.inputs[0]).toMatchObject({
			state: "LEASED",
			attempt: 2,
		});
		expect(retried.inputs[0]?.leaseToken).not.toBe(firstToken);
	});

	test("acks with the exact lease and preserves repository idempotency", async () => {
		const service = new FakeAgentInputService();
		const id = opaqueId("commit");
		const idempotencyKey = "idempotency_key_stable_0001";
		service.addHeld(id, idempotencyKey);
		const adapter = new TimelineAgentInputAdapterV1(service);
		await adapter.replay({
			schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
			agentInputIds: [id],
		});
		const leased = (
			await adapter.query({
				schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
			})
		).inputs[0]!;

		const request = {
			schemaVersion: AGENT_INPUT_COMMIT_REQUEST_VERSION,
			agentInputId: id,
			leaseToken: leased.leaseToken!,
		};
		const committed = await adapter.commit(request);
		const duplicate = await adapter.commit(request);

		expect(committed.schemaVersion).toBe(
			AGENT_INPUT_COMMIT_RESPONSE_VERSION,
		);
		expect(committed).toEqual({
			schemaVersion: AGENT_INPUT_COMMIT_RESPONSE_VERSION,
			agentInputId: id,
			state: "ACKED",
			ackedAtMs: service.nowMs,
		});
		expect(committed).not.toHaveProperty("input");
		expect(JSON.stringify(committed)).not.toContain(idempotencyKey);
		expect(duplicate).toEqual(committed);
		await expect(
			adapter.commit({
				...request,
				leaseToken: "wrong_token_after_ack_0001",
			}),
		).rejects.toMatchObject({ code: "COMMIT_REJECTED" });
		expect(
			(
				await adapter.query({
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
				})
			).inputs,
		).toHaveLength(0);
	});

	test("rejects a wrong lease token without exposing it or the input id", async () => {
		const service = new FakeAgentInputService();
		const id = opaqueId("wrong-token");
		service.addHeld(id);
		const adapter = new TimelineAgentInputAdapterV1(service);
		await adapter.replay({
			schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
			agentInputIds: [id],
		});
		const leased = (
			await adapter.query({
				schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
			})
		).inputs[0]!;
		const wrongToken = "wrong_token_00000001";

		const error = await captureError(() =>
			adapter.commit({
				schemaVersion: AGENT_INPUT_COMMIT_REQUEST_VERSION,
				agentInputId: id,
				leaseToken: wrongToken,
			}),
		);
		expect(error).toBeInstanceOf(AgentInputAdapterError);
		expect(error.code).toBe("COMMIT_REJECTED");
		expect(error.message).toBe("AgentInput commit was rejected.");
		expect(error.message).not.toContain(id);
		expect(error.message).not.toContain(wrongToken);

		expect(
			await adapter.commit({
				schemaVersion: AGENT_INPUT_COMMIT_REQUEST_VERSION,
				agentInputId: id,
				leaseToken: leased.leaseToken!,
			}),
		).toMatchObject({ state: "ACKED" });
	});

	test("strictly rejects unknown fields, invalid versions, and unsafe bounds", async () => {
		const adapter = new TimelineAgentInputAdapterV1(
			new FakeAgentInputService(),
		);
		const tooManyIds = Array.from({ length: 101 }, (_, index) =>
			opaqueId(`many-${index}`),
		);
		const invalidRequests: Array<{
			call: "query" | "commit" | "replay";
			value: unknown;
		}> = [
			{ call: "query", value: {} },
			{
				call: "query",
				value: {
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					limit: undefined,
				},
			},
			{
				call: "query",
				value: {
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					limit: 1.5,
				},
			},
			{
				call: "query",
				value: {
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					includeHeldLocal: true,
				},
			},
			{
				call: "query",
				value: {
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					limit: 0,
				},
			},
			{
				call: "query",
				value: {
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					limit: 101,
				},
			},
			{
				call: "query",
				value: {
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					leaseDurationMs: 4_999,
				},
			},
			{
				call: "query",
				value: {
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
					leaseDurationMs: AGENT_INPUT_MAX_LEASE_MS + 1,
				},
			},
			{
				call: "commit",
				value: {
					schemaVersion: AGENT_INPUT_COMMIT_REQUEST_VERSION,
					agentInputId: opaqueId("extra"),
					leaseToken: "lease_token_0001",
					extra: true,
				},
			},
			{
				call: "commit",
				value: {
					schemaVersion: "agent-input.commit.v0",
					agentInputId: opaqueId("version"),
					leaseToken: "lease_token_0001",
				},
			},
			{
				call: "commit",
				value: {
					schemaVersion: AGENT_INPUT_COMMIT_REQUEST_VERSION,
					agentInputId: "contains whitespace",
					leaseToken: "lease_token_0001",
				},
			},
			{
				call: "commit",
				value: {
					schemaVersion: AGENT_INPUT_COMMIT_REQUEST_VERSION,
					agentInputId: opaqueId("token-short"),
					leaseToken: "short",
				},
			},
			{
				call: "replay",
				value: {
					schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
					agentInputIds: [],
				},
			},
			{
				call: "replay",
				value: {
					schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
					agentInputIds: [opaqueId("duplicate"), opaqueId("duplicate")],
				},
			},
			{
				call: "replay",
				value: {
					schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
					agentInputIds: tooManyIds,
				},
			},
		];

		for (const invalid of invalidRequests) {
			const error = await captureError(() =>
				adapter[invalid.call](invalid.value),
			);
			expect(error).toBeInstanceOf(AgentInputAdapterError);
			expect(error.code).toBe("INVALID_REQUEST");
			expect(error.message).toBe("AgentInput request is invalid.");
		}
	});

	test("sanitizes underlying query errors and has no network dispatcher", async () => {
		const service = new FakeAgentInputService();
		service.failQueryWith = new Error(
			"sensitive summary and repository location",
		);
		const adapter = new TimelineAgentInputAdapterV1(service);

		const error = await captureError(() =>
			adapter.query({
				schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
			}),
		);
		expect(error.code).toBe("QUERY_FAILED");
		expect(error.message).toBe("AgentInput query failed.");
		expect(error.message).not.toContain("sensitive");
	});

	test("fails closed before delivering legacy or unsafe uncertainty snapshots", async () => {
		const mutations: Array<(input: AgentInputV1) => void> = [
			(input) => {
				delete (
					input.segments[0] as unknown as Record<string, unknown>
				).classification;
			},
			(input) => {
				input.segments = [];
			},
			(input) => {
				input.segments[0]!.classification.goalRelevance =
					"unrelated";
				input.segments[0]!.goalRelevance = "unrelated";
			},
			(input) => {
				input.segments[0]!.classification = {
					...input.segments[0]!.classification,
					activity: "development",
					goalRelevance: null,
					confidence: 0.2,
					entropy: 0.95,
					oodScore: 0.98,
					abstain: true,
				};
			},
		];

		for (const [index, mutate] of mutations.entries()) {
			const service = new FakeAgentInputService();
			const id = opaqueId(`legacy-${index}`);
			service.addHeld(id);
			mutate(service.outbox.get(id)!.input);
			const adapter = new TimelineAgentInputAdapterV1(service);
			await adapter.replay({
				schemaVersion: AGENT_INPUT_REPLAY_REQUEST_VERSION,
				agentInputIds: [id],
			});

			const error = await captureError(() =>
				adapter.query({
					schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
				}),
			);
			expect(error.code).toBe("QUERY_FAILED");
			expect(error.message).toBe("AgentInput query failed.");
			expect(error.message).not.toContain(id);
			expect(service.outbox.get(id)?.state).toBe("LEASED");
		}
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
