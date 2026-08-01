import { describe, expect, test } from "bun:test";
import { ModelRelayTransport } from "../src/bun/model-relay-transport";
import type { RemoteAuthSessionManager } from "../src/bun/remote-auth-session";

describe("ModelRelayTransport", () => {
	test("forwards the complete model body and preserves streaming byte order", async () => {
		const bytes = new TextEncoder().encode(`data: ${"x".repeat(70_000)}\n\ndata: [DONE]\n\n`);
		const captured: { value: { path: string; init: RequestInit } | null } = { value: null };
		const auth = {
			authorizedFetch: async (path: string, init: RequestInit) => {
				captured.value = { path, init };
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
			messages: [{ role: "system", content: "本地组装" }, { role: "user", content: "开始" }],
			tools: [{ type: "function", function: { name: "calendar_list", parameters: { type: "object" } } }],
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
		expect(JSON.parse(String(captured.value?.init.body))).toEqual(body);
		expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
		const restored = new Uint8Array(chunks.reduce((total, item) => total + item.byteLength, 0));
		let offset = 0;
		for (const chunk of chunks) {
			restored.set(chunk, offset);
			offset += chunk.byteLength;
		}
		expect(restored).toEqual(bytes);
	});

	test("rejects renderer or sidecar supplied identity", async () => {
		const transport = new ModelRelayTransport({} as RemoteAuthSessionManager);
		expect(
			transport.open(
				{
					runId: "run-identity",
					body: {
						model: "approved-model",
						messages: [{ role: "user", content: "hello" }],
						userId: "forged-account",
					},
				},
				{ onResponse() {}, onChunk() {} },
			),
		).rejects.toEqual(expect.objectContaining({ code: "invalid-request" }));
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
		await expect(transport.open(
			{
				runId: "run-unavailable",
				body: {
					model: "approved-model",
					messages: [{ role: "user", content: "hello" }],
				},
			},
			{ onResponse() {}, onChunk() {} },
		)).rejects.toEqual(expect.objectContaining({
			code: "service-unavailable",
			message: "当前测试账号没有模型转发能力。",
		}));
	});
});
