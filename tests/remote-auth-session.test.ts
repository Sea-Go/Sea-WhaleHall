import { describe, expect, test } from "bun:test";
import { MODEL_AGENT_IDS } from "../src/agent/mastra-host/model-agent-catalog";
import {
	RemoteAuthSessionManager,
	type SecureCredentialStore,
} from "../src/bun/remote-auth-session";

class MemoryCredentials implements SecureCredentialStore {
	readonly values = new Map<string, string>();
	reads = 0;
	async read(name: string): Promise<string | null> {
		this.reads += 1;
		return this.values.get(name) ?? null;
	}
	async write(name: string, value: string): Promise<void> {
		this.values.set(name, value);
	}
	async delete(name: string): Promise<void> {
		this.values.delete(name);
	}
}

function sessionPayload(suffix: string, accountId = "account-1") {
	return {
		id: `session-${suffix}`,
		accessToken: `access-token-${suffix}-0123456789`,
		refreshToken: `refresh-token-${suffix}-0123456789`,
		expiresAtMs: Date.now() + 15 * 60_000,
		user: {
			id: accountId,
			displayName: "测试用户",
			email: "test@example.com",
			initials: "测试",
		},
	};
}

describe("RemoteAuthSessionManager", () => {
	test("keeps bearer credentials out of the public session and rotates refresh token", async () => {
		const credentials = new MemoryCredentials();
		const seen: Array<{
			url: string;
			body: unknown;
			headers: Headers;
			redirect: RequestRedirect | undefined;
		}> = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				seen.push({
					url: String(input),
					body: init?.body ? JSON.parse(String(init.body)) : null,
					headers: new Headers(init?.headers),
					redirect: init?.redirect,
				});
				return Response.json(sessionPayload("signed-in"));
			}) as unknown as typeof fetch,
		});

		const session = await manager.signIn({
			email: " Test@Example.com ",
			password: "correct horse",
		});
		expect(session).toEqual({
			id: "session-signed-in",
			expiresAtMs: expect.any(Number),
			user: expect.objectContaining({ id: "account-1" }),
		});
		expect("accessToken" in session).toBe(false);
		expect("refreshToken" in session).toBe(false);
		expect(seen[0]?.body).toEqual({
			email: "test@example.com",
			password: "correct horse",
		});
		expect(seen[0]?.headers.get("x-whalehall-agent-key")).toBeNull();
		expect(seen[0]?.redirect).toBe("error");
		expect(credentials.values.get("auth.refresh-token.production.v1")).toBe(
			"refresh-token-signed-in-0123456789",
		);
	});

	test("preserves initial restore behavior when there is no live session", async () => {
		const credentials = new MemoryCredentials();
		credentials.values.set(
			"auth.refresh-token.production.v1",
			"refresh-token-persisted-0123456789",
		);
		const cleared: Array<string | null> = [];
		const activated: string[] = [];
		let refreshBody: unknown = null;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				cleared.push(accountId);
			},
			onSessionActivated: async (identity) => {
				activated.push(identity.sessionId);
			},
			fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				refreshBody = init?.body ? JSON.parse(String(init.body)) : null;
				return Response.json(sessionPayload("restored"));
			}) as unknown as typeof fetch,
		});

		await expect(manager.restoreSession()).resolves.toMatchObject({
			id: "session-restored",
		});
		expect(refreshBody).toEqual({
			refreshToken: "refresh-token-persisted-0123456789",
		});
		expect(cleared).toEqual([]);
		expect(activated).toEqual(["session-restored"]);
		expect(manager.accountId).toBe("account-1");
	});

	test("coalesces concurrent refresh operations", async () => {
		const credentials = new MemoryCredentials();
		let refreshCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async (input: RequestInfo | URL) => {
				if (new URL(String(input)).pathname === "/v1/auth/sessions") {
					return Response.json(sessionPayload("active"));
				}
				refreshCalls += 1;
				await Promise.resolve();
				return Response.json(sessionPayload("rotated"));
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });

		const [left, right] = await Promise.all([
			manager.refreshSession(),
			manager.refreshSession(),
		]);
		expect(left.id).toBe("session-rotated");
		expect(right.id).toBe("session-rotated");
		expect(refreshCalls).toBe(1);
	});

	test("does not expose current before the durable owner activation barrier", async () => {
		const credentials = new MemoryCredentials();
		let releaseActivation!: () => void;
		let markActivationStarted!: () => void;
		const activationStarted = new Promise<void>((resolve) => {
			markActivationStarted = resolve;
		});
		const activationReleased = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		const order: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionActivate: async (identity) => {
				order.push(`owner:${identity.accountId}`);
				markActivationStarted();
				await activationReleased;
			},
			fetch: (async () =>
				Response.json(sessionPayload("barrier"))) as unknown as typeof fetch,
		});

		const signingIn = manager.signIn({
			email: "test@example.com",
			password: "password",
		});
		await activationStarted;
		expect(manager.getSession()).toBeNull();
		expect(manager.captureCurrentSession()).toBeNull();
		expect(
			credentials.values.has("auth.refresh-token.production.v1"),
		).toBeFalse();

		releaseActivation();
		await signingIn;
		expect(manager.accountId).toBe("account-1");
		expect(order).toEqual(["owner:account-1"]);
	});

	test("rolls a partially prepared owner back when activation fails", async () => {
		const credentials = new MemoryCredentials();
		const cleared: Array<string | null> = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionActivate: async () => {
				throw new Error("injected durable owner failure");
			},
			onBeforeSessionClear: async (accountId) => {
				cleared.push(accountId);
			},
			fetch: (async () =>
				Response.json(
					sessionPayload("failed-owner"),
				)) as unknown as typeof fetch,
		});

		await expect(
			manager.signIn({ email: "test@example.com", password: "password" }),
		).rejects.toThrow("injected durable owner failure");
		expect(cleared).toEqual(["account-1"]);
		expect(manager.getSession()).toBeNull();
		expect(
			credentials.values.has("auth.refresh-token.production.v1"),
		).toBeFalse();
	});

	test("does not emit an expiry event when an initial post-activation callback fails", async () => {
		const credentials = new MemoryCredentials();
		const lifecycle: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onSessionActivated: async () => {
				throw new Error("injected initial session-ready failure");
			},
			onBeforeSessionClear: async (accountId) => {
				lifecycle.push(`clear:${String(accountId)}`);
			},
			onSessionExpired: () => lifecycle.push("expired"),
			fetch: (async () =>
				Response.json(
					sessionPayload("failed-ready"),
				)) as unknown as typeof fetch,
		});

		await expect(
			manager.signIn({ email: "test@example.com", password: "password" }),
		).rejects.toThrow("injected initial session-ready failure");
		expect(manager.getSession()).toBeNull();
		expect(
			credentials.values.has("auth.refresh-token.production.v1"),
		).toBeFalse();
		expect(lifecycle).toEqual(["clear:account-1"]);
	});

	test("uses bearer-only model requests, strips legacy keys, and binds identity generations", async () => {
		const credentials = new MemoryCredentials();
		const observed = {
			modelHeaders: null as Headers | null,
			bearerHeaders: null as Headers | null,
			modelRedirect: null as RequestRedirect | null,
		};
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				if (new URL(String(input)).pathname === "/v1/auth/sessions") {
					return Response.json(sessionPayload("active"));
				}
				if (new URL(String(input)).pathname === "/v1/agent/register") {
					observed.bearerHeaders = new Headers(init?.headers);
				} else {
					observed.modelHeaders = new Headers(init?.headers);
				}
				observed.modelRedirect = init?.redirect ?? null;
				return Response.json({ id: "model-response" });
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "test@example.com", password: "password" });
		const identity = manager.captureCurrentSession();
		if (!identity) throw new Error("Expected a current session.");
		await manager.authorizedFetch(
			"/v1/chat/completions",
			{
				method: "POST",
				headers: { "X-WhaleHall-Agent-Key": "retired-desktop-key" },
			},
			"reflection",
			MODEL_AGENT_IDS.activityReflection,
		);
		await manager.bearerFetch("/v1/agent/register", {
			method: "POST",
			headers: { "X-WhaleHall-Agent-Key": "retired-desktop-key" },
		});

		const headers = observed.modelHeaders;
		if (!headers)
			throw new Error("Expected authenticated model request headers.");
		expect(headers.get("x-whalehall-agent-key")).toBeNull();
		expect(headers.get("authorization")).toStartWith("Bearer ");
		expect(headers.get("x-session-generation")).toBe("1");
		expect(headers.get("x-whalehall-model-purpose")).toBe("reflection");
		expect(headers.get("x-whalehall-model-agent")).toBe(
			MODEL_AGENT_IDS.activityReflection,
		);
		expect(observed.bearerHeaders?.get("authorization")).toStartWith("Bearer ");
		expect(observed.bearerHeaders?.get("x-whalehall-agent-key")).toBeNull();
		expect(observed.modelRedirect).toBe("error");
		expect(manager.isCurrentSession(identity)).toBeTrue();
		expect(await manager.clearSessionIfCurrent(identity)).toBeTrue();
		expect(manager.isCurrentSession(identity)).toBeFalse();
	});

	test("rejects caller-supplied model routing headers before sending credentials", async () => {
		const credentials = new MemoryCredentials();
		let modelCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async (input: RequestInfo | URL) => {
				if (new URL(String(input)).pathname === "/v1/auth/sessions") {
					return Response.json(sessionPayload("active"));
				}
				modelCalls += 1;
				return Response.json({});
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });

		const routingHeaders: Array<Record<string, string>> = [
			{ "X-WhaleHall-Model-Purpose": "agent" },
			{ "X-WhaleHall-Model-Agent": MODEL_AGENT_IDS.conversation },
		];
		for (const headers of routingHeaders) {
			await expect(
				manager.authorizedFetch(
					"/v1/chat/completions",
					{ headers },
					"activity",
					MODEL_AGENT_IDS.activitySupportSupervisor,
				),
			).rejects.toMatchObject({ kind: "unexpected" });
		}
		expect(modelCalls).toBe(0);
	});

	test("rejects a fixed Agent whose catalog purpose does not match", async () => {
		const credentials = new MemoryCredentials();
		let modelCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async (input: RequestInfo | URL) => {
				if (new URL(String(input)).pathname === "/v1/auth/sessions") {
					return Response.json(sessionPayload("active"));
				}
				modelCalls += 1;
				return Response.json({});
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });

		await expect(
			manager.authorizedFetch(
				"/v1/chat/completions",
				{},
				"activity",
				MODEL_AGENT_IDS.conversation,
			),
		).rejects.toMatchObject({ kind: "unexpected" });
		expect(modelCalls).toBe(0);
	});

	test("keeps the host-owned purpose across a 401 refresh retry", async () => {
		const credentials = new MemoryCredentials();
		const modelPurposes: Array<string | null> = [];
		const modelAgents: Array<string | null> = [];
		const retiredKeyHeaders: Array<string | null> = [];
		let modelCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions") {
					return Response.json(sessionPayload("active"));
				}
				if (path === "/v1/auth/sessions/refresh") {
					return Response.json(sessionPayload("rotated"));
				}
				modelCalls += 1;
				modelPurposes.push(
					new Headers(init?.headers).get("x-whalehall-model-purpose"),
				);
				modelAgents.push(
					new Headers(init?.headers).get("x-whalehall-model-agent"),
				);
				retiredKeyHeaders.push(
					new Headers(init?.headers).get("x-whalehall-agent-key"),
				);
				return modelCalls === 1
					? new Response(null, { status: 401 })
					: Response.json({ id: "completed" });
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });

		const response = await manager.authorizedFetch(
			"/v1/chat/completions",
			{
				method: "POST",
				headers: { "X-WhaleHall-Agent-Key": "retired-desktop-key" },
			},
			"activity",
			MODEL_AGENT_IDS.activitySupportSupervisor,
		);

		expect(response.ok).toBeTrue();
		expect(modelPurposes).toEqual(["activity", "activity"]);
		expect(modelAgents).toEqual([
			MODEL_AGENT_IDS.activitySupportSupervisor,
			MODEL_AGENT_IDS.activitySupportSupervisor,
		]);
		expect(retiredKeyHeaders).toEqual([null, null]);
	});

	test("runs the post-activation callback after an authorized request refresh", async () => {
		const credentials = new MemoryCredentials();
		const activated: string[] = [];
		let modelCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onSessionActivated: async (identity) => {
				activated.push(identity.sessionId);
			},
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions") {
					return Response.json(sessionPayload("active"));
				}
				if (path === "/v1/auth/sessions/refresh") {
					return Response.json(sessionPayload("rotated"));
				}
				modelCalls += 1;
				return modelCalls === 1
					? new Response(null, { status: 401 })
					: Response.json({ id: "completed" });
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });

		await expect(
			manager.authorizedFetch(
				"/v1/chat/completions",
				{ method: "POST" },
				"activity",
				MODEL_AGENT_IDS.activitySupportSupervisor,
			),
		).resolves.toMatchObject({ ok: true });
		expect(activated).toEqual(["session-active", "session-rotated"]);
		expect(manager.getSession()?.id).toBe("session-rotated");
		expect(modelCalls).toBe(2);
	});

	test("revokes a refreshed session when its post-activation callback fails", async () => {
		const credentials = new MemoryCredentials();
		const lifecycle: string[] = [];
		let modelCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				lifecycle.push(`clear:${String(accountId)}`);
			},
			onSessionExpired: () => lifecycle.push("expired"),
			onSessionActivated: async (identity) => {
				if (identity.sessionId === "session-rotated") {
					throw new Error("injected session-ready failure");
				}
			},
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions") {
					return Response.json(sessionPayload("active"));
				}
				if (path === "/v1/auth/sessions/refresh") {
					return Response.json(sessionPayload("rotated"));
				}
				modelCalls += 1;
				return new Response(null, { status: 401 });
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });

		await expect(
			manager.authorizedFetch(
				"/v1/chat/completions",
				{ method: "POST" },
				"activity",
				MODEL_AGENT_IDS.activitySupportSupervisor,
			),
		).rejects.toThrow("injected session-ready failure");
		expect(manager.getSession()).toBeNull();
		expect(manager.captureCurrentSession()).toBeNull();
		expect(
			credentials.values.has("auth.refresh-token.production.v1"),
		).toBeFalse();
		expect(lifecycle).toEqual(["clear:account-1", "expired"]);
		expect(modelCalls).toBe(1);
	});

	test("does not resurrect a refresh token when logout races a credential write", async () => {
		let releaseWrite!: () => void;
		let markWriteStarted!: () => void;
		const writeStarted = new Promise<void>((resolve) => {
			markWriteStarted = resolve;
		});
		const writeReleased = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		class BlockingCredentials extends MemoryCredentials {
			override async write(name: string, value: string): Promise<void> {
				markWriteStarted();
				await writeReleased;
				await super.write(name, value);
			}
		}
		const credentials = new BlockingCredentials();
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async () =>
				Response.json(sessionPayload("racing"))) as unknown as typeof fetch,
		});

		const signingIn = manager.signIn({
			email: "test@example.com",
			password: "password",
		});
		await writeStarted;
		const signingOut = manager.signOut();
		releaseWrite();

		await expect(signingIn).rejects.toMatchObject({ kind: "expired" });
		await signingOut;
		expect(manager.getSession()).toBeNull();
		expect(credentials.values.has("auth.refresh-token.production.v1")).toBe(
			false,
		);
	});

	test("does not let an account A refresh reactivate after account B signs in", async () => {
		const credentials = new MemoryCredentials();
		let releaseRefresh!: () => void;
		let markRefreshStarted!: () => void;
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		const refreshReleased = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let signInCount = 0;
		let modelCalls = 0;
		const activations: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionActivate: async (identity) => {
				activations.push(identity.accountId);
			},
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions") {
					signInCount += 1;
					return Response.json(
						sessionPayload(
							signInCount === 1 ? "account-a" : "account-b",
							signInCount === 1 ? "account-a" : "account-b",
						),
					);
				}
				if (path === "/v1/auth/sessions/refresh") {
					markRefreshStarted();
					await refreshReleased;
					return Response.json(
						sessionPayload("account-a-refresh", "account-a"),
					);
				}
				modelCalls += 1;
				return new Response(null, { status: 401 });
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "a@example.com", password: "password" });
		const staleRequest = manager
			.authorizedFetch(
				"/v1/chat/completions",
				{ method: "POST" },
				"agent",
				MODEL_AGENT_IDS.conversation,
			)
			.then(
				() => null,
				(error: unknown) => error,
			);
		await refreshStarted;
		await manager.signIn({ email: "b@example.com", password: "password" });
		expect(manager.accountId).toBe("account-b");
		releaseRefresh();

		expect(await staleRequest).toMatchObject({ kind: "expired" });
		expect(manager.accountId).toBe("account-b");
		expect(manager.getSession()?.id).toBe("session-account-b");
		expect(credentials.values.get("auth.refresh-token.production.v1")).toBe(
			"refresh-token-account-b-0123456789",
		);
		expect(activations).toEqual(["account-a", "account-b"]);
		expect(modelCalls).toBe(1);
	});

	test("rejects and clears a refresh response for a different account", async () => {
		const credentials = new MemoryCredentials();
		const activations: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionActivate: async (identity) => {
				activations.push(identity.accountId);
			},
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				return Response.json(
					path === "/v1/auth/sessions"
						? sessionPayload("account-a", "account-a")
						: sessionPayload("mismatched", "account-b"),
				);
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "a@example.com", password: "password" });
		await expect(manager.refreshSession()).rejects.toMatchObject({
			kind: "expired",
		});

		expect(manager.getSession()).toBeNull();
		expect(
			credentials.values.has("auth.refresh-token.production.v1"),
		).toBeFalse();
		expect(activations).toEqual(["account-a"]);
	});

	test("never clears a winning same-account session after overlapping activations", async () => {
		const credentials = new MemoryCredentials();
		let releaseFirstActivation!: () => void;
		let markFirstActivationStarted!: () => void;
		const firstActivationStarted = new Promise<void>((resolve) => {
			markFirstActivationStarted = resolve;
		});
		const firstActivationReleased = new Promise<void>((resolve) => {
			releaseFirstActivation = resolve;
		});
		const events: string[] = [];
		let activationCount = 0;
		let sessionCount = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionActivate: async (identity) => {
				activationCount += 1;
				events.push(`activate:${identity.sessionId}`);
				if (activationCount === 1) {
					markFirstActivationStarted();
					await firstActivationReleased;
				}
			},
			onBeforeSessionClear: async (accountId) => {
				events.push(
					`clear:${String(accountId)}:${manager.getSession()?.id ?? "none"}`,
				);
			},
			fetch: (async () => {
				sessionCount += 1;
				return Response.json(sessionPayload(`overlap-${sessionCount}`));
			}) as unknown as typeof fetch,
		});

		const first = manager.signIn({
			email: "first@example.com",
			password: "password",
		});
		await firstActivationStarted;
		const second = manager.signIn({
			email: "second@example.com",
			password: "password",
		});
		releaseFirstActivation();

		await expect(first).rejects.toMatchObject({ kind: "expired" });
		await expect(second).resolves.toMatchObject({ id: "session-overlap-2" });
		expect(manager.getSession()?.id).toBe("session-overlap-2");
		expect(credentials.values.get("auth.refresh-token.production.v1")).toBe(
			"refresh-token-overlap-2-0123456789",
		);
		const winningActivation = events.lastIndexOf("activate:session-overlap-2");
		expect(winningActivation).toBeGreaterThanOrEqual(0);
		expect(
			events
				.slice(winningActivation + 1)
				.some((event) => event.startsWith("clear:")),
		).toBeFalse();
	});

	test("runs the old-account clear barrier before activating another subject", async () => {
		const credentials = new MemoryCredentials();
		const barriers: string[] = [];
		let signIns = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				barriers.push(`clear:${String(accountId)}`);
			},
			onBeforeSessionActivate: async (identity) => {
				barriers.push(`activate:${identity.accountId}`);
			},
			fetch: (async () => {
				signIns += 1;
				return Response.json(
					sessionPayload(
						`switch-${signIns}`,
						signIns === 1 ? "account-1" : "account-2",
					),
				);
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "first@example.com", password: "password" });
		await manager.signIn({ email: "second@example.com", password: "password" });

		expect(barriers).toEqual([
			"activate:account-1",
			"clear:account-1",
			"activate:account-2",
		]);
		expect(manager.accountId).toBe("account-2");
		expect(
			credentials.values.get("auth.refresh-token.production.v1"),
		).toContain("switch-2");
	});

	test("clears the live owner before a replacement sign-in waits on the network", async () => {
		const credentials = new MemoryCredentials();
		const barriers: string[] = [];
		let releaseReplacement!: () => void;
		let markReplacementStarted!: () => void;
		const replacementStarted = new Promise<void>((resolve) => {
			markReplacementStarted = resolve;
		});
		const replacementReleased = new Promise<void>((resolve) => {
			releaseReplacement = resolve;
		});
		let signIns = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				barriers.push(`clear:${String(accountId)}`);
			},
			onBeforeSessionActivate: async (next) => {
				barriers.push(`activate:${next.accountId}`);
			},
			fetch: (async () => {
				signIns += 1;
				if (signIns === 1) {
					return Response.json(sessionPayload("account-a", "account-a"));
				}
				markReplacementStarted();
				await replacementReleased;
				return new Response(null, { status: 401 });
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "a@example.com", password: "password" });
		const replacement = manager.signIn({
			email: "b@example.com",
			password: "wrong-password",
		});
		await replacementStarted;

		expect(manager.captureCurrentSession()).toBeNull();
		expect(manager.getSession()).toBeNull();
		expect(
			credentials.values.has("auth.refresh-token.production.v1"),
		).toBeFalse();
		expect(barriers).toEqual(["activate:account-a", "clear:account-a"]);

		releaseReplacement();
		await expect(replacement).rejects.toMatchObject({
			kind: "invalid-credentials",
		});
		expect(manager.captureCurrentSession()).toBeNull();
		expect(barriers).toEqual(["activate:account-a", "clear:account-a"]);
	});

	test("clears a live owner when restore finds no refresh token", async () => {
		const credentials = new MemoryCredentials();
		const barriers: string[] = [];
		let refreshCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				barriers.push(`clear:${String(accountId)}`);
			},
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions") {
					return Response.json(sessionPayload("account-a", "account-a"));
				}
				refreshCalls += 1;
				return Response.json(sessionPayload("restored", "account-a"));
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "a@example.com", password: "password" });
		credentials.values.delete("auth.refresh-token.production.v1");
		await expect(manager.restoreSession()).resolves.toBeNull();

		expect(manager.getSession()).toBeNull();
		expect(manager.captureCurrentSession()).toBeNull();
		expect(barriers).toEqual(["clear:account-a"]);
		expect(refreshCalls).toBe(0);
	});

	test("clears a live owner before restore waits on a failing network", async () => {
		const credentials = new MemoryCredentials();
		const barriers: string[] = [];
		let releaseRefresh!: () => void;
		let markRefreshStarted!: () => void;
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		const refreshReleased = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				barriers.push(`clear:${String(accountId)}`);
			},
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions") {
					return Response.json(sessionPayload("account-a", "account-a"));
				}
				markRefreshStarted();
				await refreshReleased;
				throw new Error("injected network failure");
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "a@example.com", password: "password" });
		const restoring = manager.restoreSession();
		await refreshStarted;

		expect(manager.getSession()).toBeNull();
		expect(manager.captureCurrentSession()).toBeNull();
		expect(
			credentials.values.has("auth.refresh-token.production.v1"),
		).toBeFalse();
		expect(barriers).toEqual(["clear:account-a"]);

		releaseRefresh();
		await expect(restoring).rejects.toMatchObject({ kind: "offline" });
		expect(manager.getSession()).toBeNull();
		expect(barriers).toEqual(["clear:account-a"]);
	});

	test("does not let an overlapping restore clear or replace a newer sign-in", async () => {
		const credentials = new MemoryCredentials();
		const events: string[] = [];
		let releaseRestore!: () => void;
		let markRestoreStarted!: () => void;
		const restoreStarted = new Promise<void>((resolve) => {
			markRestoreStarted = resolve;
		});
		const restoreReleased = new Promise<void>((resolve) => {
			releaseRestore = resolve;
		});
		let signInCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				events.push(`clear:${String(accountId)}`);
			},
			onSessionActivated: async (identity) => {
				events.push(`ready:${identity.accountId}:${identity.sessionId}`);
			},
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions") {
					signInCalls += 1;
					return Response.json(
						signInCalls === 1
							? sessionPayload("account-a", "account-a")
							: sessionPayload("account-b", "account-b"),
					);
				}
				markRestoreStarted();
				await restoreReleased;
				return Response.json(
					sessionPayload("stale-account-a-restore", "account-a"),
				);
			}) as unknown as typeof fetch,
		});

		await manager.signIn({ email: "a@example.com", password: "password" });
		const staleRestore = manager.restoreSession().then(
			() => null,
			(error: unknown) => error,
		);
		await restoreStarted;
		await manager.signIn({ email: "b@example.com", password: "password" });
		expect(manager.accountId).toBe("account-b");

		releaseRestore();
		expect(await staleRestore).toMatchObject({ kind: "expired" });
		expect(manager.accountId).toBe("account-b");
		expect(manager.getSession()?.id).toBe("session-account-b");
		expect(credentials.values.get("auth.refresh-token.production.v1")).toBe(
			"refresh-token-account-b-0123456789",
		);
		expect(events).toEqual([
			"ready:account-a:session-account-a",
			"clear:account-a",
			"ready:account-b:session-account-b",
		]);
	});

	test("closes local state before best-effort remote revoke", async () => {
		const credentials = new MemoryCredentials();
		const order: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async () => {
				order.push("barrier");
			},
			fetch: (async (input: RequestInfo | URL) => {
				if (String(input).endsWith("/v1/auth/sessions")) {
					return Response.json(sessionPayload("active"));
				}
				order.push("revoke");
				return new Response(null, { status: 204 });
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });
		await manager.signOut();
		await Promise.resolve();

		expect(manager.getSession()).toBeNull();
		expect(credentials.values.has("auth.refresh-token.production.v1")).toBe(
			false,
		);
		expect(order[0]).toBe("barrier");
	});

	test("drains an accepted best-effort remote revoke before process exit", async () => {
		const credentials = new MemoryCredentials();
		let releaseRevoke!: () => void;
		const revokeReleased = new Promise<void>((resolve) => {
			releaseRevoke = resolve;
		});
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			fetch: (async (input: RequestInfo | URL) => {
				if (String(input).endsWith("/v1/auth/sessions")) {
					return Response.json(sessionPayload("active"));
				}
				await revokeReleased;
				return new Response(null, { status: 204 });
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });
		await manager.signOut();
		manager.beginShutdown();
		let drained = false;
		const drain = manager.drain().then(() => {
			drained = true;
		});
		await Bun.sleep(1);
		expect(drained).toBe(false);

		releaseRevoke();
		await drain;
		expect(drained).toBe(true);
	});

	test("fails closed, cancels account work, and notifies the renderer when refresh expires", async () => {
		const credentials = new MemoryCredentials();
		const order: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			onBeforeSessionClear: async (accountId) => {
				order.push(`barrier:${accountId}`);
			},
			onSessionExpired: () => order.push("expired"),
			fetch: (async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname;
				if (path === "/v1/auth/sessions")
					return Response.json(sessionPayload("active"));
				return new Response(null, { status: 401 });
			}) as unknown as typeof fetch,
		});
		await manager.signIn({ email: "test@example.com", password: "password" });

		await expect(
			manager.authorizedFetch(
				"/v1/chat/completions",
				{},
				"agent",
				MODEL_AGENT_IDS.conversation,
			),
		).rejects.toMatchObject({
			kind: "expired",
		});
		expect(manager.getSession()).toBeNull();
		expect(credentials.values.has("auth.refresh-token.production.v1")).toBe(
			false,
		);
		expect(order).toEqual(["barrier:account-1", "expired"]);
	});
});
