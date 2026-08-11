import { describe, expect, test } from "bun:test";
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
});
