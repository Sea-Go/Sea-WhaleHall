import { join } from "node:path";
import type { AgentRuntime } from "../agent-runtime";
import { OllamaJsonClient } from "../model/ollama-json-client";
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
	type TimelineHypothesisGenerator,
} from "./hypothesis";
import { RuntimeTimelineVault } from "./runtime-vault";
import { TimelineV2Service } from "./service";
import { SqliteTimelineV2Repository } from "./sqlite-repository";

export type TimelineV2Runtime = {
	service: TimelineV2Service;
	repository: SqliteTimelineV2Repository;
	audit: TimelineFiveMinuteAuditExporter | null;
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
};

/**
 * Runnable composition entry point. Creating it performs no collection,
 * upload, or model request. Call start only after the v1 startup-goal gate has
 * started/reconciled whalehall-local.
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
	let teacherVerified = false;
	let hypotheses: TimelineHypothesisGenerator =
		new DeterministicTimelineHypothesisGenerator();
	if (options.verifyTeacher !== false) {
		try {
			await verifyOllamaModelLock();
			teacherVerified = true;
			hypotheses = new QwenCitedHypothesisGenerator(
				new OllamaJsonClient({
					baseUrl: WHALEHALL_TEACHER_MODEL_LOCK.baseUrl,
					model: WHALEHALL_TEACHER_MODEL_LOCK.model,
					contextLength:
						WHALEHALL_TEACHER_MODEL_LOCK.numCtx,
					keepAlive: "30m",
				}),
			);
		} catch (error) {
			// Timeline creation continues with a grounded deterministic template.
			// No unverified model receives content.
			onError(error);
		}
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
			teacherVerified,
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
