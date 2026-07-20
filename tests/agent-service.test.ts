import { describe, expect, test } from "bun:test";
import { AgentService } from "../src/bun/agent/agent-service";
import {
	RustBridgeError,
	type AgentBridge,
} from "../src/bun/agent/rust-bridge";
import type { RustMethod } from "../src/shared/protocol";

class FakeBridge implements AgentBridge {
	pid: number | null = null;
	isRunning = false;
	startError: Error | null = null;
	startCount = 0;
	private readonly listeners = new Set<(error: RustBridgeError) => void>();

	async start(): Promise<void> {
		this.startCount += 1;
		if (this.startError) throw this.startError;
		this.pid = 7001;
		this.isRunning = true;
	}

	async request<T>(method: RustMethod, params: Record<string, unknown>): Promise<T> {
		if (method === "health.check") {
			return {
				service: "whalehall-core",
				version: "0.1.0",
				pid: this.pid,
				status: "ok",
			} as T;
		}
		return { message: params.message, handledBy: "whalehall-core", pid: this.pid } as T;
	}

	stop(): void {
		this.pid = null;
		this.isRunning = false;
	}

	onFailure(listener: (error: RustBridgeError) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	fail(error: RustBridgeError): void {
		this.isRunning = false;
		this.pid = null;
		for (const listener of this.listeners) listener(error);
	}
}

describe("AgentService", () => {
	test("moves from stopped through starting to ready", async () => {
		const bridge = new FakeBridge();
		const service = new AgentService(bridge);
		const states: string[] = [];
		service.onStatusChange((status) => states.push(status.state));
		await service.start();
		expect(service.getStatus()).toEqual({ state: "ready", pid: 7001, lastError: null });
		expect(states).toEqual(["starting", "ready"]);
	});

	test("keeps the app degraded when spawn fails", async () => {
		const bridge = new FakeBridge();
		bridge.startError = new Error("missing binary");
		const service = new AgentService(bridge);
		await service.start();
		expect(service.getStatus()).toMatchObject({
			state: "degraded",
			lastError: "missing binary",
		});
	});

	test("lazily starts the child on the next explicit request", async () => {
		const bridge = new FakeBridge();
		const service = new AgentService(bridge);
		await expect(service.healthCheck()).resolves.toMatchObject({ status: "ok" });
		expect(bridge.startCount).toBe(1);
		expect(service.getStatus().state).toBe("ready");
	});

	test("records unexpected child failure", async () => {
		const bridge = new FakeBridge();
		const service = new AgentService(bridge);
		await service.start();
		bridge.fail(new RustBridgeError("PROCESS_EXITED", "native child exited"));
		expect(service.getStatus()).toEqual({
			state: "degraded",
			pid: null,
			lastError: "native child exited",
		});
	});
});
