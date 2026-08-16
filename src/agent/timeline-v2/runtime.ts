import { join } from "node:path";
import type { AgentRuntime } from "../agent-runtime";
import { loadOrCreateReflectionIdentity } from "../reflection/identity";
import type { ActiveGoalContextV1 } from "../reflection/types";
import { TimelineAgentInputAdapterV1 } from "./agent-input-adapter";
import {
	type RawFiveMinuteAuditSource,
	TimelineFiveMinuteAuditExporter,
} from "./audit";
import { HeuristicTimelineEpisodeClassifier } from "./episodes";
import { DeterministicTimelineHypothesisGenerator } from "./hypothesis";
import { RuntimeTimelineVault } from "./runtime-vault";
import { TimelineV2Service } from "./service";
import { SqliteTimelineV2Repository } from "./sqlite-repository";
import { PrivateTrainingWindowExporter } from "./training-window-export";
import type { TimelineInferenceDiagnosticV2 } from "./types";

export type TimelineEpisodeClassifierRuntimeStatus = {
	configured: false;
	artifactVerified: false;
	activeClassifier: "deterministic-cold-start";
	modelVersion: "deterministic-cold-start.v2";
	code: "disabled";
};

export type TimelineV2Runtime = {
	service: TimelineV2Service;
	repository: SqliteTimelineV2Repository;
	audit: TimelineFiveMinuteAuditExporter | null;
	/** Explicit local-only export boundary; it never runs automatically. */
	privateTrainingExport: PrivateTrainingWindowExporter | null;
	/** Local-only durable outbox boundary; no renderer or network transport. */
	agentInput: TimelineAgentInputAdapterV1;
	episodeClassifier: TimelineEpisodeClassifierRuntimeStatus;
	/** Compatibility fields fixed false now that production has no local model. */
	modelLockVerified: false;
	inferenceReady: false;
	diagnostics: readonly TimelineInferenceDiagnosticV2[];
	teacherVerified: false;
	/** Compatibility operation; deterministic classification has no artifact. */
	refreshEpisodeClassifier(): Promise<TimelineEpisodeClassifierRuntimeStatus>;
	start(): Promise<void>;
	beginShutdown(): void;
	close(): Promise<void>;
};

export type CreateTimelineV2RuntimeOptions = {
	agent: AgentRuntime;
	dataDirectory: string;
	rawAuditSource?: RawFiveMinuteAuditSource;
	/** Goal owned by the already-started Reflection runtime. */
	initialGoal?: ActiveGoalContextV1 | null;
	onError?: (error: unknown) => void;
};

const DETERMINISTIC_EPISODE_CLASSIFIER_STATUS: TimelineEpisodeClassifierRuntimeStatus =
	{
		configured: false,
		artifactVerified: false,
		activeClassifier: "deterministic-cold-start",
		modelVersion: "deterministic-cold-start.v2",
		code: "disabled",
	};

/**
 * Production Timeline v2 composition. Classification and cited hypotheses are
 * deterministic and require neither a desktop model server nor network I/O.
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
	try {
		const service = new TimelineV2Service({
			transport: options.agent,
			repository,
			identity: {
				collectorId: `${identity.collectorId}.timeline-v2`,
				deviceId: identity.deviceId,
				sessionId: identity.sessionId,
			},
			hypotheses: new DeterministicTimelineHypothesisGenerator(),
			classifier: new HeuristicTimelineEpisodeClassifier(),
			initialGoal: options.initialGoal,
			onError,
		});
		const audit = options.rawAuditSource
			? new TimelineFiveMinuteAuditExporter(options.rawAuditSource, repository)
			: null;
		const privateTrainingExport = options.rawAuditSource
			? new PrivateTrainingWindowExporter(options.rawAuditSource, repository)
			: null;
		const agentInput = new TimelineAgentInputAdapterV1(service);
		let runtimeClosed = false;
		let repositoryClosed = false;
		let closePromise: Promise<void> | null = null;
		const beginShutdown = (): void => {
			if (runtimeClosed) return;
			runtimeClosed = true;
			service.beginShutdown();
		};
		return {
			service,
			repository,
			audit,
			privateTrainingExport,
			agentInput,
			episodeClassifier: structuredClone(
				DETERMINISTIC_EPISODE_CLASSIFIER_STATUS,
			),
			modelLockVerified: false,
			inferenceReady: false,
			diagnostics: [],
			teacherVerified: false,
			async refreshEpisodeClassifier() {
				if (runtimeClosed) {
					throw new Error("Timeline v2 runtime is shutting down.");
				}
				return structuredClone(DETERMINISTIC_EPISODE_CLASSIFIER_STATUS);
			},
			start: () => service.start(),
			beginShutdown,
			close() {
				if (closePromise !== null) return closePromise;
				closePromise = (async () => {
					try {
						beginShutdown();
						await service.stop();
					} finally {
						if (!repositoryClosed) {
							repositoryClosed = true;
							repository.close();
						}
					}
				})();
				return closePromise;
			},
		};
	} catch (error) {
		repository.close();
		throw error;
	}
}
