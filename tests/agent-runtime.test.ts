import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import {
	LocalClientError,
	type LocalToolProcess,
} from "../src/agent/local-tool-client";
import type {
	LocalRuntimeHealth,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
} from "../src/agent/local-protocol";

class FakeLocalProcess implements LocalToolProcess {
	pid: number | null = null;
	isRunning = false;
	startError: Error | null = null;
	startCount = 0;
	private readonly eventListeners = new Set<(event: LocalToolEvent) => void>();
	private readonly failureListeners = new Set<(error: LocalClientError) => void>();

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

	stop(): void {
		this.pid = null;
		this.isRunning = false;
	}

	onEvent(listener: (event: LocalToolEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onFailure(listener: (error: LocalClientError) => void): () => void {
		this.failureListeners.add(listener);
		return () => this.failureListeners.delete(listener);
	}

	emit(event: LocalToolEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}

	fail(error: LocalClientError): void {
		this.isRunning = false;
		this.pid = null;
		for (const listener of this.failureListeners) listener(error);
	}
}

describe("AgentRuntime", () => {
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
});
