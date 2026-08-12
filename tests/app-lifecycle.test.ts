import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type { LocalToolProcess } from "../src/agent/local-tool-client";
import {
	BackgroundAppLifecycle,
	type BackgroundWindow,
	runBestEffortShutdown,
} from "../src/bun/app-lifecycle";

class TestWindow implements BackgroundWindow {
	showCount = 0;
	activateCount = 0;

	show() {
		this.showCount += 1;
	}

	activate() {
		this.activateCount += 1;
	}
}

describe("background application lifecycle", () => {
	test("closing the control window keeps the monitoring runtime alive", async () => {
		let shutdownCount = 0;
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				shutdownCount += 1;
			},
			exit: () => {
				exitCount += 1;
			},
		});

		const window = await lifecycle.open();
		lifecycle.didClose(window);

		expect(lifecycle.currentWindow).toBeNull();
		expect(shutdownCount).toBe(0);
		expect(exitCount).toBe(0);
	});

	test("Dock or menu reopen creates at most one replacement window", async () => {
		let createCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => {
				createCount += 1;
				await Promise.resolve();
				return new TestWindow();
			},
			shutdown: async () => {},
			exit: () => {},
		});

		const [first, sameFirst] = await Promise.all([
			lifecycle.open(),
			lifecycle.open(),
		]);
		expect(sameFirst).toBe(first);
		expect(createCount).toBe(1);

		lifecycle.didClose(first);
		const replacement = await lifecycle.open();
		expect(replacement).not.toBe(first);
		expect(createCount).toBe(2);
	});

	test("opening an existing window only presents it", async () => {
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {},
			exit: () => {},
		});
		const window = await lifecycle.open();

		expect(await lifecycle.open()).toBe(window);
		expect(window.showCount).toBe(1);
		expect(window.activateCount).toBe(1);
	});

	test("explicit quit is idempotent and waits for shutdown before exit", async () => {
		const order: string[] = [];
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				order.push("shutdown");
				await Promise.resolve();
				order.push("persisted");
			},
			exit: () => {
				order.push("exit");
			},
		});

		await Promise.all([lifecycle.quit(), lifecycle.quit()]);
		expect(order).toEqual(["shutdown", "persisted", "exit"]);
	});

	test("latches native startup synchronously before waiting for a hanging window open", async () => {
		let localRunning = false;
		let nativeStartCount = 0;
		const local = {
			pid: null,
			get isRunning() {
				return localRunning;
			},
			onEvent: () => () => {},
			onDesktopEvent: () => () => {},
			onSemanticEvent: () => () => {},
			onFailure: () => () => {},
			async start() {
				nativeStartCount += 1;
				localRunning = true;
			},
			async stop() {
				localRunning = false;
			},
		} as unknown as LocalToolProcess;
		const runtime = new AgentRuntime(local);
		let releaseOpen!: (window: TestWindow) => void;
		const pendingWindow = new Promise<TestWindow>((resolve) => {
			releaseOpen = resolve;
		});
		let quitLatchCount = 0;
		let shutdownCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: () => pendingWindow,
			onQuitRequested() {
				quitLatchCount += 1;
				runtime.beginShutdown();
			},
			shutdown: async () => {
				shutdownCount += 1;
			},
			exit: () => {},
		});
		const opening = lifecycle.open().catch((error: unknown) => error);

		const quitting = lifecycle.quit();
		expect(lifecycle.quit()).toBe(quitting);
		expect(quitLatchCount).toBe(1);
		expect(shutdownCount).toBe(0);
		await expect(runtime.start()).rejects.toThrow(
			"while WhaleHall is quitting",
		);
		await expect(runtime.listLocalTools()).rejects.toThrow(
			"while WhaleHall is quitting",
		);
		expect(nativeStartCount).toBe(0);

		releaseOpen(new TestWindow());
		await opening;
		await quitting;
		expect(shutdownCount).toBe(1);
	});

	test("vetoes Electrobun quit until shutdown authorizes the final exit", async () => {
		let releaseShutdown: (() => void) | undefined;
		const shutdownReleased = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let shutdownCount = 0;
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: () => {
				shutdownCount += 1;
				return shutdownReleased;
			},
			exit: () => {
				exitCount += 1;
			},
		});
		const firstEvent: { response?: { allow: boolean } } = {};

		lifecycle.handleBeforeQuit(firstEvent);
		expect(firstEvent.response).toEqual({ allow: false });
		expect(exitCount).toBe(0);
		const repeatedEvent: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(repeatedEvent);
		expect(repeatedEvent.response).toEqual({ allow: false });
		await Promise.resolve();
		expect(shutdownCount).toBe(1);

		releaseShutdown?.();
		await lifecycle.quit();
		expect(exitCount).toBe(1);

		const finalEvent: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(finalEvent);
		expect(finalEvent.response).toBeUndefined();
		expect(exitCount).toBe(1);
	});

	test("a failed shutdown is reported and a later quit retries before exit", async () => {
		const errors: string[] = [];
		let exitCount = 0;
		let shutdownCount = 0;
		let shutdownFails = true;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				shutdownCount += 1;
				if (shutdownFails) throw new Error("shutdown failed");
			},
			exit: () => {
				exitCount += 1;
			},
			onError(operation) {
				errors.push(operation);
			},
		});

		await lifecycle.quit();
		expect(errors).toEqual(["quit"]);
		expect(exitCount).toBe(0);
		expect(shutdownCount).toBe(1);
		await expect(lifecycle.open()).rejects.toThrow(
			"while WhaleHall is quitting",
		);

		shutdownFails = false;
		const repeatedEvent: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(repeatedEvent);
		expect(repeatedEvent.response).toEqual({ allow: false });
		await lifecycle.quit();
		expect(shutdownCount).toBe(2);
		expect(exitCount).toBe(1);
	});

	test("a failed synchronous quit latch is retried before shutdown", async () => {
		let latchCount = 0;
		let shutdownCount = 0;
		let exitCount = 0;
		const errors: string[] = [];
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			onQuitRequested() {
				latchCount += 1;
				if (latchCount === 1) throw new Error("synthetic latch failure");
			},
			shutdown: async () => {
				shutdownCount += 1;
			},
			exit: () => {
				exitCount += 1;
			},
			onError(operation) {
				errors.push(operation);
			},
		});

		await lifecycle.quit();
		expect(latchCount).toBe(1);
		expect(shutdownCount).toBe(0);
		expect(exitCount).toBe(0);
		expect(errors).toEqual(["quit"]);

		await lifecycle.quit();
		expect(latchCount).toBe(2);
		expect(shutdownCount).toBe(1);
		expect(exitCount).toBe(1);
	});

	test("concurrent quit calls share one failed latch attempt", async () => {
		let latchCount = 0;
		let shutdownCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			onQuitRequested() {
				latchCount += 1;
				if (latchCount === 1) throw new Error("synthetic latch failure");
			},
			shutdown: async () => {
				shutdownCount += 1;
			},
			exit: () => {},
		});

		const first = lifecycle.quit();
		expect(lifecycle.quit()).toBe(first);
		await first;
		expect(latchCount).toBe(1);
		expect(shutdownCount).toBe(0);

		await lifecycle.quit();
		expect(latchCount).toBe(2);
		expect(shutdownCount).toBe(1);
	});

	test("best-effort shutdown continues after failures and diagnostic errors", async () => {
		const order: string[] = [];
		const errors: string[] = [];

		const shutdown = runBestEffortShutdown(
			[
				{
					name: "first",
					critical: true,
					run() {
						order.push("first");
						throw new Error("first failed");
					},
				},
				{
					name: "second",
					run() {
						order.push("second");
					},
				},
				{
					name: "third",
					async run() {
						await Promise.resolve();
						order.push("third");
					},
				},
			],
			(step) => {
				errors.push(step);
				throw new Error("diagnostic failed");
			},
		);
		await expect(shutdown).rejects.toMatchObject({
			name: "CriticalShutdownError",
			failedSteps: ["first"],
		});

		expect(order).toEqual(["first", "second", "third"]);
		expect(errors).toEqual(["first"]);
	});

	test("bounds a stuck step and continues to later process owners", async () => {
		const order: string[] = [];
		const errors: string[] = [];
		const settled: Array<{ name: string; outcome: string }> = [];
		await runBestEffortShutdown(
			[
				{
					name: "stuck-tail",
					timeoutMs: 10,
					run: () => new Promise<void>(() => {}),
				},
				{
					name: "later-owner",
					timeoutMs: 100,
					run: () => {
						order.push("later-owner");
					},
				},
			],
			(step) => errors.push(step),
			{
				onStepSettled(result) {
					settled.push({ name: result.name, outcome: result.outcome });
				},
			},
		);

		expect(order).toEqual(["later-owner"]);
		expect(errors).toEqual(["stuck-tail"]);
		expect(settled).toEqual([
			{ name: "stuck-tail", outcome: "timed_out" },
			{ name: "later-owner", outcome: "completed" },
		]);
	});

	test("caps the complete sequence with one shared overall deadline", async () => {
		const started: string[] = [];
		const settled: Array<{ name: string; outcome: string }> = [];
		const times = [0, 0, 10, 10, 10];
		await runBestEffortShutdown(
			[
				{
					name: "consumes-deadline",
					run: () => new Promise<void>(() => {}),
				},
				{
					name: "not-started-after-deadline",
					run: () => {
						started.push("not-started-after-deadline");
					},
				},
			],
			() => {},
			{
				nowMs: () => times.shift() ?? 10,
				overallTimeoutMs: 10,
				onStepSettled(result) {
					settled.push({ name: result.name, outcome: result.outcome });
				},
			},
		);

		expect(started).toEqual([]);
		expect(settled).toEqual([
			{ name: "consumes-deadline", outcome: "timed_out" },
			{ name: "not-started-after-deadline", outcome: "timed_out" },
		]);
	});

	test("reports sanitized duration for every outcome without trusting diagnostics", async () => {
		const times = [100, 107, 107, 119];
		const settled: Array<{
			name: string;
			outcome: string;
			durationMs: number;
		}> = [];
		await runBestEffortShutdown(
			[
				{ name: "successful", run: () => {} },
				{
					name: "failed",
					run: () => {
						throw new Error("private failure detail");
					},
				},
			],
			() => {},
			{
				nowMs: () => times.shift() ?? 119,
				onStepSettled(result) {
					settled.push({
						name: result.name,
						outcome: result.outcome,
						durationMs: result.durationMs,
					});
					throw new Error("diagnostic failed");
				},
			},
		);

		expect(settled).toEqual([
			{ name: "successful", outcome: "completed", durationMs: 7 },
			{ name: "failed", outcome: "failed", durationMs: 12 },
		]);
	});
});
