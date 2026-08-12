import { describe, expect, test } from "bun:test";
import { ModelRelay } from "../src/agent/mastra-host/model-relay";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type ModelRelayEvent,
	type ModelRelayEventFrame,
	type ModelRelayOpenResult,
	type SidecarHostMethod,
} from "../src/agent/mastra-host/protocol";
import type {
	HostRequestOptions,
	HostRequestPeer,
} from "../src/agent/mastra-host/transport";

describe("Mastra ModelRelay event sequencing", () => {
	test("fails closed without a durable originating request context", async () => {
		const peer = new FakeRelayPeer();
		const relay = new ModelRelay(peer, "whalehall-relay", "approved-model");

		await expect(
			relay.fetch("https://model-relay.whalehall.invalid/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "approved-model",
					messages: [{ role: "user", content: "test" }],
					stream: true,
				}),
			}),
		).rejects.toThrow("durable originating request context");
		expect(peer.openRelayId).toBeNull();
	});

	test("fails closed for an empty originating request ID inside a relay context", async () => {
		const peer = new FakeRelayPeer();
		const relay = new ModelRelay(peer, "whalehall-relay", "approved-model");

		await expect(
			relay.runInContext(
				{ runId: "run-missing-origin", originatingRequestId: "" },
				() =>
					relay.fetch(
						"https://model-relay.whalehall.invalid/v1/chat/completions",
					),
			),
		).rejects.toThrow("durable originating request context");
		expect(peer.openRelayId).toBeNull();
	});

	test("accepts a strictly contiguous chunk stream ending at the next sequence", async () => {
		const { peer, response, relayId } = await openRelay();
		const reading = response.text();
		peer.emit(relayFrame(relayId, 1, chunk("first-")));
		peer.emit(relayFrame(relayId, 2, chunk("second")));
		peer.emit(relayFrame(relayId, 3, { kind: "model/relay.end" }));

		await expect(reading).resolves.toBe("first-second");
		expect(peer.abortCalls).toHaveLength(0);
		expect(peer.listenerCount(relayId)).toBe(0);
	});

	for (const scenario of [
		{ name: "duplicate", sequences: [1, 1] },
		{ name: "backward", sequences: [1, 2, 1] },
		{ name: "gap", sequences: [1, 3] },
	] as const) {
		test(`fails closed and aborts upstream on a ${scenario.name} sequence`, async () => {
			const { peer, response, relayId } = await openRelay();
			const reading = response.text();
			for (const sequence of scenario.sequences) {
				peer.emit(relayFrame(relayId, sequence, chunk(`seq-${sequence}`)));
			}

			await expect(reading).rejects.toThrow("strictly contiguous");
			expect(peer.abortCalls).toEqual([
				expect.objectContaining({
					method: "model/relay.abort",
					params: {
						relayId,
						runId: "run-sequence-test",
						reason: "Model relay event sequence or payload validation failed.",
					},
					options: { ownerRunId: "run-sequence-test" },
				}),
			]);
			expect(peer.listenerCount(relayId)).toBe(0);

			// The relay is terminal after the first violation. Late frames cannot
			// enqueue bytes or trigger a second upstream abort.
			peer.emit(relayFrame(relayId, 99, { kind: "model/relay.end" }));
			expect(peer.abortCalls).toHaveLength(1);
		});
	}
});

async function openRelay(): Promise<{
	peer: FakeRelayPeer;
	response: Response;
	relayId: string;
}> {
	const peer = new FakeRelayPeer();
	const relay = new ModelRelay(peer, "whalehall-relay", "approved-model");
	const response = await relay.runInContext(
		{
			runId: "run-sequence-test",
			originatingRequestId: "request-sequence-test",
		},
		() =>
			relay.fetch("https://model-relay.whalehall.invalid/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "approved-model",
					messages: [{ role: "user", content: "test" }],
					stream: true,
				}),
			}),
	);
	const relayId = peer.openRelayId;
	if (!relayId) throw new Error("Model relay did not open.");
	return { peer, response, relayId };
}

class FakeRelayPeer implements HostRequestPeer {
	readonly abortCalls: Array<{
		method: SidecarHostMethod;
		params: Record<string, unknown>;
		options?: HostRequestOptions;
	}> = [];
	openRelayId: string | null = null;
	private readonly listeners = new Map<
		string,
		Set<(event: ModelRelayEventFrame) => void>
	>();

	requestHost<TResult = unknown>(
		method: SidecarHostMethod,
		params: Record<string, unknown>,
		options?: HostRequestOptions,
	): Promise<TResult> {
		if (method === "model/relay.open") {
			this.openRelayId = String(params.relayId);
			return Promise.resolve({
				relayId: this.openRelayId,
				status: 200,
				headers: { "content-type": "text/event-stream" },
				completed: false,
			} satisfies ModelRelayOpenResult) as Promise<TResult>;
		}
		if (method === "model/relay.abort") {
			this.abortCalls.push({
				method,
				params: structuredClone(params),
				...(options ? { options: structuredClone(options) } : {}),
			});
			return Promise.resolve({ aborted: true }) as Promise<TResult>;
		}
		return Promise.reject(new Error(`Unexpected host method: ${method}`));
	}

	subscribeRelay(
		relayId: string,
		listener: (event: ModelRelayEventFrame) => void,
	): () => void {
		const listeners = this.listeners.get(relayId) ?? new Set();
		listeners.add(listener);
		this.listeners.set(relayId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(relayId);
		};
	}

	emit(frame: ModelRelayEventFrame): void {
		for (const listener of this.listeners.get(frame.relayId) ?? []) {
			listener(frame);
		}
	}

	listenerCount(relayId: string): number {
		return this.listeners.get(relayId)?.size ?? 0;
	}
}

function relayFrame(
	relayId: string,
	sequence: number,
	event: ModelRelayEvent,
): ModelRelayEventFrame {
	return {
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		type: "relay-event",
		requestId: relayId,
		relayId,
		sequence,
		emittedAtMs: 1,
		event,
	};
}

function chunk(value: string): ModelRelayEvent {
	return {
		kind: "model/relay.chunk",
		bodyBase64: Buffer.from(value, "utf8").toString("base64"),
	};
}
