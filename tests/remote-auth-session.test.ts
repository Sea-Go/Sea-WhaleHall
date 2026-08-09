import { describe, expect, test } from "bun:test";
import {
	RemoteAuthSessionManager,
	type SecureCredentialStore,
} from "../src/bun/remote-auth-session";

const personalRelayKey = ["whk", "remote-auth", "fixture"].join("_");

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
			agentKey: personalRelayKey,
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
		expect(credentials.values.get("auth.refresh-token.current")).toBe(
			"refresh-token-signed-in-0123456789",
		);
	});

	test("coalesces concurrent refresh operations", async () => {
		const credentials = new MemoryCredentials();
		let refreshCalls = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			agentKey: personalRelayKey,
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

	test("adds the personal relay key only to authenticated model requests and binds identity generations", async () => {
		const credentials = new MemoryCredentials();
		const observed = {
			modelHeaders: null as Headers | null,
			bearerHeaders: null as Headers | null,
			modelRedirect: null as RequestRedirect | null,
		};
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			agentKey: personalRelayKey,
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
		await manager.authorizedFetch("/v1/chat/completions", { method: "POST" });
		await manager.bearerFetch("/v1/agent/register", { method: "POST" });

		const headers = observed.modelHeaders;
		if (!headers)
			throw new Error("Expected authenticated model request headers.");
		expect(headers.get("x-whalehall-agent-key")).toBe(personalRelayKey);
		expect(headers.get("authorization")).toStartWith("Bearer ");
		expect(headers.get("x-session-generation")).toBe("1");
		expect(observed.bearerHeaders?.get("authorization")).toStartWith(
			"Bearer ",
		);
		expect(
			observed.bearerHeaders?.get("x-whalehall-agent-key"),
		).toBeNull();
		expect(observed.modelRedirect).toBe("error");
		expect(manager.isCurrentSession(identity)).toBeTrue();
		expect(await manager.clearSessionIfCurrent(identity)).toBeTrue();
		expect(manager.isCurrentSession(identity)).toBeFalse();
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
			agentKey: personalRelayKey,
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
		expect(credentials.values.has("auth.refresh-token.current")).toBe(false);
	});

	test("runs the old-account clear barrier before activating another subject", async () => {
		const credentials = new MemoryCredentials();
		const barriers: Array<string | null> = [];
		let signIns = 0;
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			agentKey: personalRelayKey,
			onBeforeSessionClear: async (accountId) => {
				barriers.push(accountId);
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

		expect(barriers).toEqual(["account-1"]);
		expect(manager.accountId).toBe("account-2");
		expect(credentials.values.get("auth.refresh-token.current")).toContain(
			"switch-2",
		);
	});

	test("closes local state before best-effort remote revoke", async () => {
		const credentials = new MemoryCredentials();
		const order: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			agentKey: personalRelayKey,
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
		expect(credentials.values.has("auth.refresh-token.current")).toBe(false);
		expect(order[0]).toBe("barrier");
	});

	test("fails closed, cancels account work, and notifies the renderer when refresh expires", async () => {
		const credentials = new MemoryCredentials();
		const order: string[] = [];
		const manager = new RemoteAuthSessionManager(credentials, {
			baseUrl: "https://relay.example.test",
			agentKey: personalRelayKey,
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
			manager.authorizedFetch("/v1/chat/completions"),
		).rejects.toMatchObject({
			kind: "expired",
		});
		expect(manager.getSession()).toBeNull();
		expect(credentials.values.has("auth.refresh-token.current")).toBe(false);
		expect(order).toEqual(["barrier:account-1", "expired"]);
	});
});
