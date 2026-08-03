import type { ActiveGoalContextV1 } from "../shared/goal-context";
import type { CalendarConflict, CalendarEvent, CalendarMutation } from "../shared/calendar";
import {
	PLANNING_AUTHORITY_SCHEMA_VERSION,
	type CommitPlanningDraftRequest,
	type PlanningAuthorityConflict,
	type PlanningAuthorityDraft,
	type PlanningAuthorityInput,
	type PlanningAuthorityRpcResult,
	type PlanningAuthoritySnapshot,
	type PlanningCommitResult,
	type SavePlanningDraftRequest,
} from "../shared/planning-authority";
import type { LocalTestSessionIdentity } from "./local-test-auth-session";
import {
	CalendarRevisionConflictError,
	PlanningAuthorityRevisionConflictError,
	type EncryptedAgentRepository,
} from "./encrypted-agent-repository";
import { CalendarPolicyError, validateCalendarEvent } from "./calendar-policy";
import type { CalendarRepository } from "./calendar-repository";
import { planningDraftDigest } from "./planning-authority-digest";

const MAX_PROPOSALS = 500;
const MAX_COLLECTION = 2_000;
const MAX_TEXT = 4_096;

export interface PlanningAuthorityServiceOptions {
	currentSession(): LocalTestSessionIdentity | null;
	isCurrentSession(identity: LocalTestSessionIdentity): boolean;
	repository: Pick<
		EncryptedAgentRepository,
		| "getPlanningAuthority"
		| "compareAndSetPlanningAuthority"
		| "commitCalendarAndPlanningAuthority"
	>;
	calendar: Pick<CalendarRepository, "prepareMutationBatch">;
	currentActiveGoal?(accountId: string): ActiveGoalContextV1 | null;
	applyActiveGoal(
		goal: Omit<ActiveGoalContextV1, "version">,
	): Promise<ActiveGoalContextV1>;
	now?: () => number;
}

export class PlanningAuthorityService {
	private readonly now: () => number;
	private readonly effectFlights = new Map<string, Promise<PlanningAuthoritySnapshot>>();

	constructor(private readonly options: PlanningAuthorityServiceOptions) {
		this.now = options.now ?? Date.now;
	}

	async load(): Promise<PlanningAuthorityRpcResult<PlanningAuthoritySnapshot | null>> {
		try {
			const identity = this.requireSession();
			let snapshot = await this.options.repository.getPlanningAuthority(identity.accountId);
			this.requireCurrent(identity);
			if (
				snapshot?.status === "committed" &&
				snapshot.commit?.effect.status === "applied" &&
				snapshot.activeGoal &&
				this.options.currentActiveGoal &&
				!sameGoal(this.options.currentActiveGoal(identity.accountId), snapshot.activeGoal)
			) {
				snapshot = await this.reopenGoalEffect(identity, snapshot);
			}
			if (snapshot?.commit?.effect.status === "pending") {
				snapshot = await this.applyPendingEffect(identity, snapshot);
			}
			this.requireCurrent(identity);
			return { kind: "success", data: clone(snapshot) };
		} catch (error) {
			return authorityError(error);
		}
	}

	private async reopenGoalEffect(
		identity: LocalTestSessionIdentity,
		snapshot: PlanningAuthoritySnapshot,
	): Promise<PlanningAuthoritySnapshot> {
		if (!snapshot.commit || !snapshot.activeGoal) return snapshot;
		const reopened: PlanningAuthoritySnapshot = {
			...clone(snapshot),
			revision: snapshot.revision + 1,
			commit: {
				...clone(snapshot.commit),
				effect: {
					...clone(snapshot.commit.effect),
					status: "pending",
					lastError: "日历已确认，正在恢复当前账户的本地目标上下文。",
				},
			},
			updatedAtMs: this.now(),
		};
		const saved = await this.options.repository.compareAndSetPlanningAuthority(
			identity.accountId,
			reopened,
			snapshot.revision,
			() => this.requireCurrent(identity),
		);
		this.requireCurrent(identity);
		return saved
			? reopened
			: (await this.options.repository.getPlanningAuthority(identity.accountId)) ?? snapshot;
	}

	async saveDraft(
		request: SavePlanningDraftRequest,
	): Promise<PlanningAuthorityRpcResult<PlanningAuthoritySnapshot>> {
		try {
			validateSaveRequest(request);
			const identity = this.requireSession();
			const current = await this.options.repository.getPlanningAuthority(identity.accountId);
			this.requireCurrent(identity);
			const actualRevision = current?.revision ?? null;
			if (actualRevision !== request.expectedRevision) {
				return conflict(
					"计划草案已在其他窗口发生变化，请恢复最新版本后再保存。",
					actualRevision ?? 0,
				);
			}
			if (current?.commit?.effect.status === "pending") {
				return conflict(
					"上一份计划已经写入日历，但目标事件仍待同步；请先恢复该提交。",
					current.revision,
				);
			}
			const updatedAtMs = this.now();
			const snapshot: PlanningAuthoritySnapshot = {
				schemaVersion: PLANNING_AUTHORITY_SCHEMA_VERSION,
				revision: (actualRevision ?? 0) + 1,
				status: "draft",
				input: clone(request.input),
				draft: clone(request.draft),
				confirmedPlan: clone(current?.confirmedPlan ?? null),
				activeGoal: clone(current?.activeGoal ?? null),
				commit: clone(current?.commit ?? null),
				updatedAtMs,
			};
			const saved = await this.options.repository.compareAndSetPlanningAuthority(
				identity.accountId,
				snapshot,
				actualRevision,
				() => this.requireCurrent(identity),
			);
			this.requireCurrent(identity);
			if (!saved) {
				const latest = await this.options.repository.getPlanningAuthority(identity.accountId);
				return conflict(
					"计划草案保存时版本发生变化，请恢复后重试。",
					latest?.revision ?? 0,
				);
			}
			return { kind: "success", data: clone(snapshot) };
		} catch (error) {
			return authorityError(error);
		}
	}

	async commitDraft(
		request: CommitPlanningDraftRequest,
	): Promise<PlanningAuthorityRpcResult<PlanningCommitResult>> {
		try {
			validateCommitRequest(request);
			const identity = this.requireSession();
			let current = await this.options.repository.getPlanningAuthority(identity.accountId);
			this.requireCurrent(identity);
			if (!current) return { kind: "not-found", message: "没有可确认的本地计划草案。" };
			validateAuthorityAggregate(current);

			if (current.status === "committed") {
				if (current.commit?.commitId !== request.commitId) {
					return conflict("这份草案已经使用另一提交写入日历。", current.revision);
				}
				if (current.commit.effect.status === "pending") {
					current = await this.applyPendingEffect(identity, current);
				}
				this.requireCurrent(identity);
				return {
					kind: "success",
					data: commitResult(current, true),
				};
			}
			if (current.revision !== request.expectedRevision) {
				return conflict(
					"计划草案版本已变化，请恢复最新版本后再确认。",
					current.revision,
				);
			}
			if (current.draft.plan.calendarRevision !== request.expectedCalendarRevision) {
				return conflict(
					"草案所依据的日历版本与确认请求不一致，请重新生成或恢复草案。",
					current.revision,
				);
			}

			const mutations = scheduleMutations(current.draft, this.now());
			const prepared = await this.options.calendar.prepareMutationBatch(
				identity.accountId,
				request.commitId,
				mutations,
				request.expectedCalendarRevision,
			);
			this.requireCurrent(identity);
			if (!prepared.ok) {
				return conflict(
					prepared.conflicts[0]?.message ?? "日历在确认前发生变化，请恢复草案。",
					current.revision,
				);
			}
			const committedAtMs = this.now();
			const desiredGoal: ActiveGoalContextV1 = {
				schemaVersion: "active-goal.v1",
				goalId: current.draft.plan.id,
				planId: current.draft.plan.id,
				version: (current.activeGoal?.version ?? 0) + 1,
				text: current.input.goal.trim(),
				activatedAtMs: committedAtMs,
			};
			const authority: PlanningAuthoritySnapshot = {
				...clone(current),
				revision: current.revision + 1,
				status: "committed",
				confirmedPlan: clone(current.draft.plan),
				activeGoal: desiredGoal,
				commit: {
					commitId: request.commitId,
					draftRevision: current.revision,
					draftDigest: planningDraftDigest(current.input, current.draft),
					calendarRevision: request.expectedCalendarRevision + 1,
					committedAtMs,
					committedCount: prepared.events.length,
					warnings: prepared.warnings.map(calendarWarning),
					effect: {
						status: "pending",
						attempts: 0,
						lastAttemptAtMs: null,
						lastError: null,
					},
				},
				updatedAtMs: committedAtMs,
			};
			const committed = await this.options.repository.commitCalendarAndPlanningAuthority(
				identity.accountId,
				{
					commitId: request.commitId,
					expectedAuthorityRevision: current.revision,
					calendar: prepared.commit,
					authority,
					beforeCommit: () => this.requireCurrent(identity),
				},
			);
			this.requireCurrent(identity);
			current = committed.idempotent
				? (await this.options.repository.getPlanningAuthority(identity.accountId))!
				: authority;
			if (!current) throw new Error("Committed planning authority could not be reloaded.");
			if (current.commit?.effect.status === "pending") {
				current = await this.applyPendingEffect(identity, current);
			}
			this.requireCurrent(identity);
			return {
				kind: "success",
				data: commitResult(current, committed.idempotent),
			};
		} catch (error) {
			if (error instanceof PlanningAuthorityRevisionConflictError) {
				return conflict(
					"计划草案版本已变化，请恢复最新版本后再确认。",
					error.actualRevision,
				);
			}
			if (error instanceof CalendarRevisionConflictError) {
				return conflict(
					"日历在确认期间发生变化；草案仍已保留，请检查后重试。",
					request.expectedRevision,
				);
			}
			return authorityError(error);
		}
	}

	private applyPendingEffect(
		identity: LocalTestSessionIdentity,
		snapshot: PlanningAuthoritySnapshot,
	): Promise<PlanningAuthoritySnapshot> {
		const existing = this.effectFlights.get(identity.accountId);
		if (existing) return existing;
		const operation = this.performPendingEffect(identity, snapshot).finally(() => {
			if (this.effectFlights.get(identity.accountId) === operation) {
				this.effectFlights.delete(identity.accountId);
			}
		});
		this.effectFlights.set(identity.accountId, operation);
		return operation;
	}

	private async performPendingEffect(
		identity: LocalTestSessionIdentity,
		snapshot: PlanningAuthoritySnapshot,
	): Promise<PlanningAuthoritySnapshot> {
		if (snapshot.commit?.effect.status !== "pending" || !snapshot.activeGoal) return snapshot;
		this.requireCurrent(identity);
		const attemptedAtMs = this.now();
		try {
			const normalized = await this.options.applyActiveGoal({
				schemaVersion: "active-goal.v1",
				goalId: snapshot.activeGoal.goalId,
				planId: snapshot.activeGoal.planId,
				text: snapshot.activeGoal.text,
				activatedAtMs: snapshot.activeGoal.activatedAtMs,
			});
			this.requireCurrent(identity);
			const applied: PlanningAuthoritySnapshot = {
				...clone(snapshot),
				revision: snapshot.revision + 1,
				activeGoal: clone(normalized),
				commit: {
					...clone(snapshot.commit),
					effect: {
						status: "applied",
						attempts: snapshot.commit.effect.attempts + 1,
						lastAttemptAtMs: attemptedAtMs,
						lastError: null,
					},
				},
				updatedAtMs: this.now(),
			};
			const saved = await this.options.repository.compareAndSetPlanningAuthority(
				identity.accountId,
				applied,
				snapshot.revision,
				() => this.requireCurrent(identity),
			);
			this.requireCurrent(identity);
			if (saved) return applied;
			return (await this.options.repository.getPlanningAuthority(identity.accountId)) ?? snapshot;
		} catch {
			if (!this.options.isCurrentSession(identity)) return snapshot;
			const pending: PlanningAuthoritySnapshot = {
				...clone(snapshot),
				revision: snapshot.revision + 1,
				commit: {
					...clone(snapshot.commit),
					effect: {
						status: "pending",
						attempts: snapshot.commit.effect.attempts + 1,
						lastAttemptAtMs: attemptedAtMs,
						lastError: "计划已写入日历，但目标与本地事件日志尚未同步；下次恢复时会继续重试。",
					},
				},
				updatedAtMs: this.now(),
			};
			const saved = await this.options.repository.compareAndSetPlanningAuthority(
				identity.accountId,
				pending,
				snapshot.revision,
				() => this.requireCurrent(identity),
			);
			return saved
				? pending
				: (await this.options.repository.getPlanningAuthority(identity.accountId)) ?? snapshot;
		}
	}

	private requireSession(): LocalTestSessionIdentity {
		const identity = this.options.currentSession();
		if (!identity) throw new PlanningAuthorityUnavailableError();
		return identity;
	}

	private requireCurrent(identity: LocalTestSessionIdentity): void {
		if (!this.options.isCurrentSession(identity)) {
			throw new PlanningAuthorityUnavailableError("登录会话已发生变化，旧规划操作已停止。");
		}
	}
}

class PlanningAuthorityUnavailableError extends Error {
	constructor(message = "需要有效的本地测试账户会话。") {
		super(message);
		this.name = "PlanningAuthorityUnavailableError";
	}
}

function scheduleMutations(
	draft: PlanningAuthorityDraft,
	nowMs: number,
): CalendarMutation[] {
	if (draft.proposals.length < 1 || draft.proposals.length > MAX_PROPOSALS) {
		throw new CalendarPolicyError("invalid-batch", "计划排程数量必须在 1 到 500 之间。");
	}
	const ids = new Set<string>();
	return draft.proposals.map((proposal, index) => {
		if (ids.has(proposal.id)) throw new Error("计划排程包含重复 ID。");
		ids.add(proposal.id);
		if (proposal.sourcePlanId !== draft.plan.id || proposal.state !== "proposed") {
			throw new Error("计划排程与当前草案不匹配。");
		}
		const event: CalendarEvent = {
			id: proposal.id,
			title: proposal.title,
			kind: "plan",
			state: "committed",
			schedule: {
				allDay: false,
				start: proposal.start,
				end: proposal.end,
				timeZone: proposal.timeZone,
			},
			recurrence: null,
			occurrenceId: null,
			sourcePlanId: draft.plan.id,
			editable: true,
			version: 0,
		};
		validateCalendarEvent(event);
		return {
			mutationId: `plan-commit-${nowMs}-${index}`,
			kind: "create",
			eventId: event.id,
			expectedVersion: null,
			before: null,
			after: event,
			recurrenceScope: null,
		};
	});
}

function calendarWarning(conflictValue: CalendarConflict): PlanningAuthorityConflict {
	return {
		proposalId: conflictValue.affectedEventIds[0] ?? null,
		busyWindowId: conflictValue.affectedEventIds[1] ?? null,
		reason: conflictValue.reason === "overlaps-manual-block"
			? "manual-block"
			: conflictValue.reason === "overlaps-external-event"
				? "external-event"
				: conflictValue.reason === "overlaps-committed-plan"
					? "committed-plan"
					: "agent-validation",
		severity: conflictValue.severity,
		message: conflictValue.message,
		suggestions: ["move-session"],
	};
}

function commitResult(
	snapshot: PlanningAuthoritySnapshot,
	idempotent: boolean,
): PlanningCommitResult {
	if (snapshot.status !== "committed" || !snapshot.commit) {
		throw new Error("Planning commit result is incomplete.");
	}
	return {
		snapshot: clone(snapshot),
		calendarCommitted: true,
		idempotent,
		effectsApplied: snapshot.commit.effect.status === "applied",
	};
}

function validateSaveRequest(request: SavePlanningDraftRequest): void {
	assertExactKeys(request, ["draft", "expectedRevision", "input", "requestId"]);
	boundedId(request.requestId, "requestId");
	if (request.expectedRevision !== null) nonNegativeInteger(request.expectedRevision, "expectedRevision");
	validateInput(request.input);
	validateDraft(request.draft, request.input);
}

function validateCommitRequest(request: CommitPlanningDraftRequest): void {
	assertExactKeys(request, ["commitId", "expectedCalendarRevision", "expectedRevision", "requestId"]);
	boundedId(request.requestId, "requestId");
	boundedId(request.commitId, "commitId");
	nonNegativeInteger(request.expectedRevision, "expectedRevision");
	nonNegativeInteger(request.expectedCalendarRevision, "expectedCalendarRevision");
}

function validateAuthorityAggregate(snapshot: PlanningAuthoritySnapshot): void {
	validateInput(snapshot.input);
	validateDraft(snapshot.draft, snapshot.input);
}

function validateInput(input: PlanningAuthorityInput): void {
	assertExactKeys(input, [
		"deadline",
		"goal",
		"preferredDayPart",
		"preferredSessionMinutes",
		"priority",
		"type",
		"unavailableDays",
		"weeklyCapacityHours",
	]);
	boundedText(input.goal, "goal", 1_000);
	dateOnly(input.deadline, "deadline");
	if (input.type !== "short-term" && input.type !== "long-term") throw new Error("plan type is invalid.");
	if (!["low", "medium", "high"].includes(input.priority)) throw new Error("priority is invalid.");
	if (!Number.isFinite(input.weeklyCapacityHours) || input.weeklyCapacityHours < 1 || input.weeklyCapacityHours > 40) {
		throw new Error("weekly capacity is invalid.");
	}
	if (![30, 45, 60, 90].includes(input.preferredSessionMinutes)) throw new Error("session duration is invalid.");
	if (!["morning", "afternoon", "evening", "flexible"].includes(input.preferredDayPart)) throw new Error("day part is invalid.");
	if (!Array.isArray(input.unavailableDays) || input.unavailableDays.length > 7 || new Set(input.unavailableDays).size !== input.unavailableDays.length) {
		throw new Error("unavailable days are invalid.");
	}
	for (const day of input.unavailableDays) {
		if (!["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(day)) {
			throw new Error("unavailable day is invalid.");
		}
	}
}

function validateDraft(draft: PlanningAuthorityDraft, input: PlanningAuthorityInput): void {
	assertExactKeys(draft, ["busyWindows", "conflicts", "plan", "proposals", "suggestions"]);
	if (!isRecord(draft.plan)) throw new Error("plan is invalid.");
	assertExactKeys(draft.plan, [
		"calendarRevision",
		"deadline",
		"generationRun",
		"goal",
		"id",
		"milestones",
		"phases",
		"priority",
		"scheduleWindow",
		"tasks",
		"title",
		"totalEstimatedMinutes",
		"type",
		"weeklyCapacityHours",
	]);
	boundedId(draft.plan.id, "plan.id");
	boundedText(draft.plan.title, "plan.title", 512);
	boundedText(draft.plan.goal, "plan.goal", 1_000);
	if (
		draft.plan.goal !== input.goal.trim() ||
		draft.plan.type !== input.type ||
		draft.plan.deadline !== input.deadline ||
		draft.plan.priority !== input.priority ||
		draft.plan.weeklyCapacityHours !== input.weeklyCapacityHours
	) {
		throw new Error("plan does not match its saved input.");
	}
	dateOnly(draft.plan.deadline, "plan.deadline");
	if (!Number.isSafeInteger(draft.plan.calendarRevision) || (draft.plan.calendarRevision ?? -1) < 0) {
		throw new Error("plan calendar revision is invalid.");
	}
	nonNegativeInteger(draft.plan.totalEstimatedMinutes, "plan.totalEstimatedMinutes");
	if (draft.plan.totalEstimatedMinutes > 10_000_000) throw new Error("plan.totalEstimatedMinutes is invalid.");
	boundedArray(draft.plan.phases, "plan.phases", MAX_COLLECTION);
	boundedArray(draft.plan.milestones, "plan.milestones", MAX_COLLECTION);
	boundedArray(draft.plan.tasks, "plan.tasks", MAX_COLLECTION);
	if (draft.plan.phases.length < 1) throw new Error("plan.phases is invalid.");
	boundedArray(draft.proposals, "proposals", MAX_PROPOSALS);
	boundedArray(draft.busyWindows, "busyWindows", MAX_COLLECTION);
	boundedArray(draft.conflicts, "conflicts", MAX_COLLECTION);
	boundedArray(draft.suggestions, "suggestions", MAX_COLLECTION);

	const phaseIds = new Set<string>();
	const phaseOrders = new Set<number>();
	for (const phase of draft.plan.phases) {
		if (!isRecord(phase)) throw new Error("plan phase is invalid.");
		assertExactKeys(phase, ["id", "objective", "order", "title"]);
		boundedId(phase.id, "phase.id");
		if (phaseIds.has(phase.id)) throw new Error("phase IDs must be unique.");
		phaseIds.add(phase.id);
		boundedText(phase.title, "phase.title", 512);
		boundedText(phase.objective, "phase.objective", MAX_TEXT);
		nonNegativeInteger(phase.order, "phase.order");
		if (phase.order > MAX_COLLECTION) throw new Error("phase.order is invalid.");
		if (phaseOrders.has(phase.order)) throw new Error("phase order must be unique.");
		phaseOrders.add(phase.order);
	}

	const milestoneIds = new Set<string>();
	for (const milestone of draft.plan.milestones) {
		if (!isRecord(milestone)) throw new Error("plan milestone is invalid.");
		assertExactKeys(milestone, ["id", "phaseId", "targetDate", "title"]);
		boundedId(milestone.id, "milestone.id");
		if (milestoneIds.has(milestone.id)) throw new Error("milestone IDs must be unique.");
		milestoneIds.add(milestone.id);
		boundedId(milestone.phaseId, "milestone.phaseId");
		if (!phaseIds.has(milestone.phaseId)) throw new Error("milestone references an unknown phase.");
		boundedText(milestone.title, "milestone.title", 512);
		dateOnly(milestone.targetDate, "milestone.targetDate");
	}

	const taskIds = new Set<string>();
	for (const task of draft.plan.tasks) {
		if (!isRecord(task)) throw new Error("plan task is invalid.");
		assertExactKeys(task, ["estimatedMinutes", "id", "milestoneId", "phaseId", "title"]);
		boundedId(task.id, "task.id");
		if (taskIds.has(task.id)) throw new Error("task IDs must be unique.");
		taskIds.add(task.id);
		boundedId(task.phaseId, "task.phaseId");
		if (!phaseIds.has(task.phaseId)) throw new Error("task references an unknown phase.");
		if (task.milestoneId !== null) {
			boundedId(task.milestoneId, "task.milestoneId");
			if (!milestoneIds.has(task.milestoneId)) throw new Error("task references an unknown milestone.");
		}
		boundedText(task.title, "task.title", 512);
		positiveInteger(task.estimatedMinutes, "task.estimatedMinutes", 525_600);
	}

	if (!isRecord(draft.plan.scheduleWindow)) throw new Error("plan schedule window is invalid.");
	assertExactKeys(draft.plan.scheduleWindow, ["endDateExclusive", "startDate"]);
	dateOnly(draft.plan.scheduleWindow.startDate, "scheduleWindow.startDate");
	dateOnly(draft.plan.scheduleWindow.endDateExclusive, "scheduleWindow.endDateExclusive");
	if (draft.plan.scheduleWindow.startDate >= draft.plan.scheduleWindow.endDateExclusive) {
		throw new Error("plan schedule window is invalid.");
	}
	if (!isRecord(draft.plan.generationRun)) throw new Error("generation run is invalid.");
	assertExactKeys(draft.plan.generationRun, ["completedAt", "id", "revision", "startedAt", "statuses"]);
	boundedId(draft.plan.generationRun.id, "generationRun.id");
	isoTimestamp(draft.plan.generationRun.startedAt, "generationRun.startedAt");
	isoTimestamp(draft.plan.generationRun.completedAt, "generationRun.completedAt");
	if (Date.parse(draft.plan.generationRun.startedAt) > Date.parse(draft.plan.generationRun.completedAt)) {
		throw new Error("generation run timestamps are invalid.");
	}
	nonNegativeInteger(draft.plan.generationRun.revision, "generationRun.revision");
	boundedArray(draft.plan.generationRun.statuses, "generationRun.statuses", 5);
	const allowedStatuses = new Set(["understood", "split-phases", "checking-calendar", "arranging", "ready"]);
	if (
		draft.plan.generationRun.statuses.length < 1 ||
		new Set(draft.plan.generationRun.statuses).size !== draft.plan.generationRun.statuses.length ||
		draft.plan.generationRun.statuses.some((status) => !allowedStatuses.has(status))
	) {
		throw new Error("generation run statuses are invalid.");
	}

	const proposalIds = new Set<string>();
	for (const proposal of draft.proposals) {
		if (!isRecord(proposal)) throw new Error("proposal is invalid.");
		assertExactKeys(proposal, ["end", "id", "sourcePlanId", "start", "state", "taskId", "timeZone", "title", "version"]);
		boundedId(proposal.id, "proposal.id");
		if (proposalIds.has(proposal.id)) throw new Error("proposal IDs must be unique.");
		proposalIds.add(proposal.id);
		boundedId(proposal.taskId, "proposal.taskId");
		if (!taskIds.has(proposal.taskId)) throw new Error("proposal references an unknown task.");
		boundedText(proposal.title, "proposal.title", 512);
		if (proposal.sourcePlanId !== draft.plan.id || proposal.state !== "proposed") throw new Error("proposal identity is invalid.");
		nonNegativeInteger(proposal.version, "proposal.version");
		const event: CalendarEvent = {
			id: proposal.id,
			title: proposal.title,
			kind: "plan",
			state: "proposed",
			schedule: { allDay: false, start: proposal.start, end: proposal.end, timeZone: proposal.timeZone },
			recurrence: null,
			occurrenceId: null,
			sourcePlanId: draft.plan.id,
			editable: true,
			version: proposal.version,
		};
		validateCalendarEvent(event);
	}

	const busyWindowIds = new Set<string>();
	for (const busy of draft.busyWindows) {
		if (!isRecord(busy)) throw new Error("busy window is invalid.");
		assertExactKeys(busy, ["end", "id", "kind", "start", "timeZone", "title"]);
		boundedId(busy.id, "busyWindow.id");
		if (busyWindowIds.has(busy.id)) throw new Error("busy window IDs must be unique.");
		busyWindowIds.add(busy.id);
		boundedText(busy.title, "busyWindow.title", 512);
		if (!["manual-block", "external", "committed-plan"].includes(busy.kind)) {
			throw new Error("busy window kind is invalid.");
		}
		validateCalendarEvent({
			id: busy.id,
			title: busy.title,
			kind: busy.kind === "committed-plan" ? "plan" : busy.kind,
			state: "committed",
			schedule: { allDay: false, start: busy.start, end: busy.end, timeZone: busy.timeZone },
			recurrence: null,
			occurrenceId: null,
			sourcePlanId: busy.kind === "committed-plan" ? "saved-plan" : null,
			editable: false,
			version: 0,
		});
	}

	for (const conflictValue of draft.conflicts) {
		if (!isRecord(conflictValue)) throw new Error("planning conflict is invalid.");
		assertExactKeys(conflictValue, ["busyWindowId", "message", "proposalId", "reason", "severity", "suggestions"]);
		if (conflictValue.proposalId !== null) {
			boundedId(conflictValue.proposalId, "conflict.proposalId");
			if (!proposalIds.has(conflictValue.proposalId)) throw new Error("conflict references an unknown proposal.");
		}
		if (conflictValue.busyWindowId !== null) {
			boundedId(conflictValue.busyWindowId, "conflict.busyWindowId");
			if (!busyWindowIds.has(conflictValue.busyWindowId)) throw new Error("conflict references an unknown busy window.");
		}
		if (![
			"manual-block",
			"external-event",
			"committed-plan",
			"insufficient-capacity",
			"invalid-duration",
			"agent-validation",
		].includes(conflictValue.reason)) throw new Error("planning conflict reason is invalid.");
		if (conflictValue.severity !== "warning" && conflictValue.severity !== "error") {
			throw new Error("planning conflict severity is invalid.");
		}
		boundedText(conflictValue.message, "conflict.message", MAX_TEXT);
		boundedArray(conflictValue.suggestions, "conflict.suggestions", 4);
		if (new Set(conflictValue.suggestions).size !== conflictValue.suggestions.length) {
			throw new Error("planning conflict suggestions must be unique.");
		}
		for (const suggestion of conflictValue.suggestions) {
			if (!["adjust-deadline", "reduce-scope", "increase-capacity", "move-session"].includes(suggestion)) {
				throw new Error("planning conflict suggestion is invalid.");
			}
		}
	}
	for (const suggestion of draft.suggestions) boundedText(suggestion, "suggestion", MAX_TEXT);
}

function assertExactKeys(value: object, expected: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
		throw new Error("Planning authority request contains unknown or missing fields.");
	}
}

function boundedArray(value: unknown, name: string, maximum: number): asserts value is readonly unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`${name} is invalid.`);
}

function boundedId(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256 || /\p{Cc}/u.test(value)) {
		throw new Error(`${name} is invalid.`);
	}
}

function boundedText(value: unknown, name: string, maximum: number): asserts value is string {
	if (typeof value !== "string" || value.trim().length < 1 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
		throw new Error(`${name} is invalid.`);
	}
}

function nonNegativeInteger(value: unknown, name: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} is invalid.`);
}

function positiveInteger(
	value: unknown,
	name: string,
	maximum: number,
): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
		throw new Error(`${name} is invalid.`);
	}
}

function isoTimestamp(value: unknown, name: string): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length > 64 ||
		!/^\d{4}-\d{2}-\d{2}T/.test(value) ||
		Number.isNaN(Date.parse(value))
	) {
		throw new Error(`${name} is invalid.`);
	}
}

function dateOnly(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error(`${name} is invalid.`);
	}
	const [year, month, day] = value.split("-").map(Number);
	const parsed = new Date(Date.UTC(year!, month! - 1, day!));
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() + 1 !== month ||
		parsed.getUTCDate() !== day
	) {
		throw new Error(`${name} is invalid.`);
	}
}

function conflict<T>(message: string, currentRevision: number): PlanningAuthorityRpcResult<T> {
	return { kind: "conflict", message, currentRevision };
}

function authorityError<T>(error: unknown): PlanningAuthorityRpcResult<T> {
	if (error instanceof PlanningAuthorityUnavailableError) {
		return { kind: "unavailable", message: error.message, retryable: true };
	}
	if (error instanceof CalendarPolicyError) {
		return { kind: "error", message: error.message, retryable: false };
	}
	return {
		kind: "error",
		message: "本地规划状态处理失败，请重试。",
		retryable: false,
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function sameGoal(
	left: ActiveGoalContextV1 | null,
	right: ActiveGoalContextV1,
): boolean {
	return left !== null &&
		left.goalId === right.goalId &&
		left.planId === right.planId &&
		left.text === right.text &&
		left.activatedAtMs === right.activatedAtMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
