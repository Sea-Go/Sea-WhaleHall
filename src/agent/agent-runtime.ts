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
	LocalPlanningCalendarList,
	LocalPlanningCalendarListResult,
	LocalPlanningCalendarMutate,
	LocalPlanningCalendarMutationResult,
	LocalPlanningList,
	LocalPlanningListResult,
	LocalPlanningMutationParams,
	LocalPlanningMutationResult,
	LocalPlanningOutboxAck,
	LocalPlanningOutboxAckResult,
	LocalPlanningOutboxList,
	LocalPlanningOutboxListResult,
	LocalPlanningPlanSnapshot,
	LocalPlanningVaultReferences,
	LocalPlanningVaultReferencesResult,
	LocalRuntimeStatus,
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
	LocalVaultListRecords,
	LocalVaultListRecordsResult,
	LocalVaultOpenBatch,
	LocalVaultOpenBatchResult,
	LocalVaultSealBatch,
	LocalVaultSealBatchResult,
} from "./local-protocol";
import type { LocalClientError, LocalToolProcess } from "./local-tool-client";
import type { DesktopEventV1 } from "./reflection/types";
import type { SemanticEventV2 } from "./timeline-v2/types";

export type AgentRuntimeOptions = {
	/**
	 * Holds every lazy/native start until the reflection service has prepared
	 * the authoritative startup goal handoff.
	 */
	requireStartupGoalPreparation?: boolean;
};

export class AgentRuntime {
	private status: LocalRuntimeStatus = {
		state: "stopped",
		pid: null,
		activeCalls: 0,
		lastError: null,
	};
	private readonly activeCalls = new Set<string>();
	private readonly statusListeners = new Set<
		(status: LocalRuntimeStatus) => void
	>();
	private readonly eventListeners = new Set<(event: LocalToolEvent) => void>();
	private readonly desktopEventListeners = new Set<
		(event: DesktopEventV1) => void
	>();
	private readonly semanticEventListeners = new Set<
		(event: SemanticEventV2) => void
	>();
	private startPromise: Promise<void> | null = null;
	private shutdownRequested = false;
	private startupGoalPrepared = false;
	private automaticRestartPrepared = false;
	private hasGoalReconciliationIntent = false;
	private goalReconciliationIntent: LocalEventGoalChange | null = null;

	constructor(
		private readonly local: LocalToolProcess,
		private readonly options: AgentRuntimeOptions = {},
	) {
		local.onEvent((event) => this.handleEvent(event));
		local.onDesktopEvent((event) => this.handleDesktopEvent(event));
		local.onSemanticEvent((event) => this.handleSemanticEvent(event));
		local.onFailure((error) => this.handleFailure(error));
	}

	getLocalStatus(): LocalRuntimeStatus {
		return {
			...this.status,
			pid: this.local.pid,
			activeCalls: this.activeCalls.size,
		};
	}

	onStatusChange(listener: (status: LocalRuntimeStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	onToolEvent(listener: (event: LocalToolEvent) => void): () => void {
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

	async prepareStartupGoalChange(
		change: LocalEventGoalChange | null,
	): Promise<void> {
		this.assertStartupAllowed();
		if (this.startPromise || this.local.isRunning) {
			throw new Error(
				"whalehall-local already started before its startup goal boundary was prepared.",
			);
		}
		await this.local.prepareStartupGoalChange(change);
		this.assertStartupAllowed();
		this.goalReconciliationIntent = structuredClone(change);
		this.hasGoalReconciliationIntent = true;
		this.startupGoalPrepared = true;
		this.automaticRestartPrepared = false;
	}

	async acknowledgeStartupGoalChange(): Promise<void> {
		this.assertStartupAllowed();
		await this.local.acknowledgeStartupGoalChange();
		this.assertStartupAllowed();
		this.automaticRestartPrepared = true;
	}

	async start(): Promise<void> {
		this.assertStartupAllowed();
		if (this.local.isRunning) {
			this.setStatus("ready", null);
			return;
		}
		if (
			this.options.requireStartupGoalPreparation &&
			!this.startupGoalPrepared
		) {
			throw new Error(
				"whalehall-local startup is gated until its goal boundary is prepared.",
			);
		}
		if (this.startPromise) return this.startPromise;
		this.setStatus("starting", null);
		const operation = this.startLocalProcess();
		this.startPromise = operation;
		void operation.then(
			() => {
				if (this.startPromise === operation) this.startPromise = null;
			},
			() => {
				if (this.startPromise === operation) this.startPromise = null;
			},
		);
		return operation;
	}

	/** Permanently prevents this application instance from spawning native work. */
	beginShutdown(): void {
		this.shutdownRequested = true;
		this.startupGoalPrepared = false;
		this.automaticRestartPrepared = false;
	}

	async listLocalTools(): Promise<LocalToolDescriptor[]> {
		await this.ensureStarted();
		const tools = await this.local.listTools();
		this.setStatus("ready", null);
		return tools;
	}

	async callLocalTool(call: LocalToolCall): Promise<LocalToolCallResult> {
		await this.ensureStarted();
		return this.local.callTool(call);
	}

	async cancelLocalTool(callId: string): Promise<LocalToolCancelResult> {
		await this.ensureStarted();
		return this.local.cancelTool(callId);
	}

	async queryDesktopEvents(
		query: LocalEventQuery,
	): Promise<LocalEventQueryResult> {
		await this.ensureStarted();
		return this.local.queryEvents(query);
	}

	async getDesktopEventTailCursor(): Promise<LocalEventTailCursorResult> {
		await this.ensureStarted();
		return this.local.getEventTailCursor();
	}

	async commitDesktopEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult> {
		await this.ensureStarted();
		return this.local.commitEventCursor(consumerId, cursor);
	}

	async appendDesktopGoalChange(
		change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult> {
		// The user's requested target is authoritative even if the native
		// process commits it and the response is then lost. Record it before
		// either restart or RPC so ambiguous failure cannot reconcile back to
		// the previous goal.
		this.goalReconciliationIntent = structuredClone(change);
		this.hasGoalReconciliationIntent = true;
		await this.ensureStarted();
		return this.local.appendGoalChange(change);
	}

	async getMonitoringStatus(): Promise<LocalMonitoringStatus> {
		await this.ensureStarted();
		return this.local.getMonitoringStatus();
	}

	async configureMonitoring(
		configuration: LocalMonitoringConfigure,
	): Promise<LocalMonitoringStatus> {
		await this.ensureStarted();
		return this.local.configureMonitoring(configuration);
	}

	async pauseMonitoring(): Promise<LocalMonitoringStatus> {
		await this.ensureStarted();
		return this.local.pauseMonitoring();
	}

	async resumeMonitoring(): Promise<LocalMonitoringStatus> {
		await this.ensureStarted();
		return this.local.resumeMonitoring();
	}

	async refreshMonitoringPermissions(): Promise<LocalMonitoringStatus> {
		await this.ensureStarted();
		return this.local.refreshMonitoringPermissions();
	}

	async setupMonitoringPermissions(): Promise<LocalMonitoringStatus> {
		await this.ensureStarted();
		return this.local.setupMonitoringPermissions();
	}

	async querySemanticEvents(
		query: LocalSemanticQuery,
	): Promise<LocalSemanticQueryResult> {
		await this.ensureStarted();
		return this.local.querySemanticEvents(query);
	}

	async commitSemanticEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalSemanticCommitResult> {
		await this.ensureStarted();
		return this.local.commitSemanticCursor(consumerId, cursor);
	}

	async queryAuditFiveMinutes(
		query: LocalAuditFiveMinutesQuery,
	): Promise<LocalAuditFiveMinutesResult> {
		await this.ensureStarted();
		return this.local.queryAuditFiveMinutes(query);
	}

	async sealVaultBatch(
		batch: LocalVaultSealBatch,
	): Promise<LocalVaultSealBatchResult> {
		await this.ensureStarted();
		return this.local.sealVaultBatch(batch);
	}

	async openVaultBatch(
		batch: LocalVaultOpenBatch,
	): Promise<LocalVaultOpenBatchResult> {
		await this.ensureStarted();
		return this.local.openVaultBatch(batch);
	}

	async deleteVaultBatch(
		batch: LocalVaultDeleteBatch,
	): Promise<LocalVaultDeleteBatchResult> {
		await this.ensureStarted();
		return this.local.deleteVaultBatch(batch);
	}

	async listVaultRecords(
		query: LocalVaultListRecords,
	): Promise<LocalVaultListRecordsResult> {
		await this.ensureStarted();
		const method = this.local.listVaultRecords;
		if (!method) throw new Error("Native Vault inventory is unavailable.");
		return method.call(this.local, query);
	}

	async getVaultKeyStatus(): Promise<LocalVaultKeyStatus> {
		await this.ensureStarted();
		return this.local.getVaultKeyStatus();
	}

	async migrateLegacyVaultKey(): Promise<LocalVaultLegacyMigrationResult> {
		await this.ensureStarted();
		return this.local.migrateLegacyVaultKey();
	}

	async listPlanningPlans(
		query: LocalPlanningList = {},
	): Promise<LocalPlanningListResult> {
		await this.ensureStarted();
		const method = this.local.listPlanningPlans;
		if (!method) throw new Error("Native planning store is unavailable.");
		return method.call(this.local, query);
	}

	async getPlanningPlan(
		planId: string,
	): Promise<LocalPlanningPlanSnapshot | null> {
		await this.ensureStarted();
		const method = this.local.getPlanningPlan;
		if (!method) throw new Error("Native planning store is unavailable.");
		return method.call(this.local, planId);
	}

	async getPlanningOperationResult(
		operationId: string,
	): Promise<LocalPlanningPlanSnapshot | null> {
		await this.ensureStarted();
		const method = this.local.getPlanningOperationResult;
		if (!method) throw new Error("Native planning store is unavailable.");
		return method.call(this.local, operationId);
	}

	async upsertPlanningPlan(
		mutation: LocalPlanningMutationParams,
	): Promise<LocalPlanningMutationResult> {
		await this.ensureStarted();
		const method = this.local.upsertPlanningPlan;
		if (!method) throw new Error("Native planning store is unavailable.");
		return method.call(this.local, mutation);
	}

	async mutatePlanningPlan(
		mutation: LocalPlanningMutationParams & { expectedVersion: number },
	): Promise<LocalPlanningMutationResult> {
		await this.ensureStarted();
		const method = this.local.mutatePlanningPlan;
		if (!method) throw new Error("Native planning store is unavailable.");
		return method.call(this.local, mutation);
	}

	async listPlanningVaultReferences(
		query: LocalPlanningVaultReferences = {},
	): Promise<LocalPlanningVaultReferencesResult> {
		await this.ensureStarted();
		const method = this.local.listPlanningVaultReferences;
		if (!method)
			throw new Error("Native planning Vault inventory is unavailable.");
		return method.call(this.local, query);
	}

	async listPlanningCalendar(
		query: LocalPlanningCalendarList = {},
	): Promise<LocalPlanningCalendarListResult> {
		await this.ensureStarted();
		const method = this.local.listPlanningCalendar;
		if (!method) throw new Error("Native planning calendar is unavailable.");
		return method.call(this.local, query);
	}

	async mutatePlanningCalendar(
		mutation: LocalPlanningCalendarMutate,
	): Promise<LocalPlanningCalendarMutationResult> {
		await this.ensureStarted();
		const method = this.local.mutatePlanningCalendar;
		if (!method) throw new Error("Native planning calendar is unavailable.");
		return method.call(this.local, mutation);
	}

	async listPlanningOutbox(
		query: LocalPlanningOutboxList = {},
	): Promise<LocalPlanningOutboxListResult> {
		await this.ensureStarted();
		const method = this.local.listPlanningOutbox;
		if (!method) throw new Error("Native planning outbox is unavailable.");
		return method.call(this.local, query);
	}

	async ackPlanningOutbox(
		acknowledgement: LocalPlanningOutboxAck,
	): Promise<LocalPlanningOutboxAckResult> {
		await this.ensureStarted();
		const method = this.local.ackPlanningOutbox;
		if (!method) throw new Error("Native planning outbox is unavailable.");
		return method.call(this.local, acknowledgement);
	}

	async stop(): Promise<void> {
		this.startupGoalPrepared = false;
		this.automaticRestartPrepared = false;
		this.activeCalls.clear();
		await this.local.stop();
		this.setStatus("stopped", null);
	}

	private async ensureStarted(): Promise<void> {
		this.assertStartupAllowed();
		let preparedAutomaticRestart = false;
		if (
			!this.local.isRunning &&
			this.options.requireStartupGoalPreparation &&
			!this.startupGoalPrepared &&
			this.automaticRestartPrepared &&
			this.hasGoalReconciliationIntent
		) {
			await this.local.prepareStartupGoalChange(this.goalReconciliationIntent);
			this.assertStartupAllowed();
			this.startupGoalPrepared = true;
			preparedAutomaticRestart = true;
		}
		if (!this.local.isRunning) await this.start();
		this.assertStartupAllowed();
		if (!this.local.isRunning) {
			throw new Error(
				this.status.lastError ?? "whalehall-local is unavailable.",
			);
		}
		if (preparedAutomaticRestart) {
			await this.local.acknowledgeStartupGoalChange();
			this.assertStartupAllowed();
		}
	}

	private async startLocalProcess(): Promise<void> {
		try {
			await this.local.start();
			if (this.shutdownRequested) {
				await this.local.stop();
				this.setStatus("stopped", null);
				return;
			}
			await this.local.health();
			if (this.shutdownRequested) {
				await this.local.stop();
				this.setStatus("stopped", null);
				return;
			}
			this.setStatus("ready", null);
		} catch (error) {
			if (this.shutdownRequested) {
				if (this.local.isRunning) await this.local.stop();
				this.setStatus("stopped", null);
				return;
			}
			this.setStatus("degraded", errorMessage(error));
		}
	}

	private assertStartupAllowed(): void {
		if (this.shutdownRequested) {
			throw new Error(
				"whalehall-local cannot start while WhaleHall is quitting.",
			);
		}
	}

	private handleEvent(event: LocalToolEvent): void {
		if (event.event === "tool.started") this.activeCalls.add(event.callId);
		if (
			event.event === "tool.completed" ||
			event.event === "tool.failed" ||
			event.event === "tool.cancelled"
		) {
			this.activeCalls.delete(event.callId);
		}
		for (const listener of this.eventListeners) listener(event);
		this.setStatus("ready", null);
	}

	private handleDesktopEvent(event: DesktopEventV1): void {
		for (const listener of this.desktopEventListeners) listener(event);
		this.setStatus("ready", null);
	}

	private handleSemanticEvent(event: SemanticEventV2): void {
		for (const listener of this.semanticEventListeners) listener(event);
		this.setStatus("ready", null);
	}

	private handleFailure(error: LocalClientError): void {
		this.activeCalls.clear();
		// A failed native owner may remain privately retained while its exact
		// process tree is being reaped. That ownership is not proof that the
		// process is usable, and a replacement must always replay the authoritative
		// startup goal boundary before it can collect new events.
		if (this.options.requireStartupGoalPreparation) {
			this.startupGoalPrepared = false;
		}
		if (this.status.state !== "stopped")
			this.setStatus("degraded", error.message);
	}

	private setStatus(
		state: LocalRuntimeStatus["state"],
		lastError: string | null,
	): void {
		const next: LocalRuntimeStatus = {
			state,
			pid: this.local.pid,
			activeCalls: this.activeCalls.size,
			lastError,
		};
		if (
			this.status.state === next.state &&
			this.status.pid === next.pid &&
			this.status.activeCalls === next.activeCalls &&
			this.status.lastError === next.lastError
		) {
			return;
		}
		this.status = next;
		for (const listener of this.statusListeners) listener({ ...next });
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
