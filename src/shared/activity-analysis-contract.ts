/**
 * Renderer-independent contract for the only data that may enter an automatic
 * activity-analysis Agent run. It intentionally contains Worker summaries and
 * scores only—never an EventWindow or raw desktop activity.
 */
export const MAXIMUM_ACTIVITY_ANALYSIS_RESULTS = 512;
export const MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS = 48 * 1024;
export const MAXIMUM_ACTIVITY_ANALYSIS_RESULT_CHARACTERS = 16 * 1024;

export type ActivityAnalysisWorkerEvent = {
	/**
	 * Client-derived human-readable time range. Legacy receipts may omit this
	 * field; every new client-owned reflection result includes it.
	 */
	time?: string;
	/**
	 * Chinese, reviewable aggregation statement such as “推测：正在进行编程”.
	 * Legacy receipts may omit this field during the one-way migration.
	 */
	action?: string;
	source_event_ids: string[];
	activity: string;
	goal_relevance: string;
	confidence: number;
	reason_codes: string[];
	evidence: string[];
	started_at_ms: number | null;
	ended_at_ms: number | null;
};

export type ActivityAnalysisWorkerResult = {
	request_id: string;
	events: ActivityAnalysisWorkerEvent[];
	score: number;
	score_reason: string;
};

export function isActivityAnalysisWorkerResult(
	value: unknown,
): value is ActivityAnalysisWorkerResult {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["request_id", "events", "score", "score_reason"]) &&
		isBoundedString(value.request_id, 256, false) &&
		Array.isArray(value.events) &&
		value.events.length <= 64 &&
		value.events.every(isActivityAnalysisWorkerEvent) &&
		isScore(value.score) &&
		isBoundedString(value.score_reason, 400, true) &&
		(value.events.length > 0 || value.score === 0)
	);
}

export function serializedActivityAnalysisLength(
	results: readonly ActivityAnalysisWorkerResult[],
): number {
	return JSON.stringify(results).length;
}

function isActivityAnalysisWorkerEvent(
	value: unknown,
): value is ActivityAnalysisWorkerEvent {
	return (
		isRecord(value) &&
		hasActivityAnalysisWorkerEventKeys(value) &&
		(value.time === undefined || isBoundedString(value.time, 96, false)) &&
		(value.action === undefined || isReviewableChineseAction(value.action)) &&
		Array.isArray(value.source_event_ids) &&
		value.source_event_ids.length >= 1 &&
		value.source_event_ids.length <= 32 &&
		value.source_event_ids.every((item) => isBoundedString(item, 160, false)) &&
		isBoundedString(value.activity, 80, false) &&
		isBoundedString(value.goal_relevance, 80, false) &&
		isScore(value.confidence) &&
		Array.isArray(value.reason_codes) &&
		value.reason_codes.length >= 1 &&
		value.reason_codes.length <= 4 &&
		value.reason_codes.every((item) => isBoundedString(item, 80, false)) &&
		Array.isArray(value.evidence) &&
		value.evidence.length <= 8 &&
		value.evidence.every((item) => isBoundedString(item, 240, true)) &&
		isNullableTimestamp(value.started_at_ms) &&
		isNullableTimestamp(value.ended_at_ms)
	);
}

function hasActivityAnalysisWorkerEventKeys(
	value: Record<string, unknown>,
): boolean {
	const required = [
		"source_event_ids",
		"activity",
		"goal_relevance",
		"confidence",
		"reason_codes",
		"evidence",
		"started_at_ms",
		"ended_at_ms",
	];
	const keys = Object.keys(value);
	return (
		required.every((key) => key in value) &&
		keys.every((key) => required.includes(key) || key === "time" || key === "action")
	);
}

function isReviewableChineseAction(value: unknown): value is string {
	return (
		isBoundedString(value, 80, false) &&
		/^(确定：|推测：|不确定：)/u.test(value) &&
		/[\u3400-\u9fff]/u.test(value.slice(3))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function isBoundedString(
	value: unknown,
	maximum: number,
	allowEmpty: boolean,
): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		value.length <= maximum
	);
}

function isScore(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function isNullableTimestamp(value: unknown): value is number | null {
	return (
		value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
	);
}
