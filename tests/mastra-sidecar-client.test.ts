import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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

type FakeBehavior =
	| "hang-initialize"
	| "hang-request"
	| "ignore-shutdown"
	| "ordered-hang-request"
	| "reject-initialize"
	| "succeed";

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
		expect(outcomes[0]).toEqual(
			expect.objectContaining({
				status: "rejected",
				reason: expect.objectContaining({ code: "TIMEOUT" }),
			}),
		);
		expect(outcomes[1]).toEqual(
			expect.objectContaining({
				status: "rejected",
				reason: expect.objectContaining({ code: "INTERRUPTED" }),
			}),
		);
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
		// The terminated initializer remains process-owned until Node confirms
		// close, even though its successor is already the active transport.
		harness.children[0]?.emitClose(1, null);
		await expect(
			harness.client.request("run.resume", { runId: "automatic-restart" }),
		).resolves.toEqual({ accepted: true });
		await harness.client.stop();
	});

	test("rejects an in-flight request on abort and releases its request ID", async () => {
		const harness = createHarness(["hang-request"]);
		await harness.client.start();
		const controller = new AbortController();
		const pending = harness.client.request(
			"run.resume",
			{ runId: "abortable-run" },
			{
				requestId: "abortable-request",
				timeoutMs: 5_000,
				signal: controller.signal,
			},
		);
		controller.abort();
		await expect(pending).rejects.toEqual(
			expect.objectContaining({ code: "CANCELLED", retryable: true }),
		);
		await expect(
			harness.client.request(
				"run.resume",
				{ runId: "retry-run" },
				{ requestId: "abortable-request" },
			),
		).resolves.toEqual({ accepted: true });
		await harness.client.stop();
	});
});

describe("MastraSidecarClient shutdown", () => {
	test("permanently rejects restart and external requests after shutdown", async () => {
		const harness = createHarness(["succeed"]);
		await harness.client.start();
		await harness.client.stop();

		await expect(harness.client.start()).rejects.toEqual(
			expect.objectContaining({ code: "SHUTDOWN_REQUESTED" }),
		);
		await expect(
			harness.client.request("run.resume", { runId: "late-run" }),
		).rejects.toEqual(expect.objectContaining({ code: "SHUTDOWN_REQUESTED" }));
		await Bun.sleep(25);
		expect(harness.children).toHaveLength(1);
	});

	test("a synchronous shutdown latch rejects work before stop begins", async () => {
		const harness = createHarness(["succeed"]);
		await harness.client.start();
		harness.client.beginShutdown();

		await expect(
			harness.client.request("run.resume", { runId: "late-run" }),
		).rejects.toEqual(expect.objectContaining({ code: "SHUTDOWN_REQUESTED" }));
		await expect(harness.client.stop()).resolves.toBeUndefined();
		expect(harness.children).toHaveLength(1);
	});

	test("validates every shutdown budget when the client is constructed", () => {
		for (const option of [
			"shutdownProtocolTimeoutMs",
			"shutdownGraceTimeoutMs",
			"shutdownTerminateTimeoutMs",
			"shutdownKillTimeoutMs",
		] as const) {
			expect(() => createHarness(["succeed"], { [option]: 0 })).toThrow(
				expect.objectContaining({ code: "INVALID_SHUTDOWN_TIMEOUT" }),
			);
		}
	});

	test("bounds shutdown when an ordered request blocks runtime.shutdown", async () => {
		const harness = createHarness(["ordered-hang-request"], {
			shutdownProtocolTimeoutMs: 10,
			shutdownGraceTimeoutMs: 5,
			shutdownTerminateTimeoutMs: 5,
			shutdownKillTimeoutMs: 50,
		});
		await harness.client.start();
		const request = harness.client.request(
			"reflection.analyze",
			{ invocationId: "blocked-reflection" },
			{ timeoutMs: 5_000 },
		);
		const requestOutcome = request.then(
			() => null,
			(error: unknown) => error,
		);
		await waitFor(
			() =>
				harness.children[0]?.receivedMethods.includes("reflection.analyze") ===
				true,
		);

		const startedAt = Date.now();
		await expect(harness.client.stop()).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(harness.children[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(await requestOutcome).toEqual(
			expect.objectContaining({ code: "INTERRUPTED" }),
		);
		expect(harness.client.isRunning).toBe(false);
	});

	test("returns one stop promise and waits for a confirmed close", async () => {
		const harness = createHarness(["ignore-shutdown"], {
			shutdownProtocolTimeoutMs: 10,
			shutdownGraceTimeoutMs: 5,
			shutdownTerminateTimeoutMs: 1_000,
			shutdownKillTimeoutMs: 10,
		});
		await harness.client.start();
		let settled = false;
		const stopping = harness.client.stop();
		expect(harness.client.stop()).toBe(stopping);
		void stopping.finally(() => {
			settled = true;
		});
		await waitFor(
			() => harness.children[0]?.killSignals.includes("SIGTERM") === true,
		);
		expect(settled).toBe(false);

		harness.children[0]?.emitClose(null, "SIGTERM");
		await expect(stopping).resolves.toBeUndefined();
		expect(settled).toBe(true);
		expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
	});

	test("retains ownership when SIGKILL never produces a close", async () => {
		const harness = createHarness(["ignore-shutdown"], {
			shutdownProtocolTimeoutMs: 5,
			shutdownGraceTimeoutMs: 5,
			shutdownTerminateTimeoutMs: 5,
			shutdownKillTimeoutMs: 5,
		});
		await harness.client.start();

		await expect(harness.client.stop()).rejects.toEqual(
			expect.objectContaining({ code: "STOP_FAILED" }),
		);
		expect(harness.children[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(harness.client.isRunning).toBe(true);

		harness.children[0]?.emitClose(null, "SIGKILL");
		await Promise.resolve();
		expect(harness.client.isRunning).toBe(false);
	});

	test("a child error without close remains owned by later stop retries", async () => {
		const harness = createHarness(["ignore-shutdown"], {
			shutdownProtocolTimeoutMs: 5,
			shutdownGraceTimeoutMs: 5,
			shutdownTerminateTimeoutMs: 5,
			shutdownKillTimeoutMs: 1_000,
		});
		await harness.client.start();
		const firstStop = harness.client.stop();
		await waitFor(
			() => harness.children[0]?.killSignals.includes("SIGTERM") === true,
		);
		harness.children[0]?.emitError(new Error("synthetic transport error"));
		await expect(firstStop).rejects.toEqual(
			expect.objectContaining({ code: "STOP_FAILED" }),
		);

		let retrySettled = false;
		const retry = harness.client.stop();
		void retry.finally(() => {
			retrySettled = true;
		});
		await Bun.sleep(1);
		expect(retrySettled).toBe(false);
		harness.children[0]?.emitClose(null, "SIGKILL");
		await expect(retry).resolves.toBeUndefined();
	});
});

function createHarness(
	behaviors: readonly FakeBehavior[],
	shutdownOptions: Partial<
		Pick<
			MastraSidecarClientOptions,
			| "shutdownProtocolTimeoutMs"
			| "shutdownGraceTimeoutMs"
			| "shutdownTerminateTimeoutMs"
			| "shutdownKillTimeoutMs"
		>
	> = {},
): {
	client: MastraSidecarClient;
	children: FakeSidecarChild[];
	interruptions: string[][];
	restarts: { count: number };
} {
	const children: FakeSidecarChild[] = [];
	const interruptions: string[][] = [];
	const restarts = { count: 0 };
	const spawnProcess = (() => {
		const child = new FakeSidecarChild(behaviors[children.length] ?? "succeed");
		children.push(child);
		return child as unknown as ChildProcessWithoutNullStreams;
	}) as unknown as typeof spawn;
	const options: MastraSidecarClientOptions = {
		nodePath: "unused-node",
		entryPath: "unused-entry",
		initializeTimeoutMs: 20,
		initialize: {
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			client: { name: "sidecar-client-test", version: "1" },
			model: { provider: "test", modelId: "test-model" },
			reflectionModel: {
				provider: "test-reflection",
				modelId: "test-reflection-model",
			},
		},
		onHostCall: async () => ({}),
		onRunEvent: () => {},
		onInterrupted: (runIds) => interruptions.push([...runIds]),
		onRestarted: () => {
			restarts.count += 1;
		},
		spawnProcess,
		...shutdownOptions,
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
	readonly killSignals: NodeJS.Signals[] = [];
	readonly receivedMethods: string[] = [];
	private readonly parser = new ContentLengthFrameParser();
	private hungRequest = false;
	private requestTail = Promise.resolve();

	constructor(private readonly behavior: FakeBehavior) {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			for (const message of this.parser.push(chunk)) {
				if (this.behavior === "ordered-hang-request") {
					this.requestTail = this.requestTail.then(() => this.accept(message));
					void this.requestTail.catch(() => undefined);
				} else {
					void this.accept(message);
				}
			}
		});
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killed = true;
		this.killSignals.push(signal);
		if (this.behavior === "ordered-hang-request" && signal === "SIGKILL") {
			queueMicrotask(() => this.emitClose(null, signal));
		}
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

	private async accept(value: unknown): Promise<void> {
		if (
			!isRecord(value) ||
			value.type !== "request" ||
			typeof value.requestId !== "string"
		) {
			return;
		}
		if (this.behavior === "hang-initialize") return;
		this.receivedMethods.push(
			typeof value.method === "string" ? value.method : "unknown",
		);
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
		if (
			this.behavior === "ordered-hang-request" &&
			value.method === "reflection.analyze"
		) {
			await new Promise<void>(() => {});
			return;
		}
		if (
			this.behavior === "ignore-shutdown" &&
			value.method === "runtime.shutdown"
		) {
			return;
		}
		if (this.behavior === "hang-request" && !this.hungRequest) {
			this.hungRequest = true;
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
		if (Date.now() >= deadline)
			throw new Error("Timed out waiting for Sidecar restart.");
		await Bun.sleep(10);
	}
}
