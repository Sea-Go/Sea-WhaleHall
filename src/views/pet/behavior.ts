import type { PetActionId } from "../../shared/pet-actions";

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
	if (environment.temperatureC !== undefined && environment.temperatureC >= 30) {
		return "summerFan";
	}
	return null;
}

/**
 * Turns long-running desktop signals into semantic actions. It deliberately
 * contains no rendering or model logic, so the same rules drive every pet.
 */
export class PetBehaviorController {
	private readonly play: (action: PetActionId) => void;
	private readonly now: () => Date;
	private readonly idleAfterMs: number;
	private readonly overworkAfterMs: number;
	private readonly welcomeBackAfterMs: number;
	private readonly tickIntervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastInteractionAt: number;
	private workStartedAt: number;
	private awayStartedAt: number | null = null;
	private idleActionPlayed = false;
	private overworkActionPlayed = false;
	private environment: PetEnvironment = {};
	private lastTimeAction: PetActionId;
	private enabled = true;

	constructor(options: PetBehaviorControllerOptions) {
		this.play = options.play;
		this.now = options.now ?? (() => new Date());
		this.idleAfterMs = Math.max(1_000, options.idleAfterMs ?? 45_000);
		this.overworkAfterMs = Math.max(60_000, options.overworkAfterMs ?? 50 * 60_000);
		this.welcomeBackAfterMs = Math.max(1_000, options.welcomeBackAfterMs ?? 30_000);
		this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? 1_000);
		const timestamp = this.now().getTime();
		this.lastInteractionAt = timestamp;
		this.workStartedAt = timestamp;
		this.lastTimeAction = timeActionFor(new Date(timestamp));
	}

	start(playContextAction = true): void {
		if (this.timer) return;
		if (playContextAction && this.enabled) {
			const now = this.now();
			this.lastTimeAction = timeActionFor(now);
			this.play(environmentActionFor(this.environment, now) ?? this.lastTimeAction);
		}
		this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
	}

	markInteraction(): void {
		this.lastInteractionAt = this.now().getTime();
		this.idleActionPlayed = false;
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		const now = this.now();
		this.lastInteractionAt = now.getTime();
		this.lastTimeAction = timeActionFor(now);
		if (enabled) {
			this.workStartedAt = now.getTime();
			this.idleActionPlayed = false;
			this.overworkActionPlayed = false;
		}
	}

	setPresent(present: boolean): void {
		const timestamp = this.now().getTime();
		if (!present) {
			this.awayStartedAt ??= timestamp;
			return;
		}
		if (
			this.enabled &&
			this.awayStartedAt !== null &&
			timestamp - this.awayStartedAt >= this.welcomeBackAfterMs
		) {
			this.play("welcomeUserBack");
		}
		this.awayStartedAt = null;
		this.markInteraction();
	}

	setEnvironment(environment: Readonly<PetEnvironment>, announce = true): void {
		this.environment = { ...environment };
		if (!announce || !this.enabled) return;
		const action = environmentActionFor(this.environment, this.now());
		if (action) this.play(action);
	}

	tick(): void {
		if (!this.enabled || this.awayStartedAt !== null) return;
		const now = this.now();
		const timestamp = now.getTime();
		const nextTimeAction = timeActionFor(now);
		if (nextTimeAction !== this.lastTimeAction) {
			this.lastTimeAction = nextTimeAction;
			if (!environmentActionFor(this.environment, now) && nextTimeAction !== "idle") {
				this.play(nextTimeAction);
				return;
			}
		}
		if (!this.overworkActionPlayed && timestamp - this.workStartedAt >= this.overworkAfterMs) {
			this.overworkActionPlayed = true;
			this.play("overworkRestReminder");
			return;
		}
		if (!this.idleActionPlayed && timestamp - this.lastInteractionAt >= this.idleAfterMs) {
			this.idleActionPlayed = true;
			this.play("idleSelfEntertainment");
		}
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
