export const DESKTOP_EVENT_SCHEMA_VERSION = "desktop-event.v1" as const;
export const EVENT_WINDOW_SCHEMA_VERSION = "event-window.v1" as const;
export const REFLECTION_SCHEMA_VERSION = "reflection.v1" as const;
export const COLLECTOR_SNAPSHOT_SCHEMA_VERSION = "reflection-collector-snapshot.v1" as const;
export const REFLECTION_JOB_SCHEMA_VERSION = "reflection-job.v1" as const;

export type EventSensitivity = "metadata" | "content";

export type ActiveGoalContextV1 = {
	goalId: string;
	planId: string | null;
	version: number;
	text: string;
	activatedAtMs: number;
};

export type ProcessObservation = {
	processId: number;
	appId: string;
	appName: string;
};

export type DesktopEventPayloadByKind = {
	"application.processObservedBatch": {
		started: ProcessObservation[];
		exited: ProcessObservation[];
	};
	"application.foregroundChanged": {
		appId: string;
		appName: string;
		windowTitle?: string;
	};
	"browser.tabOpened": {
		browserId: string;
		tabId: string;
		title?: string;
		url?: string;
	};
	"browser.tabNavigated": {
		browserId: string;
		tabId: string;
		title?: string;
		url?: string;
	};
	"browser.tabClosed": {
		browserId: string;
		tabId: string;
	};
	"accessibility.focusChanged": {
		appId: string;
		role: string;
		label?: string;
	};
	"accessibility.valueChanged": {
		appId: string;
		role: string;
		value?: string;
	};
	"accessibility.documentChanged": {
		appId: string;
		documentId?: string;
		insertedChars: number;
		deletedChars: number;
		text?: string;
	};
	"editor.documentChanged": {
		editorId: string;
		documentId: string;
		relativePath?: string;
		language?: string;
		insertedChars: number;
		deletedChars: number;
		text?: string;
		burstStartedAtMs: number;
		burstEndedAtMs: number;
	};
	"input.activityAggregated": {
		bucketStartedAtMs: number;
		bucketEndedAtMs: number;
		keyCount: number;
		clickCount: number;
		scrollDelta: number;
		mouseDistance: number;
	};
	"presence.afkStarted": { idleForMs: number };
	"presence.afkEnded": { idleForMs: number };
	"presence.locked": Record<string, never>;
	"presence.unlocked": Record<string, never>;
	"presence.sleep": Record<string, never>;
	"presence.wake": Record<string, never>;
	"goal.contextChanged": {
		previous: ActiveGoalContextV1 | null;
		next: ActiveGoalContextV1 | null;
	};
	"authorization.revoked": {
		permissions: string[];
	};
	"authorization.granted": {
		permissions: string[];
	};
	"reflection.completed": { windowId: string };
	"reflection.failed": { windowId: string; code: string };
	"tool.started": { callId: string; name?: string };
	"tool.progress": { callId: string; progress?: number };
	"tool.completed": { callId: string; name?: string };
	"tool.failed": { callId: string; code?: string };
	"tool.cancelled": { callId: string };
	"system.heartbeat": Record<string, never>;
};

export type DesktopEventKind = keyof DesktopEventPayloadByKind;

export type DesktopEventForKind<K extends DesktopEventKind> = {
	schemaVersion: typeof DESKTOP_EVENT_SCHEMA_VERSION;
	eventId: string;
	cursor: string;
	deviceId: string;
	sessionId: string;
	kind: K;
	source: string;
	occurredAtMs: number;
	observedAtMs: number;
	goalVersion: number | null;
	sensitivity: EventSensitivity;
	payload: DesktopEventPayloadByKind[K];
};

export type DesktopEventV1 = {
	[K in DesktopEventKind]: DesktopEventForKind<K>;
}[DesktopEventKind];

export type CountedDesktopEventKind = Exclude<
	DesktopEventKind,
	| "goal.contextChanged"
	| "authorization.revoked"
	| "authorization.granted"
	| "presence.afkStarted"
	| "presence.afkEnded"
	| "presence.locked"
	| "presence.unlocked"
	| "presence.sleep"
	| "presence.wake"
	| "reflection.completed"
	| "reflection.failed"
	| "tool.started"
	| "tool.progress"
	| "tool.completed"
	| "tool.failed"
	| "tool.cancelled"
	| "system.heartbeat"
>;

export type ReflectionTriggerReason =
	| "event_count"
	| "max_wait"
	| "goal_boundary"
	| "presence_boundary";

export type EventWindowV1 = {
	schemaVersion: typeof EVENT_WINDOW_SCHEMA_VERSION;
	windowId: string;
	collectorId: string;
	deviceId: string;
	sessionId: string;
	triggerReason: ReflectionTriggerReason;
	goal: ActiveGoalContextV1 | null;
	goalVersion: number | null;
	startedAtMs: number;
	endedAtMs: number;
	deadlineAtMs: number;
	eventCount: number;
	firstCursor: string;
	lastCursor: string;
	events: DesktopEventV1[];
	contextOnly: DesktopEventV1[];
	modelInput: string;
	inputHash: string;
};

export type ActivityLabel =
	| "development"
	| "writing"
	| "research"
	| "communication"
	| "planning"
	| "data_work"
	| "media"
	| "gaming"
	| "system_file_ops"
	| "commerce"
	| "idle_transition"
	| "other_unknown";

export type GoalRelevanceLabel = "direct" | "supporting" | "unrelated" | "uncertain";

export type FeedbackCode =
	| "silent"
	| "encourage"
	| "refocus"
	| "clarifyGoal"
	| "takeBreak";

export type ReflectionV1 = {
	schemaVersion: typeof REFLECTION_SCHEMA_VERSION;
	windowId: string;
	triggerReason: ReflectionTriggerReason;
	eventCount: number;
	durationMs: number;
	goalVersion: number | null;
	activity: {
		label: ActivityLabel;
		probabilities: Record<ActivityLabel, number>;
	};
	goalRelevance: {
		label: GoalRelevanceLabel;
		probabilities: Record<GoalRelevanceLabel, number>;
	} | null;
	embedding: number[];
	confidence: number;
	entropy: number;
	abstain: boolean;
	evidenceEventIds: string[];
	feedbackCode: FeedbackCode;
	modelVersion: string;
	taxonomyVersion: string;
};

export type CollectorRuntimeState =
	| "RECOVERING"
	| "ACTIVE_EMPTY"
	| "ACTIVE_COLLECTING"
	| "SEALED";

export type OpenEventWindowV1 = {
	goal: ActiveGoalContextV1 | null;
	goalVersion: number | null;
	startedAtMs: number;
	deadlineAtMs: number;
	events: DesktopEventV1[];
	finalizedSemanticEventCount: number;
};

export type ReflectionCollectorSnapshotV1 = {
	schemaVersion: typeof COLLECTOR_SNAPSHOT_SCHEMA_VERSION;
	collectorId: string;
	deviceId: string;
	sessionId: string;
	state: Exclude<CollectorRuntimeState, "RECOVERING" | "SEALED">;
	activeGoal: ActiveGoalContextV1 | null;
	goalRevision: number;
	openWindow: OpenEventWindowV1 | null;
	contextCandidates: DesktopEventV1[];
	recentEventIds: string[];
	revokedPermissions: string[];
	materializedCursor: string | null;
	revision: number;
	updatedAtMs: number;
};

export type ReflectionJobState =
	| "READY"
	| "RUNNING"
	| "RESULT_PERSISTED"
	| "COMMITTING"
	| "RETRY_WAIT"
	| "COMMITTED"
	| "TERMINAL_FAILED";

export type ReflectionJobFailureV1 = {
	code: string;
	message: string;
	failedAtMs: number;
};

export type ReflectionJobV1 = {
	schemaVersion: typeof REFLECTION_JOB_SCHEMA_VERSION;
	windowId: string;
	state: ReflectionJobState;
	attempt: number;
	replayCount: number;
	createdAtMs: number;
	firstAttemptAtMs: number | null;
	updatedAtMs: number;
	nextAttemptAtMs: number | null;
	leaseExpiresAtMs: number | null;
	lastFailure: ReflectionJobFailureV1 | null;
	reflection: ReflectionV1 | null;
	terminalCursorReleasedAtMs: number | null;
};

export type ReflectionQueueStats = {
	pendingJobs: number;
	pendingEvents: number;
};

export type ReflectionQueueMode = "accepting" | "draining";

export function isCountedSemanticEvent(
	event: DesktopEventV1,
): event is Extract<DesktopEventV1, { kind: CountedDesktopEventKind }> {
	switch (event.kind) {
		case "goal.contextChanged":
		case "authorization.revoked":
		case "authorization.granted":
		case "presence.afkStarted":
		case "presence.afkEnded":
		case "presence.locked":
		case "presence.unlocked":
		case "presence.sleep":
		case "presence.wake":
		case "reflection.completed":
		case "reflection.failed":
		case "tool.started":
		case "tool.progress":
		case "tool.completed":
		case "tool.failed":
		case "tool.cancelled":
		case "system.heartbeat":
			return false;
		default:
			return true;
	}
}

export function isPresenceFlushBoundary(event: DesktopEventV1): boolean {
	return (
		event.kind === "presence.afkStarted" ||
		event.kind === "presence.afkEnded" ||
		event.kind === "presence.locked" ||
		event.kind === "presence.unlocked" ||
		event.kind === "presence.sleep" ||
		event.kind === "presence.wake"
	);
}

export function isIgnoredReflectionInput(event: DesktopEventV1): boolean {
	return (
		event.kind.startsWith("reflection.") ||
		event.kind.startsWith("tool.") ||
		event.kind === "system.heartbeat"
	);
}
