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
} from "../model/ollama-model-lock";
import { loadOrCreateReflectionIdentity } from "../reflection/identity";
import type { ActiveGoalContextV1 } from "../reflection/types";
import {
	TimelineFiveMinuteAuditExporter,
	type RawFiveMinuteAuditSource,
} from "./audit";
import {
	HeuristicTimelineEpisodeClassifier,
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
import type { TimelineInferenceDiagnosticV2 } from "./types";

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
	start(): Promise<void>;
	close(): Promise<void>;
};

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
	const identity = loadOrCreateReflectionIdentity(
		join(options.dataDirectory, "reflection-identity.v1.json"),
	);
	const vault = new RuntimeTimelineVault(options.agent);
	const repository = new SqliteTimelineV2Repository(
		join(options.dataDirectory, "timeline-v2.sqlite3"),
		vault,
	);
	let modelLockVerified = false;
	let inferenceReady = false;
	const diagnostics: TimelineInferenceDiagnosticV2[] = [];
	let classifier: TimelineEpisodeClassifier =
		new HeuristicTimelineEpisodeClassifier();
	let episodeClassifier: TimelineEpisodeClassifierRuntimeStatus = {
		configured: false,
		artifactVerified: false,
		activeClassifier: "deterministic-cold-start",
		modelVersion: "deterministic-cold-start.v2",
		code: "disabled",
	};
	let hypotheses: TimelineHypothesisGenerator =
		new DeterministicTimelineHypothesisGenerator();
	if (options.modernBert?.enabled === true) {
		try {
			const modernBert = new ModernBertEpisodeClassifier(
				options.modernBert,
			);
			await modernBert.verifyArtifact();
			classifier = modernBert;
			episodeClassifier = {
				configured: true,
				artifactVerified: true,
				activeClassifier: "modernbert",
				modelVersion: modernBert.modelVersion,
				code: null,
			};
		} catch (error) {
			// Keep classification on the explicit cold-start implementation.
			// An unverified endpoint never receives EvidenceFact content.
			episodeClassifier = {
				configured: true,
				artifactVerified: false,
				activeClassifier: "deterministic-cold-start",
				modelVersion: "deterministic-cold-start.v2",
				code: modernBertStatusCode(error),
			};
			onError(error);
		}
	}
	if (options.verifyTeacher !== false) {
		try {
			await verifyOllamaModelLock(WHALEHALL_TEACHER_MODEL_LOCK, {
				fetch: options.teacherFetch,
			});
			modelLockVerified = true;
			const client = new OllamaJsonClient({
				baseUrl: WHALEHALL_TEACHER_MODEL_LOCK.baseUrl,
				model: WHALEHALL_TEACHER_MODEL_LOCK.model,
				contextLength: WHALEHALL_TEACHER_MODEL_LOCK.numCtx,
				keepAlive: "30m",
				fetch: options.teacherFetch,
			});
			try {
				await probeQwenHypothesisReadiness(client);
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
		return {
			service,
			repository,
			audit,
			episodeClassifier,
			modelLockVerified,
			inferenceReady,
			diagnostics,
			teacherVerified: modelLockVerified,
			start: () => service.start(),
			async close() {
				await service.stop();
				repository.close();
			},
		};
	} catch (error) {
		repository.close();
		throw error;
	}
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
