import {
	assertPlanningModelOutputForRequest,
	PlanningModelInvocationError,
	type PlanningModelOutput,
	PlanningModelOutputError,
	type PlanningModelPort,
	type PlanningModelProposal,
} from "./model";
import {
	PlanNotFoundError,
	type PlanningCalendarPort,
	type PlanningObservationPort,
	type PlanningRepository,
	PlanStateError,
	PlanVersionConflictError,
} from "./ports";
import { buildDeterministicSevenDaySchedule } from "./scheduler";
import {
	addDays,
	assertIanaTimeZone,
	assertIsoDate,
	canAutomaticallyMutateCalendarEvent,
	compareDates,
	compareInstants,
	durationMinutes,
	effectivePlanStartDate,
	instantForEpochMs,
	instantToDate,
	localDateAt,
	type PlanningClock,
	rollingSevenDayWindow,
	SystemPlanningClock,
} from "./time";
import type {
	CalendarChangeSet,
	CalendarEventMutation,
	ChangePlanStatusRequest,
	ConfirmObservationAttributionRequest,
	ConfirmPlanRevisionRequest,
	ConsumeObservationsRequest,
	CreatePlanDraftRequest,
	DailyPlanningSummaryRequest,
	PlanAdjustment,
	PlanConversationMessage,
	PlanEstimate,
	PlanningAnalysisDiagnostic,
	PlanningCalendarEvent,
	PlanningPlan,
	PlanObservationEvidence,
	PlanRevision,
	PlanScheduleItem,
	PlanTask,
	PlanTaskStatus,
	RetryPlanAnalysisRequest,
	RevisionTask,
	SendPlanMessageRequest,
	SetTaskStatusRequest,
	UndoPlanAdjustmentRequest,
} from "./types";

export interface PlanningRuntimeOptions {
	repository: PlanningRepository;
	calendar: PlanningCalendarPort;
	model: PlanningModelPort;
	observations?: PlanningObservationPort;
	timeZone: string | (() => string);
	clock?: PlanningClock;
	createId?: () => string;
	minimumObservationConfidence?: number;
}

const unavailableObservations: PlanningObservationPort = {
	async listSummaries() {
		return [];
	},
};

export class PlanningRuntime {
	private readonly repository: PlanningRepository;
	private readonly calendar: PlanningCalendarPort;
	private readonly model: PlanningModelPort;
	private readonly observations: PlanningObservationPort;
	private readonly resolveTimeZone: () => string;
	private readonly clock: PlanningClock;
	private readonly createId: () => string;
	private readonly minimumObservationConfidence: number;

	constructor(options: PlanningRuntimeOptions) {
		const resolveTimeZone =
			typeof options.timeZone === "function"
				? options.timeZone
				: () => options.timeZone as string;
		assertIanaTimeZone(resolveTimeZone());
		const minimumConfidence = options.minimumObservationConfidence ?? 0.75;
		if (
			!Number.isFinite(minimumConfidence) ||
			minimumConfidence < 0 ||
			minimumConfidence > 1
		) {
			throw new Error("Planning observation confidence must be in [0, 1].");
		}
		this.repository = options.repository;
		this.calendar = options.calendar;
		this.model = options.model;
		this.observations = options.observations ?? unavailableObservations;
		this.resolveTimeZone = resolveTimeZone;
		this.clock = options.clock ?? new SystemPlanningClock();
		this.createId = options.createId ?? (() => crypto.randomUUID());
		this.minimumObservationConfidence = minimumConfidence;
	}

	listPlans(): Promise<readonly PlanningPlan[]> {
		return this.repository.listPlans();
	}

	/**
	 * Replays the durable calendar stage left by an interrupted adjustment.
	 * Calendar ports are idempotent by operationId, so this is safe whether the
	 * crash happened immediately before or immediately after the calendar commit.
	 */
	async recoverPendingAdjustments(): Promise<readonly PlanningPlan[]> {
		const recovered: PlanningPlan[] = [];
		for (const snapshot of await this.repository.listPlans()) {
			const pending = snapshot.adjustments.find(
				(item) => item.status === "pending",
			);
			if (!pending) continue;
			const current = (await this.repository.getPlan(snapshot.id)) ?? snapshot;
			if (
				!current.adjustments.some(
					(item) => item.id === pending.id && item.status === "pending",
				)
			) {
				continue;
			}
			recovered.push(
				await this.finalizePendingAdjustment(current, pending.operationId),
			);
		}
		return recovered;
	}

	async getPlan(planId: string): Promise<PlanningPlan> {
		return this.requirePlan(planId);
	}

	async createPlanDraft(
		request: CreatePlanDraftRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "draft"),
		);
		if (!staged) {
			const goal = validUserText(request.input.goal, "goal", 1_000);
			const nowMs = this.clock.nowMs();
			const now = instantForEpochMs(nowMs);
			const planId = prefixedId("plan", this.createId());
			const timeZone = this.currentTimeZone();
			const initial: PlanningPlan = {
				id: planId,
				goal,
				requestedStartToday: request.input.startToday,
				timeZone,
				effectiveStartDate: null,
				type: null,
				status: "draft",
				analysisState: "awaiting-analysis",
				analysisDiagnostic: null,
				pendingAnalysis: null,
				autoAdjustAuthorized: false,
				version: 1,
				createdAt: now,
				updatedAt: now,
				activeRevisionId: null,
				proposedRevisionId: null,
				revisions: [],
				estimates: [],
				tasks: [],
				messages: [
					this.message(planId, "user", goal, request.operationId, now),
				],
				observationEvidence: [],
				pendingObservationAttributions: [],
				adjustments: [],
				dailySummaryDates: [],
			};
			const created = await this.repository.createPlan(
				initial,
				stageOperation(request.operationId, "draft"),
			);
			staged = created.plan;
		}
		return this.analyzePlan(
			staged,
			"initial-analysis",
			request.operationId,
			false,
		);
	}

	async sendPlanMessage(
		request: SendPlanMessageRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "message"),
		);
		if (!staged) {
			const plan = await this.requireVersion(
				request.planId,
				request.expectedVersion,
			);
			if (plan.status === "archived") {
				throw new PlanStateError(
					"invalid-state",
					"Archived plans cannot receive messages.",
				);
			}
			const content = validUserText(request.content, "message", 4_000);
			const now = this.now();
			staged = await this.saveNext(
				{
					...plan,
					analysisState: "awaiting-analysis",
					analysisDiagnostic: null,
					messages: [
						...plan.messages,
						this.message(plan.id, "user", content, request.operationId, now),
					],
					updatedAt: now,
				},
				plan.version,
				stageOperation(request.operationId, "message"),
			);
		}
		return this.analyzePlan(staged, "conversation", request.operationId, false);
	}

	async retryPlanAnalysis(
		request: RetryPlanAnalysisRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		const plan = await this.requireVersion(
			request.planId,
			request.expectedVersion,
		);
		const pending = plan.pendingAnalysis;
		return this.analyzePlan(
			plan,
			pending?.trigger ??
				(plan.activeRevisionId ? "conversation" : "initial-analysis"),
			request.operationId,
			pending?.automatic ?? false,
			{ forceActiveBaseline: pending?.useActiveBaseline ?? false },
		);
	}

	async confirmPlanRevision(
		request: ConfirmPlanRevisionRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		const pending = await this.repository.getOperationResult(
			stageOperation(request.operationId, "pending-calendar"),
		);
		if (pending)
			return this.finalizePendingAdjustment(pending, request.operationId);
		const plan = await this.requireVersion(
			request.planId,
			request.expectedVersion,
		);
		if (
			(plan.status !== "awaiting-confirmation" &&
				plan.status !== "active" &&
				plan.status !== "paused") ||
			plan.proposedRevisionId !== request.revisionId
		) {
			throw new PlanStateError(
				"invalid-state",
				"The requested planning revision is not awaiting confirmation.",
			);
		}
		const proposal = plan.revisions.find(
			(item) => item.id === request.revisionId,
		);
		if (!proposal) {
			throw new PlanStateError(
				"revision-not-found",
				"Planning revision was not found.",
			);
		}
		if (proposal.parentRevisionId !== plan.activeRevisionId) {
			return this.analyzePlan(
				plan,
				"conversation",
				request.operationId,
				false,
				{
					forceActiveBaseline: true,
					messagePrefix:
						"执行进度已变化，我已基于最新已确认版本刷新方案，请再次确认。",
				},
			);
		}
		const currentTimeZone = this.currentTimeZone();
		const confirmationPlan =
			plan.timeZone === currentTimeZone
				? plan
				: { ...plan, timeZone: currentTimeZone };
		const startDate =
			confirmationPlan.activeRevisionId === null
				? effectivePlanStartDate(
						this.clock.nowMs(),
						confirmationPlan.timeZone,
						confirmationPlan.requestedStartToday,
					)
				: this.currentWindowStart(confirmationPlan);
		const prepared = await this.rematerializeRevision(
			confirmationPlan,
			proposal,
			"confirmation",
			startDate,
		);
		if (confirmationNeedsReview(proposal, prepared.revision)) {
			return this.persistConfirmationReviewRequired(
				confirmationPlan,
				prepared,
				request.operationId,
			);
		}
		return this.prepareAndApplyAdjustment(
			{
				...confirmationPlan,
				effectiveStartDate: confirmationPlan.effectiveStartDate ?? startDate,
			},
			prepared,
			request.operationId,
			"manual-confirmation",
		);
	}

	private async persistConfirmationReviewRequired(
		plan: PlanningPlan,
		prepared: PreparedRevision,
		operationId: string,
	): Promise<PlanningPlan> {
		const now = this.now();
		const keepExecutionActive = plan.activeRevisionId !== null;
		return this.saveNext(
			{
				...plan,
				analysisState: "ready",
				analysisDiagnostic: null,
				pendingAnalysis: null,
				proposedRevisionId: prepared.revision.id,
				revisions: [...plan.revisions, prepared.revision],
				tasks: keepExecutionActive ? plan.tasks : prepared.tasks,
				messages: [
					...plan.messages,
					this.message(
						plan.id,
						"assistant",
						"日历或容量已变化，最新七天方案出现新的未排程任务；原日历保持不变，请查看刷新后的方案并再次确认。",
						operationId,
						now,
					),
				],
				updatedAt: now,
			},
			plan.version,
			operationId,
		);
	}

	async setTaskStatus(request: SetTaskStatusRequest): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		assertTaskStatus(request.status);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "task-status"),
		);
		if (!staged) {
			const plan = await this.requireVersion(
				request.planId,
				request.expectedVersion,
			);
			if (plan.status !== "active" && plan.status !== "paused") {
				throw new PlanStateError(
					"invalid-state",
					"Task status can only be changed on an active or paused plan.",
				);
			}
			const activeTaskIds = activeRevisionTaskIds(plan);
			const task = plan.tasks.find(
				(item) => item.id === request.taskId && activeTaskIds.has(item.id),
			);
			if (!task)
				throw new PlanStateError(
					"task-not-found",
					"Planning task was not found.",
				);
			const now = this.now();
			staged = await this.saveNext(
				{
					...plan,
					analysisState: "awaiting-analysis",
					analysisDiagnostic: null,
					tasks: plan.tasks.map((item) =>
						item.id === request.taskId
							? {
									...item,
									status: request.status,
									statusChangedAt: now,
									statusChangedBy: "user" as const,
								}
							: item,
					),
					updatedAt: now,
				},
				plan.version,
				stageOperation(request.operationId, "task-status"),
			);
		}
		return this.analyzePlan(staged, "task-status", request.operationId, true);
	}

	async consumeObservations(
		request: ConsumeObservationsRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "observations"),
		);
		let accepted = false;
		if (!staged) {
			const plan = await this.requireVersion(
				request.planId,
				request.expectedVersion,
			);
			if (plan.status !== "active" && plan.status !== "paused") {
				throw new PlanStateError(
					"invalid-state",
					"Observations can only be consumed for active or paused plans.",
				);
			}
			const summaries = await this.observations.listSummaries({
				from: request.from,
				to: request.to,
			});
			const known = new Set([
				...plan.observationEvidence.map((item) => item.observationId),
				...plan.pendingObservationAttributions.map(
					(item) => item.observation.id,
				),
			]);
			const evidence = [...plan.observationEvidence];
			const pending = [...plan.pendingObservationAttributions];
			const activeTaskIds = activeRevisionTaskIds(plan);
			for (const summary of summaries) {
				if (known.has(summary.id)) continue;
				const candidates = summary.candidates.filter(
					(candidate) =>
						candidate.planId === plan.id && activeTaskIds.has(candidate.taskId),
				);
				// A summary with explicit task intervals for other plans is not an
				// attribution question for this plan. Only truly out-of-schedule
				// activity (no candidates anywhere) or an overlap involving this plan
				// should enter its pending queue.
				if (summary.candidates.length > 0 && candidates.length === 0) continue;
				// Uniqueness is global, not scoped after filtering to this plan. A
				// segment that overlaps two plans must never be silently attributed
				// once per plan.
				const unique =
					summary.candidates.length === 1 && candidates.length === 1
						? candidates[0]
						: null;
				if (
					summary.authorized &&
					summary.coverage === "complete" &&
					unique &&
					unique.confidence >= this.minimumObservationConfidence
				) {
					evidence.push(
						this.observationEvidence(
							plan.id,
							summary,
							unique.taskId,
							unique.confidence,
							"unique-observed",
						),
					);
					accepted = true;
				} else {
					pending.push({
						observation: summary,
						status:
							!summary.authorized || summary.coverage !== "complete"
								? "ignored-unavailable"
								: candidates.some(
											(candidate) =>
												candidate.confidence <
												this.minimumObservationConfidence,
										)
									? "ignored-low-confidence"
									: "awaiting-user",
						recordedAt: this.now(),
					});
				}
			}
			staged = await this.saveNext(
				{
					...plan,
					analysisState: accepted ? "awaiting-analysis" : plan.analysisState,
					observationEvidence: evidence,
					pendingObservationAttributions: pending,
					updatedAt: this.now(),
				},
				plan.version,
				stageOperation(request.operationId, "observations"),
			);
		} else {
			accepted = staged.analysisState === "awaiting-analysis";
		}
		if (!accepted) {
			return this.saveAsOperationResult(staged, request.operationId);
		}
		return this.analyzePlan(staged, "observation", request.operationId, true);
	}

	async confirmObservationAttribution(
		request: ConfirmObservationAttributionRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "attribution"),
		);
		if (!staged) {
			const plan = await this.requireVersion(
				request.planId,
				request.expectedVersion,
			);
			const pending = plan.pendingObservationAttributions.find(
				(item) =>
					item.observation.id === request.observationId &&
					item.status === "awaiting-user",
			);
			if (!pending) {
				throw new PlanStateError(
					"observation-not-found",
					"Observation is not awaiting attribution.",
				);
			}
			if (request.taskId === null) {
				return this.saveNext(
					{
						...plan,
						pendingObservationAttributions:
							plan.pendingObservationAttributions.filter(
								(item) => item.observation.id !== request.observationId,
							),
						updatedAt: this.now(),
					},
					plan.version,
					request.operationId,
				);
			}
			if (!activeRevisionTaskIds(plan).has(request.taskId)) {
				throw new PlanStateError(
					"task-not-found",
					"Planning task was not found.",
				);
			}
			const matching = pending.observation.candidates.filter(
				(candidate) =>
					candidate.planId === plan.id && candidate.taskId === request.taskId,
			);
			const confidence = matching[0]?.confidence ?? 1;
			staged = await this.saveNext(
				{
					...plan,
					analysisState: "awaiting-analysis",
					analysisDiagnostic: null,
					observationEvidence: [
						...plan.observationEvidence,
						this.observationEvidence(
							plan.id,
							pending.observation,
							request.taskId,
							confidence,
							"user-confirmed",
						),
					],
					pendingObservationAttributions:
						plan.pendingObservationAttributions.filter(
							(item) => item.observation.id !== request.observationId,
						),
					updatedAt: this.now(),
				},
				plan.version,
				stageOperation(request.operationId, "attribution"),
			);
		}
		return this.analyzePlan(staged, "observation", request.operationId, true);
	}

	async pausePlan(request: ChangePlanStatusRequest): Promise<PlanningPlan> {
		return this.changeStatus(request, "paused", ["active"]);
	}

	async resumePlan(request: ChangePlanStatusRequest): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "resume"),
		);
		if (!staged) {
			const plan = await this.requireVersion(
				request.planId,
				request.expectedVersion,
			);
			if (plan.status !== "paused") {
				throw new PlanStateError(
					"invalid-state",
					"Only paused plans can be resumed.",
				);
			}
			staged = await this.saveNext(
				{
					...plan,
					status: "active",
					analysisState: "awaiting-analysis",
					analysisDiagnostic: null,
					updatedAt: this.now(),
				},
				plan.version,
				stageOperation(request.operationId, "resume"),
			);
		}
		return this.analyzePlan(staged, "resume", request.operationId, true);
	}

	async completePlan(request: ChangePlanStatusRequest): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "complete"),
		);
		if (!staged) {
			const plan = await this.requireVersion(
				request.planId,
				request.expectedVersion,
			);
			if (plan.status !== "active" && plan.status !== "paused") {
				throw new PlanStateError(
					"invalid-state",
					"Only an active or paused plan can be completed.",
				);
			}
			const activeTaskIds = activeRevisionTaskIds(plan);
			if (
				activeTaskIds.size === 0 ||
				plan.tasks.some(
					(task) => activeTaskIds.has(task.id) && task.status === "pending",
				)
			) {
				throw new PlanStateError(
					"invalid-state",
					"All tasks in the active revision must be completed or skipped first.",
				);
			}
			staged = await this.saveNext(
				{ ...plan, updatedAt: this.now() },
				plan.version,
				stageOperation(request.operationId, "complete"),
			);
		}
		const today = localDateAt(this.clock.nowMs(), staged.timeZone);
		const events = await this.calendar.listEvents({
			startDate: addDays(today, 1),
			endDateExclusive: addDays(today, 8),
			timeZone: staged.timeZone,
		});
		const removable = events.filter(
			(event) =>
				event.planId === staged.id &&
				event.kind === "plan" &&
				event.scheduleOrigin === "model" &&
				!event.userLocked,
		);
		if (removable.length > 0) {
			const changeSet: CalendarChangeSet = {
				id: stableDerivedId("calendar-change:complete", request.operationId),
				planId: staged.id,
				operationId: stageOperation(request.operationId, "complete-calendar"),
				createdAt: staged.updatedAt,
				changes: removable.map((event) => ({
					kind: "delete" as const,
					eventId: event.id,
					expectedVersion: event.version,
					before: event,
					after: null,
				})),
			};
			const result = await this.calendar.applyChangeSet(changeSet);
			if (!result.ok) {
				throw new PlanStateError(
					"calendar-conflict",
					"Future model-created events could not be cleared safely.",
				);
			}
		}
		return this.saveNext(
			{
				...staged,
				status: "completed",
				analysisState: "ready",
				analysisDiagnostic: null,
				pendingAnalysis: null,
				updatedAt: this.now(),
			},
			staged.version,
			request.operationId,
		);
	}

	async archivePlan(request: ChangePlanStatusRequest): Promise<PlanningPlan> {
		return this.changeStatus(request, "archived", [
			"draft",
			"awaiting-confirmation",
			"completed",
		]);
	}

	async notifyCalendarChanged(
		request: ChangePlanStatusRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		const plan = await this.requireVersion(
			request.planId,
			request.expectedVersion,
		);
		if (plan.status !== "active" && plan.status !== "paused") {
			throw new PlanStateError(
				"invalid-state",
				"Calendar changes only re-estimate active or paused plans.",
			);
		}
		return this.analyzePlan(plan, "calendar-change", request.operationId, true);
	}

	async runDailySummary(
		request: DailyPlanningSummaryRequest,
	): Promise<PlanningPlan> {
		assertIsoDate(request.localDate, "localDate");
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		let staged = await this.repository.getOperationResult(
			stageOperation(request.operationId, "daily-summary"),
		);
		if (!staged) {
			const plan = await this.requireVersion(
				request.planId,
				request.expectedVersion,
			);
			if (plan.dailySummaryDates.includes(request.localDate)) {
				return this.saveAsOperationResult(plan, request.operationId);
			}
			staged = await this.saveNext(
				{
					...plan,
					dailySummaryDates: [...plan.dailySummaryDates, request.localDate],
					analysisState: "awaiting-analysis",
					analysisDiagnostic: null,
					updatedAt: this.now(),
				},
				plan.version,
				stageOperation(request.operationId, "daily-summary"),
			);
		}
		return this.analyzePlan(staged, "daily-summary", request.operationId, true);
	}

	async undoPlanAdjustment(
		request: UndoPlanAdjustmentRequest,
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		const plan = await this.requireVersion(
			request.planId,
			request.expectedVersion,
		);
		const adjustment = plan.adjustments.find(
			(item) => item.id === request.adjustmentId,
		);
		const adjustmentVersion =
			plan.adjustments.findIndex((item) => item.id === request.adjustmentId) +
			1;
		if (adjustment?.status !== "applied") {
			throw new PlanStateError(
				"adjustment-not-found",
				"Applied planning adjustment was not found.",
			);
		}
		if (
			!Number.isSafeInteger(request.adjustmentVersion) ||
			request.adjustmentVersion !== adjustmentVersion
		) {
			throw new PlanStateError(
				"invalid-state",
				"Planning adjustment changed before the undo request was applied.",
			);
		}
		const laterApplied = plan.adjustments.some(
			(item) =>
				item.status === "applied" && item.createdAt > adjustment.createdAt,
		);
		if (laterApplied) {
			throw new PlanStateError(
				"invalid-state",
				"Only the latest applied adjustment can be undone.",
			);
		}
		const reverse = reverseChangeSet(
			adjustment.calendarChangeSet,
			// Keep the calendar request byte-stable across a crash after the
			// reverse batch commits but before the plan marks the adjustment undone.
			// The adjustment ID is already stable and unique within the plan.
			adjustment.id,
			request.operationId,
			adjustment.createdAt,
		);
		if (reverse.changes.length > 0) {
			const calendarResult = await this.calendar.applyChangeSet(reverse);
			if (!calendarResult.ok) {
				throw new PlanStateError(
					"calendar-conflict",
					"Calendar changed after this adjustment and could not be undone.",
				);
			}
		}
		const previous = adjustment.previousRevisionId
			? (plan.revisions.find(
					(item) => item.id === adjustment.previousRevisionId,
				) ?? null)
			: null;
		const now = this.now();
		return this.saveNext(
			{
				...plan,
				activeRevisionId: previous?.id ?? plan.activeRevisionId,
				goal: previous?.goal ?? plan.goal,
				type: previous?.type ?? plan.type,
				adjustments: plan.adjustments.map((item) =>
					item.id === adjustment.id
						? { ...item, status: "undone" as const, finishedAt: now }
						: item,
				),
				messages: [
					...plan.messages,
					this.message(
						plan.id,
						"assistant",
						"已撤销上一轮自动日程调整；任务完成状态保持不变。",
						request.operationId,
						now,
					),
				],
				updatedAt: now,
			},
			plan.version,
			request.operationId,
		);
	}

	private async analyzePlan(
		plan: PlanningPlan,
		trigger: Exclude<PlanRevision["trigger"], "confirmation">,
		operationId: string,
		automatic: boolean,
		options: {
			forceActiveBaseline?: boolean;
			messagePrefix?: string;
		} = {},
	): Promise<PlanningPlan> {
		const finalReplay = await this.repository.getOperationResult(operationId);
		if (finalReplay) return finalReplay;
		const startDate = this.currentWindowStart(plan);
		const window = rollingSevenDayWindow(startDate);
		let calendarEvents: readonly PlanningCalendarEvent[];
		try {
			calendarEvents = await this.calendar.listEvents({
				...window,
				timeZone: plan.timeZone,
			});
		} catch {
			return this.persistAnalysisFailure(
				plan,
				operationId,
				{
					source: "planning-model",
					code: "model-unavailable",
					retryable: true,
					recordedAt: this.now(),
				},
				trigger,
				automatic,
				options.forceActiveBaseline === true,
			);
		}
		let output: PlanningModelOutput;
		try {
			const useActiveBaseline =
				automatic || options.forceActiveBaseline === true;
			const analysisRequest = {
				planId: plan.id,
				analysisMode: automatic
					? ("automatic-adjustment" as const)
					: ("manual-proposal" as const),
				currentGoal: currentGoalForAnalysis(plan, useActiveBaseline),
				currentType: currentTypeForAnalysis(plan, useActiveBaseline),
				trigger,
				effectiveWindow: { ...window, timeZone: plan.timeZone },
				messages: plan.messages,
				currentTasks: currentTasksForAnalysis(plan, useActiveBaseline),
				currentEstimate: currentEstimate(plan, useActiveBaseline),
				currentSchedulingPreferences: activeSchedulingPreferences(plan),
				observationEvidence: plan.observationEvidence,
				calendarEvents,
			};
			output = await this.model.analyze(analysisRequest, {
				requestId: `planning-analysis:${operationId}`,
			});
			assertPlanningModelOutputForRequest(output, analysisRequest);
		} catch (error) {
			return this.persistAnalysisFailure(
				plan,
				operationId,
				diagnosticForAnalysisFailure(error, this.now()),
				trigger,
				automatic,
				options.forceActiveBaseline === true,
			);
		}

		if (output.outcome === "needs-clarification") {
			const now = this.now();
			return this.saveNext(
				{
					...plan,
					analysisState: "awaiting-user",
					analysisDiagnostic: null,
					pendingAnalysis: null,
					messages: [
						...plan.messages,
						this.message(
							plan.id,
							"assistant",
							prefixedAssistantMessage(
								output.assistantMessage,
								options.messagePrefix,
							),
							operationId,
							now,
						),
					],
					updatedAt: now,
				},
				plan.version,
				operationId,
			);
		}

		try {
			const prepared = await this.materializeModelProposal(
				plan,
				output,
				trigger,
				startDate,
				calendarEvents,
				automatic,
			);
			if (!automatic) {
				const now = this.now();
				const keepExecutionActive =
					plan.activeRevisionId !== null &&
					(plan.status === "active" || plan.status === "paused");
				return this.saveNext(
					{
						...plan,
						status: keepExecutionActive ? plan.status : "awaiting-confirmation",
						analysisState: "ready",
						analysisDiagnostic: null,
						pendingAnalysis: null,
						proposedRevisionId: prepared.revision.id,
						revisions: [...plan.revisions, prepared.revision],
						estimates: [...plan.estimates, prepared.estimate],
						tasks: keepExecutionActive ? plan.tasks : prepared.tasks,
						messages: [
							...plan.messages,
							this.message(
								plan.id,
								"assistant",
								prefixedAssistantMessage(
									assistantMessageForOutput(output),
									options.messagePrefix,
								),
								operationId,
								now,
							),
						],
						updatedAt: now,
					},
					plan.version,
					operationId,
				);
			}
			return this.prepareAndApplyAdjustment(
				plan,
				prepared,
				operationId,
				"automatic",
				assistantMessageForOutput(output),
			);
		} catch (error) {
			return this.persistAnalysisFailure(
				plan,
				operationId,
				diagnosticForAnalysisFailure(error, this.now()),
				trigger,
				automatic,
				options.forceActiveBaseline === true,
			);
		}
	}

	private async materializeModelProposal(
		plan: PlanningPlan,
		output: PlanningModelProposal,
		trigger: Exclude<PlanRevision["trigger"], "confirmation">,
		startDate: string,
		calendarEvents: readonly PlanningCalendarEvent[],
		automatic: boolean,
	): Promise<PreparedRevision> {
		if (compareDates(output.estimatedCompletionDate, startDate) < 0) {
			throw new PlanningModelOutputError();
		}
		const resolvedType =
			automatic && plan.type ? plan.type : output.recommendedType;
		if (resolvedType === "fuzzy" && output.confidence > 0.5) {
			throw new PlanningModelOutputError();
		}
		const goal = automatic
			? plan.goal
			: validUserText(output.goal, "goal", 1_000);
		const mapped = mapModelTasks(plan, output.tasks, this.createId, automatic);
		const window = rollingSevenDayWindow(startDate);
		const mutableStartDate = automatic
			? laterDate(
					addDays(localDateAt(this.clock.nowMs(), plan.timeZone), 1),
					startDate,
				)
			: startDate;
		const busy = calendarEvents.filter(
			(event) => !isReplaceablePlanEvent(plan, event, this.clock.nowMs()),
		);
		const scheduled = buildDeterministicSevenDaySchedule({
			planId: plan.id,
			timeZone: plan.timeZone,
			window,
			mutableStartDate,
			tasks: mapped.revisionTasks,
			taskStates: mapped.tasks,
			preferences: output.schedulingPreferences,
			busyEvents: busy,
			nowMs: this.clock.nowMs(),
			createId: () => prefixedId("schedule", this.createId()),
		});
		if (resolvedType === "fuzzy") {
			const validationTasks = mapped.revisionTasks.filter(
				(task) => task.purpose === "validation",
			);
			const reviewTasks = mapped.revisionTasks.filter(
				(task) => task.purpose === "review",
			);
			const unscheduled = new Set(scheduled.unscheduledTaskIds);
			if (
				validationTasks.length === 0 ||
				reviewTasks.length === 0 ||
				validationTasks.every((task) => unscheduled.has(task.taskId)) ||
				reviewTasks.every((task) => unscheduled.has(task.taskId))
			) {
				throw new PlanningModelOutputError();
			}
		}
		const now = this.now();
		const shortTermEstimate =
			resolvedType === "short-term"
				? deriveShortTermEstimate(
						plan,
						projectRevisionTasksWithStatus(
							{ ...plan, tasks: mapped.tasks },
							mapped.revisionTasks,
						),
						scheduled.schedule,
						output.schedulingPreferences.weeklyCapacityMinutes,
						window,
					)
				: null;
		const estimate: PlanEstimate = {
			id: prefixedId("estimate", this.createId()),
			estimatedCompletionDate:
				shortTermEstimate?.estimatedCompletionDate ??
				output.estimatedCompletionDate,
			confidence: shortTermEstimate?.confidence ?? output.confidence,
			assessedAt: now,
			evidenceThrough: localDateAt(this.clock.nowMs(), plan.timeZone),
			basis: shortTermEstimate?.basis ?? output.estimateBasis,
			modelVersion:
				shortTermEstimate === null
					? this.model.modelVersion
					: "deterministic-short-term.v1",
		};
		const revision: PlanRevision = {
			id: prefixedId("revision", this.createId()),
			planId: plan.id,
			number: nextRevisionNumber(plan),
			parentRevisionId: plan.activeRevisionId,
			trigger,
			goal,
			type: resolvedType,
			rationaleSummary: output.rationaleSummary,
			assumptions: [...output.assumptions],
			estimateId: estimate.id,
			schedulingPreferences: structuredClone(output.schedulingPreferences),
			tasks: mapped.revisionTasks,
			scheduleWindow: window,
			schedule: scheduled.schedule,
			unscheduledTaskIds: scheduled.unscheduledTaskIds,
			createdAt: now,
		};
		return { revision, estimate, tasks: mapped.tasks, calendarEvents };
	}

	private async rematerializeRevision(
		plan: PlanningPlan,
		base: PlanRevision,
		trigger: "confirmation",
		startDate: string,
	): Promise<PreparedRevision> {
		const window = rollingSevenDayWindow(startDate);
		const calendarEvents = await this.calendar.listEvents({
			...window,
			timeZone: plan.timeZone,
		});
		const busy = calendarEvents.filter(
			(event) => !isReplaceablePlanEvent(plan, event, this.clock.nowMs()),
		);
		const scheduled = buildDeterministicSevenDaySchedule({
			planId: plan.id,
			timeZone: plan.timeZone,
			window,
			mutableStartDate: startDate,
			tasks: base.tasks,
			taskStates: projectRevisionTasksWithStatus(plan, base.tasks),
			preferences: base.schedulingPreferences,
			busyEvents: busy,
			nowMs: this.clock.nowMs(),
			createId: () => prefixedId("schedule", this.createId()),
		});
		const revision: PlanRevision = {
			...structuredClone(base),
			id: prefixedId("revision", this.createId()),
			number: nextRevisionNumber(plan),
			parentRevisionId: plan.activeRevisionId,
			trigger,
			scheduleWindow: window,
			schedule: scheduled.schedule,
			unscheduledTaskIds: scheduled.unscheduledTaskIds,
			createdAt: this.now(),
		};
		const estimate = plan.estimates.find((item) => item.id === base.estimateId);
		if (!estimate)
			throw new PlanStateError(
				"invalid-state",
				"Revision estimate is missing.",
			);
		return {
			revision,
			estimate,
			tasks: mergeRevisionTasksIntoTaskRegistry(plan, base.tasks),
			calendarEvents,
			reuseEstimate: true,
		};
	}

	private async prepareAndApplyAdjustment(
		plan: PlanningPlan,
		prepared: PreparedRevision,
		operationId: string,
		mode: "manual-confirmation" | "automatic",
		assistantMessage?: string,
	): Promise<PlanningPlan> {
		const manualConfirmation = mode === "manual-confirmation";
		if (
			!manualConfirmation &&
			prepared.revision.unscheduledTaskIds.length > 0
		) {
			return this.persistUnscheduledAutomaticCheckpoint(
				plan,
				prepared,
				operationId,
				assistantMessage,
			);
		}
		const diff = buildCalendarChangeSet({
			plan,
			revision: prepared.revision,
			existing: prepared.calendarEvents,
			operationId,
			nowMs: this.clock.nowMs(),
			createId: this.createId,
		});
		const revision = { ...prepared.revision, schedule: diff.schedule };
		if (diff.changeSet.changes.length === 0) {
			return this.persistAppliedWithoutCalendarMutation(
				plan,
				{ ...prepared, revision },
				diff.changeSet,
				diff.summary,
				operationId,
				mode,
				assistantMessage,
			);
		}
		const now = this.now();
		const adjustment: PlanAdjustment = {
			id: prefixedId("adjustment", this.createId()),
			planId: plan.id,
			operationId,
			trigger: revision.trigger,
			previousRevisionId: plan.activeRevisionId,
			nextRevisionId: revision.id,
			calendarChangeSet: diff.changeSet,
			status: "pending",
			createdAt: now,
			finishedAt: null,
			failureCode: null,
			summary: diff.summary,
		};
		const pendingMessages = assistantMessage
			? [
					...plan.messages,
					this.message(
						plan.id,
						"assistant",
						assistantMessage,
						operationId,
						now,
					),
				]
			: plan.messages;
		const pending = await this.saveNext(
			{
				...plan,
				status: plan.status,
				analysisState: "ready",
				analysisDiagnostic: null,
				pendingAnalysis: null,
				activeRevisionId: plan.activeRevisionId,
				proposedRevisionId: plan.proposedRevisionId,
				revisions: [...plan.revisions, revision],
				estimates: prepared.reuseEstimate
					? plan.estimates
					: [...plan.estimates, prepared.estimate],
				// The calendar batch is the commit boundary. Keep the currently active
				// task projection until that atomic write succeeds.
				tasks: plan.tasks,
				messages: pendingMessages,
				adjustments: [...plan.adjustments, adjustment],
				updatedAt: now,
			},
			plan.version,
			stageOperation(operationId, "pending-calendar"),
		);
		return this.finalizePendingAdjustment(pending, operationId);
	}

	private async persistAppliedWithoutCalendarMutation(
		plan: PlanningPlan,
		prepared: PreparedRevision,
		changeSet: CalendarChangeSet,
		summary: PlanAdjustment["summary"],
		operationId: string,
		mode: "manual-confirmation" | "automatic",
		assistantMessage?: string,
	): Promise<PlanningPlan> {
		const now = this.now();
		const manualConfirmation = mode === "manual-confirmation";
		const messages = assistantMessage
			? [
					...plan.messages,
					this.message(
						plan.id,
						"assistant",
						assistantMessage,
						operationId,
						now,
					),
				]
			: plan.messages;
		return this.saveNext(
			{
				...plan,
				status:
					manualConfirmation && plan.status === "awaiting-confirmation"
						? "active"
						: plan.status,
				goal: prepared.revision.goal,
				type: prepared.revision.type,
				analysisState: "ready",
				analysisDiagnostic: null,
				pendingAnalysis: null,
				autoAdjustAuthorized: true,
				activeRevisionId: prepared.revision.id,
				proposedRevisionId: manualConfirmation ? null : plan.proposedRevisionId,
				revisions: [...plan.revisions, prepared.revision],
				estimates: prepared.reuseEstimate
					? plan.estimates
					: [...plan.estimates, prepared.estimate],
				tasks: mergeRevisionTasksIntoTaskRegistry(
					plan,
					prepared.revision.tasks,
				),
				messages,
				adjustments: [
					...plan.adjustments,
					{
						id: prefixedId("adjustment", this.createId()),
						planId: plan.id,
						operationId,
						trigger: prepared.revision.trigger,
						previousRevisionId: plan.activeRevisionId,
						nextRevisionId: prepared.revision.id,
						calendarChangeSet: changeSet,
						status: "applied" as const,
						createdAt: now,
						finishedAt: now,
						failureCode: null,
						summary,
					},
				],
				updatedAt: now,
			},
			plan.version,
			operationId,
		);
	}

	private async persistUnscheduledAutomaticCheckpoint(
		plan: PlanningPlan,
		prepared: PreparedRevision,
		operationId: string,
		assistantMessage?: string,
	): Promise<PlanningPlan> {
		const now = this.now();
		const revision: PlanRevision = {
			...prepared.revision,
			// Capacity/conflict shortfalls never partially mutate the calendar. The
			// checkpoint points at the exact schedule that remains committed.
			schedule: scheduleFromExistingPlanEvents(plan, prepared.calendarEvents),
		};
		const changeSet: CalendarChangeSet = {
			id: prefixedId("calendar-change", this.createId()),
			planId: plan.id,
			operationId: stageOperation(operationId, "calendar-apply"),
			createdAt: now,
			changes: [],
		};
		const messages = [...plan.messages];
		if (assistantMessage) {
			messages.push(
				this.message(plan.id, "assistant", assistantMessage, operationId, now),
			);
		}
		messages.push(
			this.message(
				plan.id,
				"assistant",
				"未来七天的容量或日历空档不足，本轮没有移动、新增或取消任何日历事件；未排程任务已保留，等待你调整容量或安排。",
				operationId,
				now,
			),
		);
		return this.saveNext(
			{
				...plan,
				analysisState: "ready",
				analysisDiagnostic: null,
				pendingAnalysis: null,
				activeRevisionId: revision.id,
				proposedRevisionId: plan.proposedRevisionId,
				revisions: [...plan.revisions, revision],
				estimates: prepared.reuseEstimate
					? plan.estimates
					: [...plan.estimates, prepared.estimate],
				tasks: mergeRevisionTasksIntoTaskRegistry(plan, revision.tasks),
				messages,
				adjustments: [
					...plan.adjustments,
					{
						id: prefixedId("adjustment", this.createId()),
						planId: plan.id,
						operationId,
						trigger: revision.trigger,
						previousRevisionId: plan.activeRevisionId,
						nextRevisionId: revision.id,
						calendarChangeSet: changeSet,
						status: "applied",
						createdAt: now,
						finishedAt: now,
						failureCode: null,
						summary: { created: 0, moved: 0, cancelled: 0 },
					},
				],
				updatedAt: now,
			},
			plan.version,
			operationId,
		);
	}

	private async finalizePendingAdjustment(
		pending: PlanningPlan,
		operationId: string,
	): Promise<PlanningPlan> {
		const adjustment = [...pending.adjustments]
			.reverse()
			.find(
				(item) => item.operationId === operationId && item.status === "pending",
			);
		if (!adjustment) {
			throw new PlanStateError(
				"invalid-state",
				"Pending calendar adjustment is missing.",
			);
		}
		const result = await this.calendar.applyChangeSet(
			adjustment.calendarChangeSet,
		);
		const now = this.now();
		const nextRevision = pending.revisions.find(
			(item) => item.id === adjustment.nextRevisionId,
		);
		if (!nextRevision) {
			throw new PlanStateError(
				"revision-not-found",
				"Adjustment revision is missing.",
			);
		}
		if (!result.ok) {
			const failed = {
				...pending,
				// The pending revision is persisted before the atomic calendar write so
				// the operation can be retried after a crash.  A rejected calendar batch
				// must not make that uncommitted schedule the active source of truth.
				// Keep the immutable failed revision for audit, but restore the last
				// successfully applied revision pointer.
				activeRevisionId:
					adjustment.previousRevisionId ?? pending.activeRevisionId,
				adjustments: pending.adjustments.map((item) =>
					item.id === adjustment.id
						? {
								...item,
								status: "failed" as const,
								finishedAt: now,
								failureCode: result.conflicts[0]?.code ?? "service-unavailable",
							}
						: item,
				),
				messages: [
					...pending.messages,
					this.message(
						pending.id,
						"assistant",
						"日历存在冲突，本轮调整没有写入；原有安排已保留，请检查未排程任务。",
						operationId,
						now,
					),
				],
				updatedAt: now,
			};
			return this.saveNext(failed, pending.version, operationId);
		}
		const final = {
			...pending,
			status:
				nextRevision.trigger === "confirmation" &&
				pending.status === "awaiting-confirmation"
					? ("active" as const)
					: pending.status,
			goal: nextRevision.goal,
			type: nextRevision.type,
			autoAdjustAuthorized: true,
			activeRevisionId: nextRevision.id,
			proposedRevisionId:
				nextRevision.trigger === "confirmation"
					? null
					: pending.proposedRevisionId,
			tasks: mergeRevisionTasksIntoTaskRegistry(pending, nextRevision.tasks),
			adjustments: pending.adjustments.map((item) =>
				item.id === adjustment.id
					? {
							...item,
							status: "applied" as const,
							finishedAt: now,
							failureCode: null,
						}
					: item,
			),
			updatedAt: now,
		};
		return this.saveNext(final, pending.version, operationId);
	}

	private async persistAnalysisFailure(
		plan: PlanningPlan,
		operationId: string,
		diagnostic: PlanningAnalysisDiagnostic,
		trigger: Exclude<PlanRevision["trigger"], "confirmation">,
		automatic: boolean,
		useActiveBaseline: boolean,
	): Promise<PlanningPlan> {
		return this.saveNext(
			{
				...plan,
				analysisState: "awaiting-analysis",
				analysisDiagnostic: diagnostic,
				pendingAnalysis: { trigger, automatic, useActiveBaseline },
				updatedAt: diagnostic.recordedAt,
			},
			plan.version,
			operationId,
		);
	}

	private async changeStatus(
		request: ChangePlanStatusRequest,
		status: PlanningPlan["status"],
		allowed: readonly PlanningPlan["status"][],
	): Promise<PlanningPlan> {
		assertOperationId(request.operationId);
		const replay = await this.repository.getOperationResult(
			request.operationId,
		);
		if (replay) return replay;
		const plan = await this.requireVersion(
			request.planId,
			request.expectedVersion,
		);
		if (!allowed.includes(plan.status)) {
			throw new PlanStateError(
				"invalid-state",
				`Plan cannot transition from ${plan.status} to ${status}.`,
			);
		}
		return this.saveNext(
			{ ...plan, status, updatedAt: this.now() },
			plan.version,
			request.operationId,
		);
	}

	private async saveAsOperationResult(
		plan: PlanningPlan,
		operationId: string,
	): Promise<PlanningPlan> {
		return this.saveNext(
			{ ...plan, updatedAt: this.now() },
			plan.version,
			operationId,
		);
	}

	private async saveNext(
		planWithoutNextVersion: PlanningPlan,
		expectedVersion: number,
		operationId: string,
	): Promise<PlanningPlan> {
		const plan = {
			...planWithoutNextVersion,
			version: expectedVersion + 1,
		};
		const result = await this.repository.savePlan(plan, {
			operationId,
			expectedVersion,
		});
		if (result.replayed) {
			return (await this.repository.getPlan(plan.id)) ?? result.plan;
		}
		return result.plan;
	}

	private async requirePlan(planId: string): Promise<PlanningPlan> {
		const plan = await this.repository.getPlan(planId);
		if (!plan) throw new PlanNotFoundError(planId);
		return plan;
	}

	private async requireVersion(
		planId: string,
		expectedVersion: number,
	): Promise<PlanningPlan> {
		const plan = await this.requirePlan(planId);
		if (plan.version !== expectedVersion) {
			throw new PlanVersionConflictError(expectedVersion, plan.version);
		}
		return plan;
	}

	private message(
		planId: string,
		role: PlanConversationMessage["role"],
		content: string,
		operationId: string,
		createdAt: string,
	): PlanConversationMessage {
		return {
			id: prefixedId("message", this.createId()),
			planId,
			role,
			content,
			createdAt,
			causedByOperationId: operationId,
		};
	}

	private observationEvidence(
		planId: string,
		observation: {
			id: string;
			startedAt: string;
			endedAt: string;
			relevantMinutes: number;
		},
		taskId: string,
		confidence: number,
		attribution: PlanObservationEvidence["attribution"],
	): PlanObservationEvidence {
		return {
			id: prefixedId("evidence", this.createId()),
			observationId: observation.id,
			planId,
			taskId,
			startedAt: observation.startedAt,
			endedAt: observation.endedAt,
			relevantMinutes: observation.relevantMinutes,
			confidence,
			attribution,
			recordedAt: this.now(),
		};
	}

	private currentWindowStart(plan: PlanningPlan): string {
		const today = localDateAt(this.clock.nowMs(), plan.timeZone);
		if (plan.activeRevisionId !== null) return today;
		return effectivePlanStartDate(
			this.clock.nowMs(),
			plan.timeZone,
			plan.requestedStartToday,
		);
	}

	private now(): string {
		return instantForEpochMs(this.clock.nowMs());
	}

	private currentTimeZone(): string {
		const timeZone = this.resolveTimeZone();
		assertIanaTimeZone(timeZone);
		return timeZone;
	}
}

interface PreparedRevision {
	revision: PlanRevision;
	estimate: PlanEstimate;
	tasks: readonly PlanTask[];
	calendarEvents: readonly PlanningCalendarEvent[];
	reuseEstimate?: boolean;
}

function mapModelTasks(
	plan: PlanningPlan,
	modelTasks: PlanningModelProposal["tasks"],
	createId: () => string,
	automatic: boolean,
): { tasks: PlanTask[]; revisionTasks: RevisionTask[] } {
	const existingBySourceKey = new Map(
		plan.tasks.map((task) => [task.sourceKey, task]),
	);
	// Task identity and explicit user status are append-only domain facts. The
	// registry remains auditable even when a confirmed manual revision narrows
	// its execution scope.
	const idBySourceKey = new Map(
		plan.tasks.map((task) => [task.sourceKey, task.id]),
	);
	for (const task of modelTasks) {
		idBySourceKey.set(
			task.taskKey,
			existingBySourceKey.get(task.taskKey)?.id ??
				prefixedId("task", createId()),
		);
	}
	const projectedBySourceKey = new Map(
		modelTasks.map((task) => [task.taskKey, task]),
	);
	const projectTask = (
		task: PlanningModelProposal["tasks"][number],
	): PlanTask => {
		const existing = existingBySourceKey.get(task.taskKey);
		return {
			id: requireMappedId(idBySourceKey, task.taskKey),
			planId: plan.id,
			sourceKey: task.taskKey,
			purpose: task.purpose,
			title: task.title,
			description: task.description,
			estimatedMinutes: task.estimatedMinutes,
			dependencyTaskIds: task.dependencyKeys.map((key) =>
				requireMappedId(idBySourceKey, key),
			),
			status: existing?.status ?? "pending",
			statusChangedAt: existing?.statusChangedAt ?? null,
			statusChangedBy: existing?.statusChangedBy ?? null,
		};
	};
	const tasks = plan.tasks.map((existing) => {
		const projected = projectedBySourceKey.get(existing.sourceKey);
		return projected ? projectTask(projected) : structuredClone(existing);
	});
	const existingSourceKeys = new Set(plan.tasks.map((task) => task.sourceKey));
	for (const modelTask of modelTasks) {
		if (!existingSourceKeys.has(modelTask.taskKey))
			tasks.push(projectTask(modelTask));
	}
	const modelRevisionTasks = modelTasks.map<RevisionTask>((modelTask) => {
		const task = projectTask(modelTask);
		return {
			taskId: task.id,
			sourceKey: task.sourceKey,
			purpose: task.purpose,
			title: task.title,
			description: task.description,
			estimatedMinutes: task.estimatedMinutes,
			dependencyTaskIds: [...task.dependencyTaskIds],
		};
	});
	if (!automatic) return { tasks, revisionTasks: modelRevisionTasks };

	// Automatic adjustments may refine or extend the active scope, but must not
	// silently remove an active task. Only an explicitly confirmed conversation
	// revision is allowed to narrow scope.
	const activeTasks = activeRevision(plan)?.tasks ?? [];
	const outputBySourceKey = new Map(
		modelRevisionTasks.map((task) => [task.sourceKey, task]),
	);
	const revisionTasks = activeTasks.map<RevisionTask>((task) =>
		structuredClone(outputBySourceKey.get(task.sourceKey) ?? task),
	);
	const activeSourceKeys = new Set(activeTasks.map((task) => task.sourceKey));
	for (const task of modelRevisionTasks) {
		if (!activeSourceKeys.has(task.sourceKey)) revisionTasks.push(task);
	}
	return { tasks, revisionTasks };
}

function projectRevisionTasksWithStatus(
	plan: PlanningPlan,
	revisionTasks: readonly RevisionTask[],
): PlanTask[] {
	const existingById = new Map(plan.tasks.map((task) => [task.id, task]));
	return revisionTasks.map<PlanTask>((task) => {
		const existing = existingById.get(task.taskId);
		return {
			id: task.taskId,
			planId: plan.id,
			sourceKey: task.sourceKey,
			purpose: task.purpose,
			title: task.title,
			description: task.description,
			estimatedMinutes: task.estimatedMinutes,
			dependencyTaskIds: [...task.dependencyTaskIds],
			status: existing?.status ?? "pending",
			statusChangedAt: existing?.statusChangedAt ?? null,
			statusChangedBy: existing?.statusChangedBy ?? null,
		};
	});
}

function mergeRevisionTasksIntoTaskRegistry(
	plan: PlanningPlan,
	revisionTasks: readonly RevisionTask[],
): PlanTask[] {
	const merged = projectRevisionTasksWithStatus(plan, revisionTasks);
	const included = new Set(merged.map((task) => task.id));
	for (const existing of plan.tasks) {
		if (!included.has(existing.id)) merged.push(structuredClone(existing));
	}
	return merged;
}

function requireMappedId(
	ids: ReadonlyMap<string, string>,
	key: string,
): string {
	const id = ids.get(key);
	if (!id) throw new PlanningModelOutputError();
	return id;
}

function buildCalendarChangeSet(options: {
	plan: PlanningPlan;
	revision: PlanRevision;
	existing: readonly PlanningCalendarEvent[];
	operationId: string;
	nowMs: number;
	createId: () => string;
}): {
	changeSet: CalendarChangeSet;
	schedule: PlanScheduleItem[];
	summary: PlanAdjustment["summary"];
} {
	const completedTaskIds = new Set(
		options.plan.tasks
			.filter((task) => task.status === "completed")
			.map((task) => task.id),
	);
	const currentPlanEvents = options.existing.filter(
		(event) => event.planId === options.plan.id,
	);
	const mutable = currentPlanEvents.filter(
		(event) =>
			canAutomaticallyMutateCalendarEvent(event, {
				planId: options.plan.id,
				nowMs: options.nowMs,
				planTimeZone: options.plan.timeZone,
				completedTaskIds,
			}).allowed,
	);
	const preserved = currentPlanEvents.filter(
		(event) => !mutable.some((item) => item.id === event.id),
	);
	const mutableByTask = new Map<string, PlanningCalendarEvent[]>();
	for (const event of mutable) {
		if (!event.sourceTaskId) continue;
		const list = mutableByTask.get(event.sourceTaskId) ?? [];
		list.push(event);
		mutableByTask.set(event.sourceTaskId, list);
	}
	for (const list of mutableByTask.values()) {
		list.sort((left, right) => compareInstants(left.start, right.start));
	}
	const used = new Set<string>();
	const changes: CalendarEventMutation[] = [];
	const schedule: PlanScheduleItem[] = [];
	let created = 0;
	let moved = 0;
	for (const desired of revisionScheduleWithoutCompleted(
		options.revision.schedule,
		completedTaskIds,
	)) {
		const reusable = mutableByTask
			.get(desired.taskId)
			?.find((event) => !used.has(event.id));
		if (reusable) {
			used.add(reusable.id);
			const normalized = { ...desired, id: reusable.id };
			schedule.push(normalized);
			const after = eventFromSchedule(normalized, reusable.version + 1);
			if (!calendarEventsEquivalent(reusable, after)) {
				changes.push({
					kind: "update",
					eventId: reusable.id,
					expectedVersion: reusable.version,
					before: reusable,
					after,
				});
				moved += 1;
			}
		} else {
			const normalized = {
				...desired,
				id: prefixedId("calendar-event", options.createId()),
			};
			schedule.push(normalized);
			changes.push({
				kind: "create",
				eventId: normalized.id,
				expectedVersion: null,
				before: null,
				after: eventFromSchedule(normalized, 1),
			});
			created += 1;
		}
	}
	for (const event of mutable) {
		if (used.has(event.id)) continue;
		changes.push({
			kind: "delete",
			eventId: event.id,
			expectedVersion: event.version,
			before: event,
			after: null,
		});
	}
	for (const event of preserved) {
		if (!event.sourceTaskId) continue;
		schedule.push({
			id: event.id,
			planId: options.plan.id,
			taskId: event.sourceTaskId,
			title: event.title,
			start: event.start,
			end: event.end,
			timeZone: event.timeZone,
		});
	}
	return {
		changeSet: {
			id: prefixedId("calendar-change", options.createId()),
			planId: options.plan.id,
			operationId: stageOperation(options.operationId, "calendar-apply"),
			createdAt: instantForEpochMs(options.nowMs),
			changes,
		},
		schedule: schedule.sort((left, right) =>
			compareInstants(left.start, right.start),
		),
		summary: { created, moved, cancelled: mutable.length - used.size },
	};
}

function eventFromSchedule(
	item: PlanScheduleItem,
	version: number,
): PlanningCalendarEvent {
	return {
		id: item.id,
		title: item.title,
		kind: "plan",
		state: "committed",
		start: item.start,
		end: item.end,
		timeZone: item.timeZone,
		planId: item.planId,
		sourceTaskId: item.taskId,
		scheduleOrigin: "model",
		userLocked: false,
		version,
	};
}

function calendarEventsEquivalent(
	left: PlanningCalendarEvent,
	right: PlanningCalendarEvent,
): boolean {
	const redactedPlanTitle =
		left.kind === "plan" &&
		right.kind === "plan" &&
		left.scheduleOrigin === "model" &&
		right.scheduleOrigin === "model";
	return (
		(redactedPlanTitle || left.title === right.title) &&
		left.start === right.start &&
		left.end === right.end &&
		left.timeZone === right.timeZone &&
		left.sourceTaskId === right.sourceTaskId &&
		left.userLocked === right.userLocked
	);
}

function revisionScheduleWithoutCompleted(
	schedule: readonly PlanScheduleItem[],
	completedTaskIds: ReadonlySet<string>,
): PlanScheduleItem[] {
	return schedule.filter((item) => !completedTaskIds.has(item.taskId));
}

function confirmationNeedsReview(
	base: PlanRevision,
	refreshed: PlanRevision,
): boolean {
	const previouslyUnscheduled = new Set(base.unscheduledTaskIds);
	if (
		refreshed.unscheduledTaskIds.some(
			(taskId) => !previouslyUnscheduled.has(taskId),
		)
	) {
		return true;
	}
	if (refreshed.type !== "fuzzy") return false;
	const scheduledTaskIds = new Set(
		refreshed.schedule.map((item) => item.taskId),
	);
	return (
		!refreshed.tasks.some(
			(task) =>
				task.purpose === "validation" && scheduledTaskIds.has(task.taskId),
		) ||
		!refreshed.tasks.some(
			(task) => task.purpose === "review" && scheduledTaskIds.has(task.taskId),
		)
	);
}

function scheduleFromExistingPlanEvents(
	plan: PlanningPlan,
	events: readonly PlanningCalendarEvent[],
): PlanScheduleItem[] {
	return events
		.filter(
			(event): event is PlanningCalendarEvent & { sourceTaskId: string } =>
				event.planId === plan.id &&
				event.kind === "plan" &&
				event.sourceTaskId !== null,
		)
		.map((event) => ({
			id: event.id,
			planId: plan.id,
			taskId: event.sourceTaskId,
			title: event.title,
			start: event.start,
			end: event.end,
			timeZone: event.timeZone,
		}))
		.sort((left, right) => compareInstants(left.start, right.start));
}

function isReplaceablePlanEvent(
	plan: PlanningPlan,
	event: PlanningCalendarEvent,
	nowMs: number,
): boolean {
	return canAutomaticallyMutateCalendarEvent(event, {
		planId: plan.id,
		nowMs,
		planTimeZone: plan.timeZone,
		completedTaskIds: new Set(
			plan.tasks
				.filter((task) => task.status === "completed")
				.map((task) => task.id),
		),
	}).allowed;
}

function reverseChangeSet(
	changeSet: CalendarChangeSet,
	id: string,
	operationId: string,
	createdAt: string,
): CalendarChangeSet {
	const changes = [...changeSet.changes]
		.reverse()
		.map<CalendarEventMutation>((change) => {
			if (change.kind === "create" && change.after) {
				return {
					kind: "delete",
					eventId: change.eventId,
					expectedVersion: change.after.version,
					before: change.after,
					after: null,
				};
			}
			if (change.kind === "delete" && change.before) {
				return {
					kind: "create",
					eventId: change.eventId,
					expectedVersion: null,
					before: null,
					after: { ...change.before, version: 1 },
				};
			}
			if (change.kind === "update" && change.before && change.after) {
				return {
					kind: "update",
					eventId: change.eventId,
					expectedVersion: change.after.version,
					before: change.after,
					after: { ...change.before, version: change.after.version + 1 },
				};
			}
			throw new PlanStateError(
				"invalid-state",
				"Adjustment cannot be reversed.",
			);
		});
	return {
		id,
		planId: changeSet.planId,
		operationId: stageOperation(operationId, "calendar-undo"),
		createdAt,
		changes,
	};
}

function diagnosticForAnalysisFailure(
	error: unknown,
	recordedAt: string,
): PlanningAnalysisDiagnostic {
	if (error instanceof PlanningModelOutputError) {
		return {
			source: "planning-model",
			code: "invalid-output",
			retryable: true,
			recordedAt,
		};
	}
	if (error instanceof PlanningModelInvocationError) {
		return {
			source: "planning-model",
			code:
				error.code === "request-timeout"
					? "request-timeout"
					: error.code === "invalid-output"
						? "invalid-output"
						: "model-unavailable",
			retryable: error.retryable,
			recordedAt,
		};
	}
	return {
		source: "planning-model",
		code: "unexpected-failure",
		retryable: true,
		recordedAt,
	};
}

function currentGoalForAnalysis(
	plan: PlanningPlan,
	automatic: boolean,
): string {
	if (automatic || plan.proposedRevisionId === null) return plan.goal;
	return (
		plan.revisions.find((item) => item.id === plan.proposedRevisionId)?.goal ??
		plan.goal
	);
}

function currentTypeForAnalysis(
	plan: PlanningPlan,
	automatic: boolean,
): PlanningPlan["type"] {
	if (automatic || plan.proposedRevisionId === null) return plan.type;
	return (
		plan.revisions.find((item) => item.id === plan.proposedRevisionId)?.type ??
		plan.type
	);
}

function currentTasksForAnalysis(
	plan: PlanningPlan,
	automatic: boolean,
): readonly PlanTask[] {
	const revisionId = automatic
		? plan.activeRevisionId
		: (plan.proposedRevisionId ?? plan.activeRevisionId);
	const revision = plan.revisions.find((item) => item.id === revisionId);
	return revision
		? projectRevisionTasksWithStatus(plan, revision.tasks)
		: plan.tasks;
}

function activeRevision(plan: PlanningPlan): PlanRevision | null {
	if (plan.activeRevisionId === null) return null;
	return (
		plan.revisions.find((revision) => revision.id === plan.activeRevisionId) ??
		null
	);
}

function activeRevisionTaskIds(plan: PlanningPlan): ReadonlySet<string> {
	return new Set(
		(activeRevision(plan)?.tasks ?? []).map((task) => task.taskId),
	);
}

function activeSchedulingPreferences(
	plan: PlanningPlan,
): PlanRevision["schedulingPreferences"] | null {
	if (plan.activeRevisionId === null) return null;
	const active = plan.revisions.find(
		(item) => item.id === plan.activeRevisionId,
	);
	return active ? structuredClone(active.schedulingPreferences) : null;
}

function assistantMessageForOutput(output: PlanningModelOutput): string {
	if (
		output.outcome === "proposal" &&
		output.schedulingPreferenceSource === "confirmed-reuse"
	) {
		return `沿用已确认的排程偏好，可随时修改。${output.assistantMessage}`;
	}
	return output.assistantMessage;
}

function prefixedAssistantMessage(message: string, prefix?: string): string {
	return prefix ? `${prefix}${message}` : message;
}

function currentEstimate(
	plan: PlanningPlan,
	automatic: boolean,
): PlanEstimate | null {
	const revisionId = automatic
		? plan.activeRevisionId
		: (plan.proposedRevisionId ?? plan.activeRevisionId);
	const revision = plan.revisions.find((item) => item.id === revisionId);
	if (!revision) return null;
	return plan.estimates.find((item) => item.id === revision.estimateId) ?? null;
}

function deriveShortTermEstimate(
	plan: PlanningPlan,
	tasks: readonly PlanTask[],
	schedule: readonly PlanScheduleItem[],
	weeklyCapacityMinutes: number,
	window: PlanRevision["scheduleWindow"],
): Pick<PlanEstimate, "estimatedCompletionDate" | "confidence" | "basis"> {
	const pending = tasks.filter((task) => task.status === "pending");
	const pendingIds = new Set(pending.map((task) => task.id));
	const observedByTask = new Map<string, number>();
	for (const evidence of plan.observationEvidence) {
		if (!pendingIds.has(evidence.taskId)) continue;
		observedByTask.set(
			evidence.taskId,
			(observedByTask.get(evidence.taskId) ?? 0) + evidence.relevantMinutes,
		);
	}
	const remainingMinutes = pending.reduce(
		(total, task) =>
			total +
			Math.max(0, task.estimatedMinutes - (observedByTask.get(task.id) ?? 0)),
		0,
	);
	if (remainingMinutes <= 0) {
		return {
			estimatedCompletionDate: plan.effectiveStartDate ?? window.startDate,
			confidence: 0.9,
			basis: "根据用户确认的任务完成状态，短期计划当前已无剩余工作量。",
		};
	}
	let scheduledMinutes = 0;
	for (const item of [...schedule].sort((left, right) =>
		compareInstants(left.start, right.start),
	)) {
		if (!pendingIds.has(item.taskId)) continue;
		scheduledMinutes += Math.max(0, durationMinutes(item.start, item.end));
		if (scheduledMinutes >= remainingMinutes) {
			return {
				estimatedCompletionDate: instantToDate(item.end, plan.timeZone),
				confidence: 0.85,
				basis: "根据剩余任务工作量、用户确认的容量与当前七天日历空档计算。",
			};
		}
	}
	const capacity = Math.max(15, weeklyCapacityMinutes);
	const remainingAfterWindow = Math.max(0, remainingMinutes - scheduledMinutes);
	const additionalWeeks = Math.max(
		1,
		Math.ceil(remainingAfterWindow / capacity),
	);
	return {
		estimatedCompletionDate: addDays(
			window.endDateExclusive,
			additionalWeeks * 7 - 1,
		),
		confidence: 0.75,
		basis:
			"根据剩余任务工作量、用户确认的每周容量和七天内可见日历冲突外推；后续会随完成情况重算。",
	};
}

function nextRevisionNumber(plan: PlanningPlan): number {
	return (plan.revisions.at(-1)?.number ?? 0) + 1;
}

function laterDate(left: string, right: string): string {
	return compareDates(left, right) >= 0 ? left : right;
}

function stageOperation(operationId: string, stage: string): string {
	return `${operationId}:${stage}`;
}

function stableDerivedId(prefix: string, operationId: string): string {
	return `${prefix}:${operationId}`;
}

function prefixedId(prefix: string, id: string): string {
	if (!id.trim())
		throw new Error("Planning ID generator returned an empty ID.");
	return `${prefix}_${id}`;
}

function assertOperationId(operationId: string): void {
	if (!operationId.trim() || operationId.length > 200) {
		throw new PlanStateError(
			"invalid-input",
			"A stable operation ID is required.",
		);
	}
}

function validUserText(
	value: string,
	field: string,
	maximumCharacters: number,
): string {
	const normalized = value.trim();
	if (!normalized || Array.from(normalized).length > maximumCharacters) {
		throw new PlanStateError(
			"invalid-input",
			`${field} must contain between 1 and ${maximumCharacters} characters.`,
		);
	}
	return normalized;
}

function assertTaskStatus(status: PlanTaskStatus): void {
	if (status !== "pending" && status !== "completed" && status !== "skipped") {
		throw new PlanStateError("invalid-input", "Unsupported task status.");
	}
}
