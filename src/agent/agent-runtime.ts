import type {
	LocalClientError,
	LocalToolProcess,
} from "./local-tool-client";
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
	LocalVaultOpenBatch,
	LocalVaultOpenBatchResult,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
	LocalVaultSealBatch,
	LocalVaultSealBatchResult,
} from "./local-protocol";
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
	private readonly statusListeners = new Set<(status: LocalRuntimeStatus) => void>();
	private readonly eventListeners = new Set<(event: LocalToolEvent) => void>();
	private readonly desktopEventListeners = new Set<(event: DesktopEventV1) => void>();
	private readonly semanticEventListeners = new Set<
		(event: SemanticEventV2) => void
	>();
	private startPromise: Promise<void> | null = null;
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
		return { ...this.status, pid: this.local.pid, activeCalls: this.activeCalls.size };
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
		if (this.startPromise || this.local.isRunning) {
			throw new Error(
				"whalehall-local already started before its startup goal boundary was prepared.",
			);
		}
		await this.local.prepareStartupGoalChange(change);
		this.goalReconciliationIntent = structuredClone(change);
		this.hasGoalReconciliationIntent = true;
		this.startupGoalPrepared = true;
		this.automaticRestartPrepared = false;
	}

	async acknowledgeStartupGoalChange(): Promise<void> {
		await this.local.acknowledgeStartupGoalChange();
		this.automaticRestartPrepared = true;
	}

	async start(): Promise<void> {
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
		this.startPromise = this.local
			.start()
			.then(() => this.local.health())
			.then(() => this.setStatus("ready", null))
			.catch((error: unknown) => this.setStatus("degraded", errorMessage(error)))
			.finally(() => {
				this.startPromise = null;
			});
		return this.startPromise;
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

	async queryDesktopEvents(query: LocalEventQuery): Promise<LocalEventQueryResult> {
		await this.ensureStarted();
		return this.local.queryEvents(query);
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

	async getVaultKeyStatus(): Promise<LocalVaultKeyStatus> {
		await this.ensureStarted();
		return this.local.getVaultKeyStatus();
	}

	async migrateLegacyVaultKey(): Promise<LocalVaultLegacyMigrationResult> {
		await this.ensureStarted();
		return this.local.migrateLegacyVaultKey();
	}

	async stop(): Promise<void> {
		this.startupGoalPrepared = false;
		this.automaticRestartPrepared = false;
		this.activeCalls.clear();
		await this.local.stop();
		this.setStatus("stopped", null);
	}

	private async ensureStarted(): Promise<void> {
		let preparedAutomaticRestart = false;
		if (
			!this.local.isRunning &&
			this.options.requireStartupGoalPreparation &&
			!this.startupGoalPrepared &&
			this.automaticRestartPrepared &&
			this.hasGoalReconciliationIntent
		) {
			await this.local.prepareStartupGoalChange(
				this.goalReconciliationIntent,
			);
			this.startupGoalPrepared = true;
			preparedAutomaticRestart = true;
		}
		if (!this.local.isRunning) await this.start();
		if (!this.local.isRunning) {
			throw new Error(this.status.lastError ?? "whalehall-local is unavailable.");
		}
		if (preparedAutomaticRestart) {
			await this.local.acknowledgeStartupGoalChange();
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
		if (
			this.options.requireStartupGoalPreparation &&
			!this.local.isRunning
		) {
			this.startupGoalPrepared = false;
		}
		if (this.status.state !== "stopped") this.setStatus("degraded", error.message);
	}

	private setStatus(state: LocalRuntimeStatus["state"], lastError: string | null): void {
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
