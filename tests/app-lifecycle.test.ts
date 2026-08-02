import { describe, expect, test } from "bun:test";
import {
	BackgroundAppLifecycle,
	type BackgroundWindow,
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

	test("a failed shutdown is reported but does not strand explicit quit", async () => {
		const errors: string[] = [];
		let exitCount = 0;
		const lifecycle = new BackgroundAppLifecycle({
			createWindow: async () => new TestWindow(),
			shutdown: async () => {
				throw new Error("shutdown failed");
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
		expect(exitCount).toBe(1);
	});
});
