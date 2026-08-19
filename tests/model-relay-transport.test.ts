import { describe, expect, test } from "bun:test";
import { ModelRelayTransport } from "../src/bun/model-relay-transport";
import type { RemoteAuthSessionManager } from "../src/bun/remote-auth-session";

describe("ModelRelayTransport", () => {
	test("closes ingress synchronously and drains every accepted remote stream", async () => {
		let settleFetch!: () => void;
		const fetchSettled = new Promise<void>((resolve) => {
			settleFetch = resolve;
		});
		let upstreamAborted = false;
		const transport = new ModelRelayTransport({
			authorizedFetch: async (_path, init) =>
				new Promise<Response>((_resolve, reject) => {
					const abort = () => {
						upstreamAborted = true;
						settleFetch();
						reject(new DOMException("aborted", "AbortError"));
					};
					if (init.signal?.aborted) abort();
					else init.signal?.addEventListener("abort", abort, { once: true });
				}),
		});
		const opened = transport.open(
			{
				runId: "shutdown-owned-run",
				body: {
					model: "approved-model",
					messages: [{ role: "user", content: "hello" }],
				},
			},
			{ onResponse() {}, onChunk() {} },
		);
		const openedOutcome = opened.then(
			() => null,
			(error: unknown) => error,
		);

		const draining = transport.abortAllAndDrain();
		await fetchSettled;
		expect(upstreamAborted).toBe(true);
		await expect(draining).resolves.toBeUndefined();
		expect(await openedOutcome).toEqual(
			expect.objectContaining({ code: "cancelled" }),
		);
		await expect(
			transport.open(
				{
					runId: "late-run",
					body: {
						model: "approved-model",
						messages: [{ role: "user", content: "late" }],
					},
				},
				{ onResponse() {}, onChunk() {} },
			),
		).rejects.toEqual(expect.objectContaining({ code: "cancelled" }));
	});

	test("forwards the complete model body and preserves streaming byte order", async () => {
		const bytes = new TextEncoder().encode(
			`data: ${"x".repeat(70_000)}\n\ndata: [DONE]\n\n`,
		);
		const captured: {
			value: { path: string; init: RequestInit; purpose: string } | null;
		} = { value: null };
		const auth = {
			authorizedFetch: async (
				path: string,
				init: RequestInit,
				purpose: string,
			) => {
				captured.value = { path, init, purpose };
				return new Response(bytes, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		} as RemoteAuthSessionManager;
		const transport = new ModelRelayTransport(auth);
		const chunks: Uint8Array[] = [];
		let status = 0;
		const body = {
			model: "approved-model",
			messages: [
				{ role: "system", content: "本地组装" },
				{ role: "user", content: "开始" },
			],
			tools: [
				{
					type: "function",
					function: { name: "calendar_list", parameters: { type: "object" } },
				},
			],
			stream: true,
		};
		await transport.open(
			{ runId: "run-1", body },
			{
				onResponse: (metadata) => {
					status = metadata.status;
				},
				onChunk: (chunk) => {
					chunks.push(chunk);
				},
			},
		);

		expect(status).toBe(200);
		expect(captured.value?.path).toBe("/v1/chat/completions");
		expect(captured.value?.purpose).toBe("agent");
		expect(JSON.parse(String(captured.value?.init.body))).toEqual(body);
		expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
		const restored = new Uint8Array(
			chunks.reduce((total, item) => total + item.byteLength, 0),
		);
		let offset = 0;
		for (const chunk of chunks) {
			restored.set(chunk, offset);
			offset += chunk.byteLength;
		}
		expect(restored).toEqual(bytes);
	});

	test("uses the same authenticated endpoint with a host-owned activity purpose", async () => {
		const captured: Array<{ path: string; purpose: string; headers: Headers }> =
			[];
		const transport = new ModelRelayTransport(
			{
				authorizedFetch: async (path, init, purpose) => {
					captured.push({ path, purpose, headers: new Headers(init.headers) });
					return Response.json({ ok: true });
				},
			},
			{ purpose: "activity" },
		);
		await transport.open(
			{
				runId: "activity-run-1",
				body: {
					model: "approved-model",
					messages: [{ role: "user", content: "sealed activity prompt" }],
				},
			},
			{ onResponse() {}, onChunk() {} },
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.path).toBe("/v1/chat/completions");
		expect(captured[0]?.purpose).toBe("activity");
		expect(captured[0]?.headers.get("x-whalehall-model-purpose")).toBeNull();
	});

	test("uses an independent host-owned purpose for dynamic Planning", async () => {
		const captured: Array<{ path: string; purpose: string }> = [];
		const transport = new ModelRelayTransport(
			{
				authorizedFetch: async (path, _init, purpose) => {
					captured.push({ path, purpose });
					return Response.json({ ok: true });
				},
			},
			{ purpose: "planning" },
		);
		await transport.open(
			{
				runId: "planning-analysis-invocation-1",
				body: {
					model: "approved-model",
					messages: [{ role: "user", content: "bounded planning input" }],
				},
			},
			{ onResponse() {}, onChunk() {} },
		);

		expect(captured).toEqual([
			{ path: "/v1/chat/completions", purpose: "planning" },
		]);
	});

	test("uses an independent host-owned purpose for sealed-window reflection", async () => {
		const captured: Array<{ path: string; purpose: string }> = [];
		const transport = new ModelRelayTransport(
			{
				authorizedFetch: async (path, _init, purpose) => {
					captured.push({ path, purpose });
					return Response.json({ ok: true });
				},
			},
			{ purpose: "reflection" },
		);
		await transport.open(
			{
				runId: "reflection-invocation-1",
				body: {
					model: "reflection",
					messages: [{ role: "user", content: "sealed reflection prompt" }],
				},
			},
			{ onResponse() {}, onChunk() {} },
		);

		expect(captured).toEqual([
			{ path: "/v1/chat/completions", purpose: "reflection" },
		]);
	});

	test("polls a durable in-flight operation with the same exact request", async () => {
		const requests: Array<{ body: string; key: string }> = [];
		const waits: number[] = [];
		let attempt = 0;
		const transport = new ModelRelayTransport(
			{
				authorizedFetch: async (_path, init) => {
					requests.push({
						body: String(init.body),
						key: new Headers(init.headers).get("idempotency-key") ?? "",
					});
					attempt += 1;
					if (attempt < 3) {
						return Response.json(
							{ error: { code: "request-in-progress", message: "busy" } },
							{ status: 409, headers: { "retry-after": "1" } },
						);
					}
					return Response.json({ recovered: true });
				},
			},
			{
				inflightRetryDelaysMs: [5, 10],
				wait: async (delayMs) => {
					waits.push(delayMs);
				},
			},
		);
		const chunks: Uint8Array[] = [];
		await transport.open(
			{
				runId: "run-replay",
				idempotencyKey: "relay-stable-replay-key",
				body: {
					model: "approved-model",
					messages: [{ role: "user", content: "recover me" }],
				},
			},
			{
				onResponse() {},
				onChunk: (chunk) => {
					chunks.push(chunk);
				},
			},
		);

		expect(waits).toEqual([5, 10]);
		expect(requests).toHaveLength(3);
		expect(new Set(requests.map((request) => request.key))).toEqual(
			new Set(["relay-stable-replay-key"]),
		);
		expect(new Set(requests.map((request) => request.body)).size).toBe(1);
		expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
			recovered: true,
		});
	});

	test("returns a retryable failure after the bounded in-flight budget", async () => {
		let requests = 0;
		const transport = new ModelRelayTransport(
			{
				authorizedFetch: async () => {
					requests += 1;
					return Response.json(
						{ error: { code: "request-in-progress", message: "busy" } },
						{ status: 409 },
					);
				},
			},
			{ inflightRetryDelaysMs: [0], wait: async () => {} },
		);
		await expect(
			transport.open(
				{
					runId: "run-still-inflight",
					body: {
						model: "approved-model",
						messages: [{ role: "user", content: "wait" }],
					},
				},
				{ onResponse() {}, onChunk() {} },
			),
		).rejects.toEqual(
			expect.objectContaining({
				code: "remote-failure",
				message: "模型请求仍在云端处理中，请稍后重试。",
			}),
		);
		expect(requests).toBe(2);
	});

	test("rejects every renderer or sidecar supplied identity, credential, or purpose alias", async () => {
		const transport = new ModelRelayTransport({} as RemoteAuthSessionManager);
		for (const [index, key] of [
			"userId",
			"user",
			"user_id",
			"accessToken",
			"apiKey",
			"purpose",
			"modelPurpose",
			"model_purpose",
			"token",
			"key",
			"api_key",
			"access_token",
		].entries()) {
			await expect(
				transport.open(
					{
						runId: `run-identity-${index}`,
						body: {
							model: "approved-model",
							messages: [{ role: "user", content: "hello" }],
							[key]: "forged-value",
						},
					},
					{ onResponse() {}, onChunk() {} },
				),
			).rejects.toEqual(expect.objectContaining({ code: "invalid-request" }));
		}
	});

	test("preserves authorization capability unavailability as a non-remote failure", async () => {
		const authorizationError = Object.assign(
			new Error("当前测试账号没有模型转发能力。"),
			{ kind: "service-unavailable" as const },
		);
		const transport = new ModelRelayTransport({
			authorizedFetch: async () => {
				throw authorizationError;
			},
		});
		await expect(
			transport.open(
				{
					runId: "run-unavailable",
					body: {
						model: "approved-model",
						messages: [{ role: "user", content: "hello" }],
					},
				},
				{ onResponse() {}, onChunk() {} },
			),
		).rejects.toEqual(
			expect.objectContaining({
				code: "service-unavailable",
				message: "当前测试账号没有模型转发能力。",
			}),
		);
	});
});
