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
});
