import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type { LocalToolProcess } from "../src/agent/local-tool-client";
import {
	BackgroundAppLifecycle,
	type BackgroundWindow,
	CriticalShutdownError,
	closeOwnerAfterDraining,
	runBestEffortShutdown,
	ShutdownWorkBarrier,
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

test("shutdown work barrier rejects new work and drains accepted operations", async () => {
	let release: (() => void) | undefined;
	let started = 0;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const barrier = new ShutdownWorkBarrier();
	const accepted = barrier.run(async () => {
		started += 1;
		await gate;
		return "done";
	});
	await Promise.resolve();
	barrier.close();
	let rejectedRan = false;
	await expect(
		barrier.run(() => {
			rejectedRan = true;
		}),
	).rejects.toThrow("shutdown");
	let drained = false;
	const drain = barrier.drain().then(() => {
		drained = true;
	});
	await Promise.resolve();
	expect(drained).toBeFalse();
	expect(started).toBe(1);
	expect(rejectedRan).toBeFalse();
	release?.();
	await expect(accepted).resolves.toBe("done");
	await drain;
	expect(drained).toBeTrue();
});

test("owner close drains work registered by the last producer", async () => {
	let releaseProducer!: () => void;
	let releaseRemote!: () => void;
	const producerGate = new Promise<void>((resolve) => {
		releaseProducer = resolve;
	});
	const remoteGate = new Promise<void>((resolve) => {
		releaseRemote = resolve;
	});
	const remoteSettlements = new Set<Promise<void>>();
	let producerStarted = false;
	let ownerClosed = false;

	const closing = closeOwnerAfterDraining(
		async () => {
			producerStarted = true;
			await producerGate;
			remoteSettlements.add(remoteGate);
		},
		async () => {
			for (;;) {
				const observed = [...remoteSettlements];
				await Promise.allSettled(observed);
				if (observed.length === remoteSettlements.size) return;
			}
		},
		() => {
			ownerClosed = true;
		},
	);

	await Promise.resolve();
	expect(producerStarted).toBeTrue();
	releaseProducer();
	await Promise.resolve();
	await Promise.resolve();
	expect(ownerClosed).toBeFalse();
	releaseRemote();
	await closing;
	expect(ownerClosed).toBeTrue();
});

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

	test("prepares an updater-owned exit without quitting first", async () => {
		const order: string[] = [];
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			onQuitRequested() {
				order.push("latched");
			},
			shutdown: async () => {
				order.push("shutdown");
			},
			exit: () => order.push("exit"),
		});

		await lifecycle.prepareForExternalExit();
		expect(order).toEqual(["latched", "shutdown"]);
		await expect(lifecycle.open()).rejects.toThrow(
			"while WhaleHall is quitting",
		);

		const updaterQuit: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(updaterQuit);
		expect(updaterQuit.response).toBeUndefined();
		expect(order).toEqual(["latched", "shutdown"]);
	});

	test("vetoes a last-window quit without racing the updater-owned exit", async () => {
		let releaseShutdown: (() => void) | undefined;
		let exitCount = 0;
		const shutdownGate = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: () => shutdownGate,
			exit: () => {
				exitCount += 1;
			},
		});

		const preparation = lifecycle.prepareForExternalExit();
		const lastWindowQuit: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(lastWindowQuit);
		expect(lastWindowQuit.response).toEqual({ allow: false });
		expect(exitCount).toBe(0);

		releaseShutdown?.();
		await preparation;
		await Promise.resolve();
		expect(exitCount).toBe(0);

		const updaterOwnedQuit: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(updaterOwnedQuit);
		expect(updaterOwnedQuit.response).toBeUndefined();
	});

	test("an updater takes ownership from an already-running ordinary quit", async () => {
		let releaseShutdown!: () => void;
		const shutdownGate = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: () => shutdownGate,
			exit: () => {
				exitCount += 1;
			},
		});

		const ordinaryQuit = lifecycle.quit();
		await Promise.resolve();
		const updaterPreparation = lifecycle.prepareForExternalExit();
		releaseShutdown();
		await Promise.all([ordinaryQuit, updaterPreparation]);
		expect(exitCount).toBe(0);

		const updaterOwnedQuit: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(updaterOwnedQuit);
		expect(updaterOwnedQuit.response).toBeUndefined();
	});

	test("does not authorize an updater-owned exit when shutdown fails", async () => {
		let shouldFail = true;
		let shutdownCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				shutdownCount += 1;
				if (shouldFail) throw new Error("database still closing");
			},
			exit: () => {},
		});

		await expect(lifecycle.prepareForExternalExit()).rejects.toThrow(
			"database still closing",
		);
		const blockedQuit: { response?: { allow: boolean } } = {};
		lifecycle.handleBeforeQuit(blockedQuit);
		expect(blockedQuit.response).toEqual({ allow: false });
		shouldFail = false;
		await lifecycle.prepareForExternalExit();
		expect(shutdownCount).toBe(2);
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

	test("ordinary quit retries once after the exact pending owners settle", async () => {
		let releaseOwner!: () => void;
		const ownerSettled = new Promise<void>((resolve) => {
			releaseOwner = resolve;
		});
		let resolveExited!: () => void;
		const exited = new Promise<void>((resolve) => {
			resolveExited = resolve;
		});
		let shutdownCount = 0;
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				shutdownCount += 1;
				if (shutdownCount === 1) {
					throw new CriticalShutdownError(["native-owner"]);
				}
			},
			waitForShutdownRetry: () => ownerSettled,
			exit: () => {
				exitCount += 1;
				resolveExited();
			},
		});

		await lifecycle.quit();
		expect(shutdownCount).toBe(1);
		expect(exitCount).toBe(0);
		releaseOwner();
		await exited;
		expect(shutdownCount).toBe(2);
		expect(exitCount).toBe(1);
	});

	test("an already-settled owner waiter still starts a fresh attempt", async () => {
		let shutdownCount = 0;
		let exitCount = 0;
		let resolveExited!: () => void;
		const exited = new Promise<void>((resolve) => {
			resolveExited = resolve;
		});
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				shutdownCount += 1;
				if (shutdownCount === 1) throw new CriticalShutdownError(["owner"]);
			},
			waitForShutdownRetry: () => Promise.resolve(),
			exit: () => {
				exitCount += 1;
				resolveExited();
			},
		});

		await lifecycle.quit();
		await exited;
		expect(shutdownCount).toBe(2);
		expect(exitCount).toBe(1);
	});

	test("an updater takes ownership from an in-flight automatic retry", async () => {
		let releaseOwner!: () => void;
		const ownerSettled = new Promise<void>((resolve) => {
			releaseOwner = resolve;
		});
		let releaseRetry!: () => void;
		const retryGate = new Promise<void>((resolve) => {
			releaseRetry = resolve;
		});
		let retryStarted!: () => void;
		const retryWasStarted = new Promise<void>((resolve) => {
			retryStarted = resolve;
		});
		let shutdownCount = 0;
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				shutdownCount += 1;
				if (shutdownCount === 1) throw new CriticalShutdownError(["owner"]);
				retryStarted();
				await retryGate;
			},
			waitForShutdownRetry: () => ownerSettled,
			exit: () => {
				exitCount += 1;
			},
		});

		await lifecycle.quit();
		releaseOwner();
		await retryWasStarted;
		const updaterPreparation = lifecycle.prepareForExternalExit();
		releaseRetry();
		await updaterPreparation;
		for (let index = 0; index < 4; index += 1) await Promise.resolve();
		expect(shutdownCount).toBe(2);
		expect(exitCount).toBe(0);
	});

	test("an automatic retry never loops after a second shutdown failure", async () => {
		let shutdownCount = 0;
		let waiterCount = 0;
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				shutdownCount += 1;
				throw new CriticalShutdownError(["owner"]);
			},
			waitForShutdownRetry: () => {
				waiterCount += 1;
				return Promise.resolve();
			},
			exit: () => {
				exitCount += 1;
			},
		});

		await lifecycle.quit();
		for (let index = 0; index < 8; index += 1) await Promise.resolve();
		expect(shutdownCount).toBe(2);
		expect(waiterCount).toBe(1);
		expect(exitCount).toBe(0);
	});

	test("updater preparation failures never schedule an ordinary exit retry", async () => {
		let waiterCount = 0;
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				throw new CriticalShutdownError(["owner"]);
			},
			waitForShutdownRetry: () => {
				waiterCount += 1;
				return Promise.resolve();
			},
			exit: () => {
				exitCount += 1;
			},
		});

		await expect(lifecycle.prepareForExternalExit()).rejects.toBeInstanceOf(
			CriticalShutdownError,
		);
		for (let index = 0; index < 4; index += 1) await Promise.resolve();
		expect(waiterCount).toBe(0);
		expect(exitCount).toBe(0);
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

	test("accepts only an exact late completion proof for a timed-out critical step", async () => {
		let release!: () => void;
		const lateOwner = new Promise<void>((resolve) => {
			release = resolve;
		});
		let ownerCompleted = false;
		const outcomes: Array<{ name: string; outcome: string }> = [];
		const shutdown = runBestEffortShutdown(
			[
				{
					name: "late-owner",
					critical: true,
					timeoutMs: 5,
					run: async () => {
						await lateOwner;
						ownerCompleted = true;
					},
				},
				{
					name: "final-owner-barrier",
					critical: true,
					timeoutMs: 100,
					run: async () => {
						release();
						await lateOwner;
					},
				},
			],
			() => {},
			{
				isCriticalFailureRecovered: (step) =>
					step === "late-owner" && ownerCompleted,
				onStepSettled: ({ name, outcome }) => outcomes.push({ name, outcome }),
			},
		);

		await expect(shutdown).resolves.toBeUndefined();
		expect(outcomes).toEqual([
			{ name: "late-owner", outcome: "timed_out" },
			{ name: "final-owner-barrier", outcome: "completed" },
		]);
	});

	test("fails closed when a critical recovery predicate is false or throws", async () => {
		const predicates = [
			() => false,
			() => {
				throw new Error("broken proof");
			},
		];
		for (const predicate of predicates) {
			await expect(
				runBestEffortShutdown(
					[
						{
							name: "failed-owner",
							critical: true,
							run: async () => {
								throw new Error("failed");
							},
						},
					],
					() => {},
					{ isCriticalFailureRecovered: predicate },
				),
			).rejects.toMatchObject({ failedSteps: ["failed-owner"] });
		}
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
