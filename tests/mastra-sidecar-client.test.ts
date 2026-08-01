import { describe, expect, test } from "bun:test";
import {
	spawn,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
	ContentLengthFrameParser,
	encodeContentLengthFrame,
} from "../src/agent/mastra-host/framing";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type ProtocolMessage,
} from "../src/agent/mastra-host/protocol";
import {
	MastraSidecarClient,
	type MastraSidecarClientOptions,
} from "../src/bun/mastra-sidecar-client";

type FakeBehavior = "hang-initialize" | "reject-initialize" | "succeed";

describe("MastraSidecarClient initialization recovery", () => {
	test("kills a timed-out initializer and permits a clean immediate restart", async () => {
		const harness = createHarness(["hang-initialize", "succeed"]);
		harness.client.trackRun("run-before-initialize");
		const starting = harness.client.start();
		const pendingDuringInitialize = harness.client.request(
			"run.resume",
			{ runId: "pending-run" },
			{ requestId: "pending-during-initialize", timeoutMs: 5_000 },
		);

		const outcomes = await Promise.allSettled([
			starting,
			pendingDuringInitialize,
		]);
		expect(outcomes[0]).toEqual(expect.objectContaining({
			status: "rejected",
			reason: expect.objectContaining({ code: "TIMEOUT" }),
		}));
		expect(outcomes[1]).toEqual(expect.objectContaining({
			status: "rejected",
			reason: expect.objectContaining({ code: "INTERRUPTED" }),
		}));
		expect(harness.children[0]?.killed).toBe(true);
		expect(harness.interruptions).toEqual([["run-before-initialize"]]);

		await expect(harness.client.start()).resolves.toEqual(
			expect.objectContaining({ protocolVersion: AGENT_HOST_PROTOCOL_VERSION }),
		);
		expect(harness.children).toHaveLength(2);

		// A close/error from the terminated child must not tear down its successor.
		harness.children[0]?.emitClose(1, null);
		harness.children[0]?.emitError(new Error("late stale child error"));
		await expect(
			harness.client.request(
				"run.resume",
				{ runId: "new-run" },
				{ requestId: "pending-during-initialize" },
			),
		).resolves.toEqual({ accepted: true });
		await Bun.sleep(1_050);
		expect(harness.children).toHaveLength(2);
		expect(harness.interruptions).toHaveLength(1);
		await harness.client.stop();
	});

	test("tears down a child that rejects initialize instead of leaving ALREADY_RUNNING", async () => {
		const harness = createHarness(["reject-initialize", "succeed"]);

		await expect(harness.client.start()).rejects.toEqual(
			expect.objectContaining({ code: "INTERNAL_ERROR" }),
		);
		expect(harness.children[0]?.killed).toBe(true);
		await expect(harness.client.start()).resolves.toEqual(
			expect.objectContaining({ protocolVersion: AGENT_HOST_PROTOCOL_VERSION }),
		);
		expect(harness.children).toHaveLength(2);
		harness.children[0]?.emitClose(1, null);
		await expect(
			harness.client.request("run.resume", { runId: "after-error" }),
		).resolves.toEqual({ accepted: true });
		await harness.client.stop();
	});

	test("schedules exactly one automatic restart after initialize failure", async () => {
		const harness = createHarness(["reject-initialize", "succeed"]);
		await expect(harness.client.start()).rejects.toEqual(
			expect.objectContaining({ code: "INTERNAL_ERROR" }),
		);

		await waitFor(() => harness.restarts.count === 1);
		expect(harness.children).toHaveLength(2);
		expect(harness.interruptions).toHaveLength(1);
		await Bun.sleep(50);
		expect(harness.restarts.count).toBe(1);
		expect(harness.children).toHaveLength(2);
		await expect(
			harness.client.request("run.resume", { runId: "automatic-restart" }),
		).resolves.toEqual({ accepted: true });
		await harness.client.stop();
	});
});

function createHarness(behaviors: readonly FakeBehavior[]): {
	client: MastraSidecarClient;
	children: FakeSidecarChild[];
	interruptions: string[][];
	restarts: { count: number };
} {
	const children: FakeSidecarChild[] = [];
	const interruptions: string[][] = [];
	const restarts = { count: 0 };
	const spawnProcess = ((() => {
		const child = new FakeSidecarChild(
			behaviors[children.length] ?? "succeed",
		);
		children.push(child);
		return child as unknown as ChildProcessWithoutNullStreams;
	}) as unknown) as typeof spawn;
	const options: MastraSidecarClientOptions = {
		nodePath: "unused-node",
		entryPath: "unused-entry",
		initializeTimeoutMs: 20,
		initialize: {
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			client: { name: "sidecar-client-test", version: "1" },
			model: { provider: "test", modelId: "test-model" },
		},
		onHostCall: async () => ({}),
		onRunEvent: () => {},
		onInterrupted: (runIds) => interruptions.push([...runIds]),
		onRestarted: () => {
			restarts.count += 1;
		},
		spawnProcess,
	};
	return {
		client: new MastraSidecarClient(options),
		children,
		interruptions,
		restarts,
	};
}

class FakeSidecarChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	private readonly parser = new ContentLengthFrameParser();

	constructor(private readonly behavior: FakeBehavior) {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			for (const message of this.parser.push(chunk)) this.accept(message);
		});
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}

	emitClose(code: number | null, signal: NodeJS.Signals | null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("close", code, signal);
	}

	emitError(error: Error): void {
		this.emit("error", error);
	}

	private accept(value: unknown): void {
		if (!isRecord(value) || value.type !== "request" || typeof value.requestId !== "string") {
			return;
		}
		if (this.behavior === "hang-initialize") return;
		if (value.method === "runtime.initialize") {
			if (this.behavior === "reject-initialize") {
				this.respond({
					protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
					type: "response",
					requestId: value.requestId,
					ok: false,
					error: {
						code: "INTERNAL_ERROR",
						message: "synthetic initialize failure",
						retryable: true,
					},
				});
				return;
			}
			this.respond({
				protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
				type: "response",
				requestId: value.requestId,
				ok: true,
				result: {
					service: "whalehall-agent-host",
					protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
					initializedAtMs: 1,
					capabilities: {
						methods: ["runtime.initialize", "runtime.shutdown", "run.resume"],
						hostCalls: [],
						streaming: true,
						structuredPlanning: true,
						listensOnNetwork: false,
					},
				},
			});
			return;
		}

		this.respond({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "response",
			requestId: value.requestId,
			ok: true,
			result: value.method === "runtime.shutdown" ? {} : { accepted: true },
		});
		if (value.method === "runtime.shutdown") {
			queueMicrotask(() => this.emitClose(0, null));
		}
	}

	private respond(message: ProtocolMessage): void {
		this.stdout.write(encodeContentLengthFrame(message));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Sidecar restart.");
		await Bun.sleep(10);
	}
}
