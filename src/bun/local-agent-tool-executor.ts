import { randomUUID } from "node:crypto";
import type { ActiveGoalContextV1 } from "../shared/goal-context";
import type { CalendarEvent, CalendarMutation } from "../shared/calendar";
import type { AgentToolName } from "./agent-tool-policy";
import type { LocalAgentToolExecutor } from "./agent-run-coordinator";
import type { CalendarRepository } from "./calendar-repository";
import type { EncryptedAgentRepository } from "./encrypted-agent-repository";

export interface WhaleHallAgentToolExecutorOptions {
	calendar: CalendarRepository;
	repository: EncryptedAgentRepository;
	activeGoal: (accountId: string) => ActiveGoalContextV1 | null;
	now?: () => number;
}

/** The complete v1 Tool catalogue. No Rust sensor/activity/browser tools are exposed. */
export class WhaleHallAgentToolExecutor implements LocalAgentToolExecutor {
	private readonly now: () => number;

	constructor(private readonly options: WhaleHallAgentToolExecutorOptions) {
		this.now = options.now ?? Date.now;
	}

	async execute(input: {
		accountId: string;
		runId: string;
		toolCallId: string;
		name: AgentToolName;
		arguments: Record<string, unknown>;
	}): Promise<unknown> {
		switch (input.name) {
			case "calendar.list_events":
				return this.listCalendar(input.accountId, input.arguments);
			case "planning.get_active_plan":
				return this.getActivePlan(input.accountId);
			case "planning.get_active_goal":
				return { goal: this.options.activeGoal(input.accountId) };
			case "planning.save_draft":
				return this.saveDraft(input.accountId, input.arguments);
			case "calendar.create_event":
				return this.createEvent(input.accountId, input.arguments);
			case "calendar.update_event":
				return this.updateEvent(input.accountId, input.arguments);
			case "calendar.delete_event":
				return this.deleteEvent(input.accountId, input.arguments);
			case "calendar.commit_plan_schedule":
				return this.commitPlanSchedule(input.accountId, input.arguments);
		}
	}

	private async listCalendar(accountId: string, args: Record<string, unknown>): Promise<unknown> {
		const snapshot = await this.options.calendar.snapshot(
			accountId,
			requiredDate(args.fromDate, "fromDate"),
			requiredDate(args.toDateExclusive, "toDateExclusive"),
		);
		return {
			revision: snapshot.revision,
			fromDate: snapshot.fromDate,
			toDateExclusive: snapshot.toDateExclusive,
			timeZone: snapshot.timeZone,
			events: snapshot.events,
		};
	}

	private async getActivePlan(accountId: string): Promise<unknown> {
		const workflows = await this.options.repository.listWorkflows(accountId, 100);
		const planning = workflows.find((workflow) => workflow.name === "task-planning");
		return { plan: planning?.definition ?? null };
	}

	private async saveDraft(accountId: string, args: Record<string, unknown>): Promise<unknown> {
		const draft = requiredRecord(args.draft, "draft");
		const expectedVersion = optionalVersion(args.expectedVersion);
		if (expectedVersion === null) {
			const id = `draft-${randomUUID()}`;
			const version = this.now();
			const created = await this.options.repository.compareAndSetWorkflow({
				accountId,
				id,
				name: "agent-saved-draft",
				definition: { ...structuredClone(draft), id },
				enabled: true,
				createdAtMs: version,
				updatedAtMs: version,
			}, null);
			if (!created) throw new Error("草案标识发生冲突，请重试新建操作。");
			return { saved: true, operation: "created", draftId: id, version };
		}

		const id = requiredId(draft.id, "draft.id");
		const existing = await this.options.repository.getWorkflow(accountId, id);
		if (!existing || existing.name !== "agent-saved-draft") {
			throw new Error("只能更新已存在的 Agent 本地草案。");
		}
		if (existing.updatedAtMs !== expectedVersion) {
			throw new Error("草案版本已变化，请重新读取后再更新。");
		}
		const version = Math.max(this.now(), expectedVersion + 1);
		if (!Number.isSafeInteger(version)) throw new Error("草案版本无法继续递增。");
		const updated = await this.options.repository.compareAndSetWorkflow({
			accountId,
			id,
			name: "agent-saved-draft",
			definition: { ...structuredClone(draft), id },
			enabled: true,
			createdAtMs: existing.createdAtMs,
			updatedAtMs: version,
		}, expectedVersion);
		if (!updated) throw new Error("草案版本已变化，请重新读取后再更新。");
		return { saved: true, operation: "updated", draftId: id, version };
	}

	private async createEvent(accountId: string, args: Record<string, unknown>): Promise<unknown> {
		const event = requiredEvent(args.event);
		return this.requireMutationSuccess(await this.options.calendar.mutate(accountId, {
			mutationId: `tool-${randomUUID()}`,
			kind: "create",
			eventId: event.id,
			expectedVersion: null,
			before: null,
			after: event,
			recurrenceScope: null,
		}));
	}

	private async updateEvent(accountId: string, args: Record<string, unknown>): Promise<unknown> {
		const event = requiredEvent(args.event);
		const eventId = requiredId(args.eventId, "eventId");
		if (event.id !== eventId) throw new Error("eventId does not match the event being updated.");
		return this.requireMutationSuccess(await this.options.calendar.mutate(accountId, {
			mutationId: `tool-${randomUUID()}`,
			kind: "update",
			eventId,
			expectedVersion: requiredVersion(args.expectedVersion),
			before: null,
			after: event,
			recurrenceScope: parseScope(args.recurrenceScope),
		}));
	}

	private async deleteEvent(accountId: string, args: Record<string, unknown>): Promise<unknown> {
		const eventId = requiredId(args.eventId, "eventId");
		return this.requireMutationSuccess(await this.options.calendar.mutate(accountId, {
			mutationId: `tool-${randomUUID()}`,
			kind: "delete",
			eventId,
			expectedVersion: requiredVersion(args.expectedVersion),
			before: null,
			after: null,
			recurrenceScope: parseScope(args.recurrenceScope),
		}));
	}

	private async commitPlanSchedule(accountId: string, args: Record<string, unknown>): Promise<unknown> {
		if (!Array.isArray(args.schedule) || args.schedule.length < 1 || args.schedule.length > 500) {
			throw new Error("schedule must contain one to 500 plan items.");
		}
		const planId = requiredId(args.planId, "planId");
		const mutations = args.schedule.map<CalendarMutation>((value) => {
			const proposal = requiredScheduleProposal(value);
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
				sourcePlanId: planId,
				editable: true,
				version: 0,
			};
			return {
				mutationId: `tool-${randomUUID()}`,
				kind: "create",
				eventId: event.id,
				expectedVersion: null,
				before: null,
				after: event,
				recurrenceScope: null,
			};
		});
		const result = await this.options.calendar.mutateBatch(
			accountId,
			`tool-batch-${randomUUID()}`,
			mutations,
			requiredVersion(args.calendarRevision),
		);
		if (!result.ok) throw new Error(result.conflicts[0]?.message ?? "计划排程未写入日历。");
		return { committed: result.events.length, revision: result.calendarRevision };
	}

	private requireMutationSuccess<T extends Awaited<ReturnType<CalendarRepository["mutate"]>>>(result: T): T {
		if (!result.ok) throw new Error(result.conflict.message);
		return result;
	}
}

function requiredScheduleProposal(value: unknown): {
	id: string;
	taskId: string;
	title: string;
	start: string;
	end: string;
	timeZone: string;
} {
	if (!isRecord(value)) throw new Error("schedule item is invalid.");
	return {
		id: requiredId(value.id, "schedule.id"),
		taskId: requiredId(value.taskId, "schedule.taskId"),
		title: requiredId(value.title, "schedule.title"),
		start: requiredId(value.start, "schedule.start"),
		end: requiredId(value.end, "schedule.end"),
		timeZone: requiredId(value.timeZone, "schedule.timeZone"),
	};
}

function requiredEvent(value: unknown): CalendarEvent {
	if (!isRecord(value) || typeof value.id !== "string") throw new Error("event is invalid.");
	return structuredClone(value) as unknown as CalendarEvent;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${field} must be an object.`);
	return value;
}

function requiredId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`${field} is invalid.`);
	return value;
}

function requiredDate(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} is invalid.`);
	return value;
}

function requiredVersion(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Expected version is invalid.");
	return value as number;
}

function optionalVersion(value: unknown): number | null {
	return value === undefined ? null : requiredVersion(value);
}

function parseScope(value: unknown): CalendarMutation["recurrenceScope"] {
	return value === "occurrence" || value === "following" || value === "series" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
