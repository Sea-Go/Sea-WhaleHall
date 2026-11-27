import { canonicalJson, type ReflectionHasher } from "./hash";
import {
	EVENT_WINDOW_SCHEMA_VERSION,
	type ActiveGoalContextV1,
	type DesktopEventV1,
	type EventWindowV1,
	type OpenEventWindowV1,
	type ReflectionTriggerReason,
	isCountedSemanticEvent,
} from "./types";

export const DEFAULT_CONTEXT_EVENT_LIMIT = 5;
export const DEFAULT_CONTEXT_LOOKBACK_MS = 30_000;
export const DEFAULT_CONTEXT_TOKEN_LIMIT = 96;
export const DEFAULT_MODEL_INPUT_TOKEN_LIMIT = 3_000;
export const DEFAULT_MODEL_INPUT_BYTE_LIMIT = 32 * 1_024;

export type WindowBuildRequest = {
	collectorId: string;
	deviceId: string;
	sessionId: string;
	openWindow: OpenEventWindowV1;
	triggerReason: ReflectionTriggerReason;
	endedAtMs: number;
	contextCandidates: DesktopEventV1[];
};

export type DeterministicWindowBuilderOptions = {
	contextEventLimit?: number;
	contextLookbackMs?: number;
	contextTokenLimit?: number;
	modelInputTokenLimit?: number;
	modelInputByteLimit?: number;
	estimateTokens?: (value: string) => number;
};

export class DeterministicWindowBuilder {
	private readonly contextEventLimit: number;
	private readonly contextLookbackMs: number;
	private readonly contextTokenLimit: number;
	private readonly modelInputTokenLimit: number;
	private readonly modelInputByteLimit: number;
	private readonly estimateTokens: (value: string) => number;

	constructor(
		private readonly hasher: ReflectionHasher,
		options: DeterministicWindowBuilderOptions = {},
	) {
		this.contextEventLimit = options.contextEventLimit ?? DEFAULT_CONTEXT_EVENT_LIMIT;
		this.contextLookbackMs = options.contextLookbackMs ?? DEFAULT_CONTEXT_LOOKBACK_MS;
		this.contextTokenLimit = options.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
		this.modelInputTokenLimit =
			options.modelInputTokenLimit ?? DEFAULT_MODEL_INPUT_TOKEN_LIMIT;
		this.modelInputByteLimit =
			options.modelInputByteLimit ?? DEFAULT_MODEL_INPUT_BYTE_LIMIT;
		this.estimateTokens = options.estimateTokens ?? conservativeTokenEstimate;
		if (!Number.isInteger(this.modelInputTokenLimit) || this.modelInputTokenLimit < 1) {
			throw new Error("modelInputTokenLimit must be a positive integer.");
		}
		if (!Number.isInteger(this.modelInputByteLimit) || this.modelInputByteLimit < 1) {
			throw new Error("modelInputByteLimit must be a positive integer.");
		}
	}

	async build(request: WindowBuildRequest): Promise<EventWindowV1> {
		const primaryEvents = request.openWindow.events.map(cloneEvent);
		if (primaryEvents.length === 0 || request.openWindow.finalizedSemanticEventCount === 0) {
			throw new Error("Cannot build an empty reflection window.");
		}

		const firstEvent = primaryEvents[0];
		const lastEvent = primaryEvents.at(-1);
		if (!firstEvent || !lastEvent) throw new Error("Reflection window lost its cursor bounds.");

		const contextOnly = this.selectContext(
			request.contextCandidates,
			request.openWindow.startedAtMs,
		);
		const modelInput = renderModelInput(
			request.openWindow.goal,
			primaryEvents,
			contextOnly,
			{
				tokenLimit: this.modelInputTokenLimit,
				byteLimit: this.modelInputByteLimit,
				estimateTokens: this.estimateTokens,
			},
		);
		const inputHash = await this.hasher.sha256(modelInput);
		const identity = canonicalJson({
			deviceId: request.deviceId,
			sessionId: request.sessionId,
			goalVersion: request.openWindow.goalVersion,
			firstCursor: firstEvent.cursor,
			lastCursor: lastEvent.cursor,
			triggerReason: request.triggerReason,
		});
		const windowId = `window_${await this.hasher.sha256(identity)}`;

		return {
			schemaVersion: EVENT_WINDOW_SCHEMA_VERSION,
			windowId,
			collectorId: request.collectorId,
			deviceId: request.deviceId,
			sessionId: request.sessionId,
			triggerReason: request.triggerReason,
			goal: cloneGoal(request.openWindow.goal),
			goalVersion: request.openWindow.goalVersion,
			startedAtMs: request.openWindow.startedAtMs,
			endedAtMs: Math.max(request.openWindow.startedAtMs, request.endedAtMs),
			deadlineAtMs: request.openWindow.deadlineAtMs,
			eventCount: request.openWindow.finalizedSemanticEventCount,
			firstCursor: firstEvent.cursor,
			lastCursor: lastEvent.cursor,
			events: primaryEvents,
			contextOnly,
			modelInput,
			inputHash,
		};
	}

	private selectContext(candidates: DesktopEventV1[], nextStartedAtMs: number): DesktopEventV1[] {
		const selectedNewestFirst: DesktopEventV1[] = [];
		let usedTokens = 0;

		for (let index = candidates.length - 1; index >= 0; index -= 1) {
			if (selectedNewestFirst.length >= this.contextEventLimit) break;
			const candidate = candidates[index];
			if (!candidate || !isCountedSemanticEvent(candidate)) continue;
			const ageMs = nextStartedAtMs - candidate.occurredAtMs;
			if (ageMs < 0 || ageMs > this.contextLookbackMs) continue;

			const tokens = this.estimateTokens(renderEvent(candidate));
			if (tokens > this.contextTokenLimit - usedTokens) continue;
			selectedNewestFirst.push(cloneEvent(candidate));
			usedTokens += tokens;
		}

		return selectedNewestFirst.reverse();
	}
}

export function contextCandidatesFromWindow(window: EventWindowV1): DesktopEventV1[] {
	return window.events.filter(isCountedSemanticEvent).slice(-DEFAULT_CONTEXT_EVENT_LIMIT).map(cloneEvent);
}

export function renderModelInput(
	goal: ActiveGoalContextV1 | null,
	events: DesktopEventV1[],
	contextOnly: DesktopEventV1[],
	options: {
		tokenLimit?: number;
		byteLimit?: number;
		estimateTokens?: (value: string) => number;
	} = {},
): string {
	const goalSection = goal
		? canonicalJson({ goalId: goal.goalId, planId: goal.planId, version: goal.version, text: goal.text })
		: "null";
	const tokenLimit = options.tokenLimit ?? DEFAULT_MODEL_INPUT_TOKEN_LIMIT;
	const byteLimit = options.byteLimit ?? DEFAULT_MODEL_INPUT_BYTE_LIMIT;
	const estimateTokens = options.estimateTokens ?? conservativeTokenEstimate;
	const fits = (value: string): boolean =>
		modelInputFits(value, tokenLimit, byteLimit, estimateTokens);
	const richContextLines = contextOnly.map(renderEvent);
	const richEventLines = events.map(renderEvent);
	const rich = composeModelInput(goalSection, richContextLines, richEventLines);
	if (fits(rich)) return rich;

	// Keep every semantic event visible to the model even for adversarially
	// large URLs, process batches, or inserted-text bursts. Start from a compact
	// chronological skeleton, then spend the remaining budget on the newest
	// primary evidence before older/context detail.
	const contextLines = contextOnly.map(renderEventSkeleton);
	let layout = layoutEventSkeleton(events, "one-line-each", 0);
	let bounded = composeModelInput(goalSection, contextLines, layout.lines);
	if (!fits(bounded)) {
		// Non-counted events are unbounded context: five minutes of process
		// batches alone outweigh the counted evidence. List their timestamps
		// per run instead, then drop the oldest runs with an explicit count.
		layout = layoutEventSkeleton(events, "one-line-per-run", 0);
		bounded = composeModelInput(goalSection, contextLines, layout.lines);
		if (!fits(bounded)) {
			let omittedBefore = 0;
			let fitted = false;
			while (!fitted) {
				omittedBefore = nextNonCountedRunEnd(events, omittedBefore);
				if (omittedBefore < 0) break;
				const trial = layoutEventSkeleton(
					events,
					"one-line-per-run",
					omittedBefore,
				);
				const value = composeModelInput(goalSection, contextLines, trial.lines);
				if (fits(value)) {
					layout = trial;
					bounded = value;
					fitted = true;
				}
			}
			if (!fitted) {
				throw new Error(
					"Goal and semantic event skeleton exceed the deterministic model input budget.",
				);
			}
		}
	}

	const upgrades: Array<{
		lines: string[];
		index: number;
		value: string;
	}> = [];
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const line = layout.lineOfEvent[index];
		const event = events[index];
		if (line === undefined || line < 0 || !event) continue;
		upgrades.push({ lines: layout.lines, index: line, value: renderCompactEvent(event) });
	}
	for (let index = contextOnly.length - 1; index >= 0; index -= 1) {
		const event = contextOnly[index];
		if (event) {
			upgrades.push({ lines: contextLines, index, value: renderCompactEvent(event) });
		}
	}
	for (const upgrade of upgrades) {
		const previous = upgrade.lines[upgrade.index];
		upgrade.lines[upgrade.index] = upgrade.value;
		const candidate = composeModelInput(goalSection, contextLines, layout.lines);
		if (fits(candidate)) {
			bounded = candidate;
		} else {
			upgrade.lines[upgrade.index] = previous ?? "";
		}
	}
	return bounded;
}

type EventSkeletonLayout = {
	lines: string[];
	/** Line that renders the event; negative when it shares a run line or is omitted. */
	lineOfEvent: number[];
};

/**
 * Non-counted events share one line per run only on request, so a window that
 * already fits keeps one line per event.
 */
function layoutEventSkeleton(
	events: DesktopEventV1[],
	runs: "one-line-each" | "one-line-per-run",
	omitNonCountedBefore: number,
): EventSkeletonLayout {
	const lines: string[] = [];
	const lineOfEvent: number[] = new Array<number>(events.length).fill(-1);
	let omitted = 0;
	let index = 0;
	while (index < events.length) {
		const event = events[index];
		if (!event) {
			index += 1;
			continue;
		}
		if (isCountedSemanticEvent(event) || runs === "one-line-each") {
			lineOfEvent[index] = lines.length;
			lines.push(renderEventSkeleton(event));
			index += 1;
			continue;
		}
		if (index < omitNonCountedBefore) {
			omitted += 1;
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < events.length) {
			const next = events[end];
			if (!next || isCountedSemanticEvent(next) || next.kind !== event.kind) break;
			end += 1;
		}
		lines.push(renderEventRunSkeleton(events.slice(index, end)));
		index = end;
	}
	if (omitted > 0) {
		lines.push(canonicalJson({ omittedNonCountedEvents: omitted }));
	}
	return { lines, lineOfEvent };
}

/** Exclusive end of the first non-counted run at or after `from`; -1 when none is left. */
function nextNonCountedRunEnd(events: DesktopEventV1[], from: number): number {
	let start = from;
	while (start < events.length) {
		const event = events[start];
		if (event && !isCountedSemanticEvent(event)) break;
		start += 1;
	}
	if (start >= events.length) return -1;
	let end = start + 1;
	while (end < events.length) {
		const event = events[end];
		if (!event || isCountedSemanticEvent(event) || event.kind !== events[start]?.kind) {
			break;
		}
		end += 1;
	}
	return end;
}

function renderEventRunSkeleton(run: DesktopEventV1[]): string {
	const first = run[0];
	if (!first) return "";
	if (run.length === 1) return renderEventSkeleton(first);
	return canonicalJson({
		kind: first.kind,
		occurredAtMs: run.map((event) => event.occurredAtMs),
	});
}

export function renderEvent(event: DesktopEventV1): string {
	return canonicalJson({
		eventId: event.eventId,
		cursor: event.cursor,
		kind: event.kind,
		source: event.source,
		occurredAtMs: event.occurredAtMs,
		goalVersion: event.goalVersion,
		payload: event.payload,
	});
}

export function conservativeTokenEstimate(value: string): number {
	let asciiRun = 0;
	let tokens = 0;
	for (const character of value) {
		if (character.codePointAt(0)! <= 0x7f) {
			asciiRun += 1;
			continue;
		}
		if (asciiRun > 0) {
			tokens += Math.ceil(asciiRun / 4);
			asciiRun = 0;
		}
		tokens += 1;
	}
	if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4);
	return tokens;
}

function composeModelInput(
	goalSection: string,
	contextLines: string[],
	eventLines: string[],
): string {
	const contextSection = contextLines.length === 0 ? "(none)" : contextLines.join("\n");
	return `[GOAL]\n${goalSection}\n[CONTEXT_ONLY]\n${contextSection}\n[EVENTS]\n${eventLines.join("\n")}`;
}

function modelInputFits(
	value: string,
	tokenLimit: number,
	byteLimit: number,
	estimateTokens: (value: string) => number,
): boolean {
	return (
		new TextEncoder().encode(value).byteLength <= byteLimit &&
		estimateTokens(value) <= tokenLimit
	);
}

function renderEventSkeleton(event: DesktopEventV1): string {
	return canonicalJson({
		kind: event.kind,
		occurredAtMs: event.occurredAtMs,
	});
}

function renderCompactEvent(event: DesktopEventV1): string {
	return canonicalJson({
		kind: event.kind,
		occurredAtMs: event.occurredAtMs,
		payload: compactModelValue(event.payload, 0),
	});
}

function compactModelValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return Array.from(value).slice(0, 160).join("");
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return value;
	}
	if (depth >= 4) return "[bounded]";
	if (Array.isArray(value)) {
		const selected = value
			.slice(0, 8)
			.map((entry) => compactModelValue(entry, depth + 1));
		if (value.length > selected.length) {
			selected.push({ omittedItems: value.length - selected.length });
		}
		return selected;
	}
	if (typeof value !== "object") {
		return Array.from(String(value)).slice(0, 160).join("");
	}
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry !== undefined) result[key] = compactModelValue(entry, depth + 1);
	}
	return result;
}

function cloneGoal(goal: ActiveGoalContextV1 | null): ActiveGoalContextV1 | null {
	return goal ? { ...goal } : null;
}

function cloneEvent(event: DesktopEventV1): DesktopEventV1 {
	return structuredClone(event);
}
