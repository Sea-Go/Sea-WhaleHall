import { describe, expect, test } from "bun:test";
import { WHALEHALL_RELAY_BASE_URL } from "../src/bun/client-config";
import { ReflectionModelRelayAuthorization } from "../src/bun/reflection-model-relay-authorization";

const reflectionKey =
	"whref_0123456789abcdef0123456789abcdef.fixture_reflection_secret_0123456789";

describe("ReflectionModelRelayAuthorization", () => {
	test("uses only the fixed transient reflection endpoint and host-owned key", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const authorization = new ReflectionModelRelayAuthorization({
			baseUrl: WHALEHALL_RELAY_BASE_URL,
			reflectionKey,
			fetch: (async (input, init) => {
				calls.push({ url: String(input), headers: new Headers(init?.headers) });
				return Response.json({ ok: true });
			}) as typeof fetch,
		});

		await expect(
			authorization.authorizedFetch("/v1/activity/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		).resolves.toMatchObject({ status: 200 });
		expect(calls).toEqual([
			expect.objectContaining({
				url: `${WHALEHALL_RELAY_BASE_URL}/v1/activity/completions`,
				headers: expect.any(Headers),
			}),
		]);
		expect(calls[0]?.headers.get("x-whalehall-reflection-key")).toBe(
			reflectionKey,
		);
		expect(calls[0]?.headers.has("authorization")).toBeFalse();
		expect(calls[0]?.headers.has("x-whalehall-agent-key")).toBeFalse();
	});

	test("rejects alternate routes and caller-supplied credentials", async () => {
		const authorization = new ReflectionModelRelayAuthorization({
			baseUrl: WHALEHALL_RELAY_BASE_URL,
			reflectionKey,
			fetch: (async () =>
				Response.json({ ok: true })) as unknown as typeof fetch,
		});

		await expect(
			authorization.authorizedFetch("/v1/chat/completions"),
		).rejects.toThrow("not approved");
		await expect(
			authorization.authorizedFetch("/v1/activity/completions", {
				headers: { authorization: "Bearer forged" },
			}),
		).rejects.toThrow("host-owned");
	});
});
