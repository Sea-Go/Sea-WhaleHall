import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import {
	LocalClientError,
	type LocalToolProcess,
} from "../src/agent/local-tool-client";
import type {
	LocalAuditFiveMinutesQuery,
	LocalAuditFiveMinutesResult,
	LocalEventCommitResult,
	LocalEventGoalChange,
	LocalEventGoalChangeResult,
	LocalEventQuery,
	LocalEventQueryResult,
	LocalMonitoringConfigure,
	LocalMonitoringStatus,
	LocalRuntimeHealth,
	LocalSemanticCommitResult,
	LocalSemanticQuery,
	LocalSemanticQueryResult,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
	LocalVaultOpenBatch,
	LocalVaultOpenBatchResult,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
	LocalVaultSealBatch,
	LocalVaultSealBatchResult,
} from "../src/agent/local-protocol";
import type { DesktopEventV1 } from "../src/agent/reflection/types";
import type { SemanticEventV2 } from "../src/agent/timeline-v2/types";

class FakeLocalProcess implements LocalToolProcess {
	pid: number | null = null;
	isRunning = false;
	startError: Error | null = null;
	appendGoalError: Error | null = null;
	startCount = 0;
	readonly preparedStartupGoalChanges: Array<LocalEventGoalChange | null> = [];
	readonly appendedGoalChanges: LocalEventGoalChange[] = [];
	startupGoalAcknowledgements = 0;
	private readonly eventListeners = new Set<(event: LocalToolEvent) => void>();
	private readonly desktopEventListeners = new Set<(event: DesktopEventV1) => void>();
	private readonly semanticEventListeners = new Set<
		(event: SemanticEventV2) => void
	>();
	private readonly failureListeners = new Set<(error: LocalClientError) => void>();

	async prepareStartupGoalChange(
		change: LocalEventGoalChange | null,
	): Promise<void> {
		if (this.isRunning) throw new Error("already running");
		this.preparedStartupGoalChanges.push(structuredClone(change));
	}

	async acknowledgeStartupGoalChange(): Promise<void> {
		this.startupGoalAcknowledgements += 1;
	}

	async start(): Promise<void> {
		this.startCount += 1;
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
		this.emit({ event: "tool.started", callId: call.callId, data: { name: call.name } });
		this.emit({ event: "tool.completed", callId: call.callId, data: { name: call.name } });
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

	async stop(): Promise<void> {
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
	test("production startup gate rejects lazy RPC starts until goal preparation", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local, {
			requireStartupGoalPreparation: true,
		});

		await expect(runtime.listLocalTools()).rejects.toThrow(
			"gated until its goal boundary is prepared",
		);
		expect(local.startCount).toBe(0);
		await runtime.prepareStartupGoalChange(null);
		await expect(runtime.listLocalTools()).resolves.toHaveLength(1);
		expect(local.startCount).toBe(1);
		await runtime.stop();
		await expect(runtime.listLocalTools()).rejects.toThrow(
			"gated until its goal boundary is prepared",
		);
		expect(local.startCount).toBe(1);
	});

	test("production startup gate relocks after an unexpected native exit", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local, {
			requireStartupGoalPreparation: true,
		});
		await runtime.prepareStartupGoalChange(null);
		await runtime.start();
		local.fail(new LocalClientError("PROCESS_EXITED", "native exited"));

		await expect(
			runtime.callLocalTool({
				callId: "early-retry",
				name: "system.info",
				arguments: {},
			}),
		).rejects.toThrow("gated until its goal boundary is prepared");
		expect(local.startCount).toBe(1);
	});

	test("an acknowledged runtime re-prepares its goal intent before automatic restart", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local, {
			requireStartupGoalPreparation: true,
		});
		const change: LocalEventGoalChange = {
			previous: null,
			next: {
				goalId: "goal-1",
				planId: null,
				version: 1,
				text: "Keep restart ordered",
				activatedAtMs: 1_000,
			},
			occurredAtMs: 1_000,
			deduplicationKey: "restart-intent",
		};
		await runtime.prepareStartupGoalChange(change);
		await runtime.start();
		await runtime.acknowledgeStartupGoalChange();
		local.fail(new LocalClientError("PROCESS_EXITED", "native exited"));

		await expect(runtime.listLocalTools()).resolves.toHaveLength(1);
		expect(local.startCount).toBe(2);
		expect(local.preparedStartupGoalChanges).toEqual([change, change]);
	});

	test("a lost goal response cannot make automatic restart roll back the requested target", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local, {
			requireStartupGoalPreparation: true,
		});
		await runtime.prepareStartupGoalChange(null);
		await runtime.start();
		await runtime.acknowledgeStartupGoalChange();
		const requested: LocalEventGoalChange = {
			previous: null,
			next: {
				goalId: "goal-b",
				planId: "plan-b",
				version: 1,
				text: "Newest user target",
				activatedAtMs: 2_000,
			},
			occurredAtMs: 2_000,
			deduplicationKey: "goal-b-request",
		};
		local.appendGoalError = new Error("response lost after durable append");
		await expect(runtime.appendDesktopGoalChange(requested)).rejects.toThrow(
			"response lost",
		);
		local.appendGoalError = null;
		local.fail(new LocalClientError("PROCESS_EXITED", "native exited"));

		await expect(runtime.listLocalTools()).resolves.toHaveLength(1);
		expect(local.preparedStartupGoalChanges.at(-1)).toEqual(requested);
	});

	test("prepares the startup goal boundary before starting the native process", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local);
		const change: LocalEventGoalChange = {
			previous: null,
			next: {
				goalId: "goal-1",
				planId: null,
				version: 1,
				text: "Ship startup ordering",
				activatedAtMs: 1_000,
			},
			occurredAtMs: 1_000,
			deduplicationKey: "startup-goal-1",
		};

		await runtime.prepareStartupGoalChange(change);
		expect(local.preparedStartupGoalChanges).toEqual([change]);
		await runtime.start();
		await expect(runtime.prepareStartupGoalChange(null)).rejects.toThrow(
			"already started",
		);
	});

	test("moves from stopped through starting to ready", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local);
		const states: string[] = [];
		runtime.onStatusChange((status) => states.push(status.state));
		await runtime.start();
		expect(runtime.getLocalStatus()).toEqual({
			state: "ready",
			pid: 7001,
			activeCalls: 0,
			lastError: null,
		});
		expect(states).toEqual(["starting", "ready"]);
	});

	test("keeps the desktop alive in degraded mode when spawn fails", async () => {
		const local = new FakeLocalProcess();
		local.startError = new Error("missing binary");
		const runtime = new AgentRuntime(local);
		await runtime.start();
		expect(runtime.getLocalStatus()).toMatchObject({
			state: "degraded",
			lastError: "missing binary",
		});
	});

	test("lazily starts Local Tools on the next explicit request", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local);
		await expect(runtime.listLocalTools()).resolves.toHaveLength(1);
		expect(local.startCount).toBe(1);
		expect(runtime.getLocalStatus().state).toBe("ready");
	});

	test("tracks active tool events without moving tool logic into TypeScript", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local);
		await runtime.start();
		local.emit({ event: "tool.started", callId: "call-1", data: { name: "demo.wait" } });
		expect(runtime.getLocalStatus().activeCalls).toBe(1);
		local.emit({ event: "tool.cancelled", callId: "call-1", data: { name: "demo.wait" } });
		expect(runtime.getLocalStatus().activeCalls).toBe(0);
	});

	test("records unexpected Local Tool Host failure", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local);
		await runtime.start();
		local.fail(new LocalClientError("PROCESS_EXITED", "local process exited"));
		expect(runtime.getLocalStatus()).toEqual({
			state: "degraded",
			pid: null,
			activeCalls: 0,
			lastError: "local process exited",
		});
	});

	test("forwards proactive desktop events independently from tool lifecycle events", async () => {
		const local = new FakeLocalProcess();
		const runtime = new AgentRuntime(local);
		const received: DesktopEventV1[] = [];
		runtime.onDesktopEvent((event) => received.push(event));
		await runtime.start();
		local.emitDesktop(desktopEvent());
		expect(received.map((event) => event.kind)).toEqual([
			"input.activityAggregated",
		]);
		expect(runtime.getLocalStatus().activeCalls).toBe(0);
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
