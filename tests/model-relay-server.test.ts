import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CPU_ONLY_OLLAMA_CHAT_COMPLETIONS_URL,
	createModelRelayHandler,
	createScryptPasswordHash,
	FileRelayRecordStore,
	FileSessionStore,
	FixedWindowRateLimiter,
	InMemoryRelayRecordStore,
	InMemorySessionStore,
	InMemoryUserStore,
	JsonFileUserStore,
	type ModelRelayDependencies,
	type ModelRelayHandler,
	type ModelRelayServerConfig,
	type RelayClock,
} from "../services/model-relay";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const legacyAgentKey = ["whk", "fixture", "retired-relay"].join("_");
let passwordHash = "";

beforeAll(async () => {
	passwordHash = await createScryptPasswordHash(
		"correct horse battery staple",
		{
			salt: new Uint8Array(16).fill(7),
		},
	);
});

class MutableClock implements RelayClock {
	constructor(public value = 1_800_000_000_000) {}
	now(): number {
		return this.value;
	}
}

function baseConfig(
	overrides: Partial<ModelRelayServerConfig> = {},
): ModelRelayServerConfig {
	return {
		providerChatCompletionsUrl:
			"https://provider.example.test/v1/chat/completions",
		providerApiKey: "provider-secret-key-for-tests",
		allowedModels: ["approved-model"],
		...overrides,
	};
}

function createFixture(
	options: {
		fetch?: typeof fetch;
		config?: Partial<ModelRelayServerConfig>;
		dependencies?: Partial<Pick<ModelRelayDependencies, "passwordVerifier">>;
	} = {},
) {
	const users = new InMemoryUserStore([
		{
			id: "account-1",
			email: "test@example.com",
			displayName: "测试用户",
			initials: "测试",
			passwordHash,
		},
	]);
	const sessions = new InMemorySessionStore();
	const records = new InMemoryRelayRecordStore();
	const clock = new MutableClock();
	const handler = createModelRelayHandler(baseConfig(options.config), {
		users,
		sessions,
		records,
		clock,
		fetch:
			options.fetch ??
			((async () => Response.json({ ok: true })) as unknown as typeof fetch),
		...options.dependencies,
	});
	return { handler, users, sessions, records, clock };
}

async function signIn(
	handler: ModelRelayHandler,
	password = "correct horse battery staple",
) {
	const response = await handler(
		new Request("https://relay.example.test/v1/auth/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: " Test@Example.com ", password }),
		}),
	);
	return {
		response,
		payload: (await response.json()) as Record<string, unknown>,
	};
}

function chatRequest(
	accessToken: string,
	body: string,
	idempotencyKey = "run-1",
	extraHeaders: Record<string, string> = {},
): Request {
	return new Request("https://relay.example.test/v1/chat/completions", {
		method: "POST",
		headers: {
			authorization: `Bearer ${accessToken}`,
			"x-whalehall-agent-key": legacyAgentKey,
			"x-whalehall-model-purpose": "agent",
			"content-type": "application/json",
			"idempotency-key": idempotencyKey,
			...extraHeaders,
		},
		body,
	});
}

function reflectionRequest(
	body: string,
	idempotencyKey = "reflection-1",
	extraHeaders: Record<string, string> = {},
): Request {
	return new Request("https://relay.example.test/v1/activity/completions", {
		method: "POST",
		headers: {
			"x-whalehall-reflection-key": "retired-fixture-only",
			"content-type": "application/json",
			"idempotency-key": idempotencyKey,
			...extraHeaders,
		},
		body,
	});
}

describe("model relay authentication", () => {
	test("issues opaque 15-minute access tokens, stores only digests, and returns bearer subject from /me", async () => {
		const { handler, sessions, clock } = createFixture();
		const { response, payload } = await signIn(handler);
		expect(response.status).toBe(201);
		expect(payload.user).toEqual({
			id: "account-1",
			email: "test@example.com",
			displayName: "测试用户",
			initials: "测试",
		});
		expect(payload.expiresAtMs).toBe(clock.value + 15 * 60_000);
		const accessToken = String(payload.accessToken);
		const refreshToken = String(payload.refreshToken);
		expect(accessToken).toStartWith("wh_access_");
		expect(refreshToken).toStartWith("wh_refresh_");
		const serializedSessions = JSON.stringify(sessions.snapshot());
		expect(serializedSessions).not.toContain(accessToken);
		expect(serializedSessions).not.toContain(refreshToken);
		expect(sessions.snapshot()[0]?.refreshExpiresAtMs).toBe(
			clock.value + 30 * 24 * 60 * 60_000,
		);

		const me = await handler(
			new Request("https://relay.example.test/v1/auth/me", {
				headers: { authorization: `Bearer ${accessToken}` },
			}),
		);
		expect(me.status).toBe(200);
		expect(await me.json()).toEqual(
			expect.objectContaining({ id: "account-1" }),
		);

		clock.value += 15 * 60_000;
		const expired = await handler(
			new Request("https://relay.example.test/v1/auth/me", {
				headers: { authorization: `Bearer ${accessToken}` },
			}),
		);
		expect(expired.status).toBe(401);
	});

	test("verifies passwords without disclosing whether the email exists", async () => {
		const { handler } = createFixture();
		const wrongPassword = await signIn(handler, "incorrect password");
		const missingUser = await handler(
			new Request("https://relay.example.test/v1/auth/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "missing@example.com",
					password: "incorrect password",
				}),
			}),
		);
		expect(wrongPassword.response.status).toBe(401);
		expect(missingUser.status).toBe(401);
		expect(wrongPassword.payload).toEqual(await missingUser.json());
	});

	test("rotates refresh tokens once, rejects the consumed token, and revokes current access", async () => {
		const { handler } = createFixture();
		const login = await signIn(handler);
		const accessToken = String(login.payload.accessToken);
		const refreshToken = String(login.payload.refreshToken);
		const refreshRequest = () =>
			new Request("https://relay.example.test/v1/auth/sessions/refresh", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ refreshToken }),
			});
		const rotated = await handler(refreshRequest());
		expect(rotated.status).toBe(200);
		const rotatedPayload = (await rotated.json()) as Record<string, unknown>;
		expect(rotatedPayload.refreshToken).not.toBe(refreshToken);
		expect((await handler(refreshRequest())).status).toBe(401);

		const logout = await handler(
			new Request("https://relay.example.test/v1/auth/sessions/current", {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${String(rotatedPayload.accessToken)}`,
				},
			}),
		);
		expect(logout.status).toBe(204);
		const afterLogout = await handler(
			new Request("https://relay.example.test/v1/auth/me", {
				headers: {
					authorization: `Bearer ${String(rotatedPayload.accessToken)}`,
				},
			}),
		);
		expect(afterLogout.status).toBe(401);
		// Refresh rotation revoked the original access token as part of the old session.
		const original = await handler(
			new Request("https://relay.example.test/v1/auth/me", {
				headers: { authorization: `Bearer ${accessToken}` },
			}),
		);
		expect(original.status).toBe(401);
	});
});

describe("model relay forwarding", () => {
	test("authorizes chat by bearer and ignores the retired personal key header", async () => {
		let upstreamCalls = 0;
		const fixture = createFixture({
			fetch: (async () => {
				upstreamCalls += 1;
				return Response.json({ ok: true });
			}) as unknown as typeof fetch,
		});
		const login = await signIn(fixture.handler);
		const accessToken = String(login.payload.accessToken);
		const body = JSON.stringify({ model: "approved-model", messages: [] });
		const missingBearer = await fixture.handler(
			new Request("https://relay.example.test/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "missing-bearer",
					"x-whalehall-model-purpose": "agent",
				},
				body,
			}),
		);
		const withoutLegacyKey = await fixture.handler(
			new Request("https://relay.example.test/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${accessToken}`,
					"content-type": "application/json",
					"idempotency-key": "no-legacy-key",
					"x-whalehall-model-purpose": "agent",
				},
				body,
			}),
		);
		const arbitraryLegacyKey = await fixture.handler(
			chatRequest(accessToken, body, "arbitrary-legacy-key", {
				"x-whalehall-agent-key": "not-a-valid-retired-key",
			}),
		);
		const overlongLegacyKey = await fixture.handler(
			chatRequest(accessToken, body, "overlong-personal-key", {
				"x-whalehall-agent-key": "a".repeat(1_025),
			}),
		);
		const planning = await fixture.handler(
			chatRequest(accessToken, body, "planning-request", {
				"x-whalehall-model-purpose": "planning",
			}),
		);

		expect(missingBearer.status).toBe(401);
		expect(withoutLegacyKey.status).toBe(200);
		expect(arbitraryLegacyKey.status).toBe(200);
		expect(overlongLegacyKey.status).toBe(200);
		expect(planning.status).toBe(200);
		expect(upstreamCalls).toBe(4);
		expect(fixture.records.snapshot().map((record) => record.purpose)).toEqual([
			"agent",
			"agent",
			"agent",
			"planning",
		]);
	});

	test("forwards exact request bytes, tool schemas, and SSE bytes without leaking desktop credentials upstream", async () => {
		const seen: { body?: Uint8Array; headers?: Headers; signal?: AbortSignal } =
			{};
		const first = encoder.encode(
			'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
		);
		const second = encoder.encode("data: [DONE]\n\n");
		const fixture = createFixture({
			fetch: (async (
				_input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				seen.body = new Uint8Array(
					await new Response(init?.body).arrayBuffer(),
				);
				seen.headers = new Headers(init?.headers);
				seen.signal = init?.signal ?? undefined;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(first);
							controller.enqueue(second);
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}) as unknown as typeof fetch,
		});
		const login = await signIn(fixture.handler);
		const accessToken = String(login.payload.accessToken);
		const raw = ` {\n  "model":"approved-model", "messages":[{"role":"system","content":"本地完整提示"}],\n  "tools":[{"type":"function","function":{"name":"calendar.list_events","parameters":{"type":"object"}}}],\n  "response_format":{"type":"json_schema","json_schema":{"name":"planning_result","strict":true,"schema":{"type":"object","properties":{"kind":{"type":"string"}},"required":["kind"],"additionalProperties":false}}}, "stream":true\n}`;
		const response = await fixture.handler(chatRequest(accessToken, raw));
		expect(response.status).toBe(200);
		const received = new Uint8Array(await response.arrayBuffer());
		expect(Array.from(received)).toEqual(Array.from(concat(first, second)));
		expect(decoder.decode(seen.body)).toBe(raw);
		expect(seen.headers?.get("authorization")).toBe(
			"Bearer provider-secret-key-for-tests",
		);
		expect(seen.headers?.get("authorization")).not.toContain(accessToken);
		expect(seen.headers?.has("x-user-id")).toBe(false);
		expect(seen.headers?.has("x-whalehall-agent-key")).toBe(false);
		expect(seen.headers?.has("x-whalehall-model-purpose")).toBe(false);
		const records = fixture.records.snapshot();
		expect(decoder.decode(records[0]?.requestBody)).toBe(raw);
		expect(records[0]?.responseBody).toEqual(received);
		expect(records[0]?.subject).toBe("account-1");
		expect(records[0]?.purpose).toBe("agent");
		expect(records[0]?.state).toBe("completed");
	});

	test("retires a reflection model request without forwarding or storing it", async () => {
		let upstreamCalls = 0;
		const seen: { body?: string; headers?: Headers } = {};
		const fixture = createFixture({
			fetch: (async (
				_input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				upstreamCalls += 1;
				seen.body = await new Response(init?.body).text();
				seen.headers = new Headers(init?.headers);
				return Response.json({
					id: "activity-model-result",
					choices: [{ message: { content: "{}" } }],
				});
			}) as unknown as typeof fetch,
		});
		const raw = ` {"model":"approved-model","messages":[{"role":"system","content":"客户端反思规则"},{"role":"user","content":"COMPRESSED_ACTIVITY_EVENTS_JSON=[{\\"time\\":\\"时间未知\\",\\"tools\\":\\"synthetic\\",\\"message\\":\\"raw activity\\"}]"}],"stream":false}`;

		const first = await fixture.handler(
			reflectionRequest(raw, "reflection-same-key"),
		);
		const second = await fixture.handler(
			reflectionRequest(raw, "reflection-same-key"),
		);

		expect(first.status).toBe(404);
		expect(second.status).toBe(404);
		expect(seen.body).toBeUndefined();
		expect(seen.headers).toBeUndefined();
		expect(upstreamCalls).toBe(0);
		expect(fixture.records.snapshot()).toEqual([]);
		expect(first.headers.get("cache-control")).toBe("no-store");
	});

	test("rejects every credential shape on the retired reflection route", async () => {
		let upstreamCalls = 0;
		const fixture = createFixture({
			fetch: (async () => {
				upstreamCalls += 1;
				return Response.json({ ok: true });
			}) as unknown as typeof fetch,
		});
		const body = JSON.stringify({ model: "approved-model", messages: [] });
		const missing = await fixture.handler(
			new Request("https://relay.example.test/v1/activity/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "missing-reflection-key",
				},
				body,
			}),
		);
		const bearer = await fixture.handler(
			reflectionRequest(body, "reflection-with-bearer", {
				authorization: "Bearer not-a-session-token",
			}),
		);
		const agentKey = await fixture.handler(
			reflectionRequest(body, "reflection-with-agent-key", {
				"x-whalehall-agent-key": legacyAgentKey,
			}),
		);
		const streaming = await fixture.handler(
			reflectionRequest(
				JSON.stringify({ model: "approved-model", messages: [], stream: true }),
				"reflection-streaming",
			),
		);

		expect(missing.status).toBe(404);
		expect(bearer.status).toBe(404);
		expect(agentKey.status).toBe(404);
		expect(streaming.status).toBe(404);
		expect(upstreamCalls).toBe(0);
	});

	test("does not verify keys on the retired reflection route", async () => {
		let verificationCalls = 0;
		const fixture = createFixture({
			dependencies: {
				passwordVerifier: async () => {
					verificationCalls += 1;
					return false;
				},
			},
		});
		const body = JSON.stringify({ model: "approved-model", messages: [] });
		const invalidRequest = () =>
			new Request("https://relay.example.test/v1/activity/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "invalid-reflection-key",
					"x-whalehall-reflection-key": "invalid-key",
				},
				body,
			});

		expect(
			(
				await fixture.handler(invalidRequest(), {
					clientAddress: "198.51.100.9",
				})
			).status,
		).toBe(404);
		expect(
			(
				await fixture.handler(invalidRequest(), {
					clientAddress: "198.51.100.9",
				})
			).status,
		).toBe(404);
		expect(verificationCalls).toBe(0);
	});

	test("does not start a non-settling provider on the retired reflection route", async () => {
		let upstreamSignal: AbortSignal | undefined;
		const fixture = createFixture({
			fetch: ((
				_input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				upstreamSignal = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			}) as unknown as typeof fetch,
		});
		const response = await fixture.handler(
			reflectionRequest(
				JSON.stringify({
					model: "approved-model",
					messages: [],
					stream: false,
				}),
				"reflection-provider-timeout",
			),
		);
		expect(response.status).toBe(404);
		expect(upstreamSignal).toBeUndefined();
	});

	test("does not read a provider body on the retired reflection route", async () => {
		let upstreamSignal: AbortSignal | undefined;
		let bodyCancelled = false;
		const fixture = createFixture({
			fetch: ((
				_input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				upstreamSignal = init?.signal ?? undefined;
				return Promise.resolve(
					new Response(
						new ReadableStream<Uint8Array>({
							cancel() {
								bodyCancelled = true;
							},
						}),
					),
				);
			}) as unknown as typeof fetch,
		});
		const response = await fixture.handler(
			reflectionRequest(
				JSON.stringify({
					model: "approved-model",
					messages: [],
					stream: false,
				}),
				"reflection-body-timeout",
			),
		);
		expect(response.status).toBe(404);
		expect(upstreamSignal).toBeUndefined();
		expect(bodyCancelled).toBeFalse();
	});

	test("replays a completed non-stream response by subject and key without a second provider request", async () => {
		let providerCalls = 0;
		const fixture = createFixture({
			fetch: (async () => {
				providerCalls += 1;
				return Response.json({ id: "provider-answer", choices: [] });
			}) as unknown as typeof fetch,
		});
		const login = await signIn(fixture.handler);
		const accessToken = String(login.payload.accessToken);
		const raw = JSON.stringify({
			model: "approved-model",
			messages: [],
			stream: false,
		});
		const first = await fixture.handler(
			chatRequest(accessToken, raw, "same-key"),
		);
		const second = await fixture.handler(
			chatRequest(accessToken, raw, "same-key"),
		);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(second.headers.get("x-whalehall-idempotent-replay")).toBe("true");
		expect(await second.text()).toBe(await first.text());
		expect(providerCalls).toBe(1);

		const conflict = await fixture.handler(
			chatRequest(
				accessToken,
				JSON.stringify({
					model: "approved-model",
					messages: [{ role: "user", content: "changed" }],
				}),
				"same-key",
			),
		);
		expect(conflict.status).toBe(409);
		expect((await conflict.json()).error.code).toBe("idempotency-conflict");
	});

	test("aborts the provider and marks a streaming record failed when the client cancels", async () => {
		let providerSignal: AbortSignal | undefined;
		const fixture = createFixture({
			fetch: (async (
				_input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				providerSignal = init?.signal ?? undefined;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: first\n\n"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}) as unknown as typeof fetch,
		});
		const login = await signIn(fixture.handler);
		const response = await fixture.handler(
			chatRequest(
				String(login.payload.accessToken),
				JSON.stringify({ model: "approved-model", messages: [], stream: true }),
				"cancel-stream",
			),
		);
		const reader = response.body?.getReader();
		expect((await reader?.read())?.value).toEqual(
			encoder.encode("data: first\n\n"),
		);
		await reader?.cancel("stop");
		await Promise.resolve();
		expect(providerSignal?.aborted).toBe(true);
		expect(fixture.records.snapshot()[0]?.state).toBe("failed");

		const retry = await fixture.handler(
			chatRequest(
				String(login.payload.accessToken),
				JSON.stringify({ model: "approved-model", messages: [], stream: true }),
				"cancel-stream",
			),
		);
		expect(retry.status).toBe(409);
		expect((await retry.json()).error.code).toBe("stream-not-replayable");
	});

	test("propagates client AbortSignal to the provider before response headers arrive", async () => {
		let providerSignal: AbortSignal | undefined;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const fixture = createFixture({
			fetch: (async (
				_input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				providerSignal = init?.signal ?? undefined;
				markProviderStarted();
				return new Promise<Response>((_resolve, reject) => {
					const rejectAbort = () =>
						reject(new DOMException("provider aborted", "AbortError"));
					if (init?.signal?.aborted) rejectAbort();
					else
						init?.signal?.addEventListener("abort", rejectAbort, {
							once: true,
						});
				});
			}) as unknown as typeof fetch,
		});
		const login = await signIn(fixture.handler);
		const controller = new AbortController();
		const request = new Request(
			chatRequest(
				String(login.payload.accessToken),
				JSON.stringify({ model: "approved-model", messages: [], stream: true }),
				"cancel-before-provider-headers",
			),
			{ signal: controller.signal },
		);
		const responsePromise = fixture.handler(request);

		await providerStarted;
		controller.abort(new DOMException("desktop run cancelled", "AbortError"));
		const response = await responsePromise;
		expect(providerSignal?.aborted).toBe(true);
		expect(response.status).toBe(502);
		expect(fixture.records.snapshot()[0]).toEqual(
			expect.objectContaining({ state: "failed" }),
		);
	});

	test("rejects self-reported identity, provider credentials, unapproved models, oversize bodies, and rate excess", async () => {
		const fixture = createFixture({ config: { maxRequestBytes: 1_024 } });
		const login = await signIn(fixture.handler);
		const token = String(login.payload.accessToken);
		const forgedBody = await fixture.handler(
			chatRequest(
				token,
				JSON.stringify({
					model: "approved-model",
					messages: [],
					userId: "account-2",
				}),
				"identity-body",
			),
		);
		expect(forgedBody.status).toBe(400);
		const forgedHeader = await fixture.handler(
			chatRequest(
				token,
				JSON.stringify({
					model: "approved-model",
					messages: [],
				}),
				"identity-header",
				{ "x-user-id": "account-2" },
			),
		);
		expect(forgedHeader.status).toBe(400);
		const providerKey = await fixture.handler(
			chatRequest(
				token,
				JSON.stringify({
					model: "approved-model",
					messages: [],
					apiKey: "stolen",
				}),
				"provider-key",
			),
		);
		expect(providerKey.status).toBe(400);
		const forgedPurpose = await fixture.handler(
			chatRequest(
				token,
				JSON.stringify({
					model: "approved-model",
					messages: [],
					purpose: "activity",
				}),
				"purpose-body",
			),
		);
		expect(forgedPurpose.status).toBe(400);
		const missingPurpose = await fixture.handler(
			new Request("https://relay.example.test/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"idempotency-key": "missing-purpose",
				},
				body: JSON.stringify({ model: "approved-model", messages: [] }),
			}),
		);
		expect(missingPurpose.status).toBe(400);
		const invalidPurpose = await fixture.handler(
			chatRequest(
				token,
				JSON.stringify({ model: "approved-model", messages: [] }),
				"invalid-purpose",
				{ "x-whalehall-model-purpose": "user-controlled" },
			),
		);
		expect(invalidPurpose.status).toBe(400);
		const model = await fixture.handler(
			chatRequest(
				token,
				JSON.stringify({
					model: "not-approved",
					messages: [],
				}),
				"model",
			),
		);
		expect(model.status).toBe(403);
		const oversized = await fixture.handler(
			chatRequest(
				token,
				JSON.stringify({
					model: "approved-model",
					messages: [{ role: "user", content: "x".repeat(2_000) }],
				}),
				"oversized",
			),
		);
		expect(oversized.status).toBe(413);

		const limitedFixture = createFixture();
		const limitedHandler = createModelRelayHandler(baseConfig(), {
			users: limitedFixture.users,
			sessions: limitedFixture.sessions,
			records: limitedFixture.records,
			clock: limitedFixture.clock,
			chatRateLimiter: new FixedWindowRateLimiter(1, 60_000),
			fetch: (async () =>
				Response.json({ ok: true })) as unknown as typeof fetch,
		});
		const limitedLogin = await signIn(limitedHandler);
		const limitedToken = String(limitedLogin.payload.accessToken);
		const validBody = JSON.stringify({ model: "approved-model", messages: [] });
		expect(
			(await limitedHandler(chatRequest(limitedToken, validBody, "limit-1")))
				.status,
		).toBe(200);
		const rateLimited = await limitedHandler(
			chatRequest(limitedToken, validBody, "limit-2"),
		);
		expect(rateLimited.status).toBe(429);
		expect(rateLimited.headers.get("retry-after")).toBe("60");
	});

	test("exposes no conversation, planning, tool, or history endpoint", async () => {
		const { handler } = createFixture();
		for (const path of [
			"/v1/conversations",
			"/v1/task-planning/start",
			"/v1/tools/call",
			"/v1/chat/history",
		]) {
			const response = await handler(
				new Request(`https://relay.example.test${path}`),
			);
			expect(response.status).toBe(404);
		}
	});
});

describe("model relay configuration", () => {
	test("loads current users and discards a legacy agent key hash", async () => {
		const directory = await mkdtemp(join(tmpdir(), "whalehall-relay-users-"));
		try {
			const usersPath = join(directory, "users.json");
			await writeFile(
				usersPath,
				JSON.stringify({
					users: [
						{
							id: "account-current",
							email: "current@example.com",
							displayName: "Current",
							initials: "C",
							passwordHash,
						},
						{
							id: "account-legacy",
							email: "legacy@example.com",
							displayName: "Legacy",
							initials: "L",
							passwordHash,
							agentKeyHash: "retired-hash-value",
						},
					],
				}),
				{ mode: 0o600 },
			);
			const users = await JsonFileUserStore.open(usersPath);
			expect(await users.findById("account-current")).not.toHaveProperty(
				"agentKeyHash",
			);
			expect(await users.findById("account-legacy")).not.toHaveProperty(
				"agentKeyHash",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("fails closed without a credential, exact allowlist, or secure provider URL", () => {
		const users = new InMemoryUserStore([]);
		const sessions = new InMemorySessionStore();
		const records = new InMemoryRelayRecordStore();
		expect(() =>
			createModelRelayHandler(baseConfig({ providerApiKey: "" }), {
				users,
				sessions,
				records,
			}),
		).toThrow();
		expect(() =>
			createModelRelayHandler(baseConfig({ allowedModels: ["*"] }), {
				users,
				sessions,
				records,
			}),
		).toThrow();
		expect(() =>
			createModelRelayHandler(
				baseConfig({
					providerChatCompletionsUrl:
						"http://provider.example.test/v1/chat/completions",
				}),
				{ users, sessions, records },
			),
		).toThrow();
		expect(() =>
			createModelRelayHandler(
				baseConfig({
					providerChatCompletionsUrl: CPU_ONLY_OLLAMA_CHAT_COMPLETIONS_URL,
					providerApiKey: undefined,
				}),
				{ users, sessions, records },
			),
		).toThrow();
		expect(() =>
			createModelRelayHandler(
				baseConfig({
					providerChatCompletionsUrl:
						"http://127.0.0.1:11434/v1/chat/completions",
					providerApiKey: undefined,
					allowInsecureLoopbackProvider: true,
				}),
				{ users, sessions, records },
			),
		).toThrow();
		expect(() =>
			createModelRelayHandler(
				baseConfig({
					providerChatCompletionsUrl: CPU_ONLY_OLLAMA_CHAT_COMPLETIONS_URL,
					providerApiKey: undefined,
					allowInsecureLoopbackProvider: true,
				}),
				{ users, sessions, records },
			),
		).not.toThrow();
	});

	test("persists only session token digests and replays completed non-stream records after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "whalehall-relay-test-"));
		try {
			const sessionPath = join(directory, "sessions.json");
			const sessions = new FileSessionStore(sessionPath);
			await sessions.create({
				id: "session-1",
				familyId: "family-1",
				subject: "account-1",
				accessDigest: createHash("sha256")
					.update("access-secret")
					.digest("hex"),
				refreshDigest: createHash("sha256")
					.update("refresh-secret")
					.digest("hex"),
				accessExpiresAtMs: 2_000,
				refreshExpiresAtMs: 3_000,
				createdAtMs: 1_000,
				revokedAtMs: null,
			});
			const sessionFile = await readFile(sessionPath, "utf8");
			expect(sessionFile).not.toContain("access-secret");
			expect(sessionFile).not.toContain("refresh-secret");
			expect(
				(
					await new FileSessionStore(sessionPath).findActiveByAccessDigest(
						createHash("sha256").update("access-secret").digest("hex"),
						1_500,
					)
				)?.subject,
			).toBe("account-1");

			const recordsDirectory = join(directory, "records");
			const records = new FileRelayRecordStore(recordsDirectory);
			const requestBody = encoder.encode('{"model":"approved-model"}');
			const requestHash = createHash("sha256")
				.update(requestBody)
				.digest("hex");
			const firstClaim = await records.claim({
				recordId: randomUUID(),
				subject: "account-1",
				purpose: "agent",
				idempotencyKey: "persisted-key",
				requestHash,
				model: "approved-model",
				stream: false,
				requestBody,
				createdAtMs: 1_000,
				expiresAtMs: 10_000,
			});
			expect(firstClaim.kind).toBe("claimed");
			await records.appendResponse(
				firstClaim.recordId,
				encoder.encode('{"answer":true}'),
			);
			await records.complete(firstClaim.recordId, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
			const metadataPath = join(
				recordsDirectory,
				`${createHash("sha256")
					.update("account-1")
					.update("\0")
					.update("persisted-key")
					.digest("hex")}.json`,
			);
			const legacyMetadata = JSON.parse(
				await readFile(metadataPath, "utf8"),
			) as Record<string, unknown>;
			expect(legacyMetadata.purpose).toBe("agent");
			delete legacyMetadata.purpose;
			await writeFile(metadataPath, JSON.stringify(legacyMetadata));

			const restarted = new FileRelayRecordStore(recordsDirectory);
			const replay = await restarted.claim({
				recordId: randomUUID(),
				subject: "account-1",
				purpose: "agent",
				idempotencyKey: "persisted-key",
				requestHash,
				model: "approved-model",
				stream: false,
				requestBody,
				createdAtMs: 2_000,
				expiresAtMs: 11_000,
			});
			expect(replay.kind).toBe("replay");
			if (replay.kind !== "replay")
				throw new Error("Expected persisted replay.");
			expect(decoder.decode(replay.response.body)).toBe('{"answer":true}');
			const mismatchedPurpose = await restarted.claim({
				recordId: randomUUID(),
				subject: "account-1",
				purpose: "activity",
				idempotencyKey: "persisted-key",
				requestHash,
				model: "approved-model",
				stream: false,
				requestBody,
				createdAtMs: 2_001,
				expiresAtMs: 11_001,
			});
			expect(mismatchedPurpose.kind).toBe("conflict");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function concat(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(
		chunks.reduce((total, item) => total + item.byteLength, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
