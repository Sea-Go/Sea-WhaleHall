import {
	canonicalJson,
	WebCryptoReflectionHasher,
	type ReflectionHasher,
} from "../reflection/hash";
import type {
	ActiveGoalContextV1,
	ActivityLabel,
	GoalRelevanceLabel,
} from "../reflection/types";
import type {
	TimelineEpisodeClassificationContext,
	TimelineEpisodeClassifier,
} from "./episodes";
import {
	TIMELINE_TAXONOMY_VERSION,
	type EpisodeClassificationV2,
	type EvidenceFactV2,
	type FactTemplateCode,
	type JsonPrimitive,
} from "./types";

export const MODERNBERT_MANIFEST_SCHEMA_VERSION =
	"modernbert-episode-serving-manifest.v2" as const;
export const MODERNBERT_RUNTIME_SCHEMA_VERSION =
	"modernbert-episode-runtime.v1" as const;
export const MODERNBERT_REQUEST_SCHEMA_VERSION =
	"modernbert-episode-classification-request.v2" as const;
export const MODERNBERT_INPUT_SCHEMA_VERSION =
	"modernbert-episode-input.v2" as const;
export const MODERNBERT_RESPONSE_SCHEMA_VERSION =
	"modernbert-episode-classification-response.v2" as const;
export const MODERNBERT_MODEL_INPUT_FORMAT =
	"timeline-event-sequence.v2" as const;
export const MODERNBERT_EVIDENCE_PROJECTOR_VERSION =
	"evidence-projector.v2" as const;
export const MODERNBERT_CHUNKING_STRATEGY =
	"event-boundary-greedy.v1" as const;
export const MODERNBERT_CHUNK_MERGE_VERSION =
	"core-fact-weighted-probability.v1" as const;
export const MODERNBERT_CHUNK_OVERLAP_FACTS = 5 as const;
export const MODERNBERT_CHUNK_OVERLAP_MS = 30_000 as const;
export const MODERNBERT_CONTEXT_ONLY_MAXIMUM_TOKENS = 96 as const;

export const MODERNBERT_ACTIVITY_LABELS = [
	"development",
	"writing",
	"research",
	"communication",
	"planning",
	"data_work",
	"media",
	"gaming",
	"system_file_ops",
	"commerce",
	"idle_transition",
	"other_unknown",
] as const satisfies readonly ActivityLabel[];

export const MODERNBERT_GOAL_RELEVANCE_LABELS = [
	"direct",
	"supporting",
	"unrelated",
	"uncertain",
] as const satisfies readonly GoalRelevanceLabel[];

export const MODERNBERT_FACT_TEMPLATE_CODES = [
	"application.foreground",
	"application.visible_content",
	"application.text_value",
	"browser.visible_page",
	"ui.focus",
	"ui.control_activated",
	"input.activity",
	"presence.changed",
	"goal.changed",
	"coverage.unavailable",
] as const satisfies readonly FactTemplateCode[];

const MAX_FACTS = 128;
const MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_FACT_TEXT_CHARACTERS = 4_000;
const MAX_GOAL_TEXT_CHARACTERS = 1_000;
const PROBABILITY_SUM_TOLERANCE = 1e-6;
const MODERNBERT_MAXIMUM_TOKENS = 8_192;
const MODERNBERT_EMBEDDING_DIMENSIONS = 256;
const MAX_CONTEXT_ONLY_FACTS = 5;
const UNREADY_CALIBRATION_VERSIONS = new Set([
	"uncalibrated",
	"unknown",
	"placeholder",
	"pending",
	"none",
	"n/a",
	"not-ready",
	"not_ready",
]);

export const MODERNBERT_EPISODE_HEADS = [
	"boundary",
	"activity",
	"relevance",
	"evidence",
	"summary",
	"embedding",
] as const;

/**
 * Exact application-side mirror of
 * WhaleHall-Training.episode_model_v2.episode_runtime_metadata_v2().
 */
export type ModernBertEpisodeRuntimeV1 = {
	schemaVersion: typeof MODERNBERT_RUNTIME_SCHEMA_VERSION;
	modelVersion: string;
	modelFamily: "ModernBERT";
	maximumTokens: number;
	tokenizerSha256: string;
	inputFormat: typeof MODERNBERT_MODEL_INPUT_FORMAT;
	projectorVersion: typeof MODERNBERT_EVIDENCE_PROJECTOR_VERSION;
	architecture: {
		activityClasses: 12;
		relevanceClasses: 4;
		embeddingDimensions: typeof MODERNBERT_EMBEDDING_DIMENSIONS;
		heads: readonly (typeof MODERNBERT_EPISODE_HEADS)[number][];
	};
	taxonomy: {
		version: typeof TIMELINE_TAXONOMY_VERSION;
		activities: readonly ActivityLabel[];
		goalRelevance: readonly GoalRelevanceLabel[];
	};
	oodScoring: "calibrated-energy-plus-cluster-distance.v1";
	calibrationVersion: string;
};

/**
 * Serving wrapper pinned by the application. A compatible deployment must
 * produce it explicitly; runtime.json alone is not serving attestation.
 */
export type ModernBertArtifactManifestV1 = {
	schemaVersion: typeof MODERNBERT_MANIFEST_SCHEMA_VERSION;
	artifactId: string;
	artifactSha256: string;
	runtime: ModernBertEpisodeRuntimeV1;
	requestSchemaVersion: typeof MODERNBERT_REQUEST_SCHEMA_VERSION;
	inputSchemaVersion: typeof MODERNBERT_INPUT_SCHEMA_VERSION;
	responseSchemaVersion: typeof MODERNBERT_RESPONSE_SCHEMA_VERSION;
	maximumFacts: number;
	maximumInputBytes: number;
};

export function validatePinnedModernBertArtifactManifest(
	value: unknown,
): ModernBertArtifactManifestV1 {
	validateManifest(value, "invalid_config");
	return structuredClone(value);
}

export type ModernBertFetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type ModernBertClassifierOptions = {
	endpoint: string;
	manifestEndpoint: string;
	expectedArtifact: ModernBertArtifactManifestV1;
	allowedRemoteOrigins?: readonly string[];
	allowInsecureRemote?: boolean;
	authorizationToken?: string;
	timeoutMs?: number;
	maximumResponseBytes?: number;
	/**
	 * Runtime-only startup retry schedule. At most five bounded attempts are
	 * accepted; it is not sent to the serving endpoint.
	 */
	verificationRetryDelaysMs?: readonly number[];
	fetch?: ModernBertFetchLike;
	hasher?: ReflectionHasher;
};

export type ModernBertRuntimeOptIn =
	| { enabled: false }
	| ({ enabled: true } & ModernBertClassifierOptions);

export type ModernBertClassifierErrorCode =
	| "invalid_config"
	| "unsafe_endpoint"
	| "artifact_not_verified"
	| "artifact_manifest_mismatch"
	| "invalid_input"
	| "input_too_large"
	| "request_timeout"
	| "transport_error"
	| "http_error"
	| "response_too_large"
	| "invalid_json"
	| "schema_mismatch"
	| "correlation_mismatch"
	| "artifact_response_mismatch";

export class ModernBertClassifierError extends Error {
	constructor(
		public readonly code: ModernBertClassifierErrorCode,
		message: string,
		public readonly retryable = false,
		public readonly httpStatus: number | null = null,
	) {
		super(message);
		this.name = "ModernBertClassifierError";
	}
}

export type ModernBertArtifactIdentity = {
	artifactId: string;
	artifactSha256: string;
	tokenizerSha256: string;
	modelVersion: string;
	taxonomyVersion: typeof TIMELINE_TAXONOMY_VERSION;
	runtimeSchemaVersion: typeof MODERNBERT_RUNTIME_SCHEMA_VERSION;
	inputFormat: typeof MODERNBERT_MODEL_INPUT_FORMAT;
	projectorVersion: typeof MODERNBERT_EVIDENCE_PROJECTOR_VERSION;
	calibrationVersion: string;
};

export type ModernBertInputFact = {
	factId: string;
	startedAtMs: number;
	endedAtMs: number;
	templateCode: string;
	templateArgs: Record<string, JsonPrimitive>;
	renderedText: string;
	role: EvidenceFactV2["role"];
	reliability: EvidenceFactV2["reliability"];
	coverage: EvidenceFactV2["coverage"];
	anchor: EvidenceFactV2["anchor"];
	countClass: "effective" | "boundary" | "context";
};

export type ModernBertEpisodeInput = {
	schemaVersion: typeof MODERNBERT_INPUT_SCHEMA_VERSION;
	window: {
		windowId: string;
		triggerReason: TimelineEpisodeClassificationContext["triggerReason"];
		startedAtMs: number;
		endedAtMs: number;
	};
	facts: ModernBertInputFact[];
	contextOnlyFacts: ModernBertInputFact[];
	goal: {
		goalId: string;
		version: number;
		text: string;
	} | null;
	chunking: {
		strategy: typeof MODERNBERT_CHUNKING_STRATEGY;
		maximumTokens: number;
		overlapFacts: typeof MODERNBERT_CHUNK_OVERLAP_FACTS;
		overlapMs: typeof MODERNBERT_CHUNK_OVERLAP_MS;
		merge: typeof MODERNBERT_CHUNK_MERGE_VERSION;
	};
};

export type ModernBertClassificationRequest = {
	schemaVersion: typeof MODERNBERT_REQUEST_SCHEMA_VERSION;
	correlationId: string;
	inputHash: string;
	artifact: ModernBertArtifactIdentity;
	input: ModernBertEpisodeInput;
};

export type ModernBertClassificationResponse = {
	schemaVersion: typeof MODERNBERT_RESPONSE_SCHEMA_VERSION;
	correlationId: string;
	inputHash: string;
	artifact: ModernBertArtifactIdentity;
	analysis: {
		projectorVersion: typeof MODERNBERT_EVIDENCE_PROJECTOR_VERSION;
		strategy: typeof MODERNBERT_CHUNKING_STRATEGY;
		merge: typeof MODERNBERT_CHUNK_MERGE_VERSION;
		projectedTokenCount: number;
		chunkCount: number;
		chunks: Array<{
			chunkIndex: number;
			coreFactIds: string[];
			overlapFactIds: string[];
			tokenCount: number;
			modelInputHash: string;
		}>;
	};
	classification: {
		activity: ActivityLabel;
		activityProbabilities: Record<ActivityLabel, number>;
		goalRelevance: GoalRelevanceLabel | null;
		goalRelevanceProbabilities: Record<GoalRelevanceLabel, number> | null;
		confidence: number;
		entropy: number;
		oodScore: number;
		abstain: boolean;
	};
};

/**
 * Strict trust boundary for a separately deployed ModernBERT artifact.
 *
 * Construction validates endpoint policy and the caller-pinned manifest.
 * verifyArtifact() must then match the endpoint's metadata before classify()
 * will send any EvidenceFact content.
 */
export class ModernBertEpisodeClassifier
	implements TimelineEpisodeClassifier
{
	private readonly endpoint: string;
	private readonly manifestEndpoint: string;
	private readonly expectedArtifact: ModernBertArtifactManifestV1;
	private readonly expectedManifestJson: string;
	private readonly timeoutMs: number;
	private readonly maximumResponseBytes: number;
	private readonly fetchImpl: ModernBertFetchLike;
	private readonly hasher: ReflectionHasher;
	private readonly headers: Readonly<Record<string, string>>;
	private verified = false;
	private verification: Promise<void> | null = null;

	constructor(options: ModernBertClassifierOptions) {
		validateManifest(options.expectedArtifact, "invalid_config");
		const endpoints = normalizeEndpoints(options);
		this.endpoint = endpoints.endpoint;
		this.manifestEndpoint = endpoints.manifestEndpoint;
		this.expectedArtifact = structuredClone(options.expectedArtifact);
		this.expectedManifestJson = canonicalJson(this.expectedArtifact);
		this.timeoutMs = boundedInteger(
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			1,
			MAX_TIMEOUT_MS,
			"timeoutMs",
		);
		this.maximumResponseBytes = boundedInteger(
			options.maximumResponseBytes ?? DEFAULT_RESPONSE_BYTES,
			1,
			MAX_RESPONSE_BYTES,
			"maximumResponseBytes",
		);
		this.fetchImpl = options.fetch ?? fetch;
		this.hasher = options.hasher ?? new WebCryptoReflectionHasher();
		this.headers = requestHeaders(options.authorizationToken);
	}

	get artifactVerified(): boolean {
		return this.verified;
	}

	get modelVersion(): string {
		return this.expectedArtifact.runtime.modelVersion;
	}

	async verifyArtifact(): Promise<void> {
		if (this.verified) return;
		await this.runVerification();
	}

	/**
	 * Re-fetches the pinned manifest without sending EvidenceFact content.
	 * Classification is demoted until the exact artifact is verified again.
	 */
	async refreshArtifact(): Promise<void> {
		this.verified = false;
		await this.runVerification();
	}

	private async runVerification(): Promise<void> {
		if (!this.verification) {
			this.verification = this.verifyArtifactOnce().finally(() => {
				this.verification = null;
			});
		}
		await this.verification;
	}

	async classify(
		facts: readonly EvidenceFactV2[],
		goal: ActiveGoalContextV1 | null,
		context?: TimelineEpisodeClassificationContext,
	): Promise<EpisodeClassificationV2> {
		if (!this.verified) {
			throw new ModernBertClassifierError(
				"artifact_not_verified",
				"ModernBERT artifact metadata has not been verified.",
			);
		}
		if (context === undefined) {
			throw new ModernBertClassifierError(
				"invalid_input",
				"ModernBERT requires authoritative sealed-window context.",
			);
		}
		const input = buildInput(
			facts,
			goal,
			context,
			this.expectedArtifact,
		);
		const inputJson = canonicalJson(input);
		const inputBytes = new TextEncoder().encode(inputJson).byteLength;
		if (inputBytes > this.expectedArtifact.maximumInputBytes) {
			throw new ModernBertClassifierError(
				"input_too_large",
				"ModernBERT episode input exceeds the pinned artifact byte budget.",
			);
		}
		const inputHash = await this.hasher.sha256(inputJson);
		if (!isSha256(inputHash)) {
			throw new ModernBertClassifierError(
				"invalid_config",
				"ModernBERT input hasher did not return SHA-256.",
			);
		}
		const correlationHash = await this.hasher.sha256(
			canonicalJson({
				artifactId: this.expectedArtifact.artifactId,
				inputHash,
				modelVersion: this.expectedArtifact.runtime.modelVersion,
				requestSchemaVersion: MODERNBERT_REQUEST_SCHEMA_VERSION,
			}),
		);
		if (!isSha256(correlationHash)) {
			throw new ModernBertClassifierError(
				"invalid_config",
				"ModernBERT correlation hasher did not return SHA-256.",
			);
		}
		const correlationId = `mbc1_${correlationHash}`;
		const request: ModernBertClassificationRequest = {
			schemaVersion: MODERNBERT_REQUEST_SCHEMA_VERSION,
			correlationId,
			inputHash,
			artifact: artifactIdentity(this.expectedArtifact),
			input,
		};
		try {
			const value = await this.fetchJson(this.endpoint, {
				method: "POST",
				headers: {
					...this.headers,
					"content-type": "application/json",
				},
				body: canonicalJson(request),
				redirect: "error",
			});
			const response = validateClassificationResponse(
				value,
				goal !== null,
			);
			if (
				response.correlationId !== correlationId ||
				response.inputHash !== inputHash
			) {
				throw new ModernBertClassifierError(
					"correlation_mismatch",
					"ModernBERT response correlation did not match the request.",
					true,
				);
			}
			if (
				canonicalJson(response.artifact) !==
				canonicalJson(artifactIdentity(this.expectedArtifact))
			) {
				throw new ModernBertClassifierError(
					"artifact_response_mismatch",
					"ModernBERT response did not identify the verified artifact.",
					true,
				);
			}
			await validateChunkAnalysis(
				response.analysis,
				input,
				this.expectedArtifact,
				this.hasher,
			);
			return {
				activity: response.classification.activity,
				goalRelevance: response.classification.goalRelevance,
				confidence: response.classification.confidence,
				entropy: response.classification.entropy,
				oodScore: response.classification.oodScore,
				abstain: response.classification.abstain,
				modelVersion: this.expectedArtifact.runtime.modelVersion,
			};
		} catch (error) {
			if (invalidatesVerifiedArtifact(error)) {
				this.verified = false;
			}
			throw error;
		}
	}

	private async verifyArtifactOnce(): Promise<void> {
		const value = await this.fetchJson(this.manifestEndpoint, {
			method: "GET",
			headers: this.headers,
			redirect: "error",
		});
		validateManifest(value, "artifact_manifest_mismatch");
		if (canonicalJson(value) !== this.expectedManifestJson) {
			throw new ModernBertClassifierError(
				"artifact_manifest_mismatch",
				"ModernBERT endpoint manifest does not match the pinned artifact.",
			);
		}
		this.verified = true;
	}

	private async fetchJson(
		url: string,
		init: RequestInit,
	): Promise<unknown> {
		const controller = new AbortController();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(
					new ModernBertClassifierError(
						"request_timeout",
						"ModernBERT request timed out.",
						true,
					),
				);
			}, this.timeoutMs);
		});
		try {
			return await Promise.race([
				(async () => {
					let response: Response;
					try {
						response = await this.fetchImpl(url, {
							...init,
							signal: controller.signal,
						});
					} catch {
						if (timedOut) {
							throw new ModernBertClassifierError(
								"request_timeout",
								"ModernBERT request timed out.",
								true,
							);
						}
						throw new ModernBertClassifierError(
							"transport_error",
							"ModernBERT request failed.",
							true,
						);
					}
					if (!response.ok) {
						if (response.status === 413) {
							throw new ModernBertClassifierError(
								"input_too_large",
								"ModernBERT exact-token preflight rejected an oversized event.",
								false,
								response.status,
							);
						}
						throw new ModernBertClassifierError(
							"http_error",
							"ModernBERT endpoint returned an unsuccessful status.",
							response.status >= 500 ||
								response.status === 429,
							response.status,
						);
					}
					try {
						return await readBoundedJson(
							response,
							this.maximumResponseBytes,
						);
					} catch (error) {
						if (error instanceof ModernBertClassifierError) {
							throw error;
						}
						if (timedOut) {
							throw new ModernBertClassifierError(
								"request_timeout",
								"ModernBERT request timed out.",
								true,
							);
						}
						throw new ModernBertClassifierError(
							"transport_error",
							"ModernBERT response body could not be read.",
							true,
						);
					}
				})(),
				timeout,
			]);
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}
}

function invalidatesVerifiedArtifact(error: unknown): boolean {
	if (!(error instanceof ModernBertClassifierError)) return true;
	return ![
		"artifact_not_verified",
		"invalid_config",
		"invalid_input",
		"input_too_large",
	].includes(error.code);
}

function normalizeEndpoints(options: ModernBertClassifierOptions): {
	endpoint: string;
	manifestEndpoint: string;
} {
	const allowedOrigins = new Set(
		(options.allowedRemoteOrigins ?? []).map((value) =>
			normalizeAllowedOrigin(value, options.allowInsecureRemote === true),
		),
	);
	const endpoint = normalizeEndpoint(
		options.endpoint,
		allowedOrigins,
		options.allowInsecureRemote === true,
	);
	const manifestEndpoint = normalizeEndpoint(
		options.manifestEndpoint,
		allowedOrigins,
		options.allowInsecureRemote === true,
	);
	if (new URL(endpoint).origin !== new URL(manifestEndpoint).origin) {
		throw new ModernBertClassifierError(
			"unsafe_endpoint",
			"ModernBERT inference and manifest endpoints must share one origin.",
		);
	}
	return { endpoint, manifestEndpoint };
}

function normalizeEndpoint(
	value: string,
	allowedOrigins: ReadonlySet<string>,
	allowInsecureRemote: boolean,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ModernBertClassifierError(
			"unsafe_endpoint",
			"ModernBERT endpoint is invalid.",
		);
	}
	if (
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		(url.protocol !== "http:" && url.protocol !== "https:")
	) {
		throw new ModernBertClassifierError(
			"unsafe_endpoint",
			"ModernBERT endpoint contains disallowed URL components.",
		);
	}
	if (isLoopbackHostname(url.hostname)) {
		return url.toString();
	}
	if (!allowedOrigins.has(url.origin)) {
		throw new ModernBertClassifierError(
			"unsafe_endpoint",
			"Remote ModernBERT endpoint origin is not explicitly allowlisted.",
		);
	}
	if (url.protocol !== "https:" && !allowInsecureRemote) {
		throw new ModernBertClassifierError(
			"unsafe_endpoint",
			"Remote ModernBERT endpoint must use HTTPS.",
		);
	}
	return url.toString();
}

function normalizeAllowedOrigin(
	value: string,
	allowInsecureRemote: boolean,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ModernBertClassifierError(
			"invalid_config",
			"ModernBERT remote allowlist contains an invalid origin.",
		);
	}
	if (
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		(url.pathname !== "/" && url.pathname !== "") ||
		(url.protocol !== "https:" &&
			!(allowInsecureRemote && url.protocol === "http:"))
	) {
		throw new ModernBertClassifierError(
			"invalid_config",
			"ModernBERT remote allowlist must contain exact permitted origins.",
		);
	}
	return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "127.0.0.1" ||
		hostname === "localhost" ||
		hostname === "[::1]" ||
		hostname === "::1"
	);
}

function requestHeaders(
	authorizationToken: string | undefined,
): Readonly<Record<string, string>> {
	const headers: Record<string, string> = {
		accept: "application/json",
	};
	if (authorizationToken !== undefined) {
		if (
			authorizationToken.length < 1 ||
			authorizationToken.length > 4_096 ||
			/[\u0000-\u001f\u007f]/u.test(authorizationToken)
		) {
			throw new ModernBertClassifierError(
				"invalid_config",
				"ModernBERT authorization token is invalid.",
			);
		}
		headers.authorization = `Bearer ${authorizationToken}`;
	}
	return headers;
}

function buildInput(
	facts: readonly EvidenceFactV2[],
	goal: ActiveGoalContextV1 | null,
	context: TimelineEpisodeClassificationContext,
	manifest: ModernBertArtifactManifestV1,
): ModernBertEpisodeInput {
	if (
		facts.length < 1 ||
		facts.length > manifest.maximumFacts ||
		facts.length > MAX_FACTS
	) {
		throw new ModernBertClassifierError(
			"invalid_input",
			"ModernBERT episode fact count is outside the pinned bounds.",
		);
	}
	if (
		context.contextOnlyFacts.length > MAX_CONTEXT_ONLY_FACTS ||
		!isBoundedIdentifier(context.windowId, 256) ||
		!isTriggerReason(context.triggerReason) ||
		!isNonNegativeInteger(context.startedAtMs) ||
		!isNonNegativeInteger(context.endedAtMs) ||
		context.endedAtMs < context.startedAtMs ||
		!isNonNegativeInteger(context.eventCount) ||
		context.eventCount < 1
	) {
		throw new ModernBertClassifierError(
			"invalid_input",
			"ModernBERT sealed-window context is invalid.",
		);
	}
	const seenFactIds = new Set<string>();
	const contextOnlyCandidates = context.contextOnlyFacts
		.map((fact) => inputFact(fact, "context", seenFactIds))
		.sort(
			(left, right) =>
				left.startedAtMs - right.startedAtMs ||
				left.factId.localeCompare(right.factId),
		);
	const inputFacts = facts.map((fact) =>
		inputFact(
			fact,
			fact.role === "boundary" ? "boundary" : "effective",
			seenFactIds,
		),
	);
	const contextOnlyFacts = selectContextOnlyFacts(
		contextOnlyCandidates,
	);
	if (
		inputFacts.length + contextOnlyFacts.length >
		manifest.maximumFacts
	) {
		throw new ModernBertClassifierError(
			"invalid_input",
			"ModernBERT total fact count is outside the pinned bounds.",
		);
	}
	assertDeterministicFactOrder(contextOnlyFacts);
	assertDeterministicFactOrder(inputFacts);
	if (goal !== null) validateGoal(goal);
	return {
		schemaVersion: MODERNBERT_INPUT_SCHEMA_VERSION,
		window: {
			windowId: context.windowId,
			triggerReason: context.triggerReason,
			startedAtMs: context.startedAtMs,
			endedAtMs: context.endedAtMs,
		},
		facts: inputFacts,
		contextOnlyFacts,
		goal: goal
			? {
					goalId: goal.goalId,
					version: goal.version,
					text: goal.text,
				}
			: null,
		chunking: {
			strategy: MODERNBERT_CHUNKING_STRATEGY,
			maximumTokens: manifest.runtime.maximumTokens,
			overlapFacts: MODERNBERT_CHUNK_OVERLAP_FACTS,
			overlapMs: MODERNBERT_CHUNK_OVERLAP_MS,
			merge: MODERNBERT_CHUNK_MERGE_VERSION,
		},
	};
}

function selectContextOnlyFacts(
	candidates: readonly ModernBertInputFact[],
): ModernBertInputFact[] {
	let remainingTokens = MODERNBERT_CONTEXT_ONLY_MAXIMUM_TOKENS;
	const selected: ModernBertInputFact[] = [];
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (!candidate) continue;
		const estimatedTokens = estimateModernBertContextTokens(
			candidate.renderedText,
		);
		if (estimatedTokens > remainingTokens) continue;
		selected.push(candidate);
		remainingTokens -= estimatedTokens;
	}
	return selected.reverse();
}

export function estimateModernBertContextTokens(text: string): number {
	const characterEstimate = Math.ceil(Array.from(text).length / 4);
	const byteEstimate = Math.ceil(
		new TextEncoder().encode(text).byteLength / 3,
	);
	return Math.max(characterEstimate, byteEstimate);
}

function inputFact(
	fact: EvidenceFactV2,
	countClass: ModernBertInputFact["countClass"],
	seenFactIds: Set<string>,
): ModernBertInputFact {
	validateFact(fact, seenFactIds);
	return {
		factId: fact.factId,
		startedAtMs: fact.startedAtMs,
		endedAtMs: fact.endedAtMs,
		templateCode: fact.templateCode,
		templateArgs: structuredClone(fact.templateArgs),
		renderedText: fact.renderedText,
		role: fact.role,
		reliability: fact.reliability,
		coverage: [...fact.coverage],
		anchor: structuredClone(fact.anchor),
		countClass,
	};
}

function assertDeterministicFactOrder(
	facts: readonly ModernBertInputFact[],
): void {
	for (let index = 1; index < facts.length; index += 1) {
		const previous = facts[index - 1];
		const current = facts[index];
		if (
			!previous ||
			!current ||
			current.startedAtMs < previous.startedAtMs ||
			(current.startedAtMs === previous.startedAtMs &&
				current.factId.localeCompare(previous.factId) < 0)
		) {
			throw new ModernBertClassifierError(
				"invalid_input",
				"ModernBERT EvidenceFacts are not in deterministic time order.",
			);
		}
	}
}

function validateFact(
	fact: EvidenceFactV2,
	seenFactIds: Set<string>,
): void {
	if (
		!isRecord(fact) ||
		!hasExactKeys(fact, [
			"schemaVersion",
			"factId",
			"eventIds",
			"sourceObservationIds",
			"startedAtMs",
			"endedAtMs",
			"templateCode",
			"templateArgs",
			"renderedText",
			"anchor",
			"role",
			"reliability",
			"coverage",
		]) ||
		fact.schemaVersion !== "evidence-fact.v2" ||
		!isBoundedIdentifier(fact.factId, 160) ||
		seenFactIds.has(fact.factId) ||
		!isBoundedStringArray(fact.eventIds, 1, 64, 160) ||
		!isBoundedStringArray(
			fact.sourceObservationIds,
			1,
			64,
			160,
		) ||
		!isNonNegativeInteger(fact.startedAtMs) ||
		!isNonNegativeInteger(fact.endedAtMs) ||
		fact.endedAtMs < fact.startedAtMs ||
		typeof fact.renderedText !== "string" ||
		Array.from(fact.renderedText).length < 1 ||
		Array.from(fact.renderedText).length > MAX_FACT_TEXT_CHARACTERS ||
		fact.renderedText.includes("\u0000") ||
		!isFactTemplateCode(fact.templateCode) ||
		!isTemplateArgs(fact.templateArgs) ||
		!["primary", "supporting", "boundary"].includes(fact.role) ||
		!["high", "medium", "low"].includes(fact.reliability) ||
		!isCoverage(fact.coverage) ||
		!isAnchor(fact.anchor)
	) {
		throw new ModernBertClassifierError(
			"invalid_input",
			"ModernBERT received an invalid EvidenceFact.",
		);
	}
	seenFactIds.add(fact.factId);
}

function validateGoal(goal: ActiveGoalContextV1): void {
	if (
		!isRecord(goal) ||
		!hasExactKeys(goal, [
			"goalId",
			"planId",
			"version",
			"text",
			"activatedAtMs",
		]) ||
		!isBoundedIdentifier(goal.goalId, 160) ||
		(goal.planId !== null && !isBoundedIdentifier(goal.planId, 160)) ||
		!isPositiveInteger(goal.version) ||
		typeof goal.text !== "string" ||
		Array.from(goal.text).length < 1 ||
		Array.from(goal.text).length > MAX_GOAL_TEXT_CHARACTERS ||
		goal.text.includes("\u0000") ||
		!isNonNegativeInteger(goal.activatedAtMs)
	) {
		throw new ModernBertClassifierError(
			"invalid_input",
			"ModernBERT received an invalid active goal.",
		);
	}
}

const TEMPLATE_EVENT_KIND: Readonly<Record<FactTemplateCode, string>> = {
	"application.foreground": "application.foregroundChanged",
	"application.visible_content": "application.visibleContentChanged",
	"application.text_value": "application.textValueChanged",
	"browser.visible_page": "browser.visiblePageChanged",
	"ui.focus": "ui.focusChanged",
	"ui.control_activated": "ui.controlActivated",
	"input.activity": "input.activityBucket",
	"presence.changed": "presence.changed",
	"goal.changed": "goal.changed",
	"coverage.unavailable": "coverage.unavailable",
};

/**
 * Exact TypeScript mirror of the training serializer's
 * timeline-event-sequence.v2 projection. Tokenization remains authoritative
 * on the verified artifact server because its tokenizer digest is pinned.
 */
export function projectModernBertModelInput(
	input: ModernBertEpisodeInput,
	selectedFacts: readonly ModernBertInputFact[] = input.facts,
): string {
	const events = [...input.contextOnlyFacts, ...selectedFacts];
	if (events.length < 1) {
		throw new ModernBertClassifierError(
			"invalid_input",
			"ModernBERT model projection requires at least one fact.",
		);
	}
	const lines = [
		`[CONTRACT] ${MODERNBERT_MODEL_INPUT_FORMAT}`,
		`[TIMELINE] ${canonicalJson({
			timelineId: input.window.windowId,
			triggerReason: input.window.triggerReason,
			range: [
				input.window.startedAtMs,
				input.window.endedAtMs,
			],
		})}`,
		`[GOAL] ${canonicalJson(input.goal)}`,
		"[EVENTS]",
	];
	for (const fact of events) {
		const appId = fact.anchor.appId ?? "unknown";
		const appNameValue = fact.templateArgs.appName;
		const appName =
			typeof appNameValue === "string" && appNameValue.length > 0
				? appNameValue
				: appId;
		const anchor =
			fact.anchor.pageId ??
			fact.anchor.documentId ??
			fact.anchor.windowId ??
			fact.anchor.appId;
		lines.push(
			`[EVT] ${canonicalJson({
				eventId: fact.factId,
				kind:
					TEMPLATE_EVENT_KIND[
						fact.templateCode as FactTemplateCode
					] ?? "evidence.fact",
				interval: [fact.startedAtMs, fact.endedAtMs],
				app: {
					id: appId,
					name: appName,
				},
				anchor,
				fact: {
					code: fact.templateCode,
					text: fact.renderedText,
				},
				reliability: fact.reliability,
				coverage: fact.coverage,
				countClass: fact.countClass,
			})}`,
		);
	}
	return lines.join("\n");
}

async function validateChunkAnalysis(
	analysis: ModernBertClassificationResponse["analysis"],
	input: ModernBertEpisodeInput,
	manifest: ModernBertArtifactManifestV1,
	hasher: ReflectionHasher,
): Promise<void> {
	const factsById = new Map(
		input.facts.map((fact) => [fact.factId, fact] as const),
	);
	let nextCoreIndex = 0;
	for (const chunk of analysis.chunks) {
		if (chunk.tokenCount > manifest.runtime.maximumTokens) {
			throw chunkSchemaMismatch(
				"ModernBERT chunk exceeds the pinned exact-token limit.",
			);
		}
		const expectedCore = input.facts.slice(
			nextCoreIndex,
			nextCoreIndex + chunk.coreFactIds.length,
		);
		if (
			expectedCore.length !== chunk.coreFactIds.length ||
			!exactStringArray(
				chunk.coreFactIds,
				expectedCore.map((fact) => fact.factId),
			)
		) {
			throw chunkSchemaMismatch(
				"ModernBERT chunk core coverage is incomplete or reordered.",
			);
		}
		const expectedOverlap = expectedChunkOverlap(
			input.facts,
			nextCoreIndex,
		);
		const eligibleOverlapIds = expectedOverlap.map(
			(fact) => fact.factId,
		);
		const expectedSuffix = eligibleOverlapIds.slice(
			eligibleOverlapIds.length -
				chunk.overlapFactIds.length,
		);
		if (!exactStringArray(chunk.overlapFactIds, expectedSuffix)) {
			throw chunkSchemaMismatch(
				"ModernBERT chunk overlap does not match the pinned policy.",
			);
		}
		const selectedOverlap = chunk.overlapFactIds.map(
			(factId) => factsById.get(factId)!,
		);
		const selected = [...selectedOverlap, ...expectedCore];
		const modelInputHash = await hasher.sha256(
			projectModernBertModelInput(input, selected),
		);
		if (
			!isSha256(modelInputHash) ||
			modelInputHash !== chunk.modelInputHash
		) {
			throw chunkSchemaMismatch(
				"ModernBERT chunk projector hash does not match the application projection.",
			);
		}
		nextCoreIndex += expectedCore.length;
	}
	if (nextCoreIndex !== input.facts.length) {
		throw chunkSchemaMismatch(
			"ModernBERT chunk plan did not cover every core fact exactly once.",
		);
	}
	if (
		analysis.projectedTokenCount <=
			manifest.runtime.maximumTokens &&
		analysis.chunkCount !== 1
	) {
		throw chunkSchemaMismatch(
			"ModernBERT split an input that fits the pinned token budget.",
		);
	}
	if (
		analysis.chunkCount === 1 &&
		analysis.chunks[0]?.tokenCount !==
			analysis.projectedTokenCount
	) {
		throw chunkSchemaMismatch(
			"ModernBERT unchunked token counts are inconsistent.",
		);
	}
	for (const contextFact of input.contextOnlyFacts) {
		if (factsById.has(contextFact.factId)) {
			throw chunkSchemaMismatch(
				"ModernBERT context-only fact was counted as core evidence.",
			);
		}
	}
}

function expectedChunkOverlap(
	facts: readonly ModernBertInputFact[],
	coreStartIndex: number,
): ModernBertInputFact[] {
	if (coreStartIndex === 0) return [];
	const firstCore = facts[coreStartIndex];
	if (!firstCore) return [];
	const earliestByCount = Math.max(
		0,
		coreStartIndex - MODERNBERT_CHUNK_OVERLAP_FACTS,
	);
	const cutoff = firstCore.startedAtMs - MODERNBERT_CHUNK_OVERLAP_MS;
	let earliestByTime = coreStartIndex;
	while (
		earliestByTime > 0 &&
		(facts[earliestByTime - 1]?.endedAtMs ?? -1) >= cutoff
	) {
		earliestByTime -= 1;
	}
	const earliest = Math.max(earliestByCount, earliestByTime);
	return facts.slice(earliest, coreStartIndex);
}

function chunkSchemaMismatch(message: string): ModernBertClassifierError {
	return new ModernBertClassifierError(
		"schema_mismatch",
		message,
		true,
	);
}

function validateManifest(
	value: unknown,
	code: "invalid_config" | "artifact_manifest_mismatch",
): asserts value is ModernBertArtifactManifestV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"artifactId",
			"artifactSha256",
			"runtime",
			"requestSchemaVersion",
			"inputSchemaVersion",
			"responseSchemaVersion",
			"maximumFacts",
			"maximumInputBytes",
		]) ||
		value.schemaVersion !== MODERNBERT_MANIFEST_SCHEMA_VERSION ||
		!isBoundedIdentifier(value.artifactId, 256) ||
		!isSha256(value.artifactSha256) ||
		value.artifactId !==
			modernBertArtifactId(value.artifactSha256) ||
		!isEpisodeRuntime(value.runtime) ||
		value.requestSchemaVersion !== MODERNBERT_REQUEST_SCHEMA_VERSION ||
		value.inputSchemaVersion !== MODERNBERT_INPUT_SCHEMA_VERSION ||
		value.responseSchemaVersion !== MODERNBERT_RESPONSE_SCHEMA_VERSION ||
		!isNonNegativeInteger(value.maximumFacts) ||
		value.maximumFacts < 1 ||
		value.maximumFacts > MAX_FACTS ||
		!isNonNegativeInteger(value.maximumInputBytes) ||
		value.maximumInputBytes < 1 ||
		value.maximumInputBytes > MAX_INPUT_BYTES
	) {
		throw new ModernBertClassifierError(
			code,
			code === "invalid_config"
				? "Pinned ModernBERT artifact manifest is incompatible."
				: "ModernBERT endpoint returned an incompatible artifact manifest.",
		);
	}
}

function validateClassificationResponse(
	value: unknown,
	goalPresent: boolean,
): ModernBertClassificationResponse {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"correlationId",
			"inputHash",
			"artifact",
			"analysis",
			"classification",
		]) ||
		value.schemaVersion !== MODERNBERT_RESPONSE_SCHEMA_VERSION ||
		!isCorrelationId(value.correlationId) ||
		!isSha256(value.inputHash) ||
		!isArtifactIdentity(value.artifact) ||
		!isChunkAnalysis(value.analysis) ||
		!isRecord(value.classification) ||
		!hasExactKeys(value.classification, [
			"activity",
			"activityProbabilities",
			"goalRelevance",
			"goalRelevanceProbabilities",
			"confidence",
			"entropy",
			"oodScore",
			"abstain",
		]) ||
		!isActivityLabel(value.classification.activity) ||
		!isProbabilityRecord(
			value.classification.activityProbabilities,
			MODERNBERT_ACTIVITY_LABELS,
		) ||
		!labelHasMaximumProbability(
			value.classification.activity,
			value.classification.activityProbabilities,
		) ||
		!isUnitInterval(value.classification.confidence) ||
		!isUnitInterval(value.classification.entropy) ||
		!isUnitInterval(value.classification.oodScore) ||
		typeof value.classification.abstain !== "boolean"
	) {
		throw new ModernBertClassifierError(
			"schema_mismatch",
			"ModernBERT response does not match the strict classification schema.",
			true,
		);
	}
	if (goalPresent) {
		if (
			!isGoalRelevanceLabel(value.classification.goalRelevance) ||
			!isProbabilityRecord(
				value.classification.goalRelevanceProbabilities,
				MODERNBERT_GOAL_RELEVANCE_LABELS,
			) ||
			!labelHasMaximumProbability(
				value.classification.goalRelevance,
				value.classification.goalRelevanceProbabilities,
			)
		) {
			throw new ModernBertClassifierError(
				"schema_mismatch",
				"ModernBERT goal relevance output is invalid.",
				true,
			);
		}
	} else if (
		value.classification.goalRelevance !== null ||
		value.classification.goalRelevanceProbabilities !== null
	) {
		throw new ModernBertClassifierError(
			"schema_mismatch",
			"ModernBERT must return null goal relevance when no goal exists.",
			true,
		);
	}
	return value as ModernBertClassificationResponse;
}

function isChunkAnalysis(
	value: unknown,
): value is ModernBertClassificationResponse["analysis"] {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"projectorVersion",
			"strategy",
			"merge",
			"projectedTokenCount",
			"chunkCount",
			"chunks",
		]) ||
		value.projectorVersion !== MODERNBERT_EVIDENCE_PROJECTOR_VERSION ||
		value.strategy !== MODERNBERT_CHUNKING_STRATEGY ||
		value.merge !== MODERNBERT_CHUNK_MERGE_VERSION ||
		!isPositiveInteger(value.projectedTokenCount) ||
		!isPositiveInteger(value.chunkCount) ||
		!Array.isArray(value.chunks) ||
		value.chunks.length !== value.chunkCount
	) {
		return false;
	}
	return value.chunks.every(
		(chunk, index) =>
			isRecord(chunk) &&
			hasExactKeys(chunk, [
				"chunkIndex",
				"coreFactIds",
				"overlapFactIds",
				"tokenCount",
				"modelInputHash",
			]) &&
			chunk.chunkIndex === index &&
			isBoundedStringArray(
				chunk.coreFactIds,
				1,
				MAX_FACTS,
				160,
			) &&
			isBoundedStringArray(
				chunk.overlapFactIds,
				0,
				MODERNBERT_CHUNK_OVERLAP_FACTS,
				160,
			) &&
			isPositiveInteger(chunk.tokenCount) &&
			isSha256(chunk.modelInputHash),
	);
}

function isEpisodeRuntime(
	value: unknown,
): value is ModernBertEpisodeRuntimeV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"modelVersion",
			"modelFamily",
			"maximumTokens",
			"tokenizerSha256",
			"inputFormat",
			"projectorVersion",
			"architecture",
			"taxonomy",
			"oodScoring",
			"calibrationVersion",
		]) ||
		value.schemaVersion !== MODERNBERT_RUNTIME_SCHEMA_VERSION ||
		!isBoundedIdentifier(value.modelVersion, 256) ||
		value.modelFamily !== "ModernBERT" ||
		!isPositiveInteger(value.maximumTokens) ||
		value.maximumTokens > MODERNBERT_MAXIMUM_TOKENS ||
		!isSha256(value.tokenizerSha256) ||
		value.inputFormat !== MODERNBERT_MODEL_INPUT_FORMAT ||
		value.projectorVersion !== MODERNBERT_EVIDENCE_PROJECTOR_VERSION ||
		value.oodScoring !==
			"calibrated-energy-plus-cluster-distance.v1" ||
		!isReadyCalibrationVersion(value.calibrationVersion) ||
		!isRecord(value.architecture) ||
		!hasExactKeys(value.architecture, [
			"activityClasses",
			"relevanceClasses",
			"embeddingDimensions",
			"heads",
		]) ||
		value.architecture.activityClasses !==
			MODERNBERT_ACTIVITY_LABELS.length ||
		value.architecture.relevanceClasses !==
			MODERNBERT_GOAL_RELEVANCE_LABELS.length ||
		value.architecture.embeddingDimensions !==
			MODERNBERT_EMBEDDING_DIMENSIONS ||
		!exactStringArray(
			value.architecture.heads,
			MODERNBERT_EPISODE_HEADS,
		) ||
		!isRecord(value.taxonomy) ||
		!hasExactKeys(value.taxonomy, [
			"version",
			"activities",
			"goalRelevance",
		]) ||
		value.taxonomy.version !== TIMELINE_TAXONOMY_VERSION ||
		!exactStringArray(
			value.taxonomy.activities,
			MODERNBERT_ACTIVITY_LABELS,
		) ||
		!exactStringArray(
			value.taxonomy.goalRelevance,
			MODERNBERT_GOAL_RELEVANCE_LABELS,
		)
	) {
		return false;
	}
	return true;
}

function artifactIdentity(
	manifest: ModernBertArtifactManifestV1,
): ModernBertArtifactIdentity {
	return {
		artifactId: manifest.artifactId,
		artifactSha256: manifest.artifactSha256,
		tokenizerSha256: manifest.runtime.tokenizerSha256,
		modelVersion: manifest.runtime.modelVersion,
		taxonomyVersion: manifest.runtime.taxonomy.version,
		runtimeSchemaVersion: manifest.runtime.schemaVersion,
		inputFormat: manifest.runtime.inputFormat,
		projectorVersion: manifest.runtime.projectorVersion,
		calibrationVersion: manifest.runtime.calibrationVersion,
	};
}

function isArtifactIdentity(
	value: unknown,
): value is ModernBertArtifactIdentity {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"artifactId",
			"artifactSha256",
			"tokenizerSha256",
			"modelVersion",
			"taxonomyVersion",
			"runtimeSchemaVersion",
			"inputFormat",
			"projectorVersion",
			"calibrationVersion",
		]) &&
		isBoundedIdentifier(value.artifactId, 256) &&
		isSha256(value.artifactSha256) &&
		value.artifactId ===
			modernBertArtifactId(value.artifactSha256) &&
		isSha256(value.tokenizerSha256) &&
		isBoundedIdentifier(value.modelVersion, 256) &&
		value.taxonomyVersion === TIMELINE_TAXONOMY_VERSION &&
		value.runtimeSchemaVersion === MODERNBERT_RUNTIME_SCHEMA_VERSION &&
		value.inputFormat === MODERNBERT_MODEL_INPUT_FORMAT &&
		value.projectorVersion === MODERNBERT_EVIDENCE_PROJECTOR_VERSION &&
		isReadyCalibrationVersion(value.calibrationVersion)
	);
}

function modernBertArtifactId(artifactSha256: string): string {
	return `modernbert_episode_${artifactSha256}`;
}

async function readBoundedJson(
	response: Response,
	maximumBytes: number,
): Promise<unknown> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (
			!Number.isSafeInteger(parsedLength) ||
			parsedLength < 0 ||
			parsedLength > maximumBytes
		) {
			throw new ModernBertClassifierError(
				"response_too_large",
				"ModernBERT response exceeds the configured byte limit.",
				true,
			);
		}
	}
	if (!response.body) {
		throw new ModernBertClassifierError(
			"invalid_json",
			"ModernBERT response body is empty.",
			true,
		);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximumBytes) {
			try {
				await reader.cancel();
			} catch {
				// Cancellation is best effort after the trust-boundary decision.
			}
			throw new ModernBertClassifierError(
				"response_too_large",
				"ModernBERT response exceeds the configured byte limit.",
				true,
			);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ModernBertClassifierError(
			"invalid_json",
			"ModernBERT response is not valid UTF-8 JSON.",
			true,
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ModernBertClassifierError(
			"invalid_json",
			"ModernBERT response is not valid JSON.",
			true,
		);
	}
}

function isProbabilityRecord(
	value: unknown,
	labels: readonly string[],
): value is Record<string, number> {
	if (!isRecord(value) || !hasExactKeys(value, labels)) return false;
	let sum = 0;
	for (const label of labels) {
		const probability = value[label];
		if (!isUnitInterval(probability)) return false;
		sum += probability;
	}
	return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE;
}

function labelHasMaximumProbability(
	label: string,
	probabilities: Record<string, number>,
): boolean {
	const selected = probabilities[label];
	return (
		selected !== undefined &&
		Object.values(probabilities).every(
			(probability) => selected + PROBABILITY_SUM_TOLERANCE >= probability,
		)
	);
}

function isTemplateArgs(value: unknown): value is Record<string, JsonPrimitive> {
	if (!isRecord(value)) return false;
	const entries = Object.entries(value);
	return (
		entries.length <= 64 &&
		entries.every(([key, child]) => {
			if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key)) return false;
			if (typeof child === "string") {
				return child.length <= 16_384 && !child.includes("\u0000");
			}
			return (
				child === null ||
				typeof child === "boolean" ||
				(typeof child === "number" && Number.isFinite(child))
			);
		})
	);
}

function isCoverage(value: unknown): value is EvidenceFactV2["coverage"] {
	const allowed = new Set([
		"content",
		"metadata",
		"redacted",
		"denied",
		"unavailable",
	]);
	return (
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= allowed.size &&
		value.every((entry) => allowed.has(entry)) &&
		new Set(value).size === value.length
	);
}

function isAnchor(value: unknown): value is EvidenceFactV2["anchor"] {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"appId",
			"windowId",
			"documentId",
			"pageId",
		])
	) {
		return false;
	}
	return (
		["appId", "windowId", "documentId", "pageId"] as const
	).every((key) => {
		const child = value[key];
		return child === null || isBoundedIdentifier(child, 512);
	});
}

function isActivityLabel(value: unknown): value is ActivityLabel {
	return (
		typeof value === "string" &&
		(MODERNBERT_ACTIVITY_LABELS as readonly string[]).includes(value)
	);
}

function isGoalRelevanceLabel(
	value: unknown,
): value is GoalRelevanceLabel {
	return (
		typeof value === "string" &&
		(MODERNBERT_GOAL_RELEVANCE_LABELS as readonly string[]).includes(value)
	);
}

function isTriggerReason(
	value: unknown,
): value is TimelineEpisodeClassificationContext["triggerReason"] {
	return (
		value === "event_count" ||
		value === "max_wait" ||
		value === "goal_boundary" ||
		value === "presence_boundary"
	);
}

function isFactTemplateCode(value: unknown): value is FactTemplateCode {
	return (
		typeof value === "string" &&
		(MODERNBERT_FACT_TEMPLATE_CODES as readonly string[]).includes(value)
	);
}

function isUnitInterval(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function isCorrelationId(value: unknown): value is string {
	return typeof value === "string" && /^mbc1_[0-9a-f]{64}$/u.test(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isReadyCalibrationVersion(value: unknown): value is string {
	return (
		isBoundedIdentifier(value, 256) &&
		!UNREADY_CALIBRATION_VERSIONS.has(value.toLowerCase())
	);
}

function isBoundedIdentifier(
	value: unknown,
	maximum: number,
): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		value === value.trim() &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function isBoundedStringArray(
	value: unknown,
	minimumItems: number,
	maximumItems: number,
	maximumCharacters: number,
): value is string[] {
	return (
		Array.isArray(value) &&
		value.length >= minimumItems &&
		value.length <= maximumItems &&
		value.every((entry) =>
			isBoundedIdentifier(entry, maximumCharacters),
		) &&
		new Set(value).size === value.length
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
	);
}

function isPositiveInteger(value: unknown): value is number {
	return isNonNegativeInteger(value) && value >= 1;
}

function exactStringArray(
	value: unknown,
	expected: readonly string[],
): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

function boundedInteger(
	value: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		throw new ModernBertClassifierError(
			"invalid_config",
			`ModernBERT ${name} is outside the supported bounds.`,
		);
	}
	return value;
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
