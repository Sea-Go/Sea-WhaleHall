import { join } from "node:path";
import type { AgentRuntime } from "../agent/agent-runtime";
import {
	type ActiveGoalContextV1,
	DesktopReflectionService,
	DeterministicReflectionInference,
	type EventWindowV1,
	loadOrCreateReflectionIdentity,
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
	beginShutdown(): void;
	close(): Promise<void>;
};

export type StopNativeAgentWithReflectionOptions = {
	drainProducers(): Promise<void>;
	stopNativeAgent(): Promise<void>;
	closeReflection(): Promise<void>;
};

/**
 * Joins accepted producers first, then starts native stop before Reflection
 * close. Local stop synchronously rejects pending RPCs that Reflection may be
 * awaiting, so the two owner drains cannot form a shutdown cycle.
 */
export async function stopNativeAgentWithReflection(
	options: StopNativeAgentWithReflectionOptions,
): Promise<void> {
	await options.drainProducers();
	const nativeStop = options.stopNativeAgent();
	const reflectionClose = options.closeReflection();
	await Promise.all([nativeStop, reflectionClose]);
}

export type CreateWhaleHallReflectionRuntimeOptions = {
	agent: AgentRuntime;
	dataDirectory: string;
	onError?: (error: unknown) => void;
	cloudOwnerAccountId?: () => string | null;
	onWindowSealed?: (window: EventWindowV1) => void | Promise<void>;
	onFeedback?: (code: ActiveReflectionFeedbackCode) => void | Promise<void>;
	canPresentFeedback?: () => boolean;
};

export async function createWhaleHallReflectionRuntime(
	options: CreateWhaleHallReflectionRuntimeOptions,
): Promise<WhaleHallReflectionRuntime> {
	const onError =
		options.onError ??
		((error: unknown) => console.error("[reflection]", error));
	const identity = loadOrCreateReflectionIdentity(
		join(options.dataDirectory, "reflection-identity.v1.json"),
	);
	const repository = new SqliteReflectionRepository(
		join(options.dataDirectory, "reflections.sqlite3"),
	);
	try {
		const service = new DesktopReflectionService({
			transport: options.agent,
			repository,
			inference: new DeterministicReflectionInference(),
			identity,
			// Preserve the durable executing-task goal across launches. The local
			// PlanningRuntime reconciles it against the current calendar after the
			// native planning store becomes available. Cloud ownership remains scoped
			// to the authenticated account independently of that local execution goal.
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
		return createOwnedWhaleHallReflectionRuntime({
			service,
			repository,
			teacherVerified: false,
		});
	} catch (error) {
		repository.close();
		throw error;
	}
}

export function createOwnedWhaleHallReflectionRuntime(options: {
	service: DesktopReflectionService;
	repository: SqliteReflectionRepository;
	teacherVerified: boolean;
}): WhaleHallReflectionRuntime {
	let closePromise: Promise<void> | null = null;
	return {
		...options,
		beginShutdown() {
			options.service.beginShutdown();
		},
		close() {
			options.service.beginShutdown();
			if (closePromise !== null) return closePromise;
			closePromise = (async () => {
				await options.service.stop();
				options.repository.close();
			})();
			return closePromise;
		},
	};
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
