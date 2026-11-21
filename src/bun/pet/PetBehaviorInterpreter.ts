/**
 * 桌宠行为解释器:执行包内 behaviors.json 的声明式行为(标准 §4)。
 *
 * 本模块是通用引擎,不含任何形象知识:状态机推进/计时与概率求值/
 * 移动执行(按 movement 参数)/宿主保留态强制。行为差异全部来自包声明
 * ——猫走路、鲸鱼游动、鸟飞行共用同一引擎,各走各的参数与状态机。
 */

import type {
	PetActionDefinition,
	PetBehaviorsFile,
	PetTransitionCondition,
} from "./PetPackageTypes";

export interface PetInterpreterCommand {
	kind: "play";
	actionId: string;
	holdMs?: number;
}

export interface PetMoveCommand {
	dx: number;
	dy: number;
}

export interface PetScreenBounds {
	width: number;
	height: number;
}

export interface PetInterpreterOptions {
	behaviors: PetBehaviorsFile;
	/** 动作解析(含统一回退);由调用方接 PetPackageManager。 */
	resolveAction: (actionId: string) => { action?: PetActionDefinition } | undefined;
	/** 播放指令出口(接渲染适配器)。 */
	onPlay: (command: PetInterpreterCommand) => void;
	/** 朝向变更出口。 */
	onFacing: (facing: -1 | 0 | 1) => void;
	/** 位移出口(接窗口/精灵偏移执行)。 */
	onMove: (move: PetMoveCommand) => void;
	/** 异常日志出口。 */
	log?: (message: string) => void;
	random?: () => number;
	/** 时钟(测试注入);默认真实时间。 */
	now?: () => number;
}

interface ActiveTimer {
	transition: PetTransitionCondition & { on: "timer" };
	fireAt: number;
}

type ReservedState = "dragged" | "drop" | "hidden" | "exit";

interface OverridePlay {
	actionId: string;
	holdMs: number;
	endsAt: number;
	returnActionId: string;
}

function randomInRange(random: () => number, min: number, max: number): number {
	return min + random() * (max - min);
}

function pickWeighted<T extends { weight?: number }>(items: readonly T[]): T {
	const total = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);
	let roll = Math.random() * total;
	for (const item of items) {
		roll -= item.weight ?? 1;
		if (roll <= 0) return item;
	}
	return items[items.length - 1] as T;
}

/** 行作名是否命中速度表键(walkLeft 命中键 walk:前缀匹配)。 */
function speedForAction(
	speeds: Readonly<Record<string, number>> | undefined,
	actionId: string,
): number | undefined {
	if (speeds === undefined) return undefined;
	const exact = speeds[actionId];
	if (exact !== undefined) return exact;
	const sortedKeys = Object.keys(speeds).sort((a, b) => b.length - a.length);
	for (const key of sortedKeys) {
		if (actionId.startsWith(key)) return speeds[key];
	}
	return undefined;
}

export class PetBehaviorInterpreter {
	private readonly options: PetInterpreterOptions;
	private readonly random: () => number;
	private readonly now: () => number;

	private currentState: string;
	private enteredAt: number;
	private stateDuration: number | undefined;
	private activeTimers: ActiveTimer[] = [];
	private reserved: ReservedState | null = null;
	private override: OverridePlay | null = null;
	private routineQueue: readonly { action: string; holdMs: number }[] = [];
	private routineStepEndsAt = 0;
	private horizontalDirection: -1 | 1 = 1;
	private lastTickAt: number;

	constructor(options: PetInterpreterOptions) {
		this.options = options;
		this.random = options.random ?? Math.random;
		this.now = options.now ?? Date.now;
		this.currentState = options.behaviors.stateMachine.initial;
		this.enteredAt = this.now();
		this.lastTickAt = this.enteredAt;
		this.stateDuration = this.rollStateDuration();
		this.playCurrentStateAction();
	}

	private get states(): Readonly<Record<string, { action: string; duration?: [number, number]; transitions?: readonly PetTransitionCondition[] }>> {
		return this.options.behaviors.stateMachine.states;
	}

	private rollStateDuration(): number | undefined {
		const state = this.states[this.currentState];
		if (state?.duration === undefined) return undefined;
		return randomInRange(this.random, state.duration[0], state.duration[1]);
	}

	private armTimers(): void {
		this.activeTimers = [];
		const state = this.states[this.currentState];
		for (const transition of state?.transitions ?? []) {
			if (transition.on !== "timer") continue;
			this.activeTimers.push({
				transition,
				fireAt:
					this.enteredAt +
					randomInRange(this.random, transition.afterMs[0], transition.afterMs[1]),
			});
		}
	}

	private playCurrentStateAction(): void {
		const state = this.states[this.currentState];
		if (state === undefined) return;
		const resolved = this.options.resolveAction(state.action);
		const actionId = resolved?.action?.id ?? state.action;
		this.options.onPlay({ kind: "play", actionId });
		this.applyFacing(actionId, resolved?.action);
		this.armTimers();
	}

	private applyFacing(
		actionId: string,
		action: PetActionDefinition | undefined,
	): void {
		const facing = action?.facing;
		if (facing === -1 || facing === 1) {
			this.horizontalDirection = facing;
			this.options.onFacing(facing);
		}
	}

	private enterState(name: string): void {
		this.currentState = name;
		this.enteredAt = this.now();
		this.stateDuration = this.rollStateDuration();
		this.playCurrentStateAction();
	}

	/** 进入宿主保留态(系统不变量,标准 §4)。 */
	forceState(reserved: ReservedState): void {
		this.reserved = reserved;
		this.routineQueue = [];
		this.override = null;
		const resolved = this.options.resolveAction(reserved);
		if (resolved?.action !== undefined) {
			this.options.onPlay({ kind: "play", actionId: resolved.action.id });
		}
	}

	/** 释放保留态:回到包初始态(dragged→drop 后由调用方释放)。 */
	releaseReserved(): void {
		if (this.reserved === null) return;
		this.reserved = null;
		this.enterState(this.options.behaviors.stateMachine.initial);
	}

	/**
	 * 外部直派播放(语义事件同名约定/emotionMap/表情命名空间,标准 §7/§8):
	 * 打断当前行为播放 override,播完回当前状态动作;期间状态机挂起。
	 */
	playOverride(actionId: string, holdMs?: number): void {
		if (this.reserved !== null) return;
		const resolved = this.options.resolveAction(actionId);
		if (resolved?.action === undefined) {
			// 可能是表情命名空间引用,原样下发由适配器分派。
			this.options.onPlay({ kind: "play", actionId });
			this.override = null;
			return;
		}
		const state = this.states[this.currentState];
		const returnActionId =
			this.options.resolveAction(state?.action ?? "")?.action?.id ?? state?.action ?? "idle";
		this.override = {
			actionId: resolved.action.id,
			holdMs: holdMs ?? resolved.action.durationMs,
			endsAt: this.now() + (holdMs ?? resolved.action.durationMs),
			returnActionId,
		};
		this.applyFacing(resolved.action.id, resolved.action);
		this.options.onPlay({ kind: "play", actionId: resolved.action.id });
	}

	/** 派发交互/系统事件(pointer 与 system 前缀词);命中转移返回 true。 */
	dispatch(event: string): boolean {
		if (this.reserved !== null || this.override !== null) return false;
		const state = this.states[this.currentState];
		for (const transition of state?.transitions ?? []) {
			if (transition.on !== event) continue;
			const target = this.states[transition.to];
			if (target === undefined) continue;
			// 例程目标:按声明顺序逐步播放后回初始态。
			const routine = this.options.behaviors.routines?.find((r) => r.id === transition.to);
			if (routine !== undefined) {
				this.routineQueue = routine.steps;
				this.routineStepEndsAt = 0;
				this.enterState(this.currentState); // 保持态,重播动作后由 tick 推进例程
				return true;
			}
			this.enterState(transition.to);
			return true;
		}
		return false;
	}

	private scheduleHoursMatch(date: Date, hours: readonly [number, number][]): boolean {
		const hour = date.getHours();
		return hours.some(([start, end]) =>
			start <= end ? hour >= start && hour < end : hour >= start || hour < end,
		);
	}

	private evaluateTransitions(now: number): void {
		const state = this.states[this.currentState];
		for (const transition of state?.transitions ?? []) {
			if (transition.on === "schedule") {
				if (this.scheduleHoursMatch(new Date(now), transition.hours)) {
					this.enterState(transition.to);
					return;
				}
			}
		}
		if (
			this.stateDuration !== undefined &&
			now - this.enteredAt >= this.stateDuration
		) {
			for (const transition of state?.transitions ?? []) {
				if (transition.on === "expire") {
					this.enterState(transition.to);
					return;
				}
			}
		}
		const fired = this.activeTimers.filter((timer) => now >= timer.fireAt);
		if (fired.length > 0) {
			const chosen = pickWeighted(
				fired.map((timer) => ({
					...timer.transition,
					weight: timer.transition.weight ?? 1,
				})),
			);
			this.enterState(chosen.to);
		}
	}

	private advanceRoutine(now: number): void {
		if (this.routineQueue.length === 0) return;
		if (now < this.routineStepEndsAt) return;
		const [firstStep, ...rest] = this.routineQueue;
		const step = firstStep as { action: string; holdMs: number };
		this.routineQueue = rest;
		const resolved = this.options.resolveAction(step.action);
		const actionId = resolved?.action?.id ?? step.action;
		this.applyFacing(actionId, resolved?.action);
		this.options.onPlay({ kind: "play", actionId, holdMs: step.holdMs });
		this.routineStepEndsAt = now + step.holdMs;
		if (rest.length === 0) {
			// 例程播完回初始态。
			this.routineQueue = [];
			this.currentState = this.options.behaviors.stateMachine.initial;
			this.enteredAt = now;
			this.stateDuration = this.rollStateDuration();
			this.armTimers();
		}
	}

	private executeMovement(dtSeconds: number, screen: PetScreenBounds): void {
		if (this.reserved !== null || this.override !== null) return;
		const state = this.states[this.currentState];
		if (state === undefined) return;
		const resolved = this.options.resolveAction(state.action);
		const action = resolved?.action;
		if (action === undefined) return;
		const movement = this.options.behaviors.movement;
		const speed = speedForAction(movement.speedPxPerSec, action.id);
		if (speed === undefined || speed <= 0) return;
		const dx = speed * dtSeconds * this.horizontalDirection;

		if (movement.locomotion === "ground" || movement.locomotion === "teleport") {
			this.options.onMove({ dx, dy: 0 });
			return;
		}
		// air/water:附带轻微正弦起伏;gravity 关闭时维持高度。
		const dy = movement.gravity === false ? 0 : Math.sin(this.now() / 900) * 6 * dtSeconds;
		this.options.onMove({ dx, dy });
	}

	/** 主驱动:求值转移、推进例程、执行移动。dt 由调用方或内部推导。 */
	tick(now: number, screen: PetScreenBounds): void {
		const dtSeconds = Math.min(1, Math.max(0, (now - this.lastTickAt) / 1000));
		this.lastTickAt = now;

		if (this.reserved !== null) return;

		if (this.override !== null) {
			if (now >= this.override.endsAt) {
				const returning = this.override.returnActionId;
				this.override = null;
				this.options.onPlay({ kind: "play", actionId: returning });
			}
			return;
		}

		if (this.routineQueue.length > 0) {
			this.advanceRoutine(now);
			return;
		}

		this.evaluateTransitions(now);
		this.executeMovement(dtSeconds, screen);
	}

	snapshot(): { state: string; reserved: ReservedState | null; overrideActive: boolean } {
		return {
			state: this.reserved ?? this.currentState,
			reserved: this.reserved,
			overrideActive: this.override !== null,
		};
	}
}
