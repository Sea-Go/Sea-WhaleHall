import { join } from "node:path";
import type { AgentRuntime } from "../agent/agent-runtime";
import { OllamaJsonClient } from "../agent/model/ollama-json-client";
import {
	type OllamaModelLock,
	verifyOllamaModelLock,
	WHALEHALL_TEACHER_MODEL_LOCK,
} from "../agent/model/ollama-model-lock";
import {
	type ActiveGoalContextV1,
	DesktopReflectionService,
	type EventWindowV1,
	loadOrCreateReflectionIdentity,
	ModernBertHttpClient,
	ReflectionInference,
	SqliteReflectionRepository,
} from "../agent/reflection";
import {
	type ActiveReflectionFeedbackCode,
	ReflectionFeedbackSink,
} from "./reflection-feedback";

export type WhaleHallReflectionRuntime = {
	service: DesktopReflectionService;
	repository: SqliteReflectionRepository;
	teacherVerified: boolean;
	close(): Promise<void>;
};

export type CreateWhaleHallReflectionRuntimeOptions = {
	agent: AgentRuntime;
	dataDirectory: string;
	/**
	 * User-configured Teacher address. The reviewed model lock still verifies
	 * exact model metadata before any content request.
	 */
	teacherBaseUrl?: string;
	/** Exact HTTPS origins allowed when the Teacher is remote. */
	teacherAllowedRemoteOrigins?: readonly string[];
	/** Environment-only Bearer token for an authenticated Teacher gateway. */
	teacherAuthorizationToken?: string;
	environment?: Readonly<Record<string, string | undefined>>;
	onError?: (error: unknown) => void;
	cloudOwnerAccountId?: () => string | null;
	onWindowSealed?: (window: EventWindowV1) => void | Promise<void>;
	onFeedback?: (code: ActiveReflectionFeedbackCode) => void | Promise<void>;
	canPresentFeedback?: () => boolean;
};

export async function createWhaleHallReflectionRuntime(
	options: CreateWhaleHallReflectionRuntimeOptions,
): Promise<WhaleHallReflectionRuntime> {
	const environment = options.environment ?? process.env;
	const onError =
		options.onError ??
		((error: unknown) => console.error("[reflection]", error));
	const identity = loadOrCreateReflectionIdentity(
		join(options.dataDirectory, "reflection-identity.v1.json"),
	);
	const repository = new SqliteReflectionRepository(
		join(options.dataDirectory, "reflections.sqlite3"),
	);
	const teacherLock: OllamaModelLock = {
		...WHALEHALL_TEACHER_MODEL_LOCK,
		baseUrl: options.teacherBaseUrl ?? WHALEHALL_TEACHER_MODEL_LOCK.baseUrl,
	};

	let teacherVerified = false;
	let fallback: OllamaJsonClient | undefined;
	try {
		await verifyOllamaModelLock(teacherLock, {
			allowedRemoteOrigins: options.teacherAllowedRemoteOrigins,
			authorizationToken: options.teacherAuthorizationToken,
		});
		teacherVerified = true;
		// @whalehall-model-boundary-exception local-model-lock
		// This pre-existing, lock-pinned fallback is not a configurable model
		// role. Do not add new callers here; configured desktop calls use Mastra.
		fallback = new OllamaJsonClient({
			baseUrl: teacherLock.baseUrl,
			allowedRemoteOrigins: options.teacherAllowedRemoteOrigins,
			authorizationToken: options.teacherAuthorizationToken,
			model: teacherLock.model,
			contextLength: teacherLock.numCtx,
			keepAlive: "30m",
		});
	} catch (error) {
		// ModernBERT remains usable. Low-confidence windows will be retried
		// instead of silently using an unreviewed local model.
		onError(error);
	}

	try {
		const primary = new ModernBertHttpClient({
			endpoint: environment.WHALEHALL_MODERNBERT_ENDPOINT,
			allowedOrigins: parseOrigins(
				environment.WHALEHALL_MODERNBERT_ALLOWED_ORIGINS,
			),
			authorizationToken: environment.WHALEHALL_MODERNBERT_TOKEN,
		});
		const inference = new ReflectionInference({
			primary,
			fallback,
			fallbackModelVersion: teacherVerified
				? `${teacherLock.model}@${teacherLock.digest.slice(0, 12)}`
				: teacherLock.model,
		});
		const service = new DesktopReflectionService({
			transport: options.agent,
			repository,
			inference,
			identity,
			// The local test session is not restored across application launches.
			// Clear any recovered collector goal before native sensors start so
			// early events cannot be attributed to a stale account; an authenticated
			// account's authoritative goal is restored afterwards by Bun.
			startupGoal: null,
			cloudOwnerAccountId: options.cloudOwnerAccountId,
			onWindowSealed: options.onWindowSealed,
			sinks: options.onFeedback
				? [
						new ReflectionFeedbackSink({
							repository,
							present: options.onFeedback,
							canPresent: options.canPresentFeedback,
						}),
					]
				: [],
			onError,
		});
		return {
			service,
			repository,
			teacherVerified,
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

export async function setRuntimeGoal(
	runtime: WhaleHallReflectionRuntime,
	goal: {
		goalId: string;
		planId: string | null;
		text: string;
		activatedAtMs: number;
	} | null,
): Promise<ActiveGoalContextV1 | null> {
	return runtime.service.setActiveGoal(goal);
}

function parseOrigins(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
}
