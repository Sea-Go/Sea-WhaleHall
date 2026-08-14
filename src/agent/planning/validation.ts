import { Temporal } from "temporal-polyfill";
import {
	PLAN_STATUSES,
	PLAN_TASK_PURPOSES,
	PLAN_TASK_STATUSES,
	PLAN_TYPES,
	type CalendarEventMutation,
	type PlanAdjustment,
	type PlanConversationMessage,
	type PlanEstimate,
	type PlanObservationEvidence,
	type PlanRevision,
	type PlanScheduleItem,
	type PlanTask,
	type PlanningCalendarEvent,
	type PlanningObservationSummary,
	type PlanningPlan,
} from "./types";
import {
	assertIanaTimeZone,
	assertIsoDate,
	compareDates,
	compareInstants,
	instantToDate,
} from "./time";

const PLAN_KEYS = [
	"id",
	"goal",
	"requestedStartToday",
	"timeZone",
	"effectiveStartDate",
	"type",
	"status",
	"analysisState",
	"analysisDiagnostic",
	"pendingAnalysis",
	"autoAdjustAuthorized",
	"version",
	"createdAt",
	"updatedAt",
	"activeRevisionId",
	"proposedRevisionId",
	"revisions",
	"estimates",
	"tasks",
	"messages",
	"observationEvidence",
	"pendingObservationAttributions",
	"adjustments",
	"dailySummaryDates",
] as const;

/** Strict trust-boundary validator for a complete persisted runtime payload. */
export function isPlanningPlan(value: unknown): value is PlanningPlan {
	if (!isRecordWithKeys(value, PLAN_KEYS)) return false;
	if (
		!identifier(value.id) ||
		!boundedText(value.goal, 1, 1_000) ||
		typeof value.requestedStartToday !== "boolean" ||
		typeof value.timeZone !== "string" ||
		!validTimeZone(value.timeZone) ||
		!(value.effectiveStartDate === null || validDate(value.effectiveStartDate)) ||
		!(value.type === null || PLAN_TYPES.includes(value.type as never)) ||
		!PLAN_STATUSES.includes(value.status as never) ||
		!(["awaiting-analysis", "awaiting-user", "ready"] as const).includes(
			value.analysisState as never,
		) ||
		!isAnalysisDiagnostic(value.analysisDiagnostic) ||
		!isPendingAnalysis(value.pendingAnalysis) ||
		typeof value.autoAdjustAuthorized !== "boolean" ||
		typeof value.version !== "number" ||
		!Number.isSafeInteger(value.version) ||
		value.version < 1 ||
		!validInstant(value.createdAt) ||
		!validInstant(value.updatedAt) ||
		!(value.activeRevisionId === null || identifier(value.activeRevisionId)) ||
		!(value.proposedRevisionId === null || identifier(value.proposedRevisionId)) ||
		!Array.isArray(value.revisions) ||
		!Array.isArray(value.estimates) ||
		!Array.isArray(value.tasks) ||
		!Array.isArray(value.messages) ||
		!Array.isArray(value.observationEvidence) ||
		!Array.isArray(value.pendingObservationAttributions) ||
		!Array.isArray(value.adjustments) ||
		!Array.isArray(value.dailySummaryDates)
	) {
		return false;
	}
	const planId = value.id;
	if (typeof value.timeZone !== "string") return false;
	const timeZone = value.timeZone;
	const tasks = value.tasks;
	const estimates = value.estimates;
	const revisions = value.revisions;
	if (!tasks.every((item) => isPlanTask(item, planId))) return false;
	if (!unique(tasks.map((item) => item.id))) return false;
	const taskIds = new Set(tasks.map((item) => item.id));
	if (tasks.some((task) => task.dependencyTaskIds.some((id) => !taskIds.has(id)))) {
		return false;
	}
	if (!estimates.every(isPlanEstimate) || !unique(estimates.map((item) => item.id))) {
		return false;
	}
	const estimateIds = new Set(estimates.map((item) => item.id));
	if (
		!revisions.every((item) =>
			isPlanRevision(item, planId, estimateIds, timeZone),
		) ||
		!unique(revisions.map((item) => item.id)) ||
		!unique(revisions.map((item) => String(item.number)))
	) {
		return false;
	}
	const revisionIds = new Set(revisions.map((item) => item.id));
	const activeRevision = revisions.find(
		(item) => item.id === value.activeRevisionId,
	);
	if (
		(value.activeRevisionId !== null && !revisionIds.has(value.activeRevisionId)) ||
		(value.proposedRevisionId !== null && !revisionIds.has(value.proposedRevisionId)) ||
		revisions.some(
			(revision) =>
				revision.parentRevisionId !== null &&
				!revisionIds.has(revision.parentRevisionId),
		) ||
		(activeRevision !== undefined &&
			activeRevision.tasks.some((task) => !taskIds.has(task.taskId)))
	) {
		return false;
	}
	if (
		!value.messages.every((item) => isMessage(item, planId)) ||
		!unique(value.messages.map((item) => item.id)) ||
		!value.observationEvidence.every((item) =>
			isObservationEvidence(item, planId, taskIds),
		) ||
		!unique(value.observationEvidence.map((item) => item.id)) ||
		!value.pendingObservationAttributions.every(isPendingAttribution) ||
		!unique(
			value.pendingObservationAttributions.map((item) => item.observation.id),
		) ||
		!value.adjustments.every((item) =>
			isAdjustment(item, planId, revisionIds),
		) ||
		!unique(value.adjustments.map((item) => item.id)) ||
		!value.dailySummaryDates.every(validDate) ||
		!unique(value.dailySummaryDates)
	) {
		return false;
	}
	if (
		value.status === "awaiting-confirmation" &&
		value.proposedRevisionId === null
	) {
		return false;
	}
	if (
		(value.status === "active" ||
			value.status === "paused" ||
			value.status === "completed") &&
		(value.activeRevisionId === null ||
			value.type === null ||
			value.effectiveStartDate === null)
	) {
		return false;
	}
	return true;
}

export function assertPlanningPlan(
	value: unknown,
): asserts value is PlanningPlan {
	if (!isPlanningPlan(value)) throw new PlanningPlanValidationError();
}

export function parsePlanningPlan(value: unknown): PlanningPlan {
	assertPlanningPlan(value);
	return structuredClone(value);
}

export class PlanningPlanValidationError extends Error {
	constructor() {
		super("Persisted planning payload did not satisfy its runtime contract.");
		this.name = "PlanningPlanValidationError";
	}
}

function isPlanTask(value: unknown, planId: string): value is PlanTask {
	if (
		!isRecordWithKeys(value, [
			"id",
				"planId",
				"sourceKey",
				"purpose",
			"title",
			"description",
			"estimatedMinutes",
			"dependencyTaskIds",
			"status",
			"statusChangedAt",
			"statusChangedBy",
		])
	) {
		return false;
	}
	return (
		identifier(value.id) &&
		value.planId === planId &&
			identifier(value.sourceKey) &&
			PLAN_TASK_PURPOSES.includes(value.purpose as never) &&
		boundedText(value.title, 1, 200) &&
		boundedText(value.description, 0, 1_000) &&
		typeof value.estimatedMinutes === "number" &&
		Number.isSafeInteger(value.estimatedMinutes) &&
		value.estimatedMinutes >= 15 &&
		value.estimatedMinutes % 15 === 0 &&
		stringArray(value.dependencyTaskIds, identifier) &&
		PLAN_TASK_STATUSES.includes(value.status as never) &&
		(value.statusChangedAt === null || validInstant(value.statusChangedAt)) &&
		(value.statusChangedBy === null || value.statusChangedBy === "user")
	);
}

function isPlanEstimate(value: unknown): value is PlanEstimate {
	if (
		!isRecordWithKeys(value, [
			"id",
			"estimatedCompletionDate",
			"confidence",
			"assessedAt",
			"evidenceThrough",
			"basis",
			"modelVersion",
		])
	) {
		return false;
	}
	return (
		identifier(value.id) &&
		validDate(value.estimatedCompletionDate) &&
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1 &&
		validInstant(value.assessedAt) &&
		validDate(value.evidenceThrough) &&
		boundedText(value.basis, 1, 1_000) &&
		boundedText(value.modelVersion, 1, 200)
	);
}

function isPlanRevision(
	value: unknown,
	planId: string,
	estimateIds: ReadonlySet<string>,
	timeZone: string,
): value is PlanRevision {
	if (
		!isRecordWithKeys(value, [
			"id",
			"planId",
			"number",
			"parentRevisionId",
			"trigger",
			"goal",
			"type",
			"rationaleSummary",
			"assumptions",
			"estimateId",
			"schedulingPreferences",
			"tasks",
			"scheduleWindow",
			"schedule",
			"unscheduledTaskIds",
			"createdAt",
		])
	) {
		return false;
	}
	if (
		!identifier(value.id) ||
		value.planId !== planId ||
		typeof value.number !== "number" ||
		!Number.isSafeInteger(value.number) ||
		value.number < 1 ||
		!(value.parentRevisionId === null || identifier(value.parentRevisionId)) ||
		!([
			"initial-analysis",
			"conversation",
			"confirmation",
			"task-status",
			"observation",
			"calendar-change",
			"daily-summary",
			"resume",
		] as const).includes(value.trigger as never) ||
		!boundedText(value.goal, 1, 1_000) ||
		!PLAN_TYPES.includes(value.type as never) ||
		!boundedText(value.rationaleSummary, 1, 500) ||
		!stringArray(value.assumptions, (item) => boundedText(item, 0, 300)) ||
		!identifier(value.estimateId) ||
		!estimateIds.has(value.estimateId) ||
		!isSchedulingPreferences(value.schedulingPreferences) ||
		!Array.isArray(value.tasks) ||
		!Array.isArray(value.schedule) ||
		!Array.isArray(value.unscheduledTaskIds) ||
		!isRecordWithKeys(value.scheduleWindow, ["startDate", "endDateExclusive"]) ||
		!validDate(value.scheduleWindow.startDate) ||
		!validDate(value.scheduleWindow.endDateExclusive) ||
		dayDistance(value.scheduleWindow.startDate, value.scheduleWindow.endDateExclusive) !== 7 ||
		!validInstant(value.createdAt)
	) {
		return false;
	}
	if (
		!isRecordWithKeys(value.scheduleWindow, ["startDate", "endDateExclusive"]) ||
		typeof value.scheduleWindow.startDate !== "string" ||
		typeof value.scheduleWindow.endDateExclusive !== "string"
	) {
		return false;
	}
	const windowStart = value.scheduleWindow.startDate;
	const windowEnd = value.scheduleWindow.endDateExclusive;
	const revisionTaskIds = new Set(
		value.tasks.flatMap((task) =>
			isRecord(task) && typeof task.taskId === "string" ? [task.taskId] : [],
		),
	);
	if (
		revisionTaskIds.size !== value.tasks.length ||
		!value.tasks.every((task) => {
			if (
				!isRecordWithKeys(task, [
					"taskId",
					"sourceKey",
					"purpose",
					"title",
					"description",
					"estimatedMinutes",
					"dependencyTaskIds",
				])
			) {
				return false;
			}
			return (
				identifier(task.taskId) &&
				identifier(task.sourceKey) &&
				PLAN_TASK_PURPOSES.includes(task.purpose as never) &&
				boundedText(task.title, 1, 200) &&
				boundedText(task.description, 0, 1_000) &&
				typeof task.estimatedMinutes === "number" &&
				Number.isSafeInteger(task.estimatedMinutes) &&
				task.estimatedMinutes >= 15 &&
				task.estimatedMinutes % 15 === 0 &&
				stringArray(
					task.dependencyTaskIds,
					(id) => identifier(id) && revisionTaskIds.has(id),
				)
			);
		}) ||
		!value.schedule.every((item) =>
			isScheduleItem(
				item,
				planId,
				revisionTaskIds,
				timeZone,
				windowStart,
				windowEnd,
			),
		) ||
		!stringArray(value.unscheduledTaskIds, (id) =>
			identifier(id) && revisionTaskIds.has(id),
		)
	) {
		return false;
	}
	return true;
}

function isScheduleItem(
	value: unknown,
	planId: string,
	taskIds: ReadonlySet<string>,
	timeZone: string,
	windowStart: string,
	windowEnd: string,
): value is PlanScheduleItem {
	if (
		!isRecordWithKeys(value, [
			"id",
			"planId",
			"taskId",
			"title",
			"start",
			"end",
			"timeZone",
		])
	) {
		return false;
	}
	if (
		!identifier(value.id) ||
		value.planId !== planId ||
		!identifier(value.taskId) ||
		!taskIds.has(value.taskId) ||
		!boundedText(value.title, 1, 200) ||
		!validInstant(value.start) ||
		!validInstant(value.end) ||
		compareInstants(value.start, value.end) >= 0 ||
		value.timeZone !== timeZone
	) {
		return false;
	}
	const date = instantToDate(value.start, timeZone);
	return compareDates(date, windowStart) >= 0 && compareDates(date, windowEnd) < 0;
}

function isMessage(
	value: unknown,
	planId: string,
): value is PlanConversationMessage {
	return (
		isRecordWithKeys(value, [
			"id",
			"planId",
			"role",
			"content",
			"createdAt",
			"causedByOperationId",
		]) &&
		identifier(value.id) &&
		value.planId === planId &&
		(value.role === "user" || value.role === "assistant") &&
		boundedText(value.content, 1, 4_000) &&
		validInstant(value.createdAt) &&
		boundedText(value.causedByOperationId, 1, 200)
	);
}

function isObservationEvidence(
	value: unknown,
	planId: string,
	taskIds: ReadonlySet<string>,
): value is PlanObservationEvidence {
	return (
		isRecordWithKeys(value, [
			"id",
			"observationId",
			"planId",
			"taskId",
			"startedAt",
			"endedAt",
			"relevantMinutes",
			"confidence",
			"attribution",
			"recordedAt",
		]) &&
		identifier(value.id) &&
		identifier(value.observationId) &&
		value.planId === planId &&
		identifier(value.taskId) &&
		taskIds.has(value.taskId) &&
		validInstant(value.startedAt) &&
		validInstant(value.endedAt) &&
		compareInstants(value.startedAt, value.endedAt) < 0 &&
		typeof value.relevantMinutes === "number" &&
		Number.isFinite(value.relevantMinutes) &&
		value.relevantMinutes >= 0 &&
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1 &&
		(value.attribution === "unique-observed" ||
			value.attribution === "user-confirmed") &&
		validInstant(value.recordedAt)
	);
}

function isPendingAttribution(value: unknown): boolean {
	return (
		isRecordWithKeys(value, ["observation", "status", "recordedAt"]) &&
		isObservationSummary(value.observation) &&
		([
			"awaiting-user",
			"ignored-low-confidence",
			"ignored-unavailable",
		] as const).includes(value.status as never) &&
		validInstant(value.recordedAt)
	);
}

function isObservationSummary(
	value: unknown,
): value is PlanningObservationSummary {
	return (
		isRecordWithKeys(value, [
			"id",
			"startedAt",
			"endedAt",
			"relevantMinutes",
			"coverage",
			"authorized",
			"candidates",
		]) &&
		identifier(value.id) &&
		validInstant(value.startedAt) &&
		validInstant(value.endedAt) &&
		compareInstants(value.startedAt, value.endedAt) < 0 &&
		typeof value.relevantMinutes === "number" &&
		Number.isFinite(value.relevantMinutes) &&
		value.relevantMinutes >= 0 &&
		(value.coverage === "complete" ||
			value.coverage === "partial" ||
			value.coverage === "missing") &&
		typeof value.authorized === "boolean" &&
		Array.isArray(value.candidates) &&
		value.candidates.every(
			(candidate) =>
				isRecordWithKeys(candidate, ["planId", "taskId", "confidence"]) &&
				identifier(candidate.planId) &&
				identifier(candidate.taskId) &&
				typeof candidate.confidence === "number" &&
				Number.isFinite(candidate.confidence) &&
				candidate.confidence >= 0 &&
				candidate.confidence <= 1,
		)
	);
}

function isAdjustment(
	value: unknown,
	planId: string,
	revisionIds: ReadonlySet<string>,
): value is PlanAdjustment {
	if (
		!isRecordWithKeys(value, [
			"id",
			"planId",
			"operationId",
			"trigger",
			"previousRevisionId",
			"nextRevisionId",
			"calendarChangeSet",
			"status",
			"createdAt",
			"finishedAt",
			"failureCode",
			"summary",
		])
	) {
		return false;
	}
	if (!isRecordWithKeys(value.summary, ["created", "moved", "cancelled"])) {
		return false;
	}
	const summary = value.summary;
	return (
		identifier(value.id) &&
		value.planId === planId &&
		boundedText(value.operationId, 1, 200) &&
		(typeof value.trigger === "string") &&
		(value.previousRevisionId === null ||
			(typeof value.previousRevisionId === "string" &&
				revisionIds.has(value.previousRevisionId))) &&
		typeof value.nextRevisionId === "string" &&
		revisionIds.has(value.nextRevisionId) &&
		isCalendarChangeSet(value.calendarChangeSet, planId) &&
		(["pending", "applied", "failed", "undone"] as const).includes(
			value.status as never,
		) &&
		validInstant(value.createdAt) &&
		(value.finishedAt === null || validInstant(value.finishedAt)) &&
		(value.failureCode === null || boundedText(value.failureCode, 1, 100)) &&
		["created", "moved", "cancelled"].every((key) => {
			const count = summary[key as keyof typeof summary];
			return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
		})
	);
}

function isCalendarChangeSet(value: unknown, planId: string): boolean {
	return (
		isRecordWithKeys(value, [
			"id",
			"planId",
			"operationId",
			"createdAt",
			"changes",
		]) &&
		identifier(value.id) &&
		value.planId === planId &&
		boundedText(value.operationId, 1, 240) &&
		validInstant(value.createdAt) &&
		Array.isArray(value.changes) &&
		value.changes.every((change) => isCalendarMutation(change, planId))
	);
}

function isCalendarMutation(
	value: unknown,
	planId: string,
): value is CalendarEventMutation {
	if (
		!isRecordWithKeys(value, [
			"kind",
			"eventId",
			"expectedVersion",
			"before",
			"after",
		]) ||
		!(value.kind === "create" || value.kind === "update" || value.kind === "delete") ||
		!identifier(value.eventId) ||
		!(
			value.expectedVersion === null ||
			(typeof value.expectedVersion === "number" &&
				Number.isSafeInteger(value.expectedVersion) &&
				value.expectedVersion >= 0)
		) ||
		!(value.before === null || isCalendarEvent(value.before, planId)) ||
		!(value.after === null || isCalendarEvent(value.after, planId))
	) {
		return false;
	}
	return (
		(value.kind === "create" && value.before === null && value.after !== null) ||
		(value.kind === "update" && value.before !== null && value.after !== null) ||
		(value.kind === "delete" && value.before !== null && value.after === null)
	);
}

function isCalendarEvent(
	value: unknown,
	planId: string,
): value is PlanningCalendarEvent {
	return (
		isRecordWithKeys(value, [
			"id",
			"title",
			"kind",
			"state",
			"start",
			"end",
			"timeZone",
			"planId",
			"sourceTaskId",
			"scheduleOrigin",
			"userLocked",
			"version",
		]) &&
		identifier(value.id) &&
		boundedText(value.title, 1, 200) &&
		value.kind === "plan" &&
		value.state === "committed" &&
		validInstant(value.start) &&
		validInstant(value.end) &&
		compareInstants(value.start, value.end) < 0 &&
		typeof value.timeZone === "string" &&
		validTimeZone(value.timeZone) &&
		value.planId === planId &&
		identifier(value.sourceTaskId) &&
		value.scheduleOrigin === "model" &&
		typeof value.userLocked === "boolean" &&
		typeof value.version === "number" &&
		Number.isSafeInteger(value.version) &&
		value.version >= 0
	);
}

function isSchedulingPreferences(value: unknown): boolean {
	return (
		isRecordWithKeys(value, [
			"weeklyCapacityMinutes",
			"sessionMinutes",
			"availableWindows",
		]) &&
		typeof value.weeklyCapacityMinutes === "number" &&
		Number.isSafeInteger(value.weeklyCapacityMinutes) &&
		value.weeklyCapacityMinutes >= 15 &&
		value.weeklyCapacityMinutes % 15 === 0 &&
		typeof value.sessionMinutes === "number" &&
		Number.isSafeInteger(value.sessionMinutes) &&
		value.sessionMinutes >= 15 &&
		value.sessionMinutes % 15 === 0 &&
		Array.isArray(value.availableWindows) &&
		value.availableWindows.length > 0 &&
		value.availableWindows.every(
			(window) =>
				isRecordWithKeys(window, ["dayOfWeek", "startTime", "endTime"]) &&
				typeof window.dayOfWeek === "number" &&
				Number.isSafeInteger(window.dayOfWeek) &&
				window.dayOfWeek >= 1 &&
				window.dayOfWeek <= 7 &&
				typeof window.startTime === "string" &&
				typeof window.endTime === "string" &&
				/^\d{2}:\d{2}$/.test(window.startTime) &&
				/^\d{2}:\d{2}$/.test(window.endTime) &&
				window.startTime < window.endTime,
		)
	);
}

function isAnalysisDiagnostic(value: unknown): boolean {
	return (
		value === null ||
		(isRecordWithKeys(value, ["source", "code", "retryable", "recordedAt"]) &&
			value.source === "planning-model" &&
			[
				"model-unavailable",
				"request-timeout",
				"invalid-output",
				"unexpected-failure",
			].includes(String(value.code)) &&
			typeof value.retryable === "boolean" &&
			validInstant(value.recordedAt))
	);
}

function isPendingAnalysis(value: unknown): boolean {
	return (
		value === null ||
		(isRecordWithKeys(value, ["trigger", "automatic", "useActiveBaseline"]) &&
			[
				"initial-analysis",
				"conversation",
				"task-status",
				"observation",
				"calendar-change",
				"daily-summary",
				"resume",
			].includes(String(value.trigger)) &&
			typeof value.automatic === "boolean" &&
			typeof value.useActiveBaseline === "boolean")
	);
}

function isRecordWithKeys<K extends string>(
	value: unknown,
	keys: readonly K[],
): value is Record<K, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
	value: unknown,
	minimum: number,
	maximum: number,
): value is string {
	return (
		typeof value === "string" &&
		value.trim().length >= minimum &&
		Array.from(value).length <= maximum
	);
}

function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 240 &&
		!/[\u0000-\u001f]/.test(value)
	);
}

function stringArray(
	value: unknown,
	predicate: (item: unknown) => boolean,
): value is string[] {
	return Array.isArray(value) && value.every(predicate) && unique(value);
}

function validDate(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		assertIsoDate(value);
		return true;
	} catch {
		return false;
	}
}

function validTimeZone(value: string): boolean {
	try {
		assertIanaTimeZone(value);
		return true;
	} catch {
		return false;
	}
}

function validInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		compareInstants(value, value);
		return true;
	} catch {
		return false;
	}
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function dayDistance(start: string, end: string): number {
	try {
		return Number(
			Temporal.PlainDate.from(start)
				.until(Temporal.PlainDate.from(end), { largestUnit: "day" })
				.total({ unit: "day" }),
		);
	} catch {
		return Number.NaN;
	}
}
