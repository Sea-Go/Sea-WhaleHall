import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ACTIVITY_SUPPORT_SPECIALIST_AGENT_IDS,
	MODEL_AGENT_IDS,
} from "../src/agent/mastra-host/model-agent-catalog";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type AgentHostMethod,
	type AgentRunEventFrame,
} from "../src/agent/mastra-host/protocol";
import {
	AgentRunCoordinator,
	type AgentSidecar,
} from "../src/bun/agent-run-coordinator";
import { AgentToolPolicy } from "../src/bun/agent-tool-policy";
import {
	CredentialHelperError,
	type CredentialKeyReference,
	type CredentialKeyStore,
} from "../src/bun/credential-helper-client";
import { EncryptedAgentRepository } from "../src/bun/encrypted-agent-repository";
import type { InternalAgentRunEventEnvelope } from "../src/shared/agent-runs";
import type {
	TaskPlanningDraft,
	TaskPlanningInput,
} from "../src/shared/task-planning";

const temporaryDirectories: string[] = [];
const openRepositories: EncryptedAgentRepository[] = [];

afterEach(() => {
	for (const repository of openRepositories.splice(0)) repository.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AgentRunCoordinator", () => {
	test("pet turns share one durable conversation thread for client-side history", async () => {
		const harness = createHarness();
		const first = await harness.coordinator.petConversationId();
		const second = await harness.coordinator.petConversationId();
		// 固定线程：心跳与用户消息都落在这里，客户端对话页可回看完整历史。
		expect(first).toBe("conversation-pet-main");
		expect(second).toBe(first);
		const active = await harness.coordinator.getActiveConversation();
		expect(active.kind).toBe("success");
		if (active.kind !== "success") throw new Error("unreachable");
		expect(active.data?.id).toBe("conversation-pet-main");
		expect(active.data?.title).toBe("大肥鱼对话");
	});

	test("stores a no-tool activity analysis locally without exposing it through renderer APIs", async () => {
		const harness = createHarness();
		const runId = "activity-run-private";
		const analysis = {
			request_id: "worker-request-private",
			score: 0,
			score_reason: "goal-relevant activity",
			events: [
				{
					action: "确定：联系张三并处理账号 ABC123",
					source_event_ids: ["sealed-window-only"],
					activity: "development",
					goal_relevance: "direct",
					confidence: 0.9,
					reason_codes: ["worker"],
					evidence: ["Worker summary only"],
					started_at_ms: 1,
					ended_at_ms: 2,
				},
			],
		};
		await harness.repository.archiveProactiveFeedbackEventStream({
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "sealed-window-only",
			windowStartedAtMs: 1,
			windowEndedAtMs: 2,
			analysis,
			supportPersonalization: {
				activeGoal: "完成主动反馈隐私边界",
				recentApproaches: ["small_step", "problem_breakdown"],
			},
			archivedAtMs: harness.clock(),
			consumedAtMs: null,
			consumedRunId: null,
		});
		await harness.coordinator.startActivityAnalysis({
			jobId: "activity-job-private",
			runId,
			requestId: "activity-request-private",
			consumedScore: 0,
			analyses: [analysis],
		});
		const sidecarStart = harness.sidecar.calls.find(
			(call) => call.method === "activity.start",
		);
		expect(sidecarStart?.params).toEqual({
			runId,
			activityJobId: "activity-job-private",
			supportContext: {
				schemaVersion: "activity-support-context.v1",
				activeGoal: "完成主动反馈隐私边界",
				recentApproaches: ["small_step", "problem_breakdown"],
				observations: [
					{
						activity: "development",
						goalRelation: "direct",
						evidenceStrength: "strong",
						signals: ["goal_progress"],
					},
				],
			},
		});
		expect(Object.keys(sidecarStart?.params ?? {}).sort()).toEqual([
			"activityJobId",
			"runId",
			"supportContext",
		]);
		const sourceEventId = analysis.events.at(0)?.source_event_ids.at(0);
		const activityAction = analysis.events.at(0)?.action;
		if (!sourceEventId || !activityAction) {
			throw new Error(
				"Expected private Worker fields in the analysis fixture.",
			);
		}
		const sidecarPayload = JSON.stringify(sidecarStart?.params);
		for (const disallowed of [
			"raw_event",
			"score",
			"score_reason",
			"consumedScore",
			"request_id",
			"source_event_ids",
			analysis.request_id,
			sourceEventId,
			activityAction,
			"张三",
			"ABC123",
			analysis.score_reason,
		]) {
			expect(sidecarPayload).not.toContain(disallowed);
		}
		expect(harness.coordinator.modelPurposeForRun(runId)).toBe("activity");

		harness.coordinator.acceptSidecarEvent(
			runEvent(runId, 1, { kind: "run.started", runKind: "activity" }, null),
		);
		await advanceActivityModelRelayStages(harness.coordinator, runId);
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				runId,
				2,
				{
					kind: "run.completed",
					result: { summary: "开发活动与当前目标直接相关，建议继续当前任务。" },
				},
				"completed",
			),
		);
		await waitFor(
			async () =>
				(await harness.repository.getRun("account-a", runId))?.status ===
				"completed",
		);
		const persisted = await harness.repository.getRun("account-a", runId);
		expect(persisted?.input).toEqual(
			expect.objectContaining({
				kind: "activity-analysis",
				consumedScore: 0,
				analyses: [analysis],
			}),
		);
		expect(JSON.stringify(persisted?.input)).not.toContain("raw_event");
		expect(JSON.stringify(persisted?.output)).toContain("建议继续当前任务");
		await expect(
			harness.coordinator.getAgentRunSnapshot(runId),
		).resolves.toEqual(expect.objectContaining({ kind: "not-found" }));
		await expect(
			harness.coordinator.listRestorableAgentRuns({}),
		).resolves.toEqual({
			kind: "success",
			data: { runs: [] },
		});
		expect(harness.activityTerminals).toEqual([
			expect.objectContaining({
				jobId: "activity-job-private",
				runId,
				accountId: "account-a",
				status: "completed",
			}),
		]);
	});

	test("advances the activity model relay only after supervisor, one specialist, and voice open successfully", async () => {
		const harness = createHarness();
		const runId = "activity-run-model-stages";
		const analysis = activityAnalysisResult(
			"worker-request-model-stages",
			"sealed-window-model-stages",
		);
		await harness.repository.archiveProactiveFeedbackEventStream({
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "sealed-window-model-stages",
			windowStartedAtMs: 1,
			windowEndedAtMs: 2,
			analysis,
			archivedAtMs: harness.clock(),
			consumedAtMs: null,
			consumedRunId: null,
		});
		await harness.coordinator.startActivityAnalysis({
			jobId: "activity-job-model-stages",
			runId,
			requestId: "activity-request-model-stages",
			consumedScore: 1,
			analyses: [analysis],
		});

		let openCalls = 0;
		const open = (
			agentId: Parameters<typeof harness.coordinator.runBoundModelRelayCall>[1],
		) =>
			harness.coordinator.runBoundModelRelayCall(
				runId,
				agentId,
				async (purpose) => {
					openCalls += 1;
					return purpose;
				},
			);
		await expect(open(MODEL_AGENT_IDS.activitySupportVoice)).rejects.toThrow(
			"supervisor stage",
		);
		expect(openCalls).toBe(0);

		const supervisorOpenStarted = deferred();
		const releaseSupervisorOpen = deferred();
		const failedSupervisorOpen = harness.coordinator.runBoundModelRelayCall(
			runId,
			MODEL_AGENT_IDS.activitySupportSupervisor,
			async () => {
				openCalls += 1;
				supervisorOpenStarted.resolve();
				await releaseSupervisorOpen.promise;
				throw new Error("upstream open failed");
			},
		);
		await supervisorOpenStarted.promise;
		await expect(
			open(MODEL_AGENT_IDS.activitySupportSupervisor),
		).rejects.toThrow("already has an active call");
		releaseSupervisorOpen.resolve();
		await expect(failedSupervisorOpen).rejects.toThrow("upstream open failed");
		await expect(open(MODEL_AGENT_IDS.activitySupportSupervisor)).resolves.toBe(
			"activity",
		);
		await expect(
			open(MODEL_AGENT_IDS.activitySupportSupervisor),
		).rejects.toThrow("specialist stage");
		await expect(open(MODEL_AGENT_IDS.activitySupportVoice)).rejects.toThrow(
			"specialist stage",
		);

		await expect(
			harness.coordinator.runBoundModelRelayCall(
				runId,
				ACTIVITY_SUPPORT_SPECIALIST_AGENT_IDS.focusCoach,
				async () => {
					openCalls += 1;
					throw new Error("specialist open failed");
				},
			),
		).rejects.toThrow("specialist open failed");
		await expect(
			open(ACTIVITY_SUPPORT_SPECIALIST_AGENT_IDS.blockerCoach),
		).rejects.toThrow("originally selected specialist Agent");
		await expect(
			open(ACTIVITY_SUPPORT_SPECIALIST_AGENT_IDS.focusCoach),
		).resolves.toBe("activity");
		await expect(
			open(ACTIVITY_SUPPORT_SPECIALIST_AGENT_IDS.momentumCoach),
		).rejects.toThrow("voice stage");
		await expect(open(MODEL_AGENT_IDS.activitySupportVoice)).resolves.toBe(
			"activity",
		);
		await expect(open(MODEL_AGENT_IDS.activitySupportVoice)).rejects.toThrow(
			"done stage",
		);
		expect(openCalls).toBe(5);
	});

	test("fails closed when activity completion arrives before all model relay stages", async () => {
		const harness = createHarness();
		const runId = "activity-run-early-completion";
		const analysis = activityAnalysisResult(
			"worker-request-early-completion",
			"sealed-window-early-completion",
		);
		await harness.repository.archiveProactiveFeedbackEventStream({
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "sealed-window-early-completion",
			windowStartedAtMs: 1,
			windowEndedAtMs: 2,
			analysis,
			archivedAtMs: harness.clock(),
			consumedAtMs: null,
			consumedRunId: null,
		});
		await harness.coordinator.startActivityAnalysis({
			jobId: "activity-job-early-completion",
			runId,
			requestId: "activity-request-early-completion",
			consumedScore: 1,
			analyses: [analysis],
		});
		harness.coordinator.acceptSidecarEvent(
			runEvent(runId, 1, { kind: "run.started", runKind: "activity" }, null),
		);
		harness.coordinator.acceptSidecarEvent(
			runEvent(
				runId,
				2,
				{
					kind: "run.completed",
					result: { summary: "不应接受的提前完成。" },
				},
				"completed",
			),
		);

		await waitFor(() => harness.activityTerminals.length === 1);
		expect(harness.activityTerminals[0]).toMatchObject({
			jobId: "activity-job-early-completion",
			runId,
			status: "failed",
			failureClass: "invalid-output",
			feedback: null,
		});
		await expect(
			harness.repository.getRun("account-a", runId),
		).resolves.toEqual(expect.objectContaining({ status: "failed" }));
		await expect(
			harness.coordinator.runBoundModelRelayCall(
				runId,
				MODEL_AGENT_IDS.activitySupportSupervisor,
				async () => undefined,
			),
		).rejects.toThrow("运行不存在");
	});

	test("does not dispatch support context after the activity session changes during archive loading", async () => {
		const harness = createHarness();
		const runId = "activity-run-support-context-session-race";
		const analysis = activityAnalysisResult(
			"worker-request-support-context-session-race",
			"sealed-support-context-session-race",
		);
		await harness.repository.archiveProactiveFeedbackEventStream({
			accountId: "account-a",
			id: analysis.request_id,
			sourceWindowId: "sealed-support-context-session-race",
			windowStartedAtMs: 1,
			windowEndedAtMs: 2,
			analysis,
			archivedAtMs: harness.clock(),
			consumedAtMs: null,
			consumedRunId: null,
		});
		const archiveReadStarted = deferred();
		const releaseArchiveRead = deferred();
		const getArchive = harness.repository.getProactiveFeedbackEventStream.bind(
			harness.repository,
		);
		harness.repository.getProactiveFeedbackEventStream = async (...args) => {
			archiveReadStarted.resolve();
			await releaseArchiveRead.promise;
			return getArchive(...args);
		};

		const starting = harness.coordinator.startActivityAnalysis({
			jobId: "activity-job-support-context-session-race",
			runId,
			requestId: "activity-request-support-context-session-race",
			consumedScore: 1,
			analyses: [analysis],
		});
		await archiveReadStarted.promise;
		harness.account.current = null;
		harness.account.generation += 1;
		releaseArchiveRead.resolve();

		await expect(starting).rejects.toThrow("登录会话");
		expect(
			harness.sidecar.calls.filter((call) => call.method === "activity.start"),
		).toEqual([]);
		expect(harness.sidecar.tracked.has(runId)).toBeFalse();
		await expect(
			harness.repository.getRun("account-a", runId),
		).resolves.toBeNull();
	});
});

class RecordingSidecar implements AgentSidecar {
	readonly calls: Array<{
		method: AgentHostMethod;
		params: Record<string, unknown>;
		options?: { requestId?: string; timeoutMs?: number };
	}> = [];
	readonly tracked = new Set<string>();

	request<TResult = unknown>(
		method: AgentHostMethod,
		params: Record<string, unknown>,
		options?: { requestId?: string; timeoutMs?: number },
	): Promise<TResult> {
		this.calls.push({ method, params: structuredClone(params), options });
		return Promise.resolve({ accepted: true } as TResult);
	}

	trackRun(runId: string): void {
		this.tracked.add(runId);
	}

	untrackRun(runId: string): void {
		this.tracked.delete(runId);
	}
}

class MemoryKeyStore implements CredentialKeyStore {
	private readonly keys = new Map<string, Uint8Array>();
	private counter = 0;

	async getKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const value = this.keys.get(referenceKey(reference));
		if (!value) throw new CredentialHelperError("NOT_FOUND");
		return value.slice();
	}

	async createKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const id = referenceKey(reference);
		if (this.keys.has(id)) throw new CredentialHelperError("ALREADY_EXISTS");
		this.counter += 1;
		const value = Uint8Array.from(
			{ length: 32 },
			(_, index) => (this.counter * 31 + index * 17) & 0xff,
		);
		this.keys.set(id, value);
		return value.slice();
	}

	async deleteKey(
		reference: CredentialKeyReference,
	): Promise<{ deleted: boolean }> {
		return { deleted: this.keys.delete(referenceKey(reference)) };
	}
}

function activityAnalysisResult(requestId: string, sourceEventId: string) {
	return {
		request_id: requestId,
		score: 1,
		score_reason: "与当前目标直接相关",
		events: [
			{
				source_event_ids: [sourceEventId],
				activity: "development",
				goal_relevance: "direct",
				confidence: 0.9,
				reason_codes: ["worker"],
				evidence: ["活动证据"],
				started_at_ms: 1,
				ended_at_ms: 2,
			},
		],
	};
}

async function advanceActivityModelRelayStages(
	coordinator: AgentRunCoordinator,
	runId: string,
): Promise<void> {
	for (const agentId of [
		MODEL_AGENT_IDS.activitySupportSupervisor,
		ACTIVITY_SUPPORT_SPECIALIST_AGENT_IDS.momentumCoach,
		MODEL_AGENT_IDS.activitySupportVoice,
	]) {
		await coordinator.runBoundModelRelayCall(
			runId,
			agentId,
			async (purpose) => {
				if (purpose !== "activity") {
					throw new Error("Expected an activity-bound model relay call.");
				}
			},
		);
	}
}

function createHarness(): {
	account: { current: string | null; generation: number };
	repository: EncryptedAgentRepository;
	sidecar: RecordingSidecar;
	coordinator: AgentRunCoordinator;
	events: InternalAgentRunEventEnvelope[];
	activityTerminals: Array<Record<string, unknown>>;
	executions: Record<string, unknown>[];
	relayAborts: string[];
	clock: () => number;
	advanceClock(milliseconds: number): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-agent-coordinator-"));
	temporaryDirectories.push(directory);
	let now = 1_000_000;
	const clock = () => now++;
	const advanceClock = (milliseconds: number): void => {
		now += milliseconds;
	};
	const repository = new EncryptedAgentRepository({
		databasePath: join(directory, "agent.sqlite3"),
		installationId: "installation-test",
		keyStore: new MemoryKeyStore(),
		now: clock,
	});
	openRepositories.push(repository);
	const account = { current: "account-a" as string | null, generation: 1 };
	const sidecar = new RecordingSidecar();
	const events: InternalAgentRunEventEnvelope[] = [];
	const activityTerminals: Array<Record<string, unknown>> = [];
	const executions: Record<string, unknown>[] = [];
	const relayAborts: string[] = [];
	const coordinator = new AgentRunCoordinator({
		sessionIdentity: () => sessionIdentity(account),
		repository,
		sidecar,
		abortModelRelay: (runId) => {
			relayAborts.push(runId);
			return true;
		},
		toolPolicy: new AgentToolPolicy(repository, clock),
		toolExecutor: {
			execute: async (input) => {
				executions.push(structuredClone(input));
				return { committed: true };
			},
		},
		onEvent: (event) => events.push(structuredClone(event)),
		onActivityRunTerminal: (input) => {
			activityTerminals.push(structuredClone(input));
		},
		now: clock,
	});
	return {
		account,
		repository,
		sidecar,
		coordinator,
		events,
		activityTerminals,
		executions,
		relayAborts,
		clock,
		advanceClock,
	};
}

type CoordinatorHarness = ReturnType<typeof createHarness>;

function sessionIdentity(account: {
	current: string | null;
	generation: number;
}) {
	return account.current
		? {
				accountId: account.current,
				sessionId: `session-${account.current}-${account.generation}`,
				generation: account.generation,
			}
		: null;
}

function restartCoordinator(
	harness: CoordinatorHarness,
	sidecar: RecordingSidecar = new RecordingSidecar(),
): AgentRunCoordinator {
	return new AgentRunCoordinator({
		sessionIdentity: () => sessionIdentity(harness.account),
		repository: harness.repository,
		sidecar,
		abortModelRelay: (runId) => {
			harness.relayAborts.push(runId);
			return true;
		},
		toolPolicy: new AgentToolPolicy(harness.repository, harness.clock),
		toolExecutor: {
			execute: async (input) => {
				harness.executions.push(structuredClone(input));
				return { committed: true };
			},
		},
		onEvent: (event) => harness.events.push(structuredClone(event)),
		onActivityRunTerminal: (input) => {
			harness.activityTerminals.push(structuredClone(input));
		},
		now: harness.clock,
	});
}

async function persistSuspendedCalendarApproval(
	harness: CoordinatorHarness,
	suffix: string,
): Promise<{
	runId: string;
	toolCallId: string;
	argumentsValue: ReturnType<typeof calendarCreateArguments>;
	approval: {
		approvalId: string;
		inputDigest: string;
		runVersion: number;
	};
}> {
	const started = await harness.coordinator.startConversationTurn({
		requestId: `request-${suffix}`,
		clientMessageId: `client-${suffix}`,
		text: "请创建日程",
	});
	if (started.kind !== "success") throw new Error("tool run was not accepted");
	const toolCallId = `tool-call-${suffix}`;
	const argumentsValue = calendarCreateArguments(`event-${suffix}`);
	const approval = (await harness.coordinator.propose("account-a", {
		runId: started.data.runId,
		toolCallId,
		name: "calendar.create_event",
		arguments: argumentsValue,
	})) as {
		approvalId: string;
		inputDigest: string;
		runVersion: number;
	};
	harness.coordinator.acceptSidecarEvent(
		runEvent(
			started.data.runId,
			1,
			{
				kind: "run.suspended",
				suspendPayload: { approvalId: approval.approvalId },
			},
			null,
		),
	);
	await waitFor(
		async () =>
			(await harness.repository.getRun("account-a", started.data.runId))
				?.status === "suspended",
	);
	return { runId: started.data.runId, toolCallId, argumentsValue, approval };
}

function calendarCreateArguments(eventId: string) {
	return {
		event: {
			id: eventId,
			title: "深度工作",
			kind: "manual-block",
			state: "committed",
			schedule: {
				allDay: false,
				start: "2026-08-03T01:00:00.000Z",
				end: "2026-08-03T02:00:00.000Z",
				timeZone: "Asia/Shanghai",
			},
			recurrence: null,
			occurrenceId: null,
			sourcePlanId: null,
			editable: true,
			version: 0,
		},
	};
}

function referenceKey(reference: CredentialKeyReference): string {
	return `${reference.installationId}:${reference.accountId}:v${reference.keyVersion}`;
}

function runEvent(
	runId: string,
	sequence: number,
	event: AgentRunEventFrame["event"],
	terminalState: AgentRunEventFrame["terminalState"] = "failed",
): AgentRunEventFrame {
	return {
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		type: "event",
		requestId: `sidecar-${sequence}`,
		runId,
		sequence,
		version: sequence,
		emittedAtMs: 2_000_000 + sequence,
		terminalState,
		event,
	};
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline)
			throw new Error("Timed out waiting for asynchronous coordinator state.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function planningInput(): TaskPlanningInput {
	return {
		goal: "完成本地 Agent 重构",
		planType: "short-term",
		deadline: "2026-08-31",
		priority: "high",
		weeklyCapacityHours: 20,
		unavailableDays: [],
		preferredSessionMinutes: 60,
		preferredDayPart: "morning",
		timeZone: "Asia/Shanghai",
	};
}

function planningDraft(): TaskPlanningDraft {
	return {
		id: "draft-1",
		title: "本地 Agent 重构计划",
		assumptions: ["远端只转发模型请求"],
		calendarRevision: 7,
		phases: [
			{
				id: "phase-1",
				title: "本地运行",
				objective: "完成本地 Agent 链路",
				order: 1,
			},
		],
		milestones: [
			{
				id: "milestone-1",
				phaseId: "phase-1",
				title: "完成 Sidecar",
				description: "打通本地运行链路",
				targetDate: "2026-08-10",
				acceptanceCriteria: ["本地运行通过"],
			},
		],
		tasks: [
			{
				id: "task-1",
				milestoneId: "milestone-1",
				title: "验证规划冲突",
				description: "保留冲突草案",
				estimatedMinutes: 60,
				importance: "high",
				dependencies: [],
				completionCriteria: ["冲突不自动提交"],
			},
		],
		schedule: [
			{
				id: "schedule-1",
				taskId: "task-1",
				title: "验证规划冲突",
				start: "2026-08-03T01:00:00.000Z",
				end: "2026-08-03T02:00:00.000Z",
				timeZone: "Asia/Shanghai",
			},
		],
		unscheduledTaskIds: [],
	};
}
