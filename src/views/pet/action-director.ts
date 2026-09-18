import { getPetAction, type PetActionId } from "../../shared/pet-actions";

export interface PetRoutineStep {
	readonly action: PetActionId;
	/** How long the authored action remains in control before the next step. */
	readonly holdMs: number;
}

export interface PetAutonomousRoutine {
	readonly id: string;
	readonly label: string;
	readonly weight: number;
	readonly cooldownMs: number;
	readonly minQuietMs: number;
	readonly steps: readonly PetRoutineStep[];
	/** Local-hour range. A wrapped range such as 22..6 is also supported. */
	readonly activeHours?: readonly [
		startInclusive: number,
		endExclusive: number,
	];
}

function routine(
	id: string,
	label: string,
	weight: number,
	cooldownMs: number,
	minQuietMs: number,
	steps: readonly PetRoutineStep[],
	activeHours?: readonly [number, number],
): PetAutonomousRoutine {
	return {
		id,
		label,
		weight,
		cooldownMs,
		minQuietMs,
		steps,
		...(activeHours ? { activeHours } : {}),
	};
}

function step(action: PetActionId, holdMs: number): PetRoutineStep {
	return { action, holdMs };
}

/**
 * Small authored stories made from the existing model-independent action
 * catalogue. The director owns timing; PetAnimator still owns transitions and
 * frame generation.
 */
export const PET_AUTONOMOUS_ROUTINES = [
	routine("curious-stroll", "好奇地四处走走", 6, 90_000, 6_000, [
		step("lookAround", 2_300),
		step("walkRight", 3_600),
		step("walkLeft", 3_600),
		step("stopWalking", 700),
	]),
	routine("stretch-and-jump", "伸展后跳一跳", 5, 75_000, 6_000, [
		step("stretch", 1_900),
		step("jump", 1_000),
		step("happy", 1_600),
	]),
	routine("toy-break", "自己玩一会儿", 5, 120_000, 9_000, [
		step("idleSelfEntertainment", 3_800),
		step("playToy", 4_600),
		step("happy", 1_600),
	]),
	routine(
		"cozy-reading",
		"坐下来读会儿书",
		3,
		180_000,
		14_000,
		[step("sitDown", 1_300), step("readBook", 6_500), step("standUp", 1_300)],
		[7, 23],
	),
	routine(
		"music-groove",
		"听音乐轻轻摇摆",
		4,
		150_000,
		10_000,
		[step("listenMusic", 5_400), step("laugh", 1_700)],
		[8, 23],
	),
	routine("groom-and-pose", "整理自己并得意一下", 4, 120_000, 8_000, [
		step("groom", 2_300),
		step("proud", 1_900),
	]),
	routine("edge-peek", "从边缘探头观察", 4, 150_000, 10_000, [
		step("peekFromEdge", 4_600),
		step("surprised", 1_200),
	]),
	routine(
		"mini-workout",
		"做一组小锻炼",
		3,
		180_000,
		12_000,
		[
			step("exercise", 3_800),
			step("drink", 2_300),
			step("recoverEnergy", 1_900),
		],
		[7, 22],
	),
] as const satisfies readonly PetAutonomousRoutine[];

export type PetActionPlanSource = "ambient" | "context" | "rest";

interface ActivePlan {
	readonly id: string;
	readonly source: PetActionPlanSource;
	readonly steps: readonly PetRoutineStep[];
	readonly deadlineAt: number;
	stepIndex: number;
	stepEndsAt: number;
}

const MAX_ROUTINE_DURATION_MS = 20_000;
const MAX_ROUTINE_STEP_MS = 12_000;
const MAX_REST_DURATION_MS = 3 * 60_000;

export interface PetActionDirectorOptions {
	play: (action: PetActionId) => void;
	initialNowMs: number;
	random?: () => number;
	routines?: readonly PetAutonomousRoutine[];
	firstRoutineAfterMs?: number;
	ambientDelayMs?: readonly [minimum: number, maximum: number];
	sleepAfterMs?: number;
	sleepDurationMs?: number;
}

export interface PetActionDirectorSnapshot {
	readonly enabled: boolean;
	readonly present: boolean;
	readonly engaged: boolean;
	readonly activePlan: {
		readonly id: string;
		readonly source: PetActionPlanSource;
		readonly stepIndex: number;
	} | null;
	readonly nextAmbientAt: number;
	readonly nextSleepAt: number;
	readonly pendingContextCount: number;
}

function finiteNow(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function boundedDuration(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, value));
}

function clampedRandom(random: () => number): number {
	const value = random();
	if (!Number.isFinite(value)) return 0;
	return Math.min(0.999_999, Math.max(0, value));
}

function isHourAllowed(
	routine: PetAutonomousRoutine,
	localHour: number,
): boolean {
	if (!routine.activeHours) return true;
	const [start, end] = routine.activeHours;
	if (start === end) return true;
	if (start < end) return localHour >= start && localHour < end;
	return localHour >= start || localHour < end;
}

function contextualHoldMs(action: PetActionId): number {
	const definition = getPetAction(action);
	return definition.loop
		? Math.max(4_000, definition.durationMs * 2)
		: definition.durationMs + 150;
}

/**
 * Owns autonomous action selection, sequencing, cooldowns and bounded rest.
 * It never renders frames and never arbitrates product/runtime state; callers
 * suspend it whenever a higher-priority state or direct interaction is active.
 */
export class PetActionDirector {
	private readonly play: (action: PetActionId) => void;
	private readonly random: () => number;
	private readonly routines: readonly PetAutonomousRoutine[];
	private readonly firstRoutineAfterMs: number;
	private readonly ambientDelayMs: readonly [number, number];
	private readonly sleepAfterMs: number;
	private readonly sleepDurationMs: number;
	private readonly routinePlayedAt = new Map<string, number>();
	private readonly recentRoutineIds: string[] = [];
	private readonly pendingContextSteps: PetRoutineStep[] = [];
	private enabled = true;
	private present = true;
	private engaged = false;
	private activePlan: ActivePlan | null = null;
	private lastInteractionAt: number;
	private nextAmbientAt: number;
	private nextSleepAt: number;

	constructor(options: PetActionDirectorOptions) {
		this.play = options.play;
		this.random = options.random ?? Math.random;
		this.routines = options.routines ?? PET_AUTONOMOUS_ROUTINES;
		this.firstRoutineAfterMs = boundedDuration(
			options.firstRoutineAfterMs,
			12_000,
			250,
			5 * 60_000,
		);
		const [requestedMin, requestedMax] = options.ambientDelayMs ?? [
			25_000, 50_000,
		];
		const finiteMin = Number.isFinite(requestedMin) ? requestedMin : 25_000;
		const finiteMax = Number.isFinite(requestedMax) ? requestedMax : 50_000;
		const minimum = Math.min(
			5 * 60_000,
			Math.max(500, Math.min(finiteMin, finiteMax)),
		);
		const maximum = Math.min(
			5 * 60_000,
			Math.max(minimum, Math.max(finiteMin, finiteMax)),
		);
		this.ambientDelayMs = [minimum, maximum];
		this.sleepAfterMs = boundedDuration(
			options.sleepAfterMs,
			12 * 60_000,
			10_000,
			12 * 60 * 60_000,
		);
		this.sleepDurationMs = boundedDuration(
			options.sleepDurationMs,
			35_000,
			5_000,
			MAX_REST_DURATION_MS - 3_200,
		);
		const initialNow = finiteNow(options.initialNowMs);
		this.lastInteractionAt = initialNow;
		this.nextAmbientAt = initialNow + this.firstRoutineAfterMs;
		this.nextSleepAt = initialNow + this.sleepAfterMs;
	}

	setEnabled(enabled: boolean, nowMs: number): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		this.activePlan = null;
		if (!enabled) this.pendingContextSteps.length = 0;
		if (enabled) this.resetQuietTimers(nowMs);
	}

	setPresent(present: boolean, nowMs: number): void {
		if (this.present === present) return;
		const shouldReleasePlan = !present && this.activePlan !== null;
		this.present = present;
		this.activePlan = null;
		if (!present) this.pendingContextSteps.length = 0;
		if (shouldReleasePlan) this.play("idle");
		if (present) this.resetQuietTimers(nowMs);
	}

	markInteraction(nowMs: number): void {
		this.activePlan = null;
		this.resetQuietTimers(nowMs);
	}

	setEngaged(engaged: boolean, nowMs: number): void {
		if (this.engaged === engaged) return;
		this.engaged = engaged;
		this.activePlan = null;
		this.resetQuietTimers(nowMs);
	}

	/** Interrupts ambient activity with a bounded contextual presentation. */
	presentAction(action: PetActionId, nowMs: number, holdMs?: number): void {
		if (!this.enabled || !this.present) return;
		const now = finiteNow(nowMs);
		if (action === "idle") {
			this.activePlan = null;
			this.play("idle");
			this.nextAmbientAt = now + this.nextAmbientDelay();
			return;
		}
		const contextStep = step(
			action,
			Math.max(250, holdMs ?? contextualHoldMs(action)),
		);
		if (this.engaged) {
			const queued = this.pendingContextSteps.at(-1);
			if (queued?.action !== action) this.pendingContextSteps.push(contextStep);
			while (this.pendingContextSteps.length > 4) {
				this.pendingContextSteps.shift();
			}
			return;
		}
		this.startPlan(`context:${action}`, "context", [contextStep], now);
	}

	tick(nowMs: number, localHour: number): void {
		if (!this.enabled || !this.present || this.engaged) return;
		const now = finiteNow(nowMs);
		if (this.advanceActivePlan(now)) return;
		const pendingContext = this.pendingContextSteps.shift();
		if (pendingContext) {
			this.startPlan(
				`context:${pendingContext.action}`,
				"context",
				[pendingContext],
				now,
			);
			return;
		}
		if (now >= this.nextSleepAt) {
			this.startPlan(
				"bounded-rest",
				"rest",
				[step("sleepy", 3_200), step("sleepIn", this.sleepDurationMs)],
				now,
			);
			return;
		}
		if (now < this.nextAmbientAt) return;
		const selected = this.selectRoutine(now, localHour);
		if (!selected) {
			this.nextAmbientAt = now + Math.min(5_000, this.ambientDelayMs[0]);
			return;
		}
		this.routinePlayedAt.set(selected.id, now);
		this.recentRoutineIds.push(selected.id);
		while (this.recentRoutineIds.length > 2) this.recentRoutineIds.shift();
		this.startPlan(selected.id, "ambient", selected.steps, now);
	}

	getSnapshot(): PetActionDirectorSnapshot {
		return {
			enabled: this.enabled,
			present: this.present,
			engaged: this.engaged,
			activePlan: this.activePlan
				? {
						id: this.activePlan.id,
						source: this.activePlan.source,
						stepIndex: this.activePlan.stepIndex,
					}
				: null,
			nextAmbientAt: this.nextAmbientAt,
			nextSleepAt: this.nextSleepAt,
			pendingContextCount: this.pendingContextSteps.length,
		};
	}

	private resetQuietTimers(nowMs: number): void {
		const now = finiteNow(nowMs);
		this.lastInteractionAt = now;
		this.nextAmbientAt = now + this.firstRoutineAfterMs;
		this.nextSleepAt = now + this.sleepAfterMs;
	}

	private nextAmbientDelay(): number {
		const [minimum, maximum] = this.ambientDelayMs;
		return minimum + clampedRandom(this.random) * (maximum - minimum);
	}

	private startPlan(
		id: string,
		source: PetActionPlanSource,
		steps: readonly PetRoutineStep[],
		now: number,
	): void {
		const maximumStep =
			source === "rest" ? MAX_REST_DURATION_MS : MAX_ROUTINE_STEP_MS;
		const normalizedSteps = steps.slice(0, 8).map((candidate) => ({
			action: candidate.action,
			holdMs: boundedDuration(candidate.holdMs, 250, 250, maximumStep),
		}));
		const first = normalizedSteps[0];
		if (!first) return;
		const authoredDuration = normalizedSteps.reduce(
			(total, candidate) => total + candidate.holdMs,
			0,
		);
		const maximumDuration =
			source === "rest" ? MAX_REST_DURATION_MS : MAX_ROUTINE_DURATION_MS;
		const deadlineAt = now + Math.min(maximumDuration, authoredDuration);
		this.activePlan = {
			id,
			source,
			steps: normalizedSteps,
			deadlineAt,
			stepIndex: 0,
			stepEndsAt: Math.min(deadlineAt, now + first.holdMs),
		};
		this.play(first.action);
	}

	private advanceActivePlan(now: number): boolean {
		const plan = this.activePlan;
		if (!plan) return false;
		if (now >= plan.deadlineAt) {
			this.finishActivePlan(plan, now);
			return true;
		}
		if (now < plan.stepEndsAt) return true;
		const nextIndex = plan.stepIndex + 1;
		const next = plan.steps[nextIndex];
		if (next) {
			plan.stepIndex = nextIndex;
			plan.stepEndsAt = Math.min(plan.deadlineAt, now + next.holdMs);
			this.play(next.action);
			return true;
		}
		this.finishActivePlan(plan, now);
		return true;
	}

	private finishActivePlan(plan: ActivePlan, now: number): void {
		this.activePlan = null;
		this.play("idle");
		this.nextAmbientAt = now + this.nextAmbientDelay();
		if (plan.source === "rest") this.nextSleepAt = now + this.sleepAfterMs;
	}

	private selectRoutine(
		now: number,
		localHour: number,
	): PetAutonomousRoutine | null {
		const quietFor = now - this.lastInteractionAt;
		const eligible = this.routines.filter((candidate) => {
			if (candidate.steps.length === 0 || candidate.weight <= 0) return false;
			if (quietFor < candidate.minQuietMs) return false;
			if (!isHourAllowed(candidate, localHour)) return false;
			const lastPlayedAt = this.routinePlayedAt.get(candidate.id);
			return (
				lastPlayedAt === undefined || now - lastPlayedAt >= candidate.cooldownMs
			);
		});
		if (eligible.length === 0) return null;
		const withoutRecent = eligible.filter(
			(candidate) => !this.recentRoutineIds.includes(candidate.id),
		);
		const candidates = withoutRecent.length > 0 ? withoutRecent : eligible;
		const totalWeight = candidates.reduce(
			(total, candidate) => total + candidate.weight,
			0,
		);
		let cursor = clampedRandom(this.random) * totalWeight;
		for (const candidate of candidates) {
			cursor -= candidate.weight;
			if (cursor < 0) return candidate;
		}
		return candidates.at(-1) ?? null;
	}
}
