import { describe, expect, test } from "bun:test";
import {
	TimelineRuntimeLifecycle,
	resumeTimelineRuntimeForAvailableVault,
} from "../src/bun/timeline-runtime-lifecycle";

class TestRuntime {
	startCount = 0;
	closeCount = 0;

	constructor(
		private readonly startImplementation: () => Promise<void> = async () => {},
		readonly privateTrainingExport: object = {},
	) {}

	async start(): Promise<void> {
		this.startCount += 1;
		await this.startImplementation();
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

type ScheduledRetry = {
	callback: () => void;
	delayMs: number;
	cancelled: boolean;
};

function retryScheduler() {
	const scheduled: ScheduledRetry[] = [];
	return {
		scheduled,
		schedule(callback: () => void, delayMs: number): ScheduledRetry {
			const retry = { callback, delayMs, cancelled: false };
			scheduled.push(retry);
			return retry;
		},
		cancel(handle: unknown): void {
			(handle as ScheduledRetry).cancelled = true;
		},
	};
}

describe("Timeline runtime lifecycle", () => {
	test("publishes one runtime only after one idempotent backlog recovery", async () => {
		let releaseStart: () => void = () => {
			throw new Error("start gate was not initialized");
		};
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const runtime = new TestRuntime(() => startGate, {
			kind: "committed-window-export",
		});
		let createCount = 0;
		const lifecycle = new TimelineRuntimeLifecycle({
			createRuntime: async () => {
				createCount += 1;
				return runtime;
			},
			retryDelaysMs: [5],
		});

		const first = resumeTimelineRuntimeForAvailableVault(
			{ availability: "available" },
			lifecycle,
		);
		const concurrent = resumeTimelineRuntimeForAvailableVault(
			{ availability: "available" },
			lifecycle,
		);
		await Promise.resolve();

		expect(createCount).toBe(1);
		expect(runtime.startCount).toBe(1);
		expect(lifecycle.current).toBeNull();
		expect(lifecycle.recoveryPending).toBeTrue();

		releaseStart();
		expect(await first).toBeTrue();
		expect(await concurrent).toBeTrue();
		expect(lifecycle.current).toBe(runtime);
		expect(lifecycle.current?.privateTrainingExport).toEqual({
			kind: "committed-window-export",
		});
		expect(lifecycle.recoveryPending).toBeFalse();

		expect(await lifecycle.ensureStarted()).toBe(runtime);
		expect(createCount).toBe(1);
		await lifecycle.close();
		expect(runtime.closeCount).toBe(1);
	});

	test("keeps a failed candidate unpublished and retries with a fresh runtime", async () => {
		const scheduler = retryScheduler();
		const failure = new Error("vault opened but collector recovery failed");
		const failed = new TestRuntime(async () => {
			throw failure;
		});
		const recovered = new TestRuntime();
		const errors: unknown[] = [];
		let createCount = 0;
		const lifecycle = new TimelineRuntimeLifecycle({
			createRuntime: async () => {
				createCount += 1;
				return createCount === 1 ? failed : recovered;
			},
			retryDelaysMs: [5, 15],
			onError: (error) => errors.push(error),
			scheduleRetry: scheduler.schedule,
			cancelRetry: scheduler.cancel,
		});

		expect(
			await resumeTimelineRuntimeForAvailableVault(
				{ availability: "available" },
				lifecycle,
			),
		).toBeFalse();
		expect(lifecycle.current).toBeNull();
		expect(failed.closeCount).toBe(1);
		expect(errors).toContain(failure);
		expect(scheduler.scheduled).toHaveLength(1);
		expect(scheduler.scheduled[0]?.delayMs).toBe(5);
		expect(lifecycle.recoveryPending).toBeTrue();

		scheduler.scheduled[0]?.callback();
		expect(await lifecycle.ensureStarted({ retryOnFailure: true })).toBe(
			recovered,
		);
		expect(createCount).toBe(2);
		expect(lifecycle.current).toBe(recovered);
		expect(lifecycle.recoveryPending).toBeFalse();
		await lifecycle.close();
	});

	test("does not create a runtime until the migrated vault is available", async () => {
		let createCount = 0;
		const lifecycle = new TimelineRuntimeLifecycle({
			createRuntime: async () => {
				createCount += 1;
				return new TestRuntime();
			},
			retryDelaysMs: [5],
		});

		expect(
			await resumeTimelineRuntimeForAvailableVault(
				{ availability: "migration_required" },
				lifecycle,
			),
		).toBeFalse();
		expect(
			await resumeTimelineRuntimeForAvailableVault(
				{ availability: "unavailable" },
				lifecycle,
			),
		).toBeFalse();
		expect(createCount).toBe(0);
		expect(lifecycle.current).toBeNull();
		await lifecycle.close();
	});

	test("closes an in-flight candidate instead of publishing it during shutdown", async () => {
		let releaseStart: () => void = () => {
			throw new Error("start gate was not initialized");
		};
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const runtime = new TestRuntime(() => startGate);
		const lifecycle = new TimelineRuntimeLifecycle({
			createRuntime: async () => runtime,
			retryDelaysMs: [5],
		});

		const starting = lifecycle.ensureStarted();
		await Promise.resolve();
		const closing = lifecycle.close();
		releaseStart();

		await expect(starting).rejects.toThrow(
			"Timeline runtime lifecycle is closed.",
		);
		await closing;
		expect(lifecycle.current).toBeNull();
		expect(runtime.closeCount).toBe(1);
		await expect(lifecycle.ensureStarted()).rejects.toThrow(
			"Timeline runtime lifecycle is closed.",
		);
	});
});
