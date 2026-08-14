import { Temporal } from "temporal-polyfill";
import type {
	AgentRunEventEnvelope,
	AgentRunRpcResult,
	AgentRunSnapshot,
} from "../../../../shared/agent-runs";
import type {
	TaskPlanningAnswer,
	TaskPlanningInput,
	TaskPlanningSession,
} from "../../../../shared/task-planning";
import {
	detectPlanningConflicts,
	type GeneratedPlanDraft,
	type Plan,
	type PlanInput,
	type PlanningBusyWindow,
	type Weekday,
} from "../../features/planning/domain";
import type {
	PlanningGenerationContext,
	PlanningGenerationResult,
	PlanningGenerationService,
	RestorablePlanningGeneration,
} from "../../features/planning/planning-service";

interface ActivePlanningRun {
	runId: string;
	revision: number;
}

type ClientApi = typeof import("../../rpc")["clientApi"];

/** Maps the local Mastra run into the existing review/confirmation flow. */
export class AgentPlanningGenerationService
	implements PlanningGenerationService
{
	private readonly sessions = new Map<string, ActivePlanningRun>();
	private active: ActivePlanningRun | null = null;

	async findRestorable(): Promise<RestorablePlanningGeneration | null> {
		const { clientApi } = await import("../../rpc");
		const listed = unwrap(
			await clientApi.listRestorableAgentRuns({
				kind: "task-planning",
			}),
		);
		const latest = [...listed.runs].sort(
			(left, right) => right.updatedAtMs - left.updatedAtMs,
		)[0];
		if (!latest) return null;
		const snapshot = unwrap(
			await clientApi.getAgentRunSnapshot({ runId: latest.runId }),
		);
		if (snapshot.kind !== "task-planning")
			throw new Error("可恢复运行不是规划类型。");
		return { runId: snapshot.runId, input: fromAgentInput(snapshot.input) };
	}

	async restore(
		run: RestorablePlanningGeneration,
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult> {
		const { clientApi } = await import("../../rpc");
		const snapshot = unwrap(
			await clientApi.getAgentRunSnapshot({ runId: run.runId }),
		);
		if (snapshot.kind !== "task-planning")
			throw new Error("可恢复运行不是规划类型。");
		this.active = { runId: snapshot.runId, revision: snapshot.revision };
		if (snapshot.session) {
			this.active = null;
			if (snapshot.session.status === "clarifying") {
				this.sessions.set(snapshot.session.id, {
					runId: snapshot.runId,
					revision: snapshot.revision,
				});
				return {
					kind: "clarification",
					sessionId: snapshot.session.id,
					questions: snapshot.session.questions,
				};
			}
			return {
				kind: "draft",
				draft: toGeneratedDraft(
					snapshot.session,
					run.input,
					availability,
					context,
				),
			};
		}
		if (snapshot.status === "interrupted") {
			this.active = null;
			throw new Error("计划生成曾被中断；已恢复输入，请重新生成。");
		}
		if (snapshot.status === "cancelling" || snapshot.status === "cancelled") {
			this.active = null;
			throw new Error("这次计划生成已经取消。");
		}
		if (snapshot.status === "failed") {
			this.active = null;
			throw new Error(snapshot.failure?.message ?? "计划生成失败。");
		}
		const waiter = createPlanningWaiter(
			clientApi,
			snapshot.requestId,
			context,
			snapshot.runId,
		);
		waiter.bindRun(snapshot.runId);
		try {
			const session = await waiter.result;
			this.active = null;
			if (session.status === "clarifying") {
				this.sessions.set(session.id, {
					runId: snapshot.runId,
					revision: waiter.revision(),
				});
				return {
					kind: "clarification",
					sessionId: session.id,
					questions: session.questions,
				};
			}
			return {
				kind: "draft",
				draft: toGeneratedDraft(session, run.input, availability, context),
			};
		} catch (error) {
			waiter.dispose();
			this.active = null;
			throw error;
		}
	}

	async generate(
		input: PlanInput,
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult> {
		this.notifyStart(context);
		const { clientApi } = await import("../../rpc");
		const requestId = crypto.randomUUID();
		const waiter = createPlanningWaiter(clientApi, requestId, context);
		try {
			const result = await clientApi.startTaskPlanningRun({
				requestId,
				input: toAgentInput(input, context.timeZone),
			});
			const accepted = unwrap(result);
			this.active = { runId: accepted.runId, revision: accepted.revision };
			waiter.bindRun(accepted.runId);
			const session = await waiter.result;
			this.active = null;
			if (context.isCancelled()) throw new Error("已取消计划生成。");
			if (session.status === "clarifying") {
				this.sessions.set(session.id, {
					runId: accepted.runId,
					revision: waiter.revision(),
				});
				return {
					kind: "clarification",
					sessionId: session.id,
					questions: session.questions,
				};
			}
			context.onStatus("ready");
			return {
				kind: "draft",
				draft: toGeneratedDraft(session, input, availability, context),
			};
		} catch (error) {
			waiter.dispose();
			this.active = null;
			throw error;
		}
	}

	async continueAfterClarification(
		input: PlanInput,
		sessionId: string,
		answers: readonly TaskPlanningAnswer[],
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult> {
		this.notifyStart(context);
		const active = this.sessions.get(sessionId);
		if (!active)
			throw new Error("找不到可恢复的本地澄清会话，请重新生成计划。");
		const { clientApi } = await import("../../rpc");
		const requestId = crypto.randomUUID();
		const waiter = createPlanningWaiter(
			clientApi,
			requestId,
			context,
			active.runId,
		);
		this.active = active;
		try {
			const accepted = unwrap(
				await clientApi.submitPlanningClarification({
					requestId,
					runId: active.runId,
					expectedRevision: active.revision,
					answers,
				}),
			);
			active.revision = accepted.revision;
			const session = await waiter.result;
			this.active = null;
			if (session.status === "clarifying") {
				this.sessions.set(session.id, {
					runId: active.runId,
					revision: waiter.revision(),
				});
				return {
					kind: "clarification",
					sessionId: session.id,
					questions: session.questions,
				};
			}
			this.sessions.delete(sessionId);
			context.onStatus("ready");
			return {
				kind: "draft",
				draft: toGeneratedDraft(session, input, availability, context),
			};
		} catch (error) {
			waiter.dispose();
			this.active = null;
			throw error;
		}
	}

	async cancel(): Promise<void> {
		const active = this.active;
		if (!active) return;
		const { clientApi } = await import("../../rpc");
		await clientApi.cancelAgentRun({
			requestId: crypto.randomUUID(),
			runId: active.runId,
			expectedRevision: active.revision,
		});
	}

	private notifyStart(context: PlanningGenerationContext): void {
		context.onStatus("understood");
		if (context.isCancelled()) throw new Error("已取消计划生成。");
	}
}

function createPlanningWaiter(
	clientApi: ClientApi,
	requestId: string,
	context: PlanningGenerationContext,
	initialRunId?: string,
): {
	result: Promise<TaskPlanningSession>;
	bindRun(runId: string): void;
	revision(): number;
	dispose(): void;
} {
	let runId = initialRunId;
	let latestRevision = 0;
	let settled = false;
	let resolveResult!: (session: TaskPlanningSession) => void;
	let rejectResult!: (error: Error) => void;
	const result = new Promise<TaskPlanningSession>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const unsubscribe = clientApi.onAgentRunEvent((envelope) => {
		if (envelope.requestId !== requestId && envelope.runId !== runId) return;
		latestRevision = Math.max(latestRevision, envelope.revision);
		acceptPlanningEvent(envelope, context, finish, fail);
	});
	const cancelPoll = setInterval(() => {
		if (!settled && context.isCancelled()) fail(new Error("已取消计划生成。"));
	}, 100);

	function finish(session: TaskPlanningSession): void {
		if (settled) return;
		settled = true;
		clearInterval(cancelPoll);
		unsubscribe();
		resolveResult(session);
	}
	function fail(error: Error): void {
		if (settled) return;
		settled = true;
		clearInterval(cancelPoll);
		unsubscribe();
		rejectResult(error);
	}
	return {
		result,
		bindRun(value) {
			runId = value;
			void clientApi.getAgentRunSnapshot({ runId: value }).then((snapshot) => {
				if (
					snapshot.kind !== "success" ||
					snapshot.data.kind !== "task-planning"
				)
					return;
				latestRevision = Math.max(latestRevision, snapshot.data.revision);
				acceptPlanningSnapshot(snapshot.data, context, finish, fail);
			});
		},
		revision: () => latestRevision,
		dispose: () => {
			if (settled) return;
			settled = true;
			clearInterval(cancelPoll);
			unsubscribe();
		},
	};
}

function acceptPlanningEvent(
	envelope: AgentRunEventEnvelope,
	context: PlanningGenerationContext,
	finish: (session: TaskPlanningSession) => void,
	fail: (error: Error) => void,
): void {
	const event = envelope.event;
	if (event.type === "run.started") context.onStatus("checking-calendar");
	if (event.type === "run.progress")
		context.onStatus(
			event.phase === "finalizing" ? "arranging" : "split-phases",
		);
	if (event.type === "planning.clarification.requested") {
		finish({
			id: event.sessionId,
			status: "clarifying",
			questions: event.questions,
		});
	}
	if (event.type === "planning.draft.ready") finish(event.session);
	if (event.type === "planning.completed") finish(event.session);
	if (event.type === "run.failed") fail(new Error(event.failure.message));
	if (event.type === "run.cancelled")
		fail(new Error(event.message ?? "已取消计划生成。"));
	if (event.type === "run.interrupted") fail(new Error(event.message));
}

function acceptPlanningSnapshot(
	snapshot: Extract<AgentRunSnapshot, { kind: "task-planning" }>,
	context: PlanningGenerationContext,
	finish: (session: TaskPlanningSession) => void,
	fail: (error: Error) => void,
): void {
	if (snapshot.session) finish(snapshot.session);
	else if (snapshot.status === "failed")
		fail(new Error(snapshot.failure?.message ?? "计划生成失败。"));
	else if (snapshot.status === "cancelled") fail(new Error("已取消计划生成。"));
	else if (snapshot.status === "running") context.onStatus("checking-calendar");
}

function unwrap<T>(result: AgentRunRpcResult<T>): T {
	if (result.kind === "success") return result.data;
	throw new Error(result.message);
}

function toAgentInput(input: PlanInput, timeZone: string): TaskPlanningInput {
	if (!input.type) throw new Error("生成计划前必须选择计划类型。");
	if (input.type === "fuzzy") {
		throw new Error("模糊计划只能通过本地动态计划运行时生成。");
	}
	return {
		goal: input.goal,
		planType: input.type,
		deadline: input.deadline,
		priority: input.priority,
		weeklyCapacityHours: input.weeklyCapacityHours,
		unavailableDays: input.unavailableDays,
		preferredSessionMinutes: input.preferredSessionMinutes,
		preferredDayPart: input.preferredDayPart,
		timeZone,
	};
}

function fromAgentInput(input: TaskPlanningInput): PlanInput {
	const unavailableDays = input.unavailableDays.filter(isWeekday);
	if (unavailableDays.length !== input.unavailableDays.length) {
		throw new Error("本地规划快照包含无效的不可用星期，已拒绝恢复。");
	}
	return {
		goal: input.goal,
		type: input.planType,
		deadline: input.deadline,
		priority: input.priority,
		weeklyCapacityHours: input.weeklyCapacityHours,
		unavailableDays,
		preferredSessionMinutes: input.preferredSessionMinutes,
		preferredDayPart: input.preferredDayPart,
	};
}

function isWeekday(value: string): value is Weekday {
	return [
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
		"sunday",
	].includes(value);
}

function toGeneratedDraft(
	session: Exclude<TaskPlanningSession, { status: "clarifying" }>,
	input: PlanInput,
	busyWindows: readonly PlanningBusyWindow[],
	context: PlanningGenerationContext,
): GeneratedPlanDraft {
	const agentDraft = session.draft;
	if (!input.type) throw new Error("生成计划前必须选择计划类型。");
	const planId = agentDraft.id;
	const phases = agentDraft.phases.map((phase) => ({ ...phase }));
	const phaseByMilestone = new Map(
		agentDraft.milestones.map((milestone) => [milestone.id, milestone.phaseId]),
	);
	const plan: Plan = {
		id: planId,
		type: input.type,
		title: agentDraft.title,
		goal: input.goal.trim(),
		deadline: input.deadline,
		priority: input.priority,
		weeklyCapacityHours: input.weeklyCapacityHours,
		calendarRevision: agentDraft.calendarRevision,
		totalEstimatedMinutes: agentDraft.tasks.reduce(
			(total, task) => total + task.estimatedMinutes,
			0,
		),
		phases,
		milestones: agentDraft.milestones.map((milestone) => ({
			id: milestone.id,
			phaseId: milestone.phaseId,
			title: milestone.title,
			targetDate: validDate(milestone.targetDate)
				? milestone.targetDate
				: input.deadline,
		})),
		tasks: agentDraft.tasks.map((task) => ({
			id: task.id,
			phaseId:
				phaseByMilestone.get(task.milestoneId) ??
				phases[0]?.id ??
				`${planId}-phase-unassigned`,
			milestoneId: task.milestoneId,
			title: task.title,
			estimatedMinutes: Math.max(15, task.estimatedMinutes),
		})),
		scheduleWindow: {
			startDate: context.today,
			endDateExclusive: Temporal.PlainDate.from(input.deadline)
				.add({ days: 1 })
				.toString(),
		},
		generationRun: {
			id: `agent-${session.id}`,
			startedAt: Temporal.Now.instant().toString(),
			completedAt: Temporal.Now.instant().toString(),
			statuses: [
				"understood",
				"split-phases",
				"checking-calendar",
				"arranging",
				"ready",
			],
			revision: context.revision,
		},
	};
	const proposals = agentDraft.schedule.map((proposal) => ({
		id: proposal.id,
		sourcePlanId: planId,
		taskId: proposal.taskId,
		title: proposal.title,
		state: "proposed" as const,
		start: proposal.start,
		end: proposal.end,
		timeZone: proposal.timeZone,
		version: 0,
	}));
	const conflicts = [
		...detectPlanningConflicts(proposals, busyWindows),
		...(session.status === "conflict"
			? session.validationIssues.map((issue) => ({
					proposalId: issue.proposalId ?? null,
					busyWindowId: issue.busyEventIds?.[0] ?? null,
					reason: "agent-validation" as const,
					severity: "error" as const,
					message: issue.message,
					suggestions: ["move-session" as const],
				}))
			: []),
	];
	return {
		plan,
		proposals,
		busyWindows,
		conflicts,
		suggestions:
			conflicts.length > 0
				? ["草案保留了冲突，请调整后再确认写入。"]
				: agentDraft.unscheduledTaskIds.length > 0
					? ["部分任务因容量限制未安排，可调整约束后重新生成。"]
					: [],
	};
}

function validDate(value: string | undefined): value is string {
	if (!value) return false;
	try {
		Temporal.PlainDate.from(value);
		return true;
	} catch {
		return false;
	}
}
