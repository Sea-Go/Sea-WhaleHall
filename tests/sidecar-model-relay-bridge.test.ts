import { describe, expect, test } from "bun:test";
import type { ModelRelayEventFrame } from "../src/agent/mastra-host/protocol";
import { ModelRelayError, ModelRelayTransport } from "../src/bun/model-relay-transport";
import type { RemoteAuthSessionManager } from "../src/bun/remote-auth-session";
import { SidecarModelRelayBridge } from "../src/bun/sidecar-model-relay-bridge";

describe("SidecarModelRelayBridge", () => {
	test("returns upstream metadata before emitting ordered model bytes", async () => {
		const first = new TextEncoder().encode("data: first\n\n");
		const second = new TextEncoder().encode("data: second\n\ndata: [DONE]\n\n");
		const auth = authWithResponse(() =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(first);
						controller.enqueue(second);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-request-id": "upstream-request-1",
					},
				},
			),
		);
		const events: ModelRelayEventFrame[] = [];
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async (event) => {
				events.push(structuredClone(event));
			},
			now: () => 1_234,
		});

		const metadata = await bridge.open(
			"host-request-1",
			relayOpenParams("relay-1", "run-1", validBody()),
		);
		expect(metadata).toEqual({
			relayId: "relay-1",
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-request-id": "upstream-request-1",
			},
			completed: false,
		});
		// The open response must be serializable by the host before byte events start.
		expect(events).toEqual([]);

		await waitFor(() => events.length === 3);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
		expect(events.map((event) => event.event.kind)).toEqual([
			"model/relay.chunk",
			"model/relay.chunk",
			"model/relay.end",
		]);
		expect(events.every((event) => event.requestId === "host-request-1")).toBe(true);
		expect(events.every((event) => event.relayId === "relay-1")).toBe(true);
		const restored = events
			.filter((event) => event.event.kind === "model/relay.chunk")
			.map((event) => Buffer.from((event.event as { bodyBase64: string }).bodyBase64, "base64"))
			.reduce((output, chunk) => Buffer.concat([output, chunk]), Buffer.alloc(0));
		expect(restored).toEqual(Buffer.concat([first, second]));
	});

	test("aborts the transport run and emits a terminal cancellation after metadata", async () => {
		const upstreamSignal: { value: AbortSignal | null } = { value: null };
		const auth = authWithResponse((_path, init) => {
			upstreamSignal.value = init.signal ?? null;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						init.signal?.addEventListener(
							"abort",
							() => controller.error(new DOMException("aborted", "AbortError")),
							{ once: true },
						);
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const events: ModelRelayEventFrame[] = [];
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async (event) => {
				events.push(structuredClone(event));
			},
		});

		await bridge.open(
			"host-request-abort",
			relayOpenParams("relay-abort", "run-abort", validBody()),
		);
		expect(bridge.abort({ relayId: "relay-abort", runId: "another-run" })).toEqual({
			aborted: false,
		});
		expect(bridge.abort({ relayId: "relay-abort", runId: "run-abort" })).toEqual({
			aborted: true,
		});
		expect(upstreamSignal.value?.aborted).toBe(true);
		await waitFor(() => events.length === 1);
		expect(events[0]).toEqual(
			expect.objectContaining({
				requestId: "host-request-abort",
				relayId: "relay-abort",
				sequence: 1,
				event: {
					kind: "model/relay.error",
					error: expect.objectContaining({ code: "CANCELLED", retryable: true }),
				},
			}),
		);
		expect(bridge.abort({ relayId: "relay-abort", runId: "run-abort" })).toEqual({
			aborted: false,
		});
	});

	test("aborts upstream directly by Bun runId before response headers arrive", async () => {
		const upstreamSignal: { value: AbortSignal | null } = { value: null };
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const auth = authWithResponse((_path, init) => {
			upstreamSignal.value = init.signal ?? null;
			markStarted();
			return new Promise<Response>((_resolve, reject) => {
				const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
				if (init.signal?.aborted) rejectAbort();
				else init.signal?.addEventListener("abort", rejectAbort, { once: true });
			});
		});
		const events: ModelRelayEventFrame[] = [];
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async (event) => {
				events.push(structuredClone(event));
			},
		});
		const outcome = bridge.open(
			"host-request-preheaders",
			relayOpenParams("relay-preheaders", "run-preheaders", validBody()),
		).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		await started;
		expect(bridge.abortRun("run-preheaders")).toBe(true);
		expect(upstreamSignal.value?.aborted).toBe(true);
		const result = await outcome;
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("pre-header relay unexpectedly completed");
		expect(result.error).toEqual(expect.objectContaining({ message: "模型请求已取消。" }));
		expect(events).toEqual([]);
		expect(bridge.abortRun("run-preheaders")).toBe(false);
	});

	test("abortAll cancels a header-blocked relay during Sidecar interruption", async () => {
		const upstreamSignal: { value: AbortSignal | null } = { value: null };
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const auth = authWithResponse((_path, init) => {
			upstreamSignal.value = init.signal ?? null;
			markStarted();
			return new Promise<Response>((_resolve, reject) => {
				const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
				if (init.signal?.aborted) rejectAbort();
				else init.signal?.addEventListener("abort", rejectAbort, { once: true });
			});
		});
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async () => {},
		});
		const outcome = bridge.open(
			"host-request-crash",
			relayOpenParams("relay-crash", "run-crash", validBody()),
		).then(
			() => "completed" as const,
			() => "aborted" as const,
		);

		await started;
		bridge.abortAll();
		expect(upstreamSignal.value?.aborted).toBe(true);
		await expect(outcome).resolves.toBe("aborted");
		expect(bridge.abort({ relayId: "relay-crash", runId: "run-crash" })).toEqual({
			aborted: false,
		});
	});

	test("emits an explicit non-retryable capability error when relay authorization is unavailable", async () => {
		let failProviderStream!: () => void;
		const auth = authWithResponse(() => new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					failProviderStream = () => controller.error(new ModelRelayError(
						"service-unavailable",
						"当前测试账号没有模型转发能力。",
					));
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));
		const events: ModelRelayEventFrame[] = [];
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async (event) => {
				events.push(structuredClone(event));
			},
		});

		await bridge.open(
			"host-request-unavailable",
			relayOpenParams("relay-unavailable", "run-unavailable", validBody()),
		);
		failProviderStream();
		await waitFor(() => events.length === 1);
		expect(events[0]?.event).toEqual({
			kind: "model/relay.error",
			error: {
				code: "MODEL_RELAY_UNAVAILABLE",
				message: "当前测试账号没有模型转发能力。",
				retryable: false,
			},
		});
	});

	test("preserves capability classification when open fails before response headers", async () => {
		const auth = authWithResponse(async () => {
			throw Object.assign(new Error("当前测试账号没有模型转发能力。"), {
				kind: "service-unavailable" as const,
			});
		});
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async () => {},
		});

		await expect(bridge.open(
			"host-request-unavailable-preheaders",
			relayOpenParams("relay-unavailable-preheaders", "run-unavailable-preheaders", validBody()),
		)).rejects.toEqual(expect.objectContaining({
			code: "service-unavailable",
			message: "当前测试账号没有模型转发能力。",
		}));
	});

	test("rejects sidecar-supplied identity and credentials before any remote request", async () => {
		let remoteCalls = 0;
		const auth = authWithResponse(() => {
			remoteCalls += 1;
			return new Response("should not be reached");
		});
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async () => {},
		});

		for (const [index, key] of ["userId", "user", "user_id", "accessToken", "apiKey"].entries()) {
			await expect(
				bridge.open(
					`host-request-identity-${index}`,
					relayOpenParams(`relay-identity-${index}`, `run-identity-${index}`, {
						...validBody(),
						[key]: "forged-value",
					}),
				),
			).rejects.toThrow("不得携带自报身份或供应商凭据");
		}
		expect(remoteCalls).toBe(0);
	});

	test("keeps the idempotency key stable across relay retries", async () => {
		const keys: string[] = [];
		const auth = authWithResponse((_path, init) => {
			keys.push(new Headers(init.headers).get("idempotency-key") ?? "");
			return Response.json({ ok: true });
		});
		const bridge = new SidecarModelRelayBridge({
			transport: new ModelRelayTransport(auth),
			modelId: "approved-model",
			send: async () => {},
		});
		const body = validBody();
		await bridge.open(
			"host-request-stable-1",
			relayOpenParams("relay-stable-1", "run-stable-1", body, "origin-stable"),
		);
		await bridge.open(
			"host-request-stable-2",
			relayOpenParams("relay-stable-2", "run-stable-2", body, "origin-stable"),
		);
		await bridge.open(
			"host-request-stable-3",
			relayOpenParams(
				"relay-stable-3",
				"run-stable-3",
				{ ...body, temperature: 0.2 },
				"origin-stable",
			),
		);

		expect(keys).toHaveLength(3);
		expect(keys[0]).toMatch(/^relay-[0-9a-f]{64}$/);
		expect(keys[1]).toBe(keys[0]);
		expect(keys[2]).not.toBe(keys[0]);
	});
});

function authWithResponse(
	respond: (path: string, init: RequestInit) => Response | Promise<Response>,
): RemoteAuthSessionManager {
	return {
		authorizedFetch: respond,
	} as RemoteAuthSessionManager;
}

function relayOpenParams(
	relayId: string,
	runId: string,
	body: Record<string, unknown>,
	originatingRequestId = `origin-${relayId}`,
): Record<string, unknown> {
	return {
		relayId,
		runId,
		originatingRequestId,
		provider: "whalehall-relay",
		modelId: "approved-model",
		request: {
			url: "http://whalehall.invalid/v1/chat/completions",
			method: "POST",
			headers: { "content-type": "application/json" },
			bodyBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
		},
	};
}

function validBody(): Record<string, unknown> {
	return {
		model: "approved-model",
		messages: [
			{ role: "system", content: "完整上下文由本地 Agent 组装" },
			{ role: "user", content: "开始" },
		],
		stream: true,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for relay events.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
