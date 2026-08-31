import {
	DESKTOP_EVENT_SCHEMA_VERSION,
	type DesktopEventForKind,
	type DesktopEventKind,
	type DesktopEventPayloadByKind,
	type DesktopEventV1,
	type EventSensitivity,
	type ProcessObservation,
} from "./types";

export const DESKTOP_OBSERVATION_SCHEMA_VERSION = "desktop-observation.v1" as const;
export const DEFAULT_INPUT_BUCKET_MS = 5_000;

type ObservationBase<K extends string, P> = {
	schemaVersion: typeof DESKTOP_OBSERVATION_SCHEMA_VERSION;
	observationId: string;
	deviceId: string;
	sessionId: string;
	kind: K;
	source: string;
	occurredAtMs: number;
	observedAtMs: number;
	goalVersion: number | null;
	sensitivity: EventSensitivity;
	payload: P;
};

export type InputActivityObservationV1 = ObservationBase<
	"input.activitySample",
	{
		keyCount: number;
		clickCount: number;
		scrollDelta: number;
		mouseDistance: number;
	}
>;

export type ProcessScanObservationV1 = ObservationBase<
	"application.processScan",
	{
		started: ProcessObservation[];
		exited: ProcessObservation[];
	}
>;

export type DesktopObservationV1 =
	| InputActivityObservationV1
	| ProcessScanObservationV1;

export type EventIdentity = {
	eventId: string;
	cursor: string;
};

export interface EventIdentityFactory {
	create(
		kind: DesktopEventKind,
		sourceObservationIds: readonly string[],
		occurredAtMs: number,
	): EventIdentity;
}

export class MonotonicEventIdentityFactory implements EventIdentityFactory {
	private sequence = 0;

	constructor(private readonly prefix: string) {}

	create(
		kind: DesktopEventKind,
		_sourceObservationIds: readonly string[],
		occurredAtMs: number,
	): EventIdentity {
		this.sequence += 1;
		const suffix = `${occurredAtMs.toString(36)}_${this.sequence.toString(36)}`;
		return {
			eventId: `${this.prefix}_${kind}_${suffix}`,
			cursor: `${this.prefix}:${this.sequence.toString().padStart(12, "0")}`,
		};
	}
}

export type SemanticEventCoalescerOptions = {
	identityFactory: EventIdentityFactory;
	inputBucketMs?: number;
};

export type PreparedDesktopEvent = {
	events: DesktopEventV1[];
	commit(): void;
};

type InputBucket = {
	deviceId: string;
	sessionId: string;
	source: string;
	goalVersion: number | null;
	bucketStartedAtMs: number;
	latestOccurredAtMs: number;
	latestObservedAtMs: number;
	observationIds: string[];
	keyCount: number;
	clickCount: number;
	scrollDelta: number;
	mouseDistance: number;
};

/**
 * Deterministic normalization shared by online collection and dataset
 * generation. It performs only local temporal merging and exact repeat
 * suppression; journal persistence remains outside this class.
 */
export class SemanticEventCoalescer {
	private readonly identityFactory: EventIdentityFactory;
	private readonly inputBucketMs: number;
	private readonly inputBuckets = new Map<string, InputBucket>();
	private readonly lastSignatures = new Map<string, string>();

	constructor(options: SemanticEventCoalescerOptions) {
		this.identityFactory = options.identityFactory;
		this.inputBucketMs = options.inputBucketMs ?? DEFAULT_INPUT_BUCKET_MS;
	}

	push(input: DesktopObservationV1 | DesktopEventV1): DesktopEventV1[] {
		const matured = this.flushMatured(input.occurredAtMs);
		if (input.schemaVersion === DESKTOP_EVENT_SCHEMA_VERSION) {
			const prepared = this.prepareDesktopEvent(input);
			prepared.commit();
			return [...matured, ...prepared.events];
		}

		switch (input.kind) {
			case "input.activitySample":
				this.accumulateInput(input);
				return matured;
			case "application.processScan": {
				const event = this.processScanEvent(input);
				return event ? [...matured, event] : matured;
			}
		}
	}

	flush(atMs: number): DesktopEventV1[] {
		return this.flushMatured(atMs);
	}

	flushAll(atMs: number): DesktopEventV1[] {
		return this.flushMatured(atMs, true);
	}

	/**
	 * Prepares repeat suppression without mutating its signature state. The
	 * caller commits only after the semantic event has been durably accepted;
	 * a failed collector write can therefore replay the same journal event.
	 */
	prepareDesktopEvent(event: DesktopEventV1): PreparedDesktopEvent {
		const decision = this.prepareDuplicateDecision(event);
		let committed = false;
		return {
			events: decision.duplicate ? [] : [structuredClone(event)],
			commit: () => {
				if (committed) return;
				committed = true;
				decision.commit();
			},
		};
	}

	private flushMatured(atMs: number, force = false): DesktopEventV1[] {
		const output: DesktopEventV1[] = [];
		const inputEntries = Array.from(this.inputBuckets.entries()).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		for (const [key, bucket] of inputEntries) {
			if (!force && bucket.bucketStartedAtMs + this.inputBucketMs > atMs) continue;
			this.inputBuckets.delete(key);
			output.push(this.inputBucketEvent(bucket));
		}

		return output.sort(
			(left, right) =>
				left.occurredAtMs - right.occurredAtMs || left.eventId.localeCompare(right.eventId),
		);
	}

	private accumulateInput(observation: InputActivityObservationV1): void {
		const bucketStartedAtMs =
			Math.floor(observation.occurredAtMs / this.inputBucketMs) * this.inputBucketMs;
		const key = [
			observation.deviceId,
			observation.sessionId,
			observation.goalVersion ?? "none",
			bucketStartedAtMs,
		].join("|");
		const existing = this.inputBuckets.get(key);
		if (existing) {
			existing.latestOccurredAtMs = Math.max(
				existing.latestOccurredAtMs,
				observation.occurredAtMs,
			);
			existing.latestObservedAtMs = Math.max(
				existing.latestObservedAtMs,
				observation.observedAtMs,
			);
			existing.observationIds.push(observation.observationId);
			existing.keyCount += nonNegative(observation.payload.keyCount);
			existing.clickCount += nonNegative(observation.payload.clickCount);
			existing.scrollDelta += finite(observation.payload.scrollDelta);
			existing.mouseDistance += nonNegative(observation.payload.mouseDistance);
			return;
		}
		this.inputBuckets.set(key, {
			deviceId: observation.deviceId,
			sessionId: observation.sessionId,
			source: observation.source,
			goalVersion: observation.goalVersion,
			bucketStartedAtMs,
			latestOccurredAtMs: observation.occurredAtMs,
			latestObservedAtMs: observation.observedAtMs,
			observationIds: [observation.observationId],
			keyCount: nonNegative(observation.payload.keyCount),
			clickCount: nonNegative(observation.payload.clickCount),
			scrollDelta: finite(observation.payload.scrollDelta),
			mouseDistance: nonNegative(observation.payload.mouseDistance),
		});
	}

	private inputBucketEvent(bucket: InputBucket): DesktopEventV1 {
		return this.makeEvent(
			"input.activityAggregated",
			{
				bucketStartedAtMs: bucket.bucketStartedAtMs,
				bucketEndedAtMs: bucket.bucketStartedAtMs + this.inputBucketMs,
				keyCount: bucket.keyCount,
				clickCount: bucket.clickCount,
				scrollDelta: bucket.scrollDelta,
				mouseDistance: bucket.mouseDistance,
			},
			bucket,
			"metadata",
			bucket.latestOccurredAtMs,
			bucket.latestObservedAtMs,
		);
	}

	private processScanEvent(observation: ProcessScanObservationV1): DesktopEventV1 | null {
		if (observation.payload.started.length === 0 && observation.payload.exited.length === 0) {
			return null;
		}
		return this.makeEvent(
			"application.processObservedBatch",
			{
				started: observation.payload.started.map((process) => ({ ...process })),
				exited: observation.payload.exited.map((process) => ({ ...process })),
			},
			{
				deviceId: observation.deviceId,
				sessionId: observation.sessionId,
				source: observation.source,
				goalVersion: observation.goalVersion,
				observationIds: [observation.observationId],
			},
			"metadata",
			observation.occurredAtMs,
			observation.observedAtMs,
		);
	}

	private makeEvent<K extends DesktopEventKind>(
		kind: K,
		payload: DesktopEventPayloadByKind[K],
		context: {
			deviceId: string;
			sessionId: string;
			source: string;
			goalVersion: number | null;
			observationIds: string[];
		},
		sensitivity: EventSensitivity,
		occurredAtMs: number,
		observedAtMs: number,
	): DesktopEventForKind<K> {
		const identity = this.identityFactory.create(kind, context.observationIds, occurredAtMs);
		return {
			schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
			...identity,
			deviceId: context.deviceId,
			sessionId: context.sessionId,
			kind,
			source: context.source,
			occurredAtMs,
			observedAtMs,
			goalVersion: context.goalVersion,
			sensitivity,
			payload,
		};
	}

	private prepareDuplicateDecision(event: DesktopEventV1): {
		duplicate: boolean;
		commit(): void;
	} {
		if (event.kind === "browser.tabClosed") {
			return {
				duplicate: false,
				commit: () => {
					this.lastSignatures.delete(browserTabDedupeKey(event));
				},
			};
		}
		const dedupeKey = dedupeKeyForEvent(event);
		if (!dedupeKey) return { duplicate: false, commit: () => {} };
		const previous = this.lastSignatures.get(dedupeKey.key);
		return {
			duplicate: previous === dedupeKey.signature,
			commit: () => {
				this.lastSignatures.set(dedupeKey.key, dedupeKey.signature);
			},
		};
	}
}

function dedupeKeyForEvent(
	event: DesktopEventV1,
): { key: string; signature: string } | null {
	switch (event.kind) {
		case "application.foregroundChanged":
			return {
				key: `foreground|${event.deviceId}|${event.sessionId}`,
				signature: `${event.payload.appId}|${event.payload.windowTitle ?? ""}`,
			};
		case "browser.tabOpened":
		case "browser.tabNavigated":
			// Metadata-only browser transitions deliberately omit URL/title. The
			// native browser sensor has already converted polling observations
			// into actual open/navigation transitions, so suppressing two empty
			// payloads here would erase legitimate page changes.
			if (event.payload.url === undefined && event.payload.title === undefined) {
				return null;
			}
			return {
				key: browserTabDedupeKey(event),
				signature: `${event.kind}|${event.payload.url ?? ""}|${event.payload.title ?? ""}`,
			};
		case "accessibility.focusChanged":
			return {
				key: `focus|${event.deviceId}|${event.sessionId}`,
				signature: `${event.payload.appId}|${event.payload.role}|${event.payload.label ?? ""}`,
			};
		default:
			return null;
	}
}

function browserTabDedupeKey(
	event: DesktopEventForKind<
		"browser.tabOpened" | "browser.tabNavigated" | "browser.tabClosed"
	>,
): string {
	return `browser|${event.deviceId}|${event.sessionId}|${event.payload.browserId}|${event.payload.tabId}`;
}

function nonNegative(value: number): number {
	return Math.max(0, finite(value));
}

function finite(value: number): number {
	return Number.isFinite(value) ? value : 0;
}
