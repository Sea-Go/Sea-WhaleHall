import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FixedWindowRateLimiter } from "./memory-stores.js";
import { dummyScryptPasswordHash, verifyScryptPassword } from "./password.js";
import {
	publicUser,
	type RateLimiter,
	type RelayClock,
	type RelayPublicUser,
	type RelayRecordStore,
	type RelayUser,
	type SessionStore,
	type StoredSession,
	systemClock,
	type UserStore,
} from "./types.js";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 16 * MEBIBYTE;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * MEBIBYTE;
const DEFAULT_ACCESS_TTL_MS = 15 * 60_000;
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const CPU_ONLY_OLLAMA_CHAT_COMPLETIONS_URL =
	"http://127.0.0.1:11437/v1/chat/completions";
const AUTH_BODY_LIMIT = 64 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:/+-]{1,200}$/;
const IDENTITY_HEADERS = [
	"x-user-id",
	"x-user",
	"x-account-id",
	"x-subject",
	"x-authenticated-user",
	"x-whalehall-user-id",
	"x-api-key",
	"x-provider-api-key",
] as const;
const SELF_REPORTED_IDENTITY_FIELDS = [
	"userId",
	"user_id",
	"user",
	"accountId",
	"account_id",
	"subject",
	"accessToken",
	"refreshToken",
	"apiKey",
	"api_key",
] as const;

export interface ModelRelayServerConfig {
	providerChatCompletionsUrl: string;
	/** Optional only for a protected upstream; never returned to a desktop. */
	providerApiKey?: string;
	allowedModels: readonly string[] | ReadonlySet<string>;
	accessTokenTtlMs?: number;
	refreshTokenTtlMs?: number;
	recordRetentionMs?: number;
	maxRequestBytes?: number;
	maxResponseBytes?: number;
	chatRequestsPerMinute?: number;
	loginAttemptsPerMinute?: number;
	/** Enables only the fixed CPU-only loopback Ollama endpoint below. */
	allowInsecureLoopbackProvider?: boolean;
}

export interface ModelRelayDependencies {
	users: UserStore;
	sessions: SessionStore;
	records: RelayRecordStore;
	fetch?: typeof fetch;
	clock?: RelayClock;
	chatRateLimiter?: RateLimiter;
	loginRateLimiter?: RateLimiter;
	passwordVerifier?: (password: string, encoded: string) => Promise<boolean>;
}

export interface ModelRelayRequestContext {
	/** Supplied by the trusted Node adapter, never from a forwarded header. */
	clientAddress?: string;
}

export type ModelRelayHandler = (
	request: Request,
	context?: ModelRelayRequestContext,
) => Promise<Response>;

interface ValidatedConfig {
	providerUrl: URL;
	providerApiKey: string | null;
	allowedModels: ReadonlySet<string>;
	accessTokenTtlMs: number;
	refreshTokenTtlMs: number;
	recordRetentionMs: number;
	maxRequestBytes: number;
	maxResponseBytes: number;
	chatRequestsPerMinute: number;
	loginAttemptsPerMinute: number;
}

interface AuthenticatedRequest {
	accessDigest: string;
	session: StoredSession;
	user: RelayUser;
}

export function createModelRelayHandler(
	inputConfig: ModelRelayServerConfig,
	dependencies: ModelRelayDependencies,
): ModelRelayHandler {
	const config = validateConfig(inputConfig);
	const fetchImpl = dependencies.fetch ?? fetch;
	const clock = dependencies.clock ?? systemClock;
	const chatRateLimiter =
		dependencies.chatRateLimiter ??
		new FixedWindowRateLimiter(config.chatRequestsPerMinute, 60_000);
	const loginRateLimiter =
		dependencies.loginRateLimiter ??
		new FixedWindowRateLimiter(config.loginAttemptsPerMinute, 60_000);
	const verifyPassword = dependencies.passwordVerifier ?? verifyScryptPassword;

	return async (request, context = {}) => {
		try {
			const url = new URL(request.url);
			if (url.search || url.hash)
				throw new HttpError(404, "not-found", "Endpoint not found.");

			if (request.method === "POST" && url.pathname === "/v1/auth/sessions") {
				return await createSession(request, context);
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/auth/sessions/refresh"
			) {
				return await refreshSession(request);
			}
			if (
				request.method === "DELETE" &&
				url.pathname === "/v1/auth/sessions/current"
			) {
				return await deleteCurrentSession(request);
			}
			if (request.method === "GET" && url.pathname === "/v1/auth/me") {
				return await getCurrentUser(request);
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/chat/completions"
			) {
				return await relayChatCompletion(request);
			}
			throw new HttpError(404, "not-found", "Endpoint not found.");
		} catch (error) {
			if (error instanceof HttpError) return errorResponse(error);
			return errorResponse(
				new HttpError(
					500,
					"internal-error",
					"The relay could not process the request.",
				),
			);
		}
	};

	async function createSession(
		request: Request,
		context: ModelRelayRequestContext,
	): Promise<Response> {
		requireJson(request);
		const input = parseObject(await readBoundedBody(request, AUTH_BODY_LIMIT));
		assertExactKeys(input, ["email", "password"]);
		const email = normalizeEmail(input.email);
		const password = requireString(input.password, "password", 1, 1_024);
		const rateKey = `login:${context.clientAddress ?? digest(email)}`;
		const rate = await loginRateLimiter.consume(rateKey, clock.now());
		if (!rate.allowed) throw rateLimitError(rate.retryAfterSeconds);

		const user = await dependencies.users.findByEmail(email);
		const valid = await verifyPassword(
			password,
			user?.passwordHash ?? dummyScryptPasswordHash(),
		);
		if (!user || user.disabled || !valid) {
			throw new HttpError(
				401,
				"invalid-credentials",
				"Invalid email or password.",
			);
		}
		const session = await issueSession(user, null);
		return jsonResponse(session, 201);
	}

	async function refreshSession(request: Request): Promise<Response> {
		requireJson(request);
		const input = parseObject(await readBoundedBody(request, AUTH_BODY_LIMIT));
		assertExactKeys(input, ["refreshToken"]);
		const refreshToken = requireString(
			input.refreshToken,
			"refreshToken",
			16,
			16_384,
		);
		const nowMs = clock.now();
		const previous = await dependencies.sessions.consumeRefresh(
			digest(refreshToken),
			nowMs,
		);
		if (!previous) throw unauthorized();
		const user = await dependencies.users.findById(previous.subject);
		if (!user || user.disabled) throw unauthorized();
		const session = await issueSession(user, previous.familyId);
		return jsonResponse(session);
	}

	async function deleteCurrentSession(request: Request): Promise<Response> {
		const auth = await authenticate(request);
		await dependencies.sessions.revokeByAccessDigest(
			auth.accessDigest,
			clock.now(),
		);
		return withSecurityHeaders(new Response(null, { status: 204 }));
	}

	async function getCurrentUser(request: Request): Promise<Response> {
		const auth = await authenticate(request);
		return jsonResponse(publicUser(auth.user));
	}

	async function relayChatCompletion(request: Request): Promise<Response> {
		const auth = await authenticate(request);
		const rate = await chatRateLimiter.consume(
			`chat:${auth.session.subject}`,
			clock.now(),
		);
		if (!rate.allowed) throw rateLimitError(rate.retryAfterSeconds);
		await authenticateAgentKey(request, auth.user);
		requireJson(request);

		const rawBody = await readBoundedBody(request, config.maxRequestBytes);
		const body = parseObject(rawBody);
		rejectSelfReportedIdentity(body);
		const model = requireString(body.model, "model", 1, 256);
		if (!config.allowedModels.has(model)) {
			throw new HttpError(
				403,
				"model-not-allowed",
				"The requested model is not allowed.",
			);
		}
		if (body.stream !== undefined && typeof body.stream !== "boolean") {
			throw new HttpError(
				400,
				"invalid-request",
				"stream must be a boolean when present.",
			);
		}
		const stream = body.stream === true;
		const idempotencyKey = request.headers.get("idempotency-key") ?? "";
		if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
			throw new HttpError(
				400,
				"invalid-idempotency-key",
				"A valid Idempotency-Key header is required.",
			);
		}

		const nowMs = clock.now();
		await dependencies.records.cleanup(nowMs);
		const claim = await dependencies.records.claim({
			recordId: randomUUID(),
			subject: auth.session.subject,
			idempotencyKey,
			requestHash: digestBytes(rawBody),
			model,
			stream,
			requestBody: rawBody,
			createdAtMs: nowMs,
			expiresAtMs: nowMs + config.recordRetentionMs,
		});
		if (claim.kind === "conflict") {
			throw new HttpError(
				409,
				"idempotency-conflict",
				"Idempotency-Key was already used for another request.",
			);
		}
		if (claim.kind === "inflight") {
			throw new HttpError(
				409,
				"request-in-progress",
				"An identical request is already in progress.",
				{
					"retry-after": "1",
				},
			);
		}
		if (claim.kind === "duplicate") {
			throw new HttpError(
				409,
				"stream-not-replayable",
				"This streaming request cannot be resumed or replayed.",
			);
		}
		if (claim.kind === "replay") {
			const headers = new Headers(claim.response.headers);
			headers.set("x-whalehall-idempotent-replay", "true");
			return withSecurityHeaders(
				new Response(asArrayBuffer(claim.response.body), {
					status: claim.response.status,
					headers,
				}),
			);
		}

		const relayAbort = new AbortController();
		const abortFromClient = () => relayAbort.abort(request.signal.reason);
		if (request.signal.aborted) abortFromClient();
		else
			request.signal.addEventListener("abort", abortFromClient, { once: true });

		let upstream: Response;
		try {
			const upstreamHeaders: Record<string, string> = {
				"content-type": "application/json",
				accept: stream ? "text/event-stream" : "application/json",
				"idempotency-key": idempotencyKey,
			};
			if (config.providerApiKey !== null) {
				upstreamHeaders.authorization = `Bearer ${config.providerApiKey}`;
			}
			upstream = await fetchImpl(config.providerUrl, {
				method: "POST",
				headers: upstreamHeaders,
				body: Buffer.from(rawBody),
				signal: relayAbort.signal,
			});
		} catch {
			request.signal.removeEventListener("abort", abortFromClient);
			await safeFail(
				claim.recordId,
				request.signal.aborted ? "client-abort" : "upstream",
			);
			throw new HttpError(
				502,
				"upstream-unavailable",
				"The model provider is unavailable.",
			);
		}

		const responseHeaders = forwardedResponseHeaders(upstream.headers);
		if (!upstream.body) {
			await dependencies.records.complete(claim.recordId, {
				status: upstream.status,
				headers: responseHeaders,
			});
			request.signal.removeEventListener("abort", abortFromClient);
			return withSecurityHeaders(
				new Response(null, {
					status: upstream.status,
					headers: responseHeaders,
				}),
			);
		}

		if (!stream) {
			try {
				const responseBody = await readBoundedResponse(
					upstream.body,
					config.maxResponseBytes,
					relayAbort,
				);
				await dependencies.records.appendResponse(claim.recordId, responseBody);
				await dependencies.records.complete(claim.recordId, {
					status: upstream.status,
					headers: responseHeaders,
				});
				return withSecurityHeaders(
					new Response(asArrayBuffer(responseBody), {
						status: upstream.status,
						headers: responseHeaders,
					}),
				);
			} catch (error) {
				const tooLarge = error instanceof ResponseTooLargeError;
				await safeFail(
					claim.recordId,
					tooLarge ? "response-too-large" : "upstream",
				);
				throw new HttpError(
					502,
					tooLarge ? "upstream-response-too-large" : "upstream-failure",
					"The model response could not be relayed.",
				);
			} finally {
				request.signal.removeEventListener("abort", abortFromClient);
			}
		}

		const reader = upstream.body.getReader();
		let responseBytes = 0;
		let terminal = false;
		let readerReleased = false;
		const releaseReader = () => {
			if (readerReleased) return;
			readerReleased = true;
			reader.releaseLock();
		};
		const finishFailure = async (
			controller: ReadableStreamDefaultController<Uint8Array>,
			reason: "upstream" | "client-abort" | "storage" | "response-too-large",
			error: unknown,
		) => {
			if (terminal) return;
			terminal = true;
			relayAbort.abort(error);
			await reader.cancel(error).catch(() => {});
			await safeFail(claim.recordId, reason);
			request.signal.removeEventListener("abort", abortFromClient);
			releaseReader();
			controller.error(error);
		};
		const responseBody = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const item = await reader.read();
					if (item.done) {
						try {
							await dependencies.records.complete(claim.recordId, {
								status: upstream.status,
								headers: responseHeaders,
							});
						} catch (error) {
							await finishFailure(controller, "storage", error);
							return;
						}
						terminal = true;
						request.signal.removeEventListener("abort", abortFromClient);
						releaseReader();
						controller.close();
						return;
					}
					responseBytes += item.value.byteLength;
					if (responseBytes > config.maxResponseBytes) {
						await finishFailure(
							controller,
							"response-too-large",
							new ResponseTooLargeError(),
						);
						return;
					}
					// Storage is awaited before enqueueing. That preserves order and applies
					// downstream backpressure all the way to the provider stream.
					try {
						await dependencies.records.appendResponse(
							claim.recordId,
							item.value,
						);
					} catch (error) {
						await finishFailure(controller, "storage", error);
						return;
					}
					controller.enqueue(item.value);
				} catch (error) {
					await finishFailure(
						controller,
						request.signal.aborted ? "client-abort" : "upstream",
						error,
					);
				}
			},
			async cancel(reason) {
				if (terminal) return;
				terminal = true;
				relayAbort.abort(reason);
				await reader.cancel(reason).catch(() => {});
				await safeFail(claim.recordId, "client-abort");
				request.signal.removeEventListener("abort", abortFromClient);
				releaseReader();
			},
		});

		return withSecurityHeaders(
			new Response(responseBody, {
				status: upstream.status,
				headers: responseHeaders,
			}),
		);
	}

	async function authenticate(request: Request): Promise<AuthenticatedRequest> {
		rejectIdentityHeaders(request.headers);
		const token = bearerToken(request.headers);
		const accessDigest = digest(token);
		const session = await dependencies.sessions.findActiveByAccessDigest(
			accessDigest,
			clock.now(),
		);
		if (!session) throw unauthorized();
		const user = await dependencies.users.findById(session.subject);
		if (!user || user.disabled) throw unauthorized();
		return { accessDigest, session, user };
	}

	async function authenticateAgentKey(
		request: Request,
		user: RelayUser,
	): Promise<void> {
		const key = request.headers.get("x-whalehall-agent-key") ?? "";
		const valid = await verifyPassword(
			isPersonalRelayKey(key) ? key : "",
			user.agentKeyHash || dummyScryptPasswordHash(),
		);
		if (!valid) throw unauthorized();
	}

	async function issueSession(
		user: RelayUser,
		familyId: string | null,
	): Promise<{
		id: string;
		accessToken: string;
		refreshToken: string;
		expiresAtMs: number;
		user: RelayPublicUser;
	}> {
		const nowMs = clock.now();
		const accessToken = `wh_access_${randomBytes(32).toString("base64url")}`;
		const refreshToken = `wh_refresh_${randomBytes(32).toString("base64url")}`;
		const session: StoredSession = {
			id: randomUUID(),
			familyId: familyId ?? randomUUID(),
			subject: user.id,
			accessDigest: digest(accessToken),
			refreshDigest: digest(refreshToken),
			accessExpiresAtMs: nowMs + config.accessTokenTtlMs,
			refreshExpiresAtMs: nowMs + config.refreshTokenTtlMs,
			createdAtMs: nowMs,
			revokedAtMs: null,
		};
		await dependencies.sessions.cleanup(nowMs);
		await dependencies.sessions.create(session);
		return {
			id: session.id,
			accessToken,
			refreshToken,
			expiresAtMs: session.accessExpiresAtMs,
			user: publicUser(user),
		};
	}

	async function safeFail(
		recordId: string,
		reason: "upstream" | "client-abort" | "storage" | "response-too-large",
	): Promise<void> {
		await dependencies.records.fail(recordId, reason).catch(() => {});
	}
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly headers: Record<string, string> = {},
	) {
		super(message);
		this.name = "HttpError";
	}
}

class ResponseTooLargeError extends Error {}

function validateConfig(config: ModelRelayServerConfig): ValidatedConfig {
	if (!config || typeof config !== "object")
		throw new Error("Relay config is required.");
	const providerUrl = new URL(config.providerChatCompletionsUrl);
	const loopback =
		providerUrl.hostname === "127.0.0.1" ||
		providerUrl.hostname === "localhost" ||
		providerUrl.hostname === "[::1]";
	const cpuOnlyProviderUrl = new URL(CPU_ONLY_OLLAMA_CHAT_COMPLETIONS_URL);
	if (
		providerUrl.username ||
		providerUrl.password ||
		providerUrl.hash ||
		providerUrl.search ||
		(providerUrl.protocol !== "https:" && providerUrl.protocol !== "http:")
	) {
		throw new Error(
			"Provider URL must be HTTPS and must not contain credentials or a fragment.",
		);
	}
	if (
		providerUrl.protocol === "http:" &&
		(!loopback ||
			config.allowInsecureLoopbackProvider !== true ||
			providerUrl.toString() !== cpuOnlyProviderUrl.toString())
	) {
		throw new Error(
			"Insecure provider URL must be the fixed CPU-only Ollama endpoint.",
		);
	}
	const providerApiKey = config.providerApiKey?.trim() || null;
	if (
		providerUrl.protocol === "https:" &&
		(!providerApiKey || providerApiKey.length < 8)
	) {
		throw new Error("HTTPS provider API key is required.");
	}
	if (providerApiKey !== null && providerApiKey.length > 4_096) {
		throw new Error("Provider API key is invalid.");
	}
	const models = new Set(config.allowedModels);
	if (
		models.size < 1 ||
		[...models].some(
			(model) =>
				typeof model !== "string" ||
				model.length < 1 ||
				model.length > 256 ||
				model === "*",
		)
	) {
		throw new Error("At least one exact allowed model is required.");
	}
	return {
		providerUrl,
		providerApiKey,
		allowedModels: models,
		accessTokenTtlMs: boundedInteger(
			config.accessTokenTtlMs ?? DEFAULT_ACCESS_TTL_MS,
			60_000,
			60 * 60_000,
			"accessTokenTtlMs",
		),
		refreshTokenTtlMs: boundedInteger(
			config.refreshTokenTtlMs ?? DEFAULT_REFRESH_TTL_MS,
			24 * 60 * 60_000,
			90 * 24 * 60 * 60_000,
			"refreshTokenTtlMs",
		),
		recordRetentionMs: boundedInteger(
			config.recordRetentionMs ?? DEFAULT_RECORD_RETENTION_MS,
			60_000,
			365 * 24 * 60 * 60_000,
			"recordRetentionMs",
		),
		maxRequestBytes: boundedInteger(
			config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
			1_024,
			DEFAULT_MAX_REQUEST_BYTES,
			"maxRequestBytes",
		),
		maxResponseBytes: boundedInteger(
			config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
			1_024,
			256 * MEBIBYTE,
			"maxResponseBytes",
		),
		chatRequestsPerMinute: boundedInteger(
			config.chatRequestsPerMinute ?? 60,
			1,
			10_000,
			"chatRequestsPerMinute",
		),
		loginAttemptsPerMinute: boundedInteger(
			config.loginAttemptsPerMinute ?? 10,
			1,
			1_000,
			"loginAttemptsPerMinute",
		),
	};
}

async function readBoundedBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const size = Number(contentLength);
		if (!Number.isSafeInteger(size) || size < 0)
			throw new HttpError(
				400,
				"invalid-content-length",
				"Invalid Content-Length header.",
			);
		if (size > maxBytes)
			throw new HttpError(
				413,
				"request-too-large",
				"Request body exceeds the configured limit.",
			);
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new HttpError(
					413,
					"request-too-large",
					"Request body exceeds the configured limit.",
				);
			}
			chunks.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
	return concatenate(chunks, size);
}

async function readBoundedResponse(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	abort: AbortController,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.byteLength;
			if (size > maxBytes) {
				abort.abort();
				await reader.cancel().catch(() => {});
				throw new ResponseTooLargeError();
			}
			chunks.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
	return concatenate(chunks, size);
}

function concatenate(chunks: readonly Uint8Array[], size: number): Uint8Array {
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new HttpError(
			400,
			"invalid-json",
			"Request body must be valid UTF-8 JSON.",
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HttpError(
			400,
			"invalid-json",
			"Request body must be valid JSON.",
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(
			400,
			"invalid-request",
			"Request body must be a JSON object.",
		);
	}
	return value as Record<string, unknown>;
}

function requireJson(request: Request): void {
	const value = request.headers
		.get("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	if (value !== "application/json") {
		throw new HttpError(
			415,
			"unsupported-media-type",
			"Content-Type must be application/json.",
		);
	}
}

function bearerToken(headers: Headers): string {
	const value = headers.get("authorization") ?? "";
	const match = /^Bearer ([A-Za-z0-9._~-]{16,16384})$/.exec(value);
	if (!match?.[1]) throw unauthorized();
	return match[1];
}

function isPersonalRelayKey(value: string): boolean {
	return (
		value.length >= 16 && value.length <= 1_024 && !/[^\x21-\x7e]/u.test(value)
	);
}

function rejectIdentityHeaders(headers: Headers): void {
	for (const name of IDENTITY_HEADERS) {
		if (headers.has(name)) {
			throw new HttpError(
				400,
				"self-reported-identity",
				"Self-reported identity and provider credentials are not accepted.",
			);
		}
	}
}

function rejectSelfReportedIdentity(body: Record<string, unknown>): void {
	for (const name of SELF_REPORTED_IDENTITY_FIELDS) {
		if (Object.hasOwn(body, name)) {
			throw new HttpError(
				400,
				"self-reported-identity",
				"Self-reported identity and credentials are not accepted.",
			);
		}
	}
}

function forwardedResponseHeaders(input: Headers): Record<string, string> {
	const headers: Record<string, string> = {};
	const forbidden = new Set([
		"connection",
		"content-encoding",
		"content-length",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"set-cookie",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
	]);
	for (const [name, value] of input) {
		if (!forbidden.has(name.toLowerCase()))
			headers[name] = value.slice(0, 8_192);
	}
	return headers;
}

function normalizeEmail(value: unknown): string {
	const email = requireString(value, "email", 3, 320).trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
		throw new HttpError(400, "invalid-request", "email is invalid.");
	}
	return email;
}

function requireString(
	value: unknown,
	name: string,
	minLength: number,
	maxLength: number,
): string {
	if (
		typeof value !== "string" ||
		value.length < minLength ||
		value.length > maxLength
	) {
		throw new HttpError(400, "invalid-request", `${name} is invalid.`);
	}
	return value;
}

function assertExactKeys(
	input: Record<string, unknown>,
	expected: readonly string[],
): void {
	const allowed = new Set(expected);
	if (Object.keys(input).some((key) => !allowed.has(key))) {
		throw new HttpError(
			400,
			"invalid-request",
			"Request contains unsupported fields.",
		);
	}
}

function boundedInteger(
	value: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} is outside its safe range.`);
	}
	return value;
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function unauthorized(): HttpError {
	return new HttpError(
		401,
		"unauthorized",
		"A valid bearer session is required.",
		{
			"www-authenticate": "Bearer",
		},
	);
}

function rateLimitError(retryAfterSeconds: number): HttpError {
	return new HttpError(429, "rate-limited", "Rate limit exceeded.", {
		"retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
	});
}

function jsonResponse(value: unknown, status = 200): Response {
	return withSecurityHeaders(
		Response.json(value, {
			status,
			headers: { "cache-control": "no-store" },
		}),
	);
}

function errorResponse(error: HttpError): Response {
	return withSecurityHeaders(
		Response.json(
			{
				error: {
					code: error.code,
					message: error.message,
				},
			},
			{
				status: error.status,
				headers: {
					"cache-control": "no-store",
					...error.headers,
				},
			},
		),
	);
}

function withSecurityHeaders(response: Response): Response {
	response.headers.set(
		"cache-control",
		response.headers.get("cache-control") ?? "no-store",
	);
	response.headers.set("x-content-type-options", "nosniff");
	response.headers.set("referrer-policy", "no-referrer");
	return response;
}
