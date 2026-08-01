import type {
	LocalRuntimeStatus,
	LocalToolEvent,
} from "../agent/local-protocol";
import { getPetAction } from "../shared/pet-actions";
import type { PetInteractionMessage, PetState } from "../shared/contracts";
import type { PetPresentationEvent } from "../shared/pet-presentation";

export function petStateForRuntime(status: LocalRuntimeStatus): PetState {
	if (status.activeCalls > 0) {
		return {
			mood: "busy",
			message: `${status.activeCalls} local tool running…`,
			action: "loading",
		};
	}
	if (status.state === "ready") {
		return { mood: "idle", message: "Rust agent ready", action: "idle" };
	}
	if (status.state === "starting") {
		return { mood: "busy", message: "Starting local tools…", action: "searching" };
	}
	if (status.state === "degraded") {
		return {
			mood: "error",
			message: status.lastError ?? "Local tools unavailable",
			action: "networkDisconnected",
		};
	}
	return { mood: "idle", message: "Local tools stopped", action: "idle" };
}

export function petStateForToolEvent(event: LocalToolEvent): PetState {
	const name = typeof event.data.name === "string" ? event.data.name : "local tool";
	if (event.event === "tool.started" || event.event === "tool.progress") {
		return {
			mood: "busy",
			message: `Running ${name}…`,
			action: event.event === "tool.started" ? "searching" : "loading",
		};
	}
	if (event.event === "tool.completed") {
		return { mood: "happy", message: `${name} completed`, action: "taskComplete" };
	}
	if (event.event === "tool.failed") {
		return { mood: "error", message: `${name} failed`, action: "operationFailed" };
	}
	return { mood: "idle", message: `${name} cancelled`, action: "wronged" };
}

/**
 * Minimum display time for event-driven actions. A started event only needs a
 * short lead-in before progress/loading takes over; terminal actions play their
 * complete authored duration before the steady runtime state is restored.
 */
export function petStateHoldForToolEvent(event: LocalToolEvent): number {
	if (event.event === "tool.started") return 600;
	if (event.event === "tool.progress") return 0;
	const action = petStateForToolEvent(event).action;
	return action ? getPetAction(action).durationMs : 0;
}

export function petStateForPresentationEvent(
	event: PetPresentationEvent,
): PetState {
	switch (event.kind) {
		case "plan-generation-started":
			return {
				mood: "busy",
				message: "正在一起整理计划…",
				action: "searching",
			};
		case "plan-generation-succeeded":
			return {
				mood: "happy",
				message: "计划草案准备好了。",
				action: "taskComplete",
			};
		case "plan-generation-failed":
			return {
				mood: "error",
				message: "计划暂时没有生成，再试一次吧。",
				action: "operationFailed",
			};
		case "milestone-completed":
			return {
				mood: "happy",
				message: "新的里程碑完成了！",
				action: "taskComplete",
			};
		case "focus-started":
			return {
				mood: "busy",
				message: "专注时间开始了。",
				action: "focus",
			};
		case "user-inactive":
			return {
				mood: "idle",
				message: "我先自己玩一会儿。",
				action: "idleSelfEntertainment",
			};
		case "reflection-encourage":
			return {
				mood: "happy",
				message: "你正在推进当前目标，保持这个节奏。",
				action: "focus",
			};
		case "reflection-refocus":
			return {
				mood: "busy",
				message: "当前活动可能偏离目标，建议确认下一步并把注意力拉回来。",
				action: "searching",
			};
		case "reflection-clarify-goal":
			return {
				mood: "idle",
				message: "当前活动与目标的关系不够明确，建议先确认现在想推进的事情。",
				action: "think",
			};
		case "reflection-take-break":
			return {
				mood: "idle",
				message: "检测到活动中断，可以短暂休息，或确认接下来的步骤。",
				action: "idleSelfEntertainment",
			};
	}
}

export function petStateHoldForPresentationEvent(
	event: PetPresentationEvent,
): number {
	const action = petStateForPresentationEvent(event).action;
	return action ? getPetAction(action).durationMs : 0;
}

export function petStateForInteraction(event: PetInteractionMessage): PetState | null {
	if (
		event.kind === "hover" ||
		event.kind === "hoverEnd"
	) {
		return null;
	}
	const messages = {
		click: "Hello from WhaleHall!",
		doubleClick: "Double hello!",
		rapidClick: "Easy, easy…",
		pet: "That feels nice!",
		petEnd: "That was lovely!",
		poke: "Boop!",
		dragStart: "Up we go!",
		dragEnd: "Back on solid ground!",
	} as const;
	return {
		mood: event.kind === "rapidClick" ? "error" : "happy",
		message: messages[event.kind],
		// Repeating the renderer's current action is a no-op in PetAnimator and
		// prevents a generic mood mapping from replacing pointer-controlled loops.
		action: event.action,
	};
}

export function petStateHoldForInteraction(event: PetInteractionMessage): number {
	const state = petStateForInteraction(event);
	if (!state?.action) return 0;
	if (event.kind === "pet" || event.kind === "dragStart") return Number.POSITIVE_INFINITY;
	if (event.kind === "petEnd" && state.action === "hoverLookAtPointer") {
		return Number.POSITIVE_INFINITY;
	}
	return getPetAction(state.action).durationMs;
}

type PetStateTimer = ReturnType<typeof setTimeout>;

export interface PetStateArbiterOptions {
	now?: () => number;
	schedule?: (callback: () => void, delayMs: number) => PetStateTimer;
	cancel?: (timer: PetStateTimer) => void;
}

/**
 * Prevents steady lifecycle updates emitted in the same call stack from
 * erasing a visible event action before it produces a frame.
 */
export class PetStateArbiter {
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => PetStateTimer;
	private readonly cancel: (timer: PetStateTimer) => void;
	private runtimeState: PetState = {
		mood: "idle",
		message: "Local tools stopped",
		action: "idle",
	};
	private holdUntil = 0;
	private holdPriority = 0;
	private restoreTimer: PetStateTimer | null = null;

	constructor(
		private readonly send: (state: PetState) => void,
		options: PetStateArbiterOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? setTimeout;
		this.cancel = options.cancel ?? clearTimeout;
	}

	updateRuntime(status: LocalRuntimeStatus): void {
		this.runtimeState = petStateForRuntime(status);
		const mustInterrupt = status.state === "degraded" || status.state === "stopped";
		if (!mustInterrupt && this.isHeld()) return;
		this.clearHold();
		this.send(this.runtimeState);
	}

	resetToRuntime(status: LocalRuntimeStatus): void {
		this.runtimeState = petStateForRuntime(status);
		this.clearHold();
		this.send(this.runtimeState);
	}

	showToolEvent(event: LocalToolEvent): void {
		const terminal =
			event.event === "tool.completed" ||
			event.event === "tool.failed" ||
			event.event === "tool.cancelled";
		this.showTransient(
			petStateForToolEvent(event),
			petStateHoldForToolEvent(event),
			terminal ? 2 : 1,
		);
	}

	showPresentationEvent(event: PetPresentationEvent): void {
		const terminal =
			event.kind === "plan-generation-succeeded" ||
			event.kind === "plan-generation-failed" ||
			event.kind === "milestone-completed";
		this.showTransient(
			petStateForPresentationEvent(event),
			petStateHoldForPresentationEvent(event),
			terminal ? 2 : 1,
		);
	}

	showInteraction(event: PetInteractionMessage): void {
		if (event.kind === "hover") return;
		if (event.kind === "hoverEnd") {
			this.releaseInteraction();
			return;
		}
		if (event.kind === "petEnd" && event.action === "idle") {
			this.releaseInteraction();
			return;
		}
		const state = petStateForInteraction(event);
		if (!state) return;
		this.showTransient(state, petStateHoldForInteraction(event), 3);
	}

	finishNativeDrag(): void {
		if (this.holdPriority !== 3 || !this.isHeld()) return;
		this.showTransient(
			{
				mood: "happy",
				message: "Back on solid ground!",
				action: "drop",
			},
			getPetAction("drop").durationMs,
			3,
		);
	}

	private showTransient(state: PetState, holdMs: number, priority: number): void {
		if (this.isHeld() && priority < this.holdPriority) return;
		this.clearHold();
		this.send(state);
		const duration = Number.isFinite(holdMs)
			? Math.max(0, Math.round(holdMs))
			: Number.POSITIVE_INFINITY;
		if (duration === 0) return;
		this.holdPriority = priority;
		this.holdUntil = this.now() + duration;
		if (!Number.isFinite(duration)) return;
		this.restoreTimer = this.schedule(() => {
			this.restoreTimer = null;
			this.holdUntil = 0;
			this.holdPriority = 0;
			this.send(this.runtimeState);
		}, duration);
	}

	dispose(): void {
		this.clearHold();
	}

	private clearHold(): void {
		if (this.restoreTimer !== null) this.cancel(this.restoreTimer);
		this.restoreTimer = null;
		this.holdUntil = 0;
		this.holdPriority = 0;
	}

	private isHeld(): boolean {
		return this.holdPriority > 0 && this.now() < this.holdUntil;
	}

	private releaseInteraction(): void {
		if (this.holdPriority !== 3 || Number.isFinite(this.holdUntil)) return;
		this.clearHold();
		this.send(this.runtimeState);
	}
}
