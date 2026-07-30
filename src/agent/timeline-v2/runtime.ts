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
	DeterministicTimelineHypothesisGenerator,
	QwenCitedHypothesisGenerator,
	probeQwenHypothesisReadiness,
	type TimelineHypothesisGenerator,
} from "./hypothesis";
import { RuntimeTimelineVault } from "./runtime-vault";
import { TimelineV2Service } from "./service";
import { SqliteTimelineV2Repository } from "./sqlite-repository";
import type { TimelineInferenceDiagnosticV2 } from "./types";

export type TimelineV2Runtime = {
	service: TimelineV2Service;
	repository: SqliteTimelineV2Repository;
	audit: TimelineFiveMinuteAuditExporter | null;
	modelLockVerified: boolean;
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
	let hypotheses: TimelineHypothesisGenerator =
		new DeterministicTimelineHypothesisGenerator();
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
