import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_CAPTURE_SETTLE_DELAY_MS,
	FileAuditCaptureStore,
	FiveMinuteAuditCaptureCoordinator,
	alignToCurrentOrNextBucket,
	type AuditCaptureScheduler,
	type AuditCaptureStore,
	type PersistedAuditCaptureState,
} from "../src/bun/five-minute-audit-capture";

class MemoryStore implements AuditCaptureStore {
	value: PersistedAuditCaptureState | null = null;
	readonly saves: PersistedAuditCaptureState[] = [];

	async load(): Promise<PersistedAuditCaptureState | null> {
		return this.value ? structuredClone(this.value) : null;
	}

	async save(capture: PersistedAuditCaptureState): Promise<void> {
		this.value = structuredClone(capture);
		this.saves.push(structuredClone(capture));
	}
}

class FakeClock implements AuditCaptureScheduler {
	now = 0;
	private nextId = 1;
	private readonly timers = new Map<
		number,
		{ atMs: number; callback: () => void }
	>();

	setTimer(callback: () => void, delayMs: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, {
			atMs: this.now + Math.max(0, delayMs),
			callback,
		});
		return id;
	}

	clearTimer(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	async advanceTo(nowMs: number): Promise<void> {
		if (nowMs < this.now) throw new Error("Fake clock cannot move backwards.");
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.atMs <= nowMs)
				.sort((left, right) => left[1].atMs - right[1].atMs)[0];
			if (!due) break;
			this.now = due[1].atMs;
			this.timers.delete(due[0]);
			due[1].callback();
			await drainMicrotasks();
		}
		this.now = nowMs;
		await drainMicrotasks();
	}
}

function createHarness(options: {
	nowMs?: number;
	store?: MemoryStore;
	settleRange?: (fromMs: number, toMs: number) => Promise<void>;
}) {
	const clock = new FakeClock();
	clock.now = options.nowMs ?? 0;
	const store = options.store ?? new MemoryStore();
	const settled: Array<{ fromMs: number; toMs: number }> = [];
	const coordinator = new FiveMinuteAuditCaptureCoordinator({
		store,
		scheduler: clock,
		nowMs: () => clock.now,
		createCaptureId: () => "ac1_0123456789abcdef",
		settleRange:
			options.settleRange ??
			(async (fromMs, toMs) => {
				settled.push({ fromMs, toMs });
			}),
	});
	return { clock, store, settled, coordinator };
}

describe("five-minute audit capture coordinator", () => {
	test("aligns start to the current or next complete five-second bucket", () => {
		expect(alignToCurrentOrNextBucket(10_000)).toBe(10_000);
		expect(alignToCurrentOrNextBucket(10_001)).toBe(15_000);
		expect(() => alignToCurrentOrNextBucket(-1)).toThrow();
	});

	test("start is bounded and idempotent while one capture is active", async () => {
		const harness = createHarness({ nowMs: 10_001 });
		await harness.coordinator.initialize();

		const first = await harness.coordinator.start();
		const second = await harness.coordinator.start();

		expect(first).toEqual(second);
		expect(first.fromMs).toBe(15_000);
		expect(first.toMs).toBe(315_000);
		expect(first.state).toBe("collecting");
		expect(first.analysisCompleteness).toBe("natural_windows_only");
		expect(Object.keys(first).sort()).toEqual([
			"analysisCompleteness",
			"captureId",
			"fromMs",
			"state",
			"toMs",
			"updatedAtMs",
		]);
		expect(harness.store.saves).toHaveLength(1);
		expect(harness.settled).toHaveLength(0);
	});

	test("waits twelve seconds after the range before settling exactly once", async () => {
		const harness = createHarness({ nowMs: 5_000 });
		await harness.coordinator.initialize();
		const capture = await harness.coordinator.start();

		await harness.clock.advanceTo(capture.toMs);
		expect((await harness.coordinator.status())?.state).toBe("settling");
		expect(harness.settled).toHaveLength(0);

		await harness.clock.advanceTo(
			capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS - 1,
		);
		expect(harness.settled).toHaveLength(0);
		await harness.clock.advanceTo(
			capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS,
		);
		expect(harness.settled).toEqual([
			{ fromMs: capture.fromMs, toMs: capture.toMs },
		]);
		expect((await harness.coordinator.status())?.state).toBe("ready");

		await harness.clock.advanceTo(capture.toMs + 60_000);
		expect(harness.settled).toHaveLength(1);
	});

	test("cancel is idempotent and prevents settlement", async () => {
		const harness = createHarness({ nowMs: 1 });
		await harness.coordinator.initialize();
		const capture = await harness.coordinator.start();

		const cancelled = await harness.coordinator.cancel(capture.captureId);
		const repeated = await harness.coordinator.cancel(capture.captureId);
		expect(cancelled?.state).toBe("cancelled");
		expect(repeated).toEqual(cancelled);

		await harness.clock.advanceTo(
			capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS,
		);
		expect(harness.settled).toHaveLength(0);
	});

	test("restart restores an overdue capture and settles it only once", async () => {
		const store = new MemoryStore();
		store.value = {
			captureId: "ac1_0123456789abcdef",
			state: "collecting",
			fromMs: 5_000,
			toMs: 305_000,
			createdAtMs: 1,
			updatedAtMs: 1,
			settleNotBeforeMs: 317_000,
			settleAttemptedAtMs: null,
		};
		const harness = createHarness({ nowMs: 400_000, store });

		await harness.coordinator.initialize();
		await drainMicrotasks();

		expect(harness.settled).toEqual([{ fromMs: 5_000, toMs: 305_000 }]);
		expect((await harness.coordinator.status())?.state).toBe("ready");
		expect(
			store.saves.filter((capture) => capture.settleAttemptedAtMs !== null),
		).toHaveLength(2);
	});

	test("does not replay an in-flight settlement after a restart", async () => {
		const store = new MemoryStore();
		store.value = {
			captureId: "ac1_0123456789abcdef",
			state: "settling",
			fromMs: 5_000,
			toMs: 305_000,
			createdAtMs: 1,
			updatedAtMs: 317_000,
			settleNotBeforeMs: 317_000,
			settleAttemptedAtMs: 317_000,
		};
		const harness = createHarness({ nowMs: 400_000, store });

		await harness.coordinator.initialize();

		expect(harness.settled).toHaveLength(0);
		expect((await harness.coordinator.status())?.state).toBe("failed");
	});

	test("marks the capture failed without leaking settlement errors", async () => {
		const errors: unknown[] = [];
		const clock = new FakeClock();
		const coordinator = new FiveMinuteAuditCaptureCoordinator({
			store: new MemoryStore(),
			scheduler: clock,
			nowMs: () => clock.now,
			createCaptureId: () => "ac1_0123456789abcdef",
			async settleRange() {
				throw new Error("sensitive internal failure");
			},
			onError: (error) => errors.push(error),
		});
		await coordinator.initialize();
		const capture = await coordinator.start();

		await clock.advanceTo(
			capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS,
		);

		const status = await coordinator.status();
		expect(status?.state).toBe("failed");
		expect(JSON.stringify(status)).not.toContain("sensitive");
		expect(errors).toHaveLength(1);
	});

	test("settlement runs outside bounded status and cancel operations", async () => {
		let finishSettlement: () => void = () => {};
		const settlement = new Promise<void>((resolve) => {
			finishSettlement = resolve;
		});
		const harness = createHarness({
			async settleRange() {
				await settlement;
			},
		});
		await harness.coordinator.initialize();
		const capture = await harness.coordinator.start();
		await harness.clock.advanceTo(
			capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS,
		);

		expect((await harness.coordinator.status())?.state).toBe("settling");
		expect(
			(await harness.coordinator.cancel(capture.captureId))?.state,
		).toBe("cancelled");

		finishSettlement();
		await drainMicrotasks();
		expect((await harness.coordinator.status())?.state).toBe("cancelled");
	});
});

describe("file audit capture store", () => {
	test("writes only content-free state in a private atomic file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-audit-capture-"));
		const path = join(directory, "audit-capture-session.v1.json");
		try {
			const store = new FileAuditCaptureStore(path);
			const capture: PersistedAuditCaptureState = {
				captureId: "ac1_0123456789abcdef",
				state: "collecting",
				fromMs: 5_000,
				toMs: 305_000,
				createdAtMs: 1,
				updatedAtMs: 1,
				settleNotBeforeMs: 317_000,
				settleAttemptedAtMs: null,
			};
			await store.save(capture);

			expect(await store.load()).toEqual(capture);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			const text = readFileSync(path, "utf8");
			expect(text).not.toContain("raw");
			expect(text).not.toContain("text");
			expect(text).not.toContain("path");
			expect(text).not.toContain("content");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("fails closed on corrupt persisted state", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-audit-capture-"));
		const path = join(directory, "audit-capture-session.v1.json");
		try {
			writeFileSync(path, '{"schemaVersion":"audit-capture-session.v1"}');
			const coordinator = new FiveMinuteAuditCaptureCoordinator({
				store: new FileAuditCaptureStore(path),
				settleRange: async () => {},
			});
			await coordinator.initialize();
			await expect(coordinator.start()).rejects.toThrow("unavailable");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects unexpected persisted fields instead of carrying content forward", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-audit-capture-"));
		const path = join(directory, "audit-capture-session.v1.json");
		try {
			writeFileSync(
				path,
				JSON.stringify({
					schemaVersion: "audit-capture-session.v1",
					capture: {
						captureId: "ac1_0123456789abcdef",
						state: "collecting",
						fromMs: 5_000,
						toMs: 305_000,
						createdAtMs: 1,
						updatedAtMs: 1,
						settleNotBeforeMs: 317_000,
						settleAttemptedAtMs: null,
						text: "must-not-survive",
					},
				}),
			);
			await expect(new FileAuditCaptureStore(path).load()).rejects.toThrow(
				"invalid",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

async function drainMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
}
