import type { AgentRuntime } from "../agent-runtime";
import type {
	LocalPlanningCalendarEvent,
	LocalPlanningPlanSnapshot,
} from "../local-protocol";
import { LOCAL_REDACTED_PLAN_CALENDAR_TITLE } from "../local-protocol";
import type {
	CalendarApplyResult,
	PlanningCalendarPort,
	PlanningCalendarQuery,
	PlanningRepository,
	PlanningWriteResult,
} from "./ports";
import {
	PlanVersionConflictError,
} from "./ports";
import type {
	CalendarChangeSet,
	PlanningCalendarEvent,
	PlanningPlan,
} from "./types";
import {
	addDays,
	compareInstants,
	localDateTimeToInstant,
} from "./time";
import {
	PlanningVaultPersistenceError,
	openSealedPlanningPlan,
	parseLegacyPlanningSnapshot,
	sealPlanningPlan,
	type SealedPlanningResult,
} from "./native-vault";
import { withPlanningVaultExclusiveLease } from "./native-vault-coordinator";
import {
	PlanningVaultGarbageCollector,
	type PlanningVaultGarbageCollectionPort,
	type PlanningVaultGarbageCollectionResult,
	type PlanningVaultGarbageCollectorOptions,
} from "./native-vault-gc";

const SEALED_INDEX_VALUE = "sealed";

type NativePlanningAgent = Pick<
	AgentRuntime,
	| "listPlanningPlans"
	| "getPlanningPlan"
	| "getPlanningOperationResult"
	| "upsertPlanningPlan"
	| "mutatePlanningPlan"
	| "listPlanningCalendar"
	| "mutatePlanningCalendar"
	| "sealVaultBatch"
	| "openVaultBatch"
> &
	Partial<
		Pick<
			AgentRuntime,
			"deleteVaultBatch" | "listVaultRecords" | "listPlanningVaultReferences"
		>
	>;

/** Durable repository backed by the versioned whalehall-local SQLite store. */
export class NativePlanningRepository implements PlanningRepository {
	constructor(private readonly agent: NativePlanningAgent) {}

	collectVaultGarbage(
		options: PlanningVaultGarbageCollectorOptions = {},
	): Promise<PlanningVaultGarbageCollectionResult> {
		if (
			!this.agent.deleteVaultBatch ||
			!this.agent.listVaultRecords ||
			!this.agent.listPlanningVaultReferences
		) {
			throw new Error("Native planning Vault maintenance is unavailable.");
		}
		const collector = new PlanningVaultGarbageCollector(
			this.agent as PlanningVaultGarbageCollectionPort,
			{ ...options, coordinationOwner: this.agent },
		);
		return collector.collect();
	}

	async listPlans(): Promise<readonly PlanningPlan[]> {
		const result = await this.agent.listPlanningPlans({ limit: 1_000 });
		return Promise.all(
			result.plans.map((snapshot) => fromSnapshot(this.agent, snapshot)),
		);
	}

	async getPlan(planId: string): Promise<PlanningPlan | null> {
		const snapshot = await this.agent.getPlanningPlan(planId);
		return snapshot ? fromSnapshot(this.agent, snapshot) : null;
	}

	async getOperationResult(operationId: string): Promise<PlanningPlan | null> {
		const snapshot = await this.agent.getPlanningOperationResult(operationId);
		return snapshot ? fromSnapshot(this.agent, snapshot) : null;
	}

	async createPlan(
		plan: PlanningPlan,
		operationId: string,
	): Promise<PlanningWriteResult> {
		return withPlanningVaultExclusiveLease(this.agent, async () => {
			const sealed = await sealPlanningPlan(this.agent, plan, operationId);
			const result = await this.agent.upsertPlanningPlan({
				operationId,
				expectedVersion: null,
				plan: toSnapshot(plan, sealed),
				outbox: [planChangedOutbox(plan, operationId)],
			});
			return {
				plan: await fromSnapshot(this.agent, result.plan),
				replayed: false,
			};
		});
	}

	async savePlan(
		plan: PlanningPlan,
		options: { operationId: string; expectedVersion: number },
	): Promise<PlanningWriteResult> {
		return withPlanningVaultExclusiveLease(this.agent, async () => {
			try {
				const sealed = await sealPlanningPlan(
					this.agent,
					plan,
					options.operationId,
				);
				const result = await this.agent.mutatePlanningPlan({
					operationId: options.operationId,
					expectedVersion: options.expectedVersion,
					plan: toSnapshot(plan, sealed),
					outbox: [planChangedOutbox(plan, options.operationId)],
				});
				return {
					plan: await fromSnapshot(this.agent, result.plan),
					replayed: false,
				};
			} catch (error) {
				if (
					nativeErrorCode(error) === "BUSY" ||
					nativeErrorReason(error) === "stale-version"
				) {
					throw new PlanVersionConflictError(options.expectedVersion, null);
				}
				throw error;
			}
		});
	}
}

/** Native calendar port. A change set is one atomic, idempotent mutation. */
export class NativePlanningCalendar implements PlanningCalendarPort {
	constructor(private readonly agent: NativePlanningAgent) {}

	async listEvents(
		query: PlanningCalendarQuery,
	): Promise<readonly PlanningCalendarEvent[]> {
		const result = await this.agent.listPlanningCalendar({
			// Native v1 indexes RFC3339 UTC dates. Widen by one local date on
			// either side, then apply the authoritative named-timezone interval
			// filter below so positive/negative UTC offsets cannot lose events.
			fromDate: addDays(query.startDate, -1),
			toDateExclusive: addDays(query.endDateExclusive, 1),
		});
		const start = localDateTimeToInstant(
			query.startDate,
			"00:00",
			query.timeZone,
		);
		const end = localDateTimeToInstant(
			query.endDateExclusive,
			"00:00",
			query.timeZone,
		);
		return result.events.flatMap((event) => {
			const projected = fromCalendarEvent(event);
			return projected &&
				compareInstants(projected.start, end) < 0 &&
				compareInstants(projected.end, start) > 0
				? [projected]
				: [];
		});
	}

	async applyChangeSet(changeSet: CalendarChangeSet): Promise<CalendarApplyResult> {
		if (changeSet.changes.length === 0) {
			return {
				ok: true,
				changeSetId: changeSet.id,
				events: [],
				replayed: false,
			};
		}
		try {
			const result = await this.agent.mutatePlanningCalendar({
				operationId: changeSet.operationId,
				actor: "planning-runtime",
				mutations: changeSet.changes.map((mutation) =>
					mutation.kind === "delete"
						? {
								action: "delete" as const,
								eventId: mutation.eventId,
								expectedVersion: mutation.expectedVersion ?? 0,
							}
						: {
								action: "upsert" as const,
								expectedVersion: mutation.expectedVersion,
								event: toCalendarEvent(mutation.after!),
							},
				),
				outbox: [
					{
						entryId: `calendar:${changeSet.id}`,
						kind: "calendar-changed",
						aggregateId: changeSet.planId,
						payload: {
							changeSetId: changeSet.id,
							planId: changeSet.planId,
						},
						createdAtMs: Date.parse(changeSet.createdAt),
					},
				],
			});
			return {
				ok: true,
				changeSetId: changeSet.id,
				events: result.outcomes.flatMap((outcome) => {
					const event = outcome.event ? fromCalendarEvent(outcome.event) : null;
					return event ? [event] : [];
				}),
				replayed: false,
			};
		} catch (error) {
			return {
				ok: false,
				changeSetId: changeSet.id,
				conflicts: [
					{
						code:
							nativeErrorCode(error) === "BUSY" ||
							nativeErrorReason(error) === "stale-version"
								? "stale-version"
								: "service-unavailable",
						affectedEventIds: changeSet.changes.map(
							(item) => item.eventId,
						),
					},
				],
			};
		}
	}
}

function toSnapshot(
	plan: PlanningPlan,
	sealed: SealedPlanningResult,
): LocalPlanningPlanSnapshot {
	const active = plan.revisions.find(
		(item) => item.id === (plan.proposedRevisionId ?? plan.activeRevisionId),
	);
	const estimate = plan.estimates.find((item) => item.id === active?.estimateId);
	return {
		schemaVersion: "planning.v1",
		planId: plan.id,
		version: plan.version,
		planType: plan.type ?? active?.type ?? null,
		status: plan.status,
		goal: null,
		sealedContentRef: sealed.contentRef,
		redactedContent: false,
		startToday: plan.requestedStartToday,
		timeZone: plan.timeZone,
		effectiveStartDate: plan.effectiveStartDate,
		schedulingWindow: active
			? {
					startDate: active.scheduleWindow.startDate,
					endDateInclusive: previousDate(active.scheduleWindow.endDateExclusive),
				}
			: null,
		currentEstimate: estimate ? toSafeNativeEstimate(estimate) : null,
		tasks: plan.tasks.map((task) => ({
			taskId: task.id,
			title: SEALED_INDEX_VALUE,
			description: "",
			dependencyTaskIds: [...task.dependencyTaskIds],
			estimatedEffortMinutes: task.estimatedMinutes,
			status: task.status,
		})),
		conversation: [],
		revisions: plan.revisions.map((revision) => ({
			revisionId: revision.id,
			planVersion: revision.number,
			createdAtMs: Date.parse(revision.createdAt),
			reason: revision.trigger,
			estimate: null,
			payload: { revisionId: revision.id },
		})),
		estimateSnapshots: [],
		observationEvidence: plan.observationEvidence.map((evidence) => ({
			evidenceId: evidence.id,
			taskId: evidence.taskId,
			startedAtMs: Date.parse(evidence.startedAt),
			endedAtMs: Date.parse(evidence.endedAt),
			relevanceConfidence: evidence.confidence,
			attribution: "confirmed",
			sourceEventIds: [evidence.observationId],
			createdAtMs: Date.parse(evidence.recordedAt),
		})),
		// Runtime adjustments are a status machine (pending -> applied/failed ->
		// undone), while this indexed native collection is append-only. Keep the
		// full validated authority in the content vault until the native protocol has
		// a transition-log representation instead of mutating records in place.
		adjustments: [],
		autoScheduleAuthorized: plan.autoAdjustAuthorized,
		monitoringMode: "authorized",
		analysisState: plan.analysisState,
		analysisDiagnostic: plan.analysisDiagnostic?.code ?? null,
		activeRevisionId: plan.activeRevisionId,
		proposedRevisionId: plan.proposedRevisionId,
		runtimePayload: sealed.reference,
		createdAtMs: Date.parse(plan.createdAt),
		updatedAtMs: Date.parse(plan.updatedAt),
	};
}

async function fromSnapshot(
	agent: NativePlanningAgent,
	snapshot: LocalPlanningPlanSnapshot,
): Promise<PlanningPlan> {
	if (snapshot.sealedContentRef !== undefined && snapshot.sealedContentRef !== null) {
		if (
			typeof snapshot.sealedContentRef !== "string" ||
			snapshot.sealedContentRef.length === 0
		) {
			throw new PlanningVaultPersistenceError("invalid-reference");
		}
		assertSafeSealedProjection(snapshot);
		return openSealedPlanningPlan(agent, snapshot);
	}
	// Compatibility is deliberately read-only. The next normal runtime write
	// always calls sealPlanningPlan and migrates this aggregate to the encrypted
	// manifest format; a broken sealed snapshot never downgrades to plaintext.
	return parseLegacyPlanningSnapshot(snapshot);
}

function toSafeNativeEstimate(estimate: PlanningPlan["estimates"][number]) {
	return {
		estimatedCompletionDate: estimate.estimatedCompletionDate,
		confidence: estimate.confidence,
		assessedAtMs: Date.parse(estimate.assessedAt),
		evidenceThroughMs: Date.parse(`${estimate.evidenceThrough}T00:00:00Z`),
		basis: SEALED_INDEX_VALUE,
		modelVersion: SEALED_INDEX_VALUE,
	};
}

function assertSafeSealedProjection(snapshot: LocalPlanningPlanSnapshot): void {
	const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : null;
	const revisions = Array.isArray(snapshot.revisions) ? snapshot.revisions : null;
	if (
		!(snapshot.goal === null || snapshot.goal === undefined) ||
		!Array.isArray(snapshot.conversation) ||
		snapshot.conversation.length !== 0 ||
		!Array.isArray(snapshot.estimateSnapshots) ||
		snapshot.estimateSnapshots.length !== 0 ||
		!tasks ||
		!tasks.every(
			(task) =>
				task !== null &&
				typeof task === "object" &&
				"title" in task &&
				task.title === SEALED_INDEX_VALUE &&
				"description" in task &&
				task.description === "",
		) ||
		!revisions ||
		!revisions.every(
			(revision) =>
				revision !== null &&
				typeof revision === "object" &&
				"estimate" in revision &&
				revision.estimate === null,
		) ||
		!(
			snapshot.currentEstimate === null ||
			(typeof snapshot.currentEstimate === "object" &&
				snapshot.currentEstimate !== null &&
				"basis" in snapshot.currentEstimate &&
				snapshot.currentEstimate.basis === SEALED_INDEX_VALUE)
		)
	) {
		throw new PlanningVaultPersistenceError("invalid-reference");
	}
}

function planChangedOutbox(plan: PlanningPlan, operationId: string) {
	return {
		entryId: `plan:${operationId}`,
		kind: "plan-changed" as const,
		aggregateId: plan.id,
		payload: { planId: plan.id, version: plan.version },
		createdAtMs: Date.parse(plan.updatedAt),
	};
}

function toCalendarEvent(event: PlanningCalendarEvent): LocalPlanningCalendarEvent {
	const redactModelContent =
		event.kind === "plan" && event.scheduleOrigin === "model";
	return {
		schemaVersion: "calendar.v1",
		eventId: event.id,
		title: redactModelContent
			? LOCAL_REDACTED_PLAN_CALENDAR_TITLE
			: event.title,
		sealedContentRef: null,
		redactedContent: redactModelContent,
		kind: event.kind,
		state: event.state,
		schedule: {
			allDay: false,
			start: event.start,
			end: event.end,
			timeZone: event.timeZone,
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: event.planId,
		sourceTaskId: event.sourceTaskId,
		scheduleOrigin: event.scheduleOrigin,
		userLocked: event.userLocked,
		editable: true,
		version: event.version,
	};
}

function fromCalendarEvent(
	event: LocalPlanningCalendarEvent,
): PlanningCalendarEvent | null {
	if (event.schedule.allDay) return null;
	return {
		id: event.eventId,
		title:
			event.redactedContent || event.sealedContentRef !== null
				? LOCAL_REDACTED_PLAN_CALENDAR_TITLE
				: event.title,
		kind: event.kind,
		state: event.state,
		start: event.schedule.start,
		end: event.schedule.end,
		timeZone: event.schedule.timeZone,
		planId: event.sourcePlanId,
		sourceTaskId: event.sourceTaskId,
		scheduleOrigin: event.scheduleOrigin ?? "user",
		userLocked: event.userLocked,
		version: event.version,
	};
}

function previousDate(exclusive: string): string {
	const value = new Date(`${exclusive}T00:00:00Z`);
	value.setUTCDate(value.getUTCDate() - 1);
	return value.toISOString().slice(0, 10);
}

function nativeErrorCode(error: unknown): string | null {
	return error !== null && typeof error === "object" && "code" in error
		? String(error.code)
		: null;
}

function nativeErrorReason(error: unknown): string | null {
	return error !== null &&
		typeof error === "object" &&
		"details" in error &&
		error.details !== null &&
		typeof error.details === "object" &&
		"reason" in error.details
		? String(error.details.reason)
		: null;
}
