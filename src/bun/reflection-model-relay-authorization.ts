import { WHALEHALL_RELAY_BASE_URL } from "./client-config";
import type { ModelRelayAuthorization } from "./model-relay-transport";

const REFLECTION_COMPLETIONS_PATH = "/v1/activity/completions";

export interface ReflectionModelRelayAuthorizationOptions {
	baseUrl: string;
	reflectionKey: string;
	fetch?: typeof fetch;
}

/**
 * Bun-only credential adapter for sealed activity reflections. It knows only
 * how to reach the fixed generic relay endpoint. It does not build prompts,
 * interpret responses, or expose the key to the Mastra sidecar/renderer.
 */
export class ReflectionModelRelayAuthorization
	implements ModelRelayAuthorization
{
	private readonly baseUrl: URL;
	private readonly reflectionKey: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ReflectionModelRelayAuthorizationOptions) {
		this.baseUrl = normalizeRelayBaseUrl(options.baseUrl);
		this.reflectionKey = normalizeReflectionKey(options.reflectionKey);
		this.fetchImpl = options.fetch ?? fetch;
	}

	async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
		if (path !== REFLECTION_COMPLETIONS_PATH) {
			throw new Error("Reflection relay endpoint is not approved.");
		}
		const headers = new Headers(init.headers);
		if (
			headers.has("authorization") ||
			headers.has("x-whalehall-agent-key") ||
			headers.has("x-whalehall-reflection-key")
		) {
			throw new Error("Reflection relay credentials are host-owned.");
		}
		headers.set("x-whalehall-reflection-key", this.reflectionKey);
		return this.fetchImpl(new URL(path, this.baseUrl), {
			...init,
			headers,
			redirect: "error",
		});
	}
}

function normalizeRelayBaseUrl(value: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Reflection relay base URL is invalid.");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.origin !== WHALEHALL_RELAY_BASE_URL ||
		(parsed.pathname !== "" && parsed.pathname !== "/") ||
		parsed.search ||
		parsed.hash ||
		parsed.username ||
		parsed.password
	) {
		throw new Error("Reflection relay base URL is not approved.");
	}
	return new URL(`${WHALEHALL_RELAY_BASE_URL}/`);
}

function normalizeReflectionKey(value: string): string {
	const key = value.trim();
	if (
		key.length < 16 ||
		key.length > 1_024 ||
		/[\p{Cc}\s]/u.test(key) ||
		key.includes("${")
	) {
		throw new Error("Reflection relay key is invalid.");
	}
	return key;
}
