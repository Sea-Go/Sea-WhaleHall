import { Temporal } from "temporal-polyfill";
import type {
	PlanningPlanProjection,
	PlanningPlanSummaryProjection,
} from "../../../../shared/planning";
import type {
	PlanAdjustmentView,
	PlanEstimate,
	PlanningObservationView,
	PlanningTaskView,
	PlanSummaryView,
	PlanView,
} from "../../features/planning/domain";
import {
	type PlanningService,
	PlanningServiceError,
	type PlanningServiceEvent,
} from "../../features/planning/planning-service";

export type PlanningRpcClient = Pick<
	Awaited<ReturnType<typeof planningApi>>,
	| "listPlans"
	| "getPlan"
	| "createPlanDraft"
	| "sendPlanMessage"
	| "confirmPlanRevision"
	| "setPlanningTaskStatus"
	| "confirmPlanningObservation"
	| "pausePlan"
	| "resumePlan"
	| "completePlan"
	| "archivePlan"
	| "undoPlanAdjustment"
	| "retryPendingPlanAnalysis"
	| "onPlanChanged"
	| "onCalendarChanged"
>;

export type PlanningRpcLoader = () => Promise<PlanningRpcClient>;

/** Renderer adapter for the Bun-owned PlanningRuntime. */
export class ElectrobunPlanningService implements PlanningService {
	constructor(private readonly loadApi: PlanningRpcLoader = planningApi) {}

	subscribe(listener: (event: PlanningServiceEvent) => void): () => void {
		let disposed = false;
		const stops: Array<() => void> = [];
		void this.loadApi()
			.then((api) => {
				if (disposed) return;
				stops.push(
					api.onPlanChanged((change) =>
						listener({ kind: "planChanged", planId: change.planId }),
					),
					api.onCalendarChanged(() =>
						listener({ kind: "calendarChanged", planId: null }),
					),
				);
			})
			.catch(() => {
				// Initial reads surface transport failures. A subscription failure must
				// not become an unhandled renderer rejection.
			});
		return () => {
			disposed = true;
			for (const stop of stops) stop();
		};
	}

	async listPlans(): Promise<readonly PlanSummaryView[]> {
		try {
			return (await (await this.loadApi()).listPlans()).plans.map(fromSummary);
		} catch (error) {
			throw serviceError(error);
		}
	}

	async getPlan(planId: string): Promise<PlanView> {
		try {
			return fromPlan((await (await this.loadApi()).getPlan(planId)).plan);
		} catch (error) {
			throw serviceError(error);
		}
	}

	async createPlanDraft(
		request: Parameters<PlanningService["createPlanDraft"]>[0],
	) {
		try {
			return (await this.loadApi()).createPlanDraft(request);
		} catch (error) {
			throw serviceError(error);
		}
	}

	async sendPlanMessage(
		request: Parameters<PlanningService["sendPlanMessage"]>[0],
	) {
		await this.write((api) => api.sendPlanMessage(request));
	}
	async confirmPlanRevision(
		request: Parameters<PlanningService["confirmPlanRevision"]>[0],
	) {
		await this.write((api) => api.confirmPlanRevision(request));
	}
	async setTaskStatus(
		request: Parameters<PlanningService["setTaskStatus"]>[0],
	) {
		await this.write((api) => api.setPlanningTaskStatus(request));
	}
	async confirmObservationAttribution(
		request: Parameters<PlanningService["confirmObservationAttribution"]>[0],
	) {
		await this.write((api) => api.confirmPlanningObservation(request));
	}
	async pausePlan(request: Parameters<PlanningService["pausePlan"]>[0]) {
		await this.write((api) => api.pausePlan(request));
	}
	async resumePlan(request: Parameters<PlanningService["resumePlan"]>[0]) {
		await this.write((api) => api.resumePlan(request));
	}
	async completePlan(request: Parameters<PlanningService["completePlan"]>[0]) {
		await this.write((api) => api.completePlan(request));
	}
	async archivePlan(request: Parameters<PlanningService["archivePlan"]>[0]) {
		await this.write((api) => api.archivePlan(request));
	}
	async undoPlanAdjustment(
		request: Parameters<PlanningService["undoPlanAdjustment"]>[0],
	) {
		await this.write((api) =>
			api.undoPlanAdjustment({
				planId: request.planId,
				adjustmentId: request.adjustmentId,
				operationId: request.operationId,
				expectedVersion: request.expectedVersion,
				adjustmentVersion: request.adjustmentVersion,
			}),
		);
	}
	async retryPendingAnalysis(
		request: Parameters<PlanningService["retryPendingAnalysis"]>[0],
	) {
		await this.write((api) => api.retryPendingPlanAnalysis(request));
	}

	private async write(
		operation: (api: PlanningRpcClient) => Promise<unknown>,
	): Promise<void> {
		try {
			await operation(await this.loadApi());
		} catch (error) {
			throw serviceError(error);
		}
	}
}

async function planningApi() {
	return (await import("../../rpc")).clientApi;
}

function fromSummary(plan: PlanningPlanSummaryProjection): PlanSummaryView {
	return {
		id: plan.id,
		title: titleForGoal(plan.goal),
		goal: plan.goal,
		status: plan.status,
		type: plan.type,
		version: plan.version,
		estimatedCompletionDate: plan.estimatedCompletionDate,
		confidence:
			plan.estimateConfidence === null
				? null
				: confidenceLabel(plan.estimateConfidence),
		updatedAt: plan.updatedAt,
	};
}

function fromPlan(plan: PlanningPlanProjection): PlanView {
	const estimate = plan.estimate ? fromEstimate(plan.estimate) : null;
	const tasks = plan.tasks.map(fromTask);
	const displayedRevision = plan.proposedRevision ?? plan.activeRevision;
	const displayedRevisionStatus = plan.proposedRevision
		? ("proposed" as const)
		: ("confirmed" as const);
	return {
		id: plan.id,
		title: titleForGoal(plan.goal),
		goal: plan.goal,
		status: plan.status,
		type: plan.type,
		version: plan.version,
		timeZone: plan.timeZone,
		startToday: plan.startToday,
		effectiveDate: plan.effectiveStartDate || null,
		estimate,
		revision: displayedRevision
			? {
					revisionId: displayedRevision.revisionId,
					version: displayedRevision.version,
					status: displayedRevisionStatus,
					createdAt: displayedRevision.createdAt,
					goal: displayedRevision.goal,
					summary: displayedRevision.typeReason,
					reasoningSummary: displayedRevision.typeReason,
					planType: displayedRevision.type,
					estimate: fromEstimate(displayedRevision.estimate),
					schedulingPreferences: {
						weeklyCapacityMinutes:
							displayedRevision.schedulingPreferences.weeklyCapacityMinutes,
						sessionMinutes:
							displayedRevision.schedulingPreferences.sessionMinutes,
						availableWindows:
							displayedRevision.schedulingPreferences.availableWindows.map(
								(window) => ({ ...window }),
							),
					},
					scheduleWindow: {
						startDate: displayedRevision.scheduleWindow.startDate,
						endDateInclusive: endDateInclusive(
							displayedRevision.scheduleWindow.endDateExclusive,
						),
						timeZone: plan.timeZone,
					},
					assumptions: displayedRevision.assumptions,
					questions: displayedRevision.clarifyingQuestions,
					tasks: displayedRevision.tasks.map(fromTask),
				}
			: null,
		messages: plan.messages.map((message) => ({
			id: message.id,
			role: message.role,
			content: message.content,
			createdAt: message.createdAt,
			status: message.state,
			revisionId: null,
		})),
		tasks,
		monitoring: {
			authorized: plan.monitoring.authorized,
			enabled: plan.monitoring.enabled,
			mode: plan.monitoring.mode,
			coverage: plan.monitoring.coverage,
			message: plan.monitoring.message,
		},
		pendingObservations: plan.pendingObservations.map(fromObservation),
		adjustments: plan.adjustments.map(fromAdjustment),
		notifications: plan.notifications.map((notification) => ({
			id: notification.id,
			kind: notification.kind,
			message: notification.message,
			createdAt: notification.createdAt,
		})),
		updatedAt: plan.updatedAt,
	};
}

function fromTask(
	task: PlanningPlanProjection["tasks"][number],
): PlanningTaskView {
	return {
		id: task.id,
		title: task.title,
		description: task.description || null,
		purpose: task.purpose,
		status: task.status,
		estimatedMinutes: task.estimatedMinutes,
		dependencyIds: task.dependsOnTaskIds,
		schedules: task.schedules.flatMap((schedule) =>
			schedule.eventId && schedule.start && schedule.end
				? [
						{
							eventId: schedule.eventId,
							date: localDateForSchedule(schedule.start, schedule.timeZone),
							start: schedule.start,
							end: schedule.end,
							timeZone: schedule.timeZone,
							scheduleOrigin: schedule.scheduleOrigin,
							userLocked: schedule.userLocked,
							version: schedule.version,
						},
					]
				: [],
		),
		unplanned: task.unscheduledReason
			? { kind: "other", message: task.unscheduledReason }
			: null,
	};
}

function fromEstimate(
	value: PlanningPlanProjection["estimate"] & {},
): PlanEstimate {
	return {
		estimatedCompletionDate: value.estimatedCompletionDate,
		confidence: confidenceLabel(value.confidence),
		assessedAt: value.assessedAt,
		evidenceThrough: value.evidenceThrough,
		basis: value.basis,
		modelVersion: value.modelVersion,
	};
}

function fromObservation(
	value: PlanningPlanProjection["pendingObservations"][number],
): PlanningObservationView {
	return {
		id: value.id,
		occurredAt: value.periodEndedAt,
		durationMinutes: value.minutes,
		summary: "检测到计划相关投入，请确认归属任务。",
		confidence: confidenceLabel(value.confidence),
		candidateTaskIds: value.suggestedTaskIds,
		version: 1,
	};
}

function fromAdjustment(
	value: PlanningPlanProjection["adjustments"][number],
): PlanAdjustmentView {
	return {
		id: value.id,
		createdAt: value.createdAt,
		trigger: adjustmentTrigger(value.reason),
		summary: adjustmentSummary(value.reason),
		previousEstimatedCompletionDate: value.previousEstimateDate || null,
		nextEstimatedCompletionDate: value.nextEstimateDate || null,
		movedCount: value.movedCount,
		addedCount: value.addedCount,
		cancelledCount: value.cancelledCount,
		canUndo: value.canUndo,
		undoUnavailableReason: value.undoUnavailableReason,
		undoneAt: value.undoneAt,
		version: value.version,
	};
}

function confidenceLabel(value: number): "high" | "medium" | "low" {
	return value >= 0.75 ? "high" : value > 0.5 ? "medium" : "low";
}

function titleForGoal(goal: string): string {
	return Array.from(goal.trim()).slice(0, 24).join("") || "未命名计划";
}

function endDateInclusive(exclusive: string): string {
	try {
		return Temporal.PlainDate.from(exclusive).subtract({ days: 1 }).toString();
	} catch (cause) {
		throw invalidProjection("Planning schedule window is invalid.", cause);
	}
}

function serviceError(error: unknown): PlanningServiceError {
	if (error instanceof PlanningServiceError) return error;
	const message =
		error instanceof Error ? error.message : "Planning request failed.";
	const normalized = message.toLowerCase();
	if (normalized.includes("model_unavailable")) {
		return new PlanningServiceError("model-unavailable", message);
	}
	if (
		normalized.includes("stale_version") ||
		normalized.includes("busy") ||
		normalized.includes("changed concurrently") ||
		normalized.includes("stale-version")
	) {
		return new PlanningServiceError("stale-version", message);
	}
	if (
		normalized.includes("not_found") ||
		normalized.includes("was not found")
	) {
		return new PlanningServiceError("not-found", message);
	}
	if (
		normalized.includes("planning_validation") ||
		normalized.includes("invalid_arguments") ||
		normalized.includes("must contain between") ||
		normalized.includes("stable operation id is required") ||
		normalized.includes("unsupported task status") ||
		normalized.includes("valid iana")
	) {
		return new PlanningServiceError("validation", message, {
			retryable: false,
		});
	}
	if (
		normalized.includes("calendar-conflict") ||
		normalized.includes("could not be undone") ||
		normalized.includes("cannot transition") ||
		normalized.includes("can only be") ||
		normalized.includes("cannot receive messages") ||
		normalized.includes("not awaiting") ||
		normalized.includes("changed before the undo") ||
		normalized.includes("only the latest") ||
		normalized.includes("operation id was reused") ||
		normalized.includes("adjustment cannot be reversed")
	) {
		return new PlanningServiceError("conflict", message);
	}
	return new PlanningServiceError("offline", message, { cause: error });
}

function localDateForSchedule(start: string, timeZone: string): string {
	try {
		return Temporal.Instant.from(start)
			.toZonedDateTimeISO(timeZone)
			.toPlainDate()
			.toString();
	} catch (cause) {
		throw invalidProjection("Planning task schedule is invalid.", cause);
	}
}

function invalidProjection(
	message: string,
	cause: unknown,
): PlanningServiceError {
	return new PlanningServiceError("validation", message, {
		retryable: false,
		cause,
	});
}

function adjustmentTrigger(reason: string): PlanAdjustmentView["trigger"] {
	switch (reason) {
		case "task-status":
			return "task-status";
		case "observation":
			return "observation";
		case "calendar-change":
			return "calendar";
		case "daily-summary":
			return "daily-rollover";
		default:
			return "user-request";
	}
}

function adjustmentSummary(reason: string): string {
	switch (reason) {
		case "task-status":
			return "根据任务状态重新估算并调整未来安排";
		case "observation":
			return "根据已确认的观测投入调整未来安排";
		case "calendar-change":
			return "根据日历变化重新安排未来任务";
		case "daily-summary":
			return "根据每日进度汇总更新预计完成日与安排";
		case "confirmation":
			return "确认本次计划修订与未来 7 天安排";
		case "resume":
			return "恢复计划后重新估算未来安排";
		case "conversation":
			return "根据计划对话更新目标与未来安排";
		case "initial-analysis":
			return "建立首个未来 7 天安排";
		default:
			return reason;
	}
}
