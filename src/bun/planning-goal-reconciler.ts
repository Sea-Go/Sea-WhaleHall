import { createHash } from "node:crypto";
import type { LocalPlanningCalendarEvent } from "../agent/local-protocol";
import type { PlanningPlan, PlanTask } from "../agent/planning";
import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../shared/goal-context";
import type { ActiveGoalWrite } from "./account-scoped-active-goal";

export type PlanningGoalWrite = Exclude<ActiveGoalWrite, null>;

/** The goal as the reflection runtime currently holds it. */
export type CurrentPlanningGoal = {
	goalId: string;
	planId: string | null;
	text: string;
	activatedAtMs: number;
};

export type PlanningGoalResolution =
	| {
			tier: "executing-task";
			goal: PlanningGoalWrite;
			planId: string;
			taskId: string;
	  }
	| {
			tier: "pending-tasks";
			goal: PlanningGoalWrite;
			planIds: readonly string[];
			taskCount: number;
	  }
	| {
			tier: "none";
			goal: null;
			reason: "no-active-plan" | "no-pending-tasks";
	  };

export type PlanningGoalReconcileResult =
	| PlanningGoalResolution
	| { tier: "unavailable"; goal: null; stage: "lookup" | "apply" }
	| { tier: "signed-out"; goal: null };

export const PENDING_TASKS_GOAL_PREFIX = "待办任务：";
export const DEFAULT_PLAN_CACHE_TTL_MS = 10 * 60_000;

/**
 * Resolves the reflection goal in priority order: the task whose committed
 * calendar block is executing now, otherwise the pending tasks of every active
 * plan, otherwise no goal. The plan order is stable (creation time, then id)
 * so that routine plan writes cannot turn the same tasks into a new goal.
 */
export function resolvePlanningGoal(input: {
	nowMs: number;
	calendar: readonly LocalPlanningCalendarEvent[];
	plans: readonly PlanningPlan[];
}): PlanningGoalResolution {
	const executing = resolveExecutingTaskGoal(input);
	if (executing !== null) return executing;
	return resolvePendingTasksGoal(input);
}

export type PlanningGoalReconcilerOptions = {
	loadCalendar: () => Promise<readonly LocalPlanningCalendarEvent[]>;
	/** Unseals every plan; rejects while the Vault key is unavailable. */
	loadPlans: () => Promise<readonly PlanningPlan[]>;
	currentGoal: () => CurrentPlanningGoal | null;
	applyGoal: (goal: ActiveGoalWrite) => Promise<CurrentPlanningGoal | null>;
	afterChange?: () => Promise<void> | void;
	/** While it reports false no goal is set and a leftover goal is cleared. */
	hasSession?: () => boolean;
	diag?: (line: string) => void;
	nowMs?: () => number;
	planCacheTtlMs?: number;
};

/**
 * Keeps the reflection goal aligned with the planning store. A failed lookup
 * or write leaves the current goal untouched, is reported once per distinct
 * failure and never reaches the caller, so a transient Vault outage neither
 * clears the goal, seals an open window with a goal boundary, nor fails the
 * plan mutation that triggered the reconciliation.
 */
export class PlanningGoalReconciler {
	private cachedPlans: {
		plans: readonly PlanningPlan[];
		fetchedAtMs: number;
	} | null = null;
	private planGeneration = 0;
	private lastReportedState: string | null = null;
	private readonly nowMs: () => number;
	private readonly planCacheTtlMs: number;

	constructor(private readonly options: PlanningGoalReconcilerOptions) {
		this.nowMs = options.nowMs ?? Date.now;
		this.planCacheTtlMs = options.planCacheTtlMs ?? DEFAULT_PLAN_CACHE_TTL_MS;
	}

	invalidate(): void {
		this.cachedPlans = null;
		this.planGeneration += 1;
	}

	async reconcile(): Promise<PlanningGoalReconcileResult> {
		if (this.options.hasSession?.() === false) {
			// The logout barrier clears the goal; nothing may set it again
			// before a session is active.
			await this.clearForSignedOut();
			return { tier: "signed-out", goal: null };
		}
		let calendar: readonly LocalPlanningCalendarEvent[];
		let plans: readonly PlanningPlan[];
		try {
			calendar = await this.options.loadCalendar();
			plans = await this.loadPlans();
		} catch (error) {
			this.report(`tier=unavailable stage=lookup ${describeError(error)}`);
			return { tier: "unavailable", goal: null, stage: "lookup" };
		}
		const resolution = resolvePlanningGoal({
			nowMs: this.nowMs(),
			calendar,
			plans,
		});
		try {
			await this.apply(resolution);
		} catch (error) {
			this.report(`tier=unavailable stage=apply ${describeError(error)}`);
			return { tier: "unavailable", goal: null, stage: "apply" };
		}
		this.report(describeResolution(resolution));
		return resolution;
	}

	private async clearForSignedOut(): Promise<void> {
		this.cachedPlans = null;
		if (this.options.currentGoal() !== null) {
			try {
				await this.options.applyGoal(null);
			} catch (error) {
				this.report(`tier=signed-out clear-failed ${describeError(error)}`);
				return;
			}
		}
		this.report("tier=signed-out");
	}

	private async loadPlans(): Promise<readonly PlanningPlan[]> {
		const cached = this.cachedPlans;
		if (
			cached !== null &&
			this.nowMs() - cached.fetchedAtMs < this.planCacheTtlMs
		) {
			return cached.plans;
		}
		// A plan written while this load is in flight must not be hidden by
		// the stale result it captured.
		const generation = this.planGeneration;
		const plans = await this.options.loadPlans();
		this.cachedPlans =
			generation === this.planGeneration
				? { plans, fetchedAtMs: this.nowMs() }
				: null;
		return plans;
	}

	private async apply(resolution: PlanningGoalResolution): Promise<void> {
		const current = this.options.currentGoal();
		const resolved = resolution.goal;
		if (resolved === null) {
			if (current === null) return;
			await this.options.applyGoal(null);
			await this.pullTimeline();
			return;
		}
		// The reflection service keeps the existing goal when a request is
		// activated earlier than it. A block that started before the pending
		// tasks goal was set must still take over.
		const goal =
			current !== null && resolved.activatedAtMs < current.activatedAtMs
				? { ...resolved, activatedAtMs: current.activatedAtMs }
				: resolved;
		const applied = await this.options.applyGoal(goal);
		if (
			current === null ||
			applied === null ||
			current.goalId !== applied.goalId ||
			current.planId !== applied.planId ||
			current.text !== applied.text
		) {
			await this.pullTimeline();
		}
	}

	private async pullTimeline(): Promise<void> {
		try {
			await this.options.afterChange?.();
		} catch (error) {
			this.options.diag?.(
				`[planning-goal] pull-failed ${describeError(error)}`,
			);
		}
	}

	private report(state: string): void {
		if (state === this.lastReportedState) return;
		this.lastReportedState = state;
		this.options.diag?.(`[planning-goal] ${state}`);
	}
}

type ExecutingBlock = {
	event: LocalPlanningCalendarEvent;
	startMs: number;
};

function resolveExecutingTaskGoal(input: {
	nowMs: number;
	calendar: readonly LocalPlanningCalendarEvent[];
	plans: readonly PlanningPlan[];
}): PlanningGoalResolution | null {
	const blocks: ExecutingBlock[] = [];
	for (const event of input.calendar) {
		if (
			event.kind !== "plan" ||
			event.state !== "committed" ||
			event.schedule.allDay ||
			event.sourcePlanId === null ||
			event.sourceTaskId === null
		) {
			continue;
		}
		const startMs = Date.parse(event.schedule.start);
		const endMs = Date.parse(event.schedule.end);
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
		if (startMs <= input.nowMs && input.nowMs < endMs) {
			blocks.push({ event, startMs });
		}
	}
	blocks.sort(
		(left, right) =>
			left.startMs - right.startMs ||
			left.event.eventId.localeCompare(right.event.eventId),
	);
	const block = blocks[0];
	if (!block) return null;
	const plan = input.plans.find(
		(candidate) => candidate.id === block.event.sourcePlanId,
	);
	const task = plan?.tasks.find(
		(candidate) => candidate.id === block.event.sourceTaskId,
	);
	if (plan?.status !== "active" || !task || task.status !== "pending") {
		return null;
	}
	return {
		tier: "executing-task",
		goal: {
			goalId: task.id,
			planId: plan.id,
			text: task.title,
			activatedAtMs: block.startMs,
		},
		planId: plan.id,
		taskId: task.id,
	};
}

function resolvePendingTasksGoal(input: {
	nowMs: number;
	plans: readonly PlanningPlan[];
}): PlanningGoalResolution {
	const activePlans = input.plans
		.filter((plan) => plan.status === "active")
		.sort(
			(left, right) =>
				compareCreatedAt(left, right) || compareText(left.id, right.id),
		);
	if (activePlans.length === 0) {
		return { tier: "none", goal: null, reason: "no-active-plan" };
	}
	const titles = activePlans.flatMap((plan) =>
		pendingTasksInScheduleOrder(plan)
			.map((task) => normalizeGoalText(task.title))
			.filter((title) => title.length > 0),
	);
	if (titles.length === 0) {
		return { tier: "none", goal: null, reason: "no-pending-tasks" };
	}
	const [onlyPlan] = activePlans;
	const single = onlyPlan !== undefined && activePlans.length === 1;
	return {
		tier: "pending-tasks",
		goal: {
			goalId: single
				? `pending-tasks:${onlyPlan.id}`
				: `pending-tasks:${digest(activePlans.map((plan) => plan.id))}`,
			planId: single ? onlyPlan.id : null,
			text: composePendingTasksGoalText(titles),
			activatedAtMs: input.nowMs,
		},
		planIds: activePlans.map((plan) => plan.id),
		taskCount: titles.length,
	};
}

function pendingTasksInScheduleOrder(plan: PlanningPlan): PlanTask[] {
	const revision = plan.revisions.find(
		(candidate) => candidate.id === plan.activeRevisionId,
	);
	const scheduledRank = new Map(
		(revision?.schedule ?? []).map(
			(item, index) => [item.taskId, index] as const,
		),
	);
	const declaredRank = new Map(
		plan.tasks.map((task, index) => [task.id, index] as const),
	);
	const rank = (task: PlanTask): number =>
		scheduledRank.get(task.id) ?? Number.MAX_SAFE_INTEGER;
	return plan.tasks
		.filter((task) => task.status === "pending")
		.sort(
			(left, right) =>
				rank(left) - rank(right) ||
				(declaredRank.get(left.id) ?? 0) - (declaredRank.get(right.id) ?? 0),
		);
}

export function composePendingTasksGoalText(titles: readonly string[]): string {
	const body = titles
		.map((title, index) => `${index + 1}. ${normalizeGoalText(title)}`)
		.join("；");
	return truncateGoalText(`${PENDING_TASKS_GOAL_PREFIX}${body}`);
}

function normalizeGoalText(value: string): string {
	// The reflection service rejects control characters other than line
	// whitespace, and a plan title may carry any of them.
	return value
		.replace(/\s+/gu, " ")
		.replace(/\p{Cc}/gu, "")
		.trim();
}

function truncateGoalText(text: string): string {
	const characters = Array.from(text);
	if (characters.length <= MAX_ACTIVE_GOAL_TEXT_LENGTH) return text;
	return `${characters
		.slice(0, MAX_ACTIVE_GOAL_TEXT_LENGTH - 1)
		.join("")
		.trimEnd()}…`;
}

function digest(values: readonly string[]): string {
	return createHash("sha256")
		.update(values.join("\n"))
		.digest("hex")
		.slice(0, 32);
}

function describeResolution(resolution: PlanningGoalResolution): string {
	switch (resolution.tier) {
		case "executing-task":
			return `tier=executing-task plan=${resolution.planId} task=${resolution.taskId}`;
		case "pending-tasks":
			return `tier=pending-tasks plans=${resolution.planIds.length} tasks=${resolution.taskCount}`;
		case "none":
			return `tier=none reason=${resolution.reason}`;
	}
}

function compareCreatedAt(left: PlanningPlan, right: PlanningPlan): number {
	const leftMs = Date.parse(left.createdAt);
	const rightMs = Date.parse(right.createdAt);
	if (
		Number.isFinite(leftMs) &&
		Number.isFinite(rightMs) &&
		leftMs !== rightMs
	) {
		return leftMs < rightMs ? -1 : 1;
	}
	return 0;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** `error=<name> message="<text>"`, single line and bounded, for diag.log. */
function describeError(error: unknown): string {
	const name = error instanceof Error ? error.name : typeof error;
	const message = error instanceof Error ? error.message : String(error);
	const text = message
		.replace(/[\p{Cc}\p{Zl}\p{Zp}"`]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 160);
	return `error=${name} message="${text}"`;
}
