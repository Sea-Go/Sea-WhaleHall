import type {
	LocalClientError,
	LocalToolProcess,
} from "./local-tool-client";
import type {
	LocalRuntimeStatus,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
} from "./local-protocol";

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
	private startPromise: Promise<void> | null = null;

	constructor(private readonly local: LocalToolProcess) {
		local.onEvent((event) => this.handleEvent(event));
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

	async start(): Promise<void> {
		if (this.local.isRunning) {
			this.setStatus("ready", null);
			return;
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

	stop(): void {
		this.activeCalls.clear();
		this.local.stop();
		this.setStatus("stopped", null);
	}

	private async ensureStarted(): Promise<void> {
		if (!this.local.isRunning) await this.start();
		if (!this.local.isRunning) {
			throw new Error(this.status.lastError ?? "whalehall-local is unavailable.");
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

	private handleFailure(error: LocalClientError): void {
		this.activeCalls.clear();
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
