import type { PetActionId } from "../../shared/pet-actions";
import {
	PetActionDirector,
	type PetAutonomousRoutine,
} from "./action-director";

export interface PetEnvironment {
	weather?: "clear" | "cloudy" | "rain" | "snow";
	temperatureC?: number;
	holiday?: string;
	/** Local calendar date in MM-DD form. */
	birthday?: string;
}

export interface PetBehaviorControllerOptions {
	play: (action: PetActionId) => void;
	now?: () => Date;
	idleAfterMs?: number;
	ambientDelayMs?: readonly [minimum: number, maximum: number];
	sleepAfterMs?: number;
	sleepDurationMs?: number;
	random?: () => number;
	routines?: readonly PetAutonomousRoutine[];
	overworkAfterMs?: number;
	welcomeBackAfterMs?: number;
	tickIntervalMs?: number;
}

function monthDay(date: Date): string {
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function timeActionFor(date: Date): PetActionId {
	const hour = date.getHours();
	if (hour >= 5 && hour < 10) return "morningWakeUp";
	if (hour >= 11 && hour < 14) return "lunchTime";
	if (hour >= 18 && hour < 22) return "eveningSleepy";
	if (hour >= 22 || hour < 5) return "lateNightRestReminder";
	return "idle";
}

export function environmentActionFor(
	environment: Readonly<PetEnvironment>,
	now: Date,
): PetActionId | null {
	if (environment.birthday === monthDay(now)) return "birthdayCelebrate";
	if (environment.holiday?.trim()) return "holidayAction";
	if (environment.weather === "rain") return "rainUmbrella";
	if (environment.temperatureC !== undefined && environment.temperatureC <= 8) {
		return "winterShiver";
	}
	if (
		environment.temperatureC !== undefined &&
		environment.temperatureC >= 30
	) {
		return "summerFan";
	}
	return null;
}

/**
 * Turns long-running desktop signals into semantic actions. It deliberately
 * contains no rendering or model logic, so the same rules drive every pet.
 */
export class PetBehaviorController {
	private readonly now: () => Date;
	private readonly overworkAfterMs: number;
	private readonly welcomeBackAfterMs: number;
	private readonly tickIntervalMs: number;
	private readonly actionDirector: PetActionDirector;
	private timer: ReturnType<typeof setInterval> | null = null;
	private workStartedAt: number;
	private awayStartedAt: number | null = null;
	private overworkActionPlayed = false;
	private environment: PetEnvironment = {};
	private lastTimeAction: PetActionId;
	private enabled = true;

	constructor(options: PetBehaviorControllerOptions) {
		this.now = options.now ?? (() => new Date());
		this.overworkAfterMs = Math.max(
			60_000,
			options.overworkAfterMs ?? 50 * 60_000,
		);
		this.welcomeBackAfterMs = Math.max(
			1_000,
			options.welcomeBackAfterMs ?? 30_000,
		);
		this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? 1_000);
		const timestamp = this.now().getTime();
		this.workStartedAt = timestamp;
		this.lastTimeAction = timeActionFor(new Date(timestamp));
		this.actionDirector = new PetActionDirector({
			play: options.play,
			initialNowMs: timestamp,
			firstRoutineAfterMs: Math.max(1_000, options.idleAfterMs ?? 12_000),
			...(options.ambientDelayMs
				? { ambientDelayMs: options.ambientDelayMs }
				: {}),
			...(options.sleepAfterMs !== undefined
				? { sleepAfterMs: options.sleepAfterMs }
				: {}),
			...(options.sleepDurationMs !== undefined
				? { sleepDurationMs: options.sleepDurationMs }
				: {}),
			...(options.random ? { random: options.random } : {}),
			...(options.routines ? { routines: options.routines } : {}),
		});
	}

	start(playContextAction = true): void {
		if (this.timer) return;
		if (playContextAction && this.enabled) {
			const now = this.now();
			this.lastTimeAction = timeActionFor(now);
			const contextAction =
				environmentActionFor(this.environment, now) ?? this.lastTimeAction;
			if (contextAction !== "idle") {
				this.actionDirector.presentAction(contextAction, now.getTime());
			}
		}
		this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
	}

	markInteraction(): void {
		this.actionDirector.markInteraction(this.now().getTime());
	}

	setEngaged(engaged: boolean): void {
		this.actionDirector.setEngaged(engaged, this.now().getTime());
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		const now = this.now();
		this.actionDirector.setEnabled(enabled, now.getTime());
		this.lastTimeAction = timeActionFor(now);
	}

	setPresent(present: boolean): void {
		const timestamp = this.now().getTime();
		if (!present) {
			this.awayStartedAt ??= timestamp;
			this.actionDirector.setPresent(false, timestamp);
			return;
		}
		this.actionDirector.setPresent(true, timestamp);
		if (
			this.enabled &&
			this.awayStartedAt !== null &&
			timestamp - this.awayStartedAt >= this.welcomeBackAfterMs
		) {
			this.actionDirector.presentAction("welcomeUserBack", timestamp);
		}
		this.awayStartedAt = null;
	}

	setEnvironment(environment: Readonly<PetEnvironment>, announce = true): void {
		const unchanged =
			this.environment.weather === environment.weather &&
			this.environment.temperatureC === environment.temperatureC &&
			this.environment.holiday === environment.holiday &&
			this.environment.birthday === environment.birthday;
		this.environment = { ...environment };
		if (unchanged || !announce || !this.enabled) return;
		const action = environmentActionFor(this.environment, this.now());
		if (action) this.actionDirector.presentAction(action, this.now().getTime());
	}

	tick(): void {
		if (!this.enabled || this.awayStartedAt !== null) return;
		const now = this.now();
		const timestamp = now.getTime();
		const nextTimeAction = timeActionFor(now);
		if (nextTimeAction !== this.lastTimeAction) {
			this.lastTimeAction = nextTimeAction;
			if (
				!environmentActionFor(this.environment, now) &&
				nextTimeAction !== "idle"
			) {
				this.actionDirector.presentAction(nextTimeAction, timestamp);
				return;
			}
		}
		if (
			!this.overworkActionPlayed &&
			timestamp - this.workStartedAt >= this.overworkAfterMs
		) {
			this.overworkActionPlayed = true;
			this.actionDirector.presentAction("overworkRestReminder", timestamp);
			return;
		}
		this.actionDirector.tick(timestamp, now.getHours());
	}

	resetWorkSession(): void {
		this.workStartedAt = this.now().getTime();
		this.overworkActionPlayed = false;
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
