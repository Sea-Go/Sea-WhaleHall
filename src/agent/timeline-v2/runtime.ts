import { join } from "node:path";
import type { AgentRuntime } from "../agent-runtime";
import {
	OllamaClientError,
	OllamaJsonClient,
	type FetchLike,
} from "../model/ollama-json-client";
import {
	WHALEHALL_TEACHER_MODEL_LOCK,
	verifyOllamaModelLock,
	type OllamaModelLock,
} from "../model/ollama-model-lock";
import { loadOrCreateReflectionIdentity } from "../reflection/identity";
import type { ActiveGoalContextV1 } from "../reflection/types";
import {
	TimelineFiveMinuteAuditExporter,
	type RawFiveMinuteAuditSource,
} from "./audit";
import { TimelineAgentInputAdapterV1 } from "./agent-input-adapter";
import {
	HeuristicTimelineEpisodeClassifier,
	type TimelineEpisodeClassificationContext,
	type TimelineEpisodeClassifier,
} from "./episodes";
import {
	DeterministicTimelineHypothesisGenerator,
	QwenCitedHypothesisGenerator,
	probeQwenHypothesisReadiness,
	type TimelineHypothesisGenerator,
} from "./hypothesis";
import {
	ModernBertClassifierError,
	ModernBertEpisodeClassifier,
	type ModernBertClassifierErrorCode,
	type ModernBertRuntimeOptIn,
} from "./modernbert-classifier";
import { RuntimeTimelineVault } from "./runtime-vault";
import { TimelineV2Service } from "./service";
import { SqliteTimelineV2Repository } from "./sqlite-repository";
import { PrivateTrainingWindowExporter } from "./training-window-export";
import type {
	EpisodeClassificationV2,
	EvidenceFactV2,
	TimelineInferenceDiagnosticV2,
} from "./types";

const MODERNBERT_VERIFICATION_RETRY_DELAYS_MS = [
	5_000,
	15_000,
	45_000,
	120_000,
	300_000,
] as const;
const MODERNBERT_MAX_VERIFICATION_RETRIES = 5;
const MODERNBERT_MAX_VERIFICATION_RETRY_MS = 300_000;

export type TimelineEpisodeClassifierRuntimeStatus = {
	configured: boolean;
	artifactVerified: boolean;
	activeClassifier: "deterministic-cold-start" | "modernbert";
	modelVersion: string;
	code:
		| "disabled"
		| `modernbert.${ModernBertClassifierErrorCode}`
		| "modernbert.unexpected_failure"
		| null;
};

export type TimelineV2Runtime = {
	service: TimelineV2Service;
	repository: SqliteTimelineV2Repository;
	audit: TimelineFiveMinuteAuditExporter | null;
	/**
	 * Explicit local-only full-window export boundary. It never runs
	 * automatically and accepts only persisted COMMITTED window identifiers.
	 */
	privateTrainingExport: PrivateTrainingWindowExporter | null;
	/** Local-only durable outbox boundary; no renderer or network transport. */
	agentInput: TimelineAgentInputAdapterV1;
	episodeClassifier: TimelineEpisodeClassifierRuntimeStatus;
	modelLockVerified: boolean;
	/** Readiness of the Qwen cited-hypothesis generator, not classification. */
	inferenceReady: boolean;
	diagnostics: readonly TimelineInferenceDiagnosticV2[];
	/**
	 * @deprecated Compatibility alias for modelLockVerified. It does not mean
	 * that the production structured-output probe succeeded.
	 */
	teacherVerified: boolean;
	/**
	 * Metadata-only re-verification. It demotes classification before the
	 * request and promotes only after the exact pinned manifest matches.
	 */
	refreshEpisodeClassifier(): Promise<TimelineEpisodeClassifierRuntimeStatus>;
	start(): Promise<void>;
	beginShutdown(): void;
	close(): Promise<void>;
};

export class SwitchableTimelineEpisodeClassifier
	implements TimelineEpisodeClassifier
{
	private readonly fallback = new HeuristicTimelineEpisodeClassifier();
	private active: TimelineEpisodeClassifier = this.fallback;
	private modernBert: ModernBertEpisodeClassifier | null = null;

	constructor(
		private readonly onModernBertInvalidated: (
			error: unknown,
		) => void = () => {},
	) {}

	useModernBert(classifier: ModernBertEpisodeClassifier): void {
		this.modernBert = classifier;
		this.active = classifier;
	}

	useFallback(): void {
		this.active = this.fallback;
	}

	async classify(
		facts: readonly EvidenceFactV2[],
		goal: ActiveGoalContextV1 | null,
		context?: TimelineEpisodeClassificationContext,
		signal?: AbortSignal,
	): Promise<EpisodeClassificationV2> {
		const active = this.active;
		try {
			return await active.classify(facts, goal, context, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			if (
				active === this.modernBert &&
				this.active === active &&
				!this.modernBert.artifactVerified
			) {
				this.useFallback();
				this.onModernBertInvalidated(error);
				return this.fallback.classify(facts, goal, context, signal);
			}
			throw error;
		}
	}
}

export type CreateTimelineV2RuntimeOptions = {
	agent: AgentRuntime;
	dataDirectory: string;
	rawAuditSource?: RawFiveMinuteAuditSource;
	/**
	 * Current goal returned by the already-started reflection runtime. Passing
	 * it prevents semantic backlog events carrying that goal version from
	 * being rejected while a fresh Timeline v2 collector is initialized.
	 */
	initialGoal?: ActiveGoalContextV1 | null;
	onError?: (error: unknown) => void;
	verifyTeacher?: boolean;
	/**
	 * User-configured local Teacher address. It is still constrained by the
	 * reviewed Qwen lock and the Ollama loopback-only verifier.
	 */
	teacherBaseUrl?: string;
	/** Shared only by the metadata lock check and local inference client. */
	teacherFetch?: FetchLike;
	/**
	 * Disabled unless explicitly enabled with a caller-pinned v2 deployment
	 * manifest. Verification fetches metadata only; no fact content is sent
	 * unless the manifest matches exactly.
	 */
	modernBert?: ModernBertRuntimeOptIn;
};

/**
 * Runnable composition entry point. Creating it performs no collection,
 * upload, or user-content model request. When teacher verification is enabled,
 * it checks loopback metadata and sends one synthetic production-schema probe.
 * Call start only after the v1 startup-goal gate has started/reconciled
 * whalehall-local.
 */
export async function createTimelineV2Runtime(
	options: CreateTimelineV2RuntimeOptions,
): Promise<TimelineV2Runtime> {
	const onError =
		options.onError ??
		((error: unknown) =>
			console.error(
				"[timeline-v2]",
				error instanceof Error ? error.message : "unknown error",
			));
	const verificationRetryDelays =
		modernBertVerificationRetryDelays(options.modernBert);
	const identity = loadOrCreateReflectionIdentity(
		join(options.dataDirectory, "reflection-identity.v1.json"),
	);
	const vault = new RuntimeTimelineVault(options.agent);
	const repository = new SqliteTimelineV2Repository(
		join(options.dataDirectory, "timeline-v2.sqlite3"),
		vault,
	);
	const teacherLock: OllamaModelLock = {
		...WHALEHALL_TEACHER_MODEL_LOCK,
		baseUrl:
			options.teacherBaseUrl ?? WHALEHALL_TEACHER_MODEL_LOCK.baseUrl,
	};
	let modelLockVerified = false;
	let inferenceReady = false;
	const diagnostics: TimelineInferenceDiagnosticV2[] = [];
	let handleModernBertInvalidation: (error: unknown) => void = () => {};
	const classifier = new SwitchableTimelineEpisodeClassifier((error) =>
		handleModernBertInvalidation(error),
	);
	let episodeClassifier: TimelineEpisodeClassifierRuntimeStatus = {
		configured: false,
		artifactVerified: false,
		activeClassifier: "deterministic-cold-start",
		modelVersion: "deterministic-cold-start.v2",
		code: "disabled",
	};
	let modernBert: ModernBertEpisodeClassifier | null = null;
	let verificationRetryTimer: ReturnType<typeof setTimeout> | null =
		null;
	let verificationRetryIndex = 0;
	let runtimeClosed = false;
	const shutdownController = new AbortController();
	const cancelVerificationRetry = (): void => {
		if (verificationRetryTimer !== null) {
			clearTimeout(verificationRetryTimer);
			verificationRetryTimer = null;
		}
	};
	const promoteModernBert = (): void => {
		if (runtimeClosed || modernBert === null) return;
		cancelVerificationRetry();
		verificationRetryIndex = 0;
		classifier.useModernBert(modernBert);
		episodeClassifier = {
			configured: true,
			artifactVerified: true,
			activeClassifier: "modernbert",
			modelVersion: modernBert.modelVersion,
			code: null,
		};
	};
	const demoteModernBert = (error: unknown): void => {
		if (runtimeClosed) return;
		classifier.useFallback();
		episodeClassifier = {
			configured: true,
			artifactVerified: false,
			activeClassifier: "deterministic-cold-start",
			modelVersion: "deterministic-cold-start.v2",
			code: modernBertStatusCode(error),
		};
	};
	const scheduleVerificationRetry = (
		error: unknown,
		forceMetadataRetry = false,
	): void => {
		if (
			runtimeClosed ||
			modernBert === null ||
			!(error instanceof ModernBertClassifierError) ||
			(!forceMetadataRetry && !error.retryable) ||
			verificationRetryTimer !== null ||
			verificationRetryIndex >= verificationRetryDelays.length
		) {
			return;
		}
		const delayMs =
			verificationRetryDelays[verificationRetryIndex++]!;
		verificationRetryTimer = setTimeout(() => {
			verificationRetryTimer = null;
			if (runtimeClosed || modernBert === null) return;
			void modernBert.verifyArtifact(shutdownController.signal).then(
				() => promoteModernBert(),
				(retryError: unknown) => {
					if (runtimeClosed) return;
					demoteModernBert(retryError);
					onError(retryError);
					scheduleVerificationRetry(
						retryError,
						forceMetadataRetry,
					);
				},
			);
		}, delayMs);
	};
	handleModernBertInvalidation = (error) => {
		if (runtimeClosed) return;
		demoteModernBert(error);
		try {
			onError(error);
		} catch {
			// Diagnostics must not prevent the privacy-preserving demotion.
		}
		scheduleVerificationRetry(error, true);
	};
	let hypotheses: TimelineHypothesisGenerator =
		new DeterministicTimelineHypothesisGenerator();
	if (options.modernBert?.enabled === true) {
		try {
			modernBert = new ModernBertEpisodeClassifier(
				options.modernBert,
			);
			await modernBert.verifyArtifact(shutdownController.signal);
			promoteModernBert();
		} catch (error) {
			// Keep classification on the explicit cold-start implementation.
			// An unverified endpoint never receives EvidenceFact content.
			demoteModernBert(error);
			onError(error);
			scheduleVerificationRetry(error);
		}
	}
	if (options.verifyTeacher !== false) {
		try {
			await verifyOllamaModelLock(teacherLock, {
				fetch: options.teacherFetch,
			});
			modelLockVerified = true;
			// @whalehall-model-boundary-exception local-model-lock
			// This cited-hypothesis helper is a verified legacy local component,
			// not a configurable desktop model role. New model calls use Mastra.
			const client = new OllamaJsonClient({
				baseUrl: teacherLock.baseUrl,
				model: teacherLock.model,
				contextLength: teacherLock.numCtx,
				keepAlive: "30m",
				fetch: options.teacherFetch,
			});
			try {
				await probeQwenHypothesisReadiness(client, {
					signal: shutdownController.signal,
				});
				inferenceReady = true;
				hypotheses = new QwenCitedHypothesisGenerator(client);
			} catch (error) {
				diagnostics.push(
					runtimeDiagnostic("readiness_probe", error),
				);
				onError(error);
			}
		} catch (error) {
			// Timeline creation continues with a grounded deterministic template.
			// No unverified model receives content.
			diagnostics.push(runtimeDiagnostic("model_lock", error));
			onError(error);
		}
	} else {
		diagnostics.push({
			source: "qwen3:4b",
			stage: "model_lock",
			code: "model_verification_disabled",
			retryable: false,
			httpStatus: null,
			affectedEpisodeCount: null,
		});
	}
	try {
		const service = new TimelineV2Service({
			transport: options.agent,
			repository,
			identity: {
				collectorId: `${identity.collectorId}.timeline-v2`,
				deviceId: identity.deviceId,
				sessionId: identity.sessionId,
			},
			hypotheses,
			classifier,
			initialGoal: options.initialGoal,
			onError,
		});
		const audit = options.rawAuditSource
			? new TimelineFiveMinuteAuditExporter(
					options.rawAuditSource,
					repository,
				)
			: null;
		const privateTrainingExport = options.rawAuditSource
			? new PrivateTrainingWindowExporter(
					options.rawAuditSource,
					repository,
				)
			: null;
		const agentInput = new TimelineAgentInputAdapterV1(service);
		let repositoryClosed = false;
		let closePromise: Promise<void> | null = null;
		const beginShutdown = (): void => {
			if (runtimeClosed) return;
			runtimeClosed = true;
			cancelVerificationRetry();
			shutdownController.abort(
				new DOMException("Timeline v2 runtime is shutting down.", "AbortError"),
			);
			service.beginShutdown();
		};
		return {
			service,
			repository,
			audit,
			privateTrainingExport,
			agentInput,
			get episodeClassifier() {
				return structuredClone(episodeClassifier);
			},
			modelLockVerified,
			inferenceReady,
			diagnostics,
			teacherVerified: modelLockVerified,
			async refreshEpisodeClassifier() {
				if (runtimeClosed) {
					throw new Error("Timeline v2 runtime is shutting down.");
				}
				cancelVerificationRetry();
				verificationRetryIndex = 0;
				if (modernBert === null) {
					return structuredClone(episodeClassifier);
				}
				classifier.useFallback();
				try {
					await modernBert.refreshArtifact(
						shutdownController.signal,
					);
					promoteModernBert();
				} catch (error) {
					demoteModernBert(error);
					onError(error);
					scheduleVerificationRetry(error);
				}
				return structuredClone(episodeClassifier);
			},
			start: () => service.start(),
			beginShutdown,
			close() {
				if (closePromise !== null) return closePromise;
				beginShutdown();
				closePromise = (async () => {
					await service.stop();
					if (repositoryClosed) return;
					repositoryClosed = true;
					repository.close();
				})();
				return closePromise;
			},
		};
	} catch (error) {
		runtimeClosed = true;
		cancelVerificationRetry();
		shutdownController.abort(
			new DOMException("Timeline v2 runtime creation failed.", "AbortError"),
		);
		repository.close();
		throw error;
	}
}

function modernBertVerificationRetryDelays(
	options: ModernBertRuntimeOptIn | undefined,
): readonly number[] {
	if (options?.enabled !== true) return [];
	const configured = options.verificationRetryDelaysMs;
	if (configured === undefined) {
		return MODERNBERT_VERIFICATION_RETRY_DELAYS_MS;
	}
	if (
		configured.length >
			MODERNBERT_MAX_VERIFICATION_RETRIES ||
		configured.some(
			(delayMs) =>
				!Number.isSafeInteger(delayMs) ||
				delayMs < 1 ||
				delayMs > MODERNBERT_MAX_VERIFICATION_RETRY_MS,
		)
	) {
		throw new ModernBertClassifierError(
			"invalid_config",
			"ModernBERT verification retry schedule is invalid.",
		);
	}
	return [...configured];
}

function modernBertStatusCode(
	error: unknown,
): TimelineEpisodeClassifierRuntimeStatus["code"] {
	return error instanceof ModernBertClassifierError
		? `modernbert.${error.code}`
		: "modernbert.unexpected_failure";
}

function runtimeDiagnostic(
	stage: "model_lock" | "readiness_probe",
	error: unknown,
): TimelineInferenceDiagnosticV2 {
	if (error instanceof OllamaClientError) {
		return {
			source: "qwen3:4b",
			stage,
			code: `ollama.${error.code}`,
			retryable: error.retryable,
			httpStatus: error.httpStatus,
			affectedEpisodeCount: null,
		};
	}
	return {
		source: "qwen3:4b",
		stage,
		code:
			stage === "model_lock"
				? "model_lock_failed"
				: "unexpected_failure",
		retryable: true,
		httpStatus: null,
		affectedEpisodeCount: null,
	};
}
