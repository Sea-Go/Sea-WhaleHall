import type { RuntimeStatus } from "../../shared/contracts";
import {
	MAX_ECHO_CHARACTERS,
	type EchoResult,
	type HealthResult,
} from "../../shared/protocol";
import type { AgentBridge, RustBridgeError } from "./rust-bridge";

export class AgentService {
	private status: RuntimeStatus = {
		state: "stopped",
		pid: null,
		lastError: null,
	};
	private readonly listeners = new Set<(status: RuntimeStatus) => void>();
	private startPromise: Promise<void> | null = null;

	constructor(private readonly bridge: AgentBridge) {
		bridge.onFailure((error) => this.handleBridgeFailure(error));
	}

	getStatus(): RuntimeStatus {
		return { ...this.status, pid: this.bridge.pid };
	}

	onStatusChange(listener: (status: RuntimeStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.bridge.isRunning) {
			this.setStatus("ready", null);
			return;
		}
		if (this.startPromise) return this.startPromise;

		this.setStatus("starting", null);
		this.startPromise = this.bridge
			.start()
			.then(() => this.setStatus("ready", null))
			.catch((error: unknown) => {
				this.setStatus("degraded", error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				this.startPromise = null;
			});
		return this.startPromise;
	}

	async healthCheck(): Promise<HealthResult> {
		return this.execute<HealthResult>("health.check", {});
	}

	async echo(message: string): Promise<EchoResult> {
		if (message.length > MAX_ECHO_CHARACTERS) {
			throw new Error(`Echo message must not exceed ${MAX_ECHO_CHARACTERS} characters.`);
		}
		return this.execute<EchoResult>("echo", { message });
	}

	stop(): void {
		this.bridge.stop();
		this.setStatus("stopped", null);
	}

	private async execute<T>(
		method: "health.check" | "echo",
		params: Record<string, unknown>,
	): Promise<T> {
		if (!this.bridge.isRunning) await this.start();
		if (!this.bridge.isRunning) {
			throw new Error(this.status.lastError ?? "Rust agent service is unavailable.");
		}

		try {
			const result = await this.bridge.request<T>(method, params);
			this.setStatus("ready", null);
			return result;
		} catch (error) {
			this.setStatus("degraded", error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	private handleBridgeFailure(error: RustBridgeError): void {
		if (this.status.state !== "stopped") this.setStatus("degraded", error.message);
	}

	private setStatus(state: RuntimeStatus["state"], lastError: string | null): void {
		const next = { state, pid: this.bridge.pid, lastError } satisfies RuntimeStatus;
		if (
			this.status.state === next.state &&
			this.status.pid === next.pid &&
			this.status.lastError === next.lastError
		) {
			return;
		}
		this.status = next;
		for (const listener of this.listeners) listener({ ...next });
	}
}
