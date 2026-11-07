import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type {
	LocalAuditFiveMinutesQuery,
	LocalAuditFiveMinutesResult,
	LocalEventCommitResult,
	LocalEventGoalChange,
	LocalEventGoalChangeResult,
	LocalEventQuery,
	LocalEventQueryResult,
	LocalEventTailCursorResult,
	LocalMonitoringConfigure,
	LocalMonitoringStatus,
	LocalPlanningCalendarEvent,
	LocalPlanningCalendarList,
	LocalPlanningCalendarListResult,
	LocalRuntimeHealth,
	LocalSemanticCommitResult,
	LocalSemanticQuery,
	LocalSemanticQueryResult,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
	LocalVaultDeleteBatch,
	LocalVaultDeleteBatchResult,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
	LocalVaultOpenBatch,
	LocalVaultOpenBatchResult,
	LocalVaultSealBatch,
	LocalVaultSealBatchResult,
} from "../src/agent/local-protocol";
import {
	LocalClientError,
	type LocalToolProcess,
} from "../src/agent/local-tool-client";
import type { DesktopEventV1 } from "../src/agent/reflection/types";
import type { SemanticEventV2 } from "../src/agent/timeline/types";

class FakeLocalProcess implements LocalToolProcess {
	pid: number | null = null;
	isRunning = false;
	startError: Error | null = null;
	appendGoalError: Error | null = null;
	startCount = 0;
	stopCount = 0;
	startGate: Promise<void> | null = null;
	prepareGate: Promise<void> | null = null;
	readonly preparedStartupGoalChanges: Array<LocalEventGoalChange | null> = [];
	readonly appendedGoalChanges: LocalEventGoalChange[] = [];
	readonly calendarQueries: LocalPlanningCalendarList[] = [];
	readonly calendarPages = new Map<string, LocalPlanningCalendarListResult>();
	startupGoalAcknowledgements = 0;
	private readonly eventListeners = new Set<(event: LocalToolEvent) => void>();
	private readonly desktopEventListeners = new Set<
		(event: DesktopEventV1) => void
	>();
	private readonly semanticEventListeners = new Set<
		(event: SemanticEventV2) => void
	>();
	private readonly failureListeners = new Set<
		(error: LocalClientError) => void
	>();

	async prepareStartupGoalChange(
		change: LocalEventGoalChange | null,
	): Promise<void> {
		await this.prepareGate;
		if (this.isRunning) throw new Error("already running");
		this.preparedStartupGoalChanges.push(structuredClone(change));
	}

	async acknowledgeStartupGoalChange(): Promise<void> {
		this.startupGoalAcknowledgements += 1;
	}

	async start(): Promise<void> {
		this.startCount += 1;
		await this.startGate;
		if (this.startError) throw this.startError;
		this.pid = 7001;
		this.isRunning = true;
	}

	async health(): Promise<LocalRuntimeHealth> {
		return {
			service: "whalehall-local",
			version: "0.1.0",
			pid: 7001,
			status: "ok",
		};
	}

	async getEventTailCursor(): Promise<LocalEventTailCursorResult> {
		return { cursor: "ec1_0000000000000000" };
	}

	async listTools(): Promise<LocalToolDescriptor[]> {
		return [
			{
				name: "system.info",
				description: "system",
				inputSchema: { type: "object" },
				risk: "read",
				requiredPermissions: [],
				supportsCancellation: false,
			},
		];
	}

	async callTool(call: LocalToolCall): Promise<LocalToolCallResult> {
		this.emit({
			event: "tool.started",
			callId: call.callId,
			data: { name: call.name },
		});
		this.emit({
			event: "tool.completed",
			callId: call.callId,
			data: { name: call.name },
		});
		return { callId: call.callId, output: { ok: true } };
	}

	async cancelTool(callId: string): Promise<LocalToolCancelResult> {
		return { callId, cancelled: true };
	}

	async queryEvents(_query: LocalEventQuery): Promise<LocalEventQueryResult> {
		return { events: [], nextCursor: null, hasMore: false };
	}

	async commitEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult> {
		return { consumerId, cursor, advanced: true };
	}

	async appendGoalChange(
		change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult> {
		this.appendedGoalChanges.push(structuredClone(change));
		if (this.appendGoalError) throw this.appendGoalError;
		return {
			inserted: true,
			event: {
				schemaVersion: "desktop-event.v1",
				eventId: "goal-event",
				cursor: "ec1_0000000000000001",
				deviceId: "device",
				sessionId: "session",
				kind: "goal.contextChanged",
				source: "planning.controller",
				occurredAtMs: change.occurredAtMs,
				observedAtMs: change.occurredAtMs,
				goalVersion: change.previous?.version ?? null,
				sensitivity: "content",
				payload: {
					previous: structuredClone(change.previous),
					next: structuredClone(change.next),
				},
			},
		};
	}

	async getMonitoringStatus(): Promise<LocalMonitoringStatus> {
		return monitoringStatus();
	}

	async configureMonitoring(
		configuration: LocalMonitoringConfigure,
	): Promise<LocalMonitoringStatus> {
		return monitoringStatus({
			state: configuration.enabled ? "running" : "disabled",
			enabled: configuration.enabled,
			captureContent: configuration.captureContent,
			excludedBundleIds: configuration.excludedBundleIds,
		});
	}

	async pauseMonitoring(): Promise<LocalMonitoringStatus> {
		return monitoringStatus({ state: "paused", tapReady: false });
	}

	async resumeMonitoring(): Promise<LocalMonitoringStatus> {
		return monitoringStatus();
	}

	async refreshMonitoringPermissions(): Promise<LocalMonitoringStatus> {
		return monitoringStatus();
	}

	async setupMonitoringPermissions(): Promise<LocalMonitoringStatus> {
		return monitoringStatus();
	}

	async querySemanticEvents(
		_query: LocalSemanticQuery,
	): Promise<LocalSemanticQueryResult> {
		return { events: [], nextCursor: null, hasMore: false };
	}

	async commitSemanticCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalSemanticCommitResult> {
		return { consumerId, cursor, advanced: true };
	}

	async queryAuditFiveMinutes(
		query: LocalAuditFiveMinutesQuery,
	): Promise<LocalAuditFiveMinutesResult> {
		return {
			fromMs: query.fromMs,
			toMs: query.toMs,
			permissions: monitoringStatus().permissions,
			coverage: ["metadata"],
			rawObservations: [],
			semanticEvents: [],
		};
	}

	async sealVaultBatch(
		_batch: LocalVaultSealBatch,
	): Promise<LocalVaultSealBatchResult> {
		return { records: [] };
	}

	async openVaultBatch(
		_batch: LocalVaultOpenBatch,
	): Promise<LocalVaultOpenBatchResult> {
		return { records: [] };
	}

	async deleteVaultBatch(
		batch: LocalVaultDeleteBatch,
	): Promise<LocalVaultDeleteBatchResult> {
		return {
			records: batch.recordIds.map((recordId) => ({ recordId, deleted: true })),
		};
	}

	async getVaultKeyStatus(): Promise<LocalVaultKeyStatus> {
		return {
			availability: "available",
			storageMode: "data_protection_keychain",
			keyVersion: "keychain-v1",
			interactiveMigrationAvailable: false,
		};
	}

	async migrateLegacyVaultKey(): Promise<LocalVaultLegacyMigrationResult> {
		return {
			migrated: false,
			status: await this.getVaultKeyStatus(),
		};
	}

	async listPlanningCalendar(
		query: LocalPlanningCalendarList = {},
	): Promise<LocalPlanningCalendarListResult> {
		this.calendarQueries.push(structuredClone(query));
		return structuredClone(
			this.calendarPages.get(query.cursor ?? "") ?? {
				events: [],
				nextCursor: null,
			},
		);
	}

	async stop(): Promise<void> {
		this.stopCount += 1;
		this.pid = null;
		this.isRunning = false;
	}

	onEvent(listener: (event: LocalToolEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onDesktopEvent(listener: (event: DesktopEventV1) => void): () => void {
		this.desktopEventListeners.add(listener);
		return () => this.desktopEventListeners.delete(listener);
	}

	onSemanticEvent(listener: (event: SemanticEventV2) => void): () => void {
		this.semanticEventListeners.add(listener);
		return () => this.semanticEventListeners.delete(listener);
	}

	onFailure(listener: (error: LocalClientError) => void): () => void {
		this.failureListeners.add(listener);
		return () => this.failureListeners.delete(listener);
	}

	emit(event: LocalToolEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}

	emitDesktop(event: DesktopEventV1): void {
		for (const listener of this.desktopEventListeners) listener(event);
	}

	fail(error: LocalClientError): void {
		this.isRunning = false;
		this.pid = null;
		for (const listener of this.failureListeners) listener(error);
	}

	emitFailureWhileOwnerIsRetained(error: LocalClientError): void {
		for (const listener of this.failureListeners) listener(error);
	}

	releaseRetainedOwner(): void {
		this.isRunning = false;
		this.pid = null;
	}
}

function monitoringStatus(
	overrides: Partial<LocalMonitoringStatus> = {},
): LocalMonitoringStatus {
	return {
		state: "running",
		enabled: true,
		captureContent: true,
		excludedBundleIds: [],
		helperPid: 7002,
		helperPathAvailable: true,
		bootId: "boot-test",
		lastSequence: 2,
		lastAckedSequence: 2,
		lastHeartbeatAtMs: 1_800_000_000_000,
		tapReady: true,
		lastCallbackAtMs: 1_799_999_999_999,
		lastBucketAtMs: 1_799_999_995_000,
		permissions: {
			accessibility: "granted",
			screenRecording: "granted",
			inputMonitoring: "granted",
			automation: "granted",
		},
		permissionCheckState: "current",
		permissionsCheckedAtMs: 1_800_000_000_000,
		permissionSetupAvailable: true,
		permissionSetupAttempted: true,
		coverage: ["content", "metadata"],
		lastError: null,
		...overrides,
	};
}

describe("AgentRuntime", () => {
	test("permanently gates startup after application shutdown begins", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local, {
			requireStartupGoalPreparation: true,
		});
		runtime.beginShutdown();
		runtime.beginShutdown();

		await expect(runtime.prepareStartupGoalChange(null)).rejects.toThrow(
			"while WhaleHall is quitting",
		);
		await expect(runtime.start()).rejects.toThrow(
			"while WhaleHall is quitting",
		);
		await expect(runtime.listLocalTools()).rejects.toThrow(
			"while WhaleHall is quitting",
		);
		expect(local.startCount).toBe(0);
	});

	test("rejects a startup preparation that completes after shutdown begins", async () => {
		const local = new FakeLocalProcess();
		let releasePreparation!: () => void;
		local.prepareGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const runtime = new AgentRuntime(local, {
			requireStartupGoalPreparation: true,
		});
		const preparing = runtime.prepareStartupGoalChange(null);
		await Promise.resolve();
		runtime.beginShutdown();
		releasePreparation();

		await expect(preparing).rejects.toThrow("while WhaleHall is quitting");
		await expect(runtime.start()).rejects.toThrow(
			"while WhaleHall is quitting",
		);
		expect(local.startCount).toBe(0);
	});

	test("stops a native process whose in-flight startup completes after shutdown", async () => {
		const local = new FakeLocalProcess();
		let releaseStart!: () => void;
		local.startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const runtime = new AgentRuntime(local, {
			requireStartupGoalPreparation: true,
		});
		await runtime.prepareStartupGoalChange(null);
		const starting = runtime.start();
		await Promise.resolve();
		runtime.beginShutdown();
		await runtime.stop();
		expect(local.isRunning).toBe(false);

		releaseStart();
		await starting;
		expect(local.startCount).toBe(1);
		expect(local.stopCount).toBe(2);
		expect(local.isRunning).toBe(false);
		expect(runtime.getLocalStatus().state).toBe("stopped");
	});















});

function desktopEvent(): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: "event-1",
		cursor: "ec1_0000000000000001",
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "input.activityAggregated",
		source: "input.sensor",
		occurredAtMs: 1_000,
		observedAtMs: 1_001,
		goalVersion: null,
		sensitivity: "metadata",
		payload: {
			bucketStartedAtMs: 995,
			bucketEndedAtMs: 1_000,
			keyCount: 3,
			clickCount: 1,
			scrollDelta: 0,
			mouseDistance: 0,
		},
	};
}

function localCalendarEvent(eventId: string): LocalPlanningCalendarEvent {
	return {
		schemaVersion: "calendar.v1",
		eventId,
		title: "外部日程",
		sealedContentRef: null,
		redactedContent: false,
		kind: "external",
		state: "committed",
		schedule: {
			allDay: false,
			start: "2026-08-14T01:00:00Z",
			end: "2026-08-14T02:00:00Z",
			timeZone: "Asia/Shanghai",
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: null,
		sourceTaskId: null,
		scheduleOrigin: null,
		userLocked: false,
		editable: false,
		version: 1,
	};
}
