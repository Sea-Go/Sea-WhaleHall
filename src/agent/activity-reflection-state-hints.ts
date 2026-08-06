type RawActivityEvent = Record<string, unknown>;

const presenceBoundaryDefinitions = {
	"presence.afkStarted": {
		state: "暂离开始",
		action: "确定：检测到用户暂时离开电脑",
		evidence: "检测到已确认的暂离状态边界",
	},
	"presence.afkEnded": {
		state: "恢复活动",
		action: "确定：检测到用户恢复使用电脑",
		evidence: "检测到已确认的恢复活动状态边界",
	},
	"presence.locked": {
		state: "锁屏",
		action: "确定：电脑已锁屏",
		evidence: "检测到已确认的锁屏状态边界",
	},
	"presence.unlocked": {
		state: "解锁",
		action: "确定：电脑已解锁，后续活动待确认",
		evidence: "检测到已确认的解锁状态边界",
	},
	"presence.sleep": {
		state: "睡眠",
		action: "确定：电脑进入睡眠状态",
		evidence: "检测到已确认的睡眠状态边界",
	},
	"presence.wake": {
		state: "唤醒",
		action: "确定：电脑已从睡眠中唤醒",
		evidence: "检测到已确认的唤醒状态边界",
	},
} as const;

type PresenceBoundaryKind = keyof typeof presenceBoundaryDefinitions;

export type ActivityReflectionStateHints = {
	observation_quality:
		| "存在可用内容证据"
		| "仅有元数据证据"
		| "交互与上下文证据有限"
		| "信息缺失";
	interaction_density:
		| "连续创建或编辑"
		| "连续操作"
		| "轻度导航"
		| "低交互"
		| "无可用交互";
	continuity:
		| "未发现确定的状态中断"
		| "存在应用切换，需区分短暂辅助切换与真实主题切换"
		| "被在场状态边界中断";
	presence_boundaries: Array<{
		state: (typeof presenceBoundaryDefinitions)[PresenceBoundaryKind]["state"];
		at_ms: number | null;
	}>;
};

export type ActivityReflectionStateMarker = {
	action: string;
	activity: "idle_transition";
	goal_relevance: "uncertain";
	confidence: number;
	reason_codes: string[];
	evidence: string[];
	started_at_ms: number;
	ended_at_ms: number;
};

/**
 * Derives only compact, privacy-safe state categories. Raw labels, titles,
 * text, IDs and URLs remain in the raw event payload rather than this hint.
 */
export function deriveActivityReflectionStateHints(
	rawEvent: unknown,
): ActivityReflectionStateHints {
	const events = rawActivityEvents(rawEvent);
	const presenceBoundaries = events
		.map((event) => presenceBoundary(event))
		.filter((event): event is NonNullable<typeof event> => event !== null)
		.map((event) => ({
			state: event.definition.state,
			at_ms: event.occurredAtMs,
		}));
	const kinds = events
		.map((event) => stringValue(event.kind))
		.filter((kind): kind is string => kind !== null);
	return {
		observation_quality: observationQuality(events),
		interaction_density: interactionDensity(kinds),
		continuity:
			presenceBoundaries.length > 0
				? "被在场状态边界中断"
				: kinds.filter((kind) => kind === "application.foregroundChanged")
							.length > 1
					? "存在应用切换，需区分短暂辅助切换与真实主题切换"
					: "未发现确定的状态中断",
		presence_boundaries: presenceBoundaries,
	};
}

/** Builds deterministic, zero-score status events only for real raw boundaries. */
export function deriveActivityReflectionStateMarkers(
	rawEvent: unknown,
	window: { startedAtMs: number | null; endedAtMs: number | null },
): ActivityReflectionStateMarker[] {
	const rawEvents = rawActivityEvents(rawEvent);
	// A presence boundary only annotates an already non-empty sealed window. It
	// must never turn a standalone state signal into a model request/result.
	if (!rawEvents.some(isOrdinaryActivityEvent)) return [];
	const deduplicated = new Map<string, ActivityReflectionStateMarker>();
	for (const event of rawEvents) {
		const boundary = presenceBoundary(event);
		if (!boundary || boundary.occurredAtMs === null) continue;
		const timestamp = clampToWindow(boundary.occurredAtMs, window);
		const marker: ActivityReflectionStateMarker = {
			action: boundary.definition.action,
			activity: "idle_transition",
			goal_relevance: "uncertain",
			confidence: 1,
			reason_codes: ["客户端状态边界"],
			evidence: [boundary.definition.evidence],
			started_at_ms: timestamp,
			ended_at_ms: timestamp,
		};
		deduplicated.set(`${boundary.kind}:${timestamp}`, marker);
	}
	return [...deduplicated.values()].sort(
		(left, right) =>
			left.started_at_ms - right.started_at_ms ||
			left.action.localeCompare(right.action, "zh-CN"),
	);
}

function isOrdinaryActivityEvent(event: RawActivityEvent): boolean {
	return presenceBoundary(event) === null;
}

function rawActivityEvents(rawEvent: unknown): RawActivityEvent[] {
	if (!isRecord(rawEvent) || !Array.isArray(rawEvent.events)) return [];
	return rawEvent.events.filter(isRecord);
}

function observationQuality(
	events: readonly RawActivityEvent[],
): ActivityReflectionStateHints["observation_quality"] {
	if (events.length === 0) return "信息缺失";
	if (events.some((event) => event.sensitivity === "content"))
		return "存在可用内容证据";
	const kinds = events
		.map((event) => stringValue(event.kind))
		.filter((kind): kind is string => kind !== null);
	if (
		kinds.length === 0 ||
		kinds.every((kind) =>
			[
				"application.foregroundChanged",
				"browser.tabOpened",
				"browser.tabNavigated",
				"input.activityAggregated",
			].includes(kind),
		)
	) {
		return "交互与上下文证据有限";
	}
	return "仅有元数据证据";
}

function interactionDensity(
	kinds: readonly string[],
): ActivityReflectionStateHints["interaction_density"] {
	if (kinds.length === 0) return "无可用交互";
	if (
		kinds.some((kind) =>
			[
				"editor.documentChanged",
				"accessibility.documentChanged",
				"accessibility.valueChanged",
			].includes(kind),
		)
	) {
		return "连续创建或编辑";
	}
	if (kinds.includes("input.activityAggregated")) return "连续操作";
	if (
		kinds.some((kind) =>
			["browser.tabOpened", "browser.tabNavigated"].includes(kind),
		)
	) {
		return "轻度导航";
	}
	return "低交互";
}

function presenceBoundary(event: RawActivityEvent): {
	kind: PresenceBoundaryKind;
	definition: (typeof presenceBoundaryDefinitions)[PresenceBoundaryKind];
	occurredAtMs: number | null;
} | null {
	const kind = stringValue(event.kind);
	if (!kind || !Object.hasOwn(presenceBoundaryDefinitions, kind)) return null;
	const typedKind = kind as PresenceBoundaryKind;
	return {
		kind: typedKind,
		definition: presenceBoundaryDefinitions[typedKind],
		occurredAtMs: nonNegativeTimestamp(event.occurredAtMs),
	};
}

function clampToWindow(
	timestamp: number,
	window: { startedAtMs: number | null; endedAtMs: number | null },
): number {
	if (window.startedAtMs === null || window.endedAtMs === null)
		return timestamp;
	return Math.max(window.startedAtMs, Math.min(window.endedAtMs, timestamp));
}

function nonNegativeTimestamp(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0
		? (value as number)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
