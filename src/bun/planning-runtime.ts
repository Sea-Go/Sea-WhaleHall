import type { AgentRuntime } from "../agent/agent-runtime";
import {
	localDateAt,
	NativePlanningCalendar,
	NativePlanningRepository,
	type PlanningModelPort,
	type PlanningObservationPort,
	type PlanningObservationQuery,
	type PlanningObservationSummary,
	type PlanningPlan,
	PlanningRuntime,
	projectTimelinePlanningObservation,
	scheduledTaskIntervals,
} from "../agent/planning";
import type { AgentInputV1 } from "../agent/timeline-v2/types";
import type {
	PlanningAdjustmentProjection,
	PlanningChangeProjection,
	PlanningMonitoringProjection,
	PlanningPlanProjection,
	PlanningPlanSummaryProjection,
} from "../shared/planning";

export interface PlanningRuntimeNotifications {
	planChanged(change: PlanningChangeProjection): void;
	calendarChanged(version: number): void;
}

export class WhaleHallPlanningRuntime {
	readonly runtime: PlanningRuntime;
	private readonly repository: NativePlanningRepository;
	private readonly observations: PlanningObservationInbox;
	private calendarVersion = 0;
	private flushingOutbox = false;
	private nextVaultMaintenanceAtMs = 0;

	constructor(
		private readonly agent: AgentRuntime,
		private readonly notifications: PlanningRuntimeNotifications,
		timeZone: string | (() => string),
		model: PlanningModelPort,
	) {
		this.observations = new PlanningObservationInbox();
		this.repository = new NativePlanningRepository(agent);
		this.runtime = new PlanningRuntime({
			repository: this.repository,
			calendar: new NativePlanningCalendar(agent),
			model,
			observations: this.observations,
			timeZone,
		});
	}

	/** Run the fail-closed planning Vault collector at most once per local day. */
	async collectVaultGarbageIfDue(nowMs = Date.now()): Promise<void> {
		if (nowMs < this.nextVaultMaintenanceAtMs) return;
		try {
			const result = await this.repository.collectVaultGarbage();
			this.nextVaultMaintenanceAtMs =
				nowMs +
				(result.status === "completed"
					? 24 * 60 * 60 * 1_000
					: 60 * 60 * 1_000);
		} catch (error) {
			// Inventory or Vault outages never make deletion permissive. Retry on
			// a bounded cadence without turning the one-minute maintenance loop
			// into a full encrypted-record scan.
			this.nextVaultMaintenanceAtMs = nowMs + 60 * 60 * 1_000;
			throw error;
		}
	}

	async listPlans(): Promise<PlanningPlanSummaryProjection[]> {
		const plans = await this.runtime.listPlans();
		return plans.map(projectSummary);
	}

	async getPlan(planId: string): Promise<PlanningPlanProjection> {
		return this.projectPlan(await this.runtime.getPlan(planId));
	}

	async createPlanDraft(command: {
		input: { goal: string; startToday: boolean };
		operationId: string;
	}): Promise<PlanningPlan> {
		return this.afterWrite(
			await this.runtime.createPlanDraft(command),
			"created",
		);
	}

	async sendPlanMessage(command: {
		planId: string;
		content: string;
		operationId: string;
		expectedVersion: number;
	}): Promise<PlanningPlan> {
		return this.afterWrite(
			await this.runtime.sendPlanMessage(command),
			"analysis",
		);
	}

	async confirmPlanRevision(command: {
		planId: string;
		revisionId: string;
		operationId: string;
		expectedVersion: number;
	}): Promise<PlanningPlan> {
		return this.afterWrite(
			await this.runtime.confirmPlanRevision(command),
			"activated",
			true,
		);
	}

	async setTaskStatus(
		command: Parameters<PlanningRuntime["setTaskStatus"]>[0],
	) {
		return this.afterWrite(
			await this.runtime.setTaskStatus(command),
			"progress",
			true,
		);
	}

	async confirmObservationAttribution(
		command: Parameters<PlanningRuntime["confirmObservationAttribution"]>[0],
	) {
		const updated = await this.afterWrite(
			await this.runtime.confirmObservationAttribution(command),
			"adjusted",
			true,
		);
		// One Timeline interval can be presented to several plans when it was
		// outside every schedule or overlapped multiple plan slots. Once the user
		// chooses one task, clear the same pending attribution from every other
		// plan so the evidence cannot be counted twice.
		if (command.taskId !== null) {
			await this.dismissObservationFromOtherPlans(
				command.planId,
				command.observationId,
			);
		}
		return updated;
	}

	async pausePlan(command: Parameters<PlanningRuntime["pausePlan"]>[0]) {
		return this.afterWrite(await this.runtime.pausePlan(command), "status");
	}
	async resumePlan(command: Parameters<PlanningRuntime["resumePlan"]>[0]) {
		return this.afterWrite(
			await this.runtime.resumePlan(command),
			"status",
			true,
		);
	}
	async completePlan(command: Parameters<PlanningRuntime["completePlan"]>[0]) {
		return this.afterWrite(await this.runtime.completePlan(command), "status");
	}
	async archivePlan(command: Parameters<PlanningRuntime["archivePlan"]>[0]) {
		return this.afterWrite(await this.runtime.archivePlan(command), "status");
	}
	async undoPlanAdjustment(
		command: Parameters<PlanningRuntime["undoPlanAdjustment"]>[0],
	) {
		return this.afterWrite(
			await this.runtime.undoPlanAdjustment(command),
			"adjusted",
			true,
		);
	}
	async retryPendingAnalysis(
		command: Parameters<PlanningRuntime["retryPlanAnalysis"]>[0],
	) {
		return this.afterWrite(
			await this.runtime.retryPlanAnalysis(command),
			"analysis",
		);
	}

	async notifyCalendarChanged(
		planIds: readonly string[],
		causeOperationId: string,
	): Promise<void> {
		this.calendarVersion += 1;
		this.notifications.calendarChanged(this.calendarVersion);
		for (const planId of new Set(planIds.filter(Boolean))) {
			const plan = await this.runtime.getPlan(planId).catch(() => null);
			if (!plan || (plan.status !== "active" && plan.status !== "paused"))
				continue;
			const changed = await this.runtime.notifyCalendarChanged({
				planId,
				operationId: `calendar-replan:${planId}:${causeOperationId}`,
				expectedVersion: plan.version,
			});
			await this.afterWrite(changed, "adjusted", true);
		}
	}

	async consumeTimelineInput(input: AgentInputV1): Promise<void> {
		const plans = await this.runtime.listPlans();
		const active = plans.filter(
			(plan) => plan.status === "active" || plan.status === "paused",
		);
		if (active.length === 0) return;
		const observation = projectTimelinePlanningObservation(
			{
				id: input.agentInputId,
				period: input.period,
				coverage: input.coverage,
				segments: input.segments.map((segment) => ({
					startedAtMs: segment.startedAtMs,
					endedAtMs: segment.endedAtMs,
					goalRelevance: segment.goalRelevance,
					confidence: segment.classification.confidence,
				})),
			},
			scheduledTaskIntervals(active),
		);
		this.observations.put(observation);
		for (const plan of active) {
			const next = await this.runtime.consumeObservations({
				planId: plan.id,
				operationId: `timeline:${input.agentInputId}:${plan.id}`,
				expectedVersion: plan.version,
				from: observation.startedAt,
				to: observation.endedAt,
			});
			await this.afterWrite(next, "adjusted", true);
		}
	}

	async runDailySummaries(): Promise<void> {
		for (const plan of await this.runtime.listPlans()) {
			if (plan.status !== "active" && plan.status !== "paused") continue;
			const localDate = localDateAt(Date.now(), plan.timeZone);
			if (plan.dailySummaryDates.includes(localDate)) continue;
			const next = await this.runtime.runDailySummary({
				planId: plan.id,
				localDate,
				operationId: `daily:${plan.id}:${localDate}`,
				expectedVersion: plan.version,
			});
			await this.afterWrite(next, "adjusted", true);
		}
	}

	async recoverPendingAdjustments(): Promise<void> {
		for (const plan of await this.runtime.recoverPendingAdjustments()) {
			await this.afterWrite(plan, "adjusted", true);
		}
	}

	private async afterWrite(
		plan: PlanningPlan,
		_kind: PlanningChangeProjection["kind"],
		_calendarMayHaveChanged = false,
	): Promise<PlanningPlan> {
		// The durable native outbox is the only renderer push path. Receivers then
		// reload the authoritative snapshot, including persistent notifications.
		await this.flushOutbox();
		return plan;
	}

	async flushOutbox(): Promise<void> {
		if (this.flushingOutbox) return;
		this.flushingOutbox = true;
		try {
			const pending = await this.agent.listPlanningOutbox({
				status: "pending",
				limit: 100,
			});
			if (pending.entries.length === 0) return;
			for (const entry of pending.entries) {
				if (entry.kind === "calendar-changed") {
					const requiresPlanningReestimate =
						entry.payload.requiresPlanningReestimate === true;
					const planIds = Array.isArray(entry.payload.planIds)
						? entry.payload.planIds.filter(
								(value): value is string =>
									typeof value === "string" && value.length > 0,
							)
						: [];
					if (requiresPlanningReestimate && planIds.length > 0) {
						const causeOperationId =
							typeof entry.payload.batchId === "string"
								? entry.payload.batchId
								: entry.entryId;
						await this.notifyCalendarChanged(planIds, causeOperationId);
						continue;
					}
					this.calendarVersion += 1;
					this.notifications.calendarChanged(this.calendarVersion);
					continue;
				}
				if (entry.kind === "plan-changed") {
					const version =
						typeof entry.payload.version === "number"
							? entry.payload.version
							: 0;
					this.notifications.planChanged({
						planId: entry.aggregateId,
						version,
						kind: "adjusted",
					});
				}
			}
			await this.agent.ackPlanningOutbox({
				operationId: `planning-outbox-ack:${crypto.randomUUID()}`,
				entryIds: pending.entries.map((entry) => entry.entryId),
				deliveredAtMs: Date.now(),
			});
		} finally {
			this.flushingOutbox = false;
		}
	}

	private async projectPlan(
		plan: PlanningPlan,
	): Promise<PlanningPlanProjection> {
		const active = revisionById(plan, plan.activeRevisionId);
		const proposed = revisionById(plan, plan.proposedRevisionId);
		const activeEstimate = active
			? (plan.estimates.find((item) => item.id === active.estimateId) ?? null)
			: null;
		const proposedEstimate = proposed
			? (plan.estimates.find((item) => item.id === proposed.estimateId) ?? null)
			: null;
		const windowRevision = active ?? proposed;
		const calendar = await this.agent.listAllPlanningCalendar({
			sourcePlanId: plan.id,
		});
		const calendarById = new Map(
			calendar.map((event) => [event.eventId, event]),
		);
		const schedulesByTask = new Map<
			string,
			PlanningPlanProjection["tasks"][number]["schedules"]
		>();
		for (const item of active?.schedule ?? []) {
			const persisted = calendarById.get(item.id);
			// Manual edits become user-owned and are no longer represented by the
			// model revision's old interval. Present the authoritative native event
			// while still resolving its sensitive title from the opened plan task.
			const persistedTimed =
				persisted && !persisted.schedule.allDay ? persisted.schedule : null;
			const start = persistedTimed?.start ?? item.start;
			const end = persistedTimed?.end ?? item.end;
			const timeZone = persistedTimed?.timeZone ?? item.timeZone;
			const schedules = schedulesByTask.get(item.taskId) ?? [];
			schedules.push({
				eventId: item.id,
				start,
				end,
				timeZone,
				userLocked: persisted?.userLocked ?? false,
				scheduleOrigin: persisted?.scheduleOrigin ?? "model",
				version: persisted?.version ?? 0,
				unplannedReason: null,
			});
			schedulesByTask.set(item.taskId, schedules);
		}
		const unscheduled = new Set(active?.unscheduledTaskIds ?? []);
		const activeTaskIds = new Set(
			active?.tasks.map((task) => task.taskId) ?? [],
		);
		const liveTasks: PlanningPlanProjection["tasks"] = plan.tasks
			.filter((task) => activeTaskIds.has(task.id))
			.map((task) => ({
				id: task.id,
				title: task.title,
				description: task.description,
				purpose: taskPurpose(task),
				status: task.status,
				estimatedMinutes: task.estimatedMinutes,
				dependsOnTaskIds: [...task.dependencyTaskIds],
				schedules: schedulesByTask.get(task.id) ?? [],
				unscheduledReason: unscheduled.has(task.id)
					? "当前 7 天容量或日历冲突不足，任务暂未排程。"
					: null,
			}));
		const revisionProjection = (
			revision: NonNullable<typeof active>,
			estimate: NonNullable<typeof activeEstimate>,
			isActive: boolean,
		): NonNullable<PlanningPlanProjection["activeRevision"]> => {
			const taskStatusById = new Map(
				plan.tasks.map((task) => [task.id, task.status]),
			);
			const revisionSchedules = new Map<
				string,
				PlanningPlanProjection["tasks"][number]["schedules"]
			>();
			for (const item of revision.schedule) {
				const schedules = revisionSchedules.get(item.taskId) ?? [];
				schedules.push({
					eventId: item.id,
					start: item.start,
					end: item.end,
					timeZone: item.timeZone,
					userLocked: false,
					scheduleOrigin: "model",
					version: 0,
					unplannedReason: null,
				});
				revisionSchedules.set(item.taskId, schedules);
			}
			const revisionUnscheduled = new Set(revision.unscheduledTaskIds);
			return {
				revisionId: revision.id,
				version: revision.number,
				createdAt: revision.createdAt,
				goal: revision.goal,
				reason: projectionRevisionReason(revision.trigger),
				type: revision.type,
				typeReason: revision.rationaleSummary,
				assumptions: [...revision.assumptions],
				clarifyingQuestions: [],
				estimate: projectEstimate(estimate),
				schedulingPreferences: {
					weeklyCapacityMinutes:
						revision.schedulingPreferences.weeklyCapacityMinutes,
					sessionMinutes: revision.schedulingPreferences.sessionMinutes,
					availableWindows: revision.schedulingPreferences.availableWindows.map(
						(window) => ({ ...window }),
					),
				},
				scheduleWindow: revision.scheduleWindow,
				tasks: revision.tasks.map((task) => ({
					id: task.taskId,
					title: task.title,
					description: task.description,
					purpose: taskPurpose(task),
					status: isActive
						? (taskStatusById.get(task.taskId) ?? "pending")
						: "pending",
					estimatedMinutes: task.estimatedMinutes,
					dependsOnTaskIds: [...task.dependencyTaskIds],
					schedules: isActive
						? (schedulesByTask.get(task.taskId) ?? [])
						: (revisionSchedules.get(task.taskId) ?? []),
					unscheduledReason: revisionUnscheduled.has(task.taskId)
						? "当前 7 天容量或日历冲突不足，任务暂未排程。"
						: null,
				})),
			};
		};
		const monitoring = await this.monitoringProjection();
		return {
			id: plan.id,
			goal: plan.goal,
			status: plan.status,
			version: plan.version,
			timeZone: plan.timeZone,
			startToday: plan.requestedStartToday,
			effectiveStartDate: plan.effectiveStartDate,
			scheduleWindow: windowRevision?.scheduleWindow ?? {
				startDate: "",
				endDateExclusive: "",
			},
			type: plan.type,
			typeReason: active?.rationaleSummary ?? null,
			estimate: activeEstimate ? projectEstimate(activeEstimate) : null,
			activeRevision:
				active && activeEstimate
					? revisionProjection(active, activeEstimate, true)
					: null,
			proposedRevision:
				proposed && proposedEstimate
					? revisionProjection(proposed, proposedEstimate, false)
					: null,
			messages: plan.messages.map((message, index) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				createdAt: message.createdAt,
				state:
					plan.analysisState === "awaiting-analysis" &&
					index === plan.messages.length - 1
						? "pending-analysis"
						: "complete",
			})),
			tasks: liveTasks,
			monitoring,
			pendingObservations: plan.pendingObservationAttributions
				.filter((item) => item.status === "awaiting-user")
				.map((item) => {
					const matchingTaskIds = item.observation.candidates
						.filter((candidate) => candidate.planId === plan.id)
						.map((candidate) => candidate.taskId);
					return {
						id: item.observation.id,
						periodStartedAt: item.observation.startedAt,
						periodEndedAt: item.observation.endedAt,
						minutes: item.observation.relevantMinutes,
						confidence: Math.max(
							0,
							...item.observation.candidates.map(
								(candidate) => candidate.confidence,
							),
						),
						// An out-of-schedule interval has no model candidates. The user
						// can still explicitly choose any pending task in this plan.
						suggestedTaskIds:
							matchingTaskIds.length > 0
								? matchingTaskIds
								: liveTasks
										.filter((task) => task.status === "pending")
										.map((task) => task.id),
						status: "pending" as const,
					};
				}),
			adjustments: projectAdjustments(plan),
			notifications: projectPersistentNotifications(plan),
			createdAt: plan.createdAt,
			updatedAt: plan.updatedAt,
		};
	}

	private async monitoringProjection(): Promise<PlanningMonitoringProjection> {
		const status = await this.agent.getMonitoringStatus().catch(() => null);
		const authorized = status?.enabled === true;
		const unavailable =
			!status ||
			status.coverage.includes("denied") ||
			status.coverage.includes("unavailable");
		return {
			authorized,
			enabled: authorized && status?.state === "running",
			mode: authorized ? "observed" : "manual-only",
			coverage: unavailable
				? "unavailable"
				: status?.coverage.includes("redacted")
					? "partial"
					: "complete",
			message: authorized
				? "仅使用已授权的 Timeline 汇总，观测不会自动完成任务。"
				: "活动监测未授权；计划仅使用手动任务进度和日历变化。",
		};
	}

	private async dismissObservationFromOtherPlans(
		selectedPlanId: string,
		observationId: string,
	): Promise<void> {
		for (const summary of await this.runtime.listPlans()) {
			if (summary.id === selectedPlanId) continue;
			const pending = summary.pendingObservationAttributions.some(
				(item) =>
					item.observation.id === observationId &&
					item.status === "awaiting-user",
			);
			if (!pending) continue;
			const operationId = `attribution-dismiss:${observationId}:${summary.id}`;
			let current = summary;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				try {
					const dismissed = await this.runtime.confirmObservationAttribution({
						planId: current.id,
						observationId,
						taskId: null,
						operationId,
						expectedVersion: current.version,
					});
					await this.afterWrite(dismissed, "adjusted");
					break;
				} catch {
					const latest = await this.runtime
						.getPlan(current.id)
						.catch(() => null);
					if (
						!latest?.pendingObservationAttributions.some(
							(item) =>
								item.observation.id === observationId &&
								item.status === "awaiting-user",
						)
					) {
						break;
					}
					current = latest;
				}
			}
		}
	}
}

class PlanningObservationInbox implements PlanningObservationPort {
	private readonly values = new Map<string, PlanningObservationSummary>();
	put(value: PlanningObservationSummary): void {
		this.values.set(value.id, structuredClone(value));
	}
	async listSummaries(query: PlanningObservationQuery) {
		return [...this.values.values()].filter(
			(value) => value.endedAt >= query.from && value.startedAt < query.to,
		);
	}
}

function projectSummary(plan: PlanningPlan): PlanningPlanSummaryProjection {
	// Execution summaries remain anchored to the confirmed revision while a new
	// conversation proposal is waiting. Drafts can still preview their first ETA.
	const revision =
		revisionById(plan, plan.activeRevisionId) ??
		revisionById(plan, plan.proposedRevisionId);
	const estimate = revision
		? (plan.estimates.find((item) => item.id === revision.estimateId) ?? null)
		: null;
	return {
		id: plan.id,
		goal: plan.goal,
		status: plan.status,
		type: plan.type,
		estimatedCompletionDate: estimate?.estimatedCompletionDate ?? null,
		estimateConfidence: estimate?.confidence ?? null,
		version: plan.version,
		updatedAt: plan.updatedAt,
	};
}

function revisionById(plan: PlanningPlan, id: string | null) {
	return id ? (plan.revisions.find((item) => item.id === id) ?? null) : null;
}

function taskPurpose(task: unknown) {
	const purpose =
		task && typeof task === "object" && "purpose" in task ? task.purpose : null;
	return purpose === "validation" || purpose === "review"
		? purpose
		: "execution";
}

function projectEstimate(estimate: PlanningPlan["estimates"][number]) {
	return {
		estimatedCompletionDate: estimate.estimatedCompletionDate,
		confidence: estimate.confidence,
		assessedAt: estimate.assessedAt,
		evidenceThrough: estimate.evidenceThrough,
		basis: estimate.basis,
		modelVersion: estimate.modelVersion,
	};
}

function projectPersistentNotifications(plan: PlanningPlan) {
	const notifications: PlanningPlanProjection["notifications"] = [];
	const proposed = revisionById(plan, plan.proposedRevisionId);
	if (proposed) {
		notifications.push({
			id: `planning-analysis:${proposed.id}`,
			planId: plan.id,
			kind: "analysis-ready",
			message: "计划分析已完成，有一版新提案等待你确认。",
			createdAt: proposed.createdAt,
		});
	}
	for (const adjustment of plan.adjustments) {
		if (adjustment.status === "failed") {
			notifications.push({
				id: `planning-adjustment-failed:${adjustment.id}`,
				planId: plan.id,
				kind: "attention-required",
				message: "自动调整未能原子应用，上一版日历已保留，请检查冲突或容量。",
				createdAt: adjustment.finishedAt ?? adjustment.createdAt,
			});
			continue;
		}
		if (adjustment.status !== "applied") continue;
		const previousEstimate = estimateDateForRevision(
			plan,
			adjustment.previousRevisionId,
		);
		const nextEstimate = estimateDateForRevision(
			plan,
			adjustment.nextRevisionId,
		);
		const calendarChanged =
			adjustment.summary.created > 0 ||
			adjustment.summary.moved > 0 ||
			adjustment.summary.cancelled > 0;
		if (!calendarChanged && previousEstimate === nextEstimate) continue;
		notifications.push({
			id: `planning-adjustment:${adjustment.id}`,
			planId: plan.id,
			kind: "schedule-adjusted",
			message: `计划已动态调整：移动 ${adjustment.summary.moved}、新增 ${adjustment.summary.created}、取消 ${adjustment.summary.cancelled} 项${previousEstimate !== nextEstimate ? "，预计完成日期已更新" : ""}。`,
			createdAt: adjustment.finishedAt ?? adjustment.createdAt,
		});
	}
	if (plan.analysisDiagnostic) {
		notifications.push({
			id: `planning-diagnostic:${plan.id}:${plan.version}`,
			planId: plan.id,
			kind: "attention-required",
			message: "计划分析服务暂时不可用，消息已保存，可稍后重试。",
			createdAt: plan.updatedAt,
		});
	}
	return notifications
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
		.slice(0, 8);
}

function estimateDateForRevision(
	plan: PlanningPlan,
	revisionId: string | null,
) {
	const revision = revisionById(plan, revisionId);
	return revision
		? (plan.estimates.find((estimate) => estimate.id === revision.estimateId)
				?.estimatedCompletionDate ?? null)
		: null;
}

function projectionRevisionReason(
	trigger: PlanningPlan["revisions"][number]["trigger"],
) {
	switch (trigger) {
		case "initial-analysis":
			return "initial-analysis" as const;
		case "conversation":
			return "conversation" as const;
		case "task-status":
			return "user-progress" as const;
		case "observation":
			return "observation" as const;
		case "calendar-change":
			return "calendar-change" as const;
		case "daily-summary":
			return "daily-summary" as const;
		case "confirmation":
		case "resume":
			return "conversation" as const;
	}
}

function projectAdjustments(
	plan: PlanningPlan,
): PlanningAdjustmentProjection[] {
	return plan.adjustments.map((adjustment, index) => {
		const previous = adjustment.previousRevisionId
			? plan.revisions.find((item) => item.id === adjustment.previousRevisionId)
			: null;
		const next = plan.revisions.find(
			(item) => item.id === adjustment.nextRevisionId,
		);
		const previousEstimate = previous
			? plan.estimates.find((item) => item.id === previous.estimateId)
			: null;
		const nextEstimate = next
			? plan.estimates.find((item) => item.id === next.estimateId)
			: null;
		const laterApplied = plan.adjustments
			.slice(index + 1)
			.some((item) => item.status === "applied");
		const canUndo = adjustment.status === "applied" && !laterApplied;
		return {
			id: adjustment.id,
			createdAt: adjustment.createdAt,
			reason: adjustment.trigger,
			previousEstimateDate: previousEstimate?.estimatedCompletionDate ?? "",
			nextEstimateDate: nextEstimate?.estimatedCompletionDate ?? "",
			movedCount: adjustment.summary.moved,
			addedCount: adjustment.summary.created,
			cancelledCount: adjustment.summary.cancelled,
			canUndo,
			undoUnavailableReason: canUndo
				? null
				: "只有最新且未被后续版本覆盖的调整可以撤销。",
			undoneAt: adjustment.status === "undone" ? adjustment.finishedAt : null,
			version: index + 1,
		};
	});
}
