import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_CAPTURE_DURATION_MS,
	AUDIT_CAPTURE_JOB_GRACE_MS,
	AUDIT_CAPTURE_SETTLE_DELAY_MS,
	AUDIT_CAPTURE_SETTLE_POLL_MS,
	type AuditCaptureScheduler,
	type AuditCaptureSettlementResult,
	type AuditCaptureStore,
	alignToCurrentOrNextBucket,
	FileAuditCaptureStore,
	FiveMinuteAuditCaptureCoordinator,
	lastEffectiveAuditCursor,
	type PersistedAuditCaptureState,
	settleEffectiveAuditAuthorities,
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
	settleRange?: (
		fromMs: number,
		toMs: number,
	) => Promise<AuditCaptureSettlementResult>;
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
				return { state: "ready" };
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

	test("treats empty and boundary-only ranges as having no effective authority cursor", () => {
		expect(lastEffectiveAuditCursor([], 5_000, 305_000)).toBeNull();
		expect(
			lastEffectiveAuditCursor(
				[
					{
						cursor: "sec2_0000000000000002",
						countClass: "boundary",
						occurredAtMs: 10_000,
					},
					{
						cursor: "sec2_0000000000000003",
						countClass: "effective",
						occurredAtMs: 305_000,
					},
				],
				5_000,
				305_000,
			),
		).toBeNull();
	});

	test("selects the highest in-range effective cursor regardless of input order", () => {
		expect(
			lastEffectiveAuditCursor(
				[
					{
						cursor: "sec2_0000000000000009",
						countClass: "effective",
						occurredAtMs: 20_000,
					},
					{
						cursor: "sec2_000000000000000a",
						countClass: "effective",
						occurredAtMs: 10_000,
					},
					{
						cursor: "sec2_000000000000000b",
						countClass: "ignored",
						occurredAtMs: 30_000,
					},
				],
				5_000,
				305_000,
			),
		).toBe("sec2_000000000000000a");
	});

	test("does not let a later COMMITTED window hide an earlier failed window", async () => {
		const events = [
			{
				cursor: "sec2_0000000000000001",
				countClass: "effective" as const,
				occurredAtMs: 10_000,
			},
			{
				cursor: "sec2_0000000000000002",
				countClass: "effective" as const,
				occurredAtMs: 20_000,
			},
		];
		const result = await settleEffectiveAuditAuthorities(
			events,
			5_000,
			305_000,
			async (cursor) =>
				cursor.endsWith("1")
					? {
							state: "terminal_failed",
							windowId: "window-earlier",
							failureCode: "inference_failed",
						}
					: { state: "committed", windowId: "window-later" },
		);
		expect(result).toEqual({
			state: "failed",
			failureCode: "timeline_job_terminal_failure",
		});
	});

	test("waits when any earlier window is pending even if the latest is COMMITTED", async () => {
		const visited: string[] = [];
		const result = await settleEffectiveAuditAuthorities(
			[
				{
					cursor: "sec2_0000000000000001",
					countClass: "effective",
					occurredAtMs: 10_000,
				},
				{
					cursor: "sec2_0000000000000002",
					countClass: "effective",
					occurredAtMs: 20_000,
				},
			],
			5_000,
			305_000,
			async (cursor) => {
				visited.push(cursor);
				return cursor.endsWith("1")
					? { state: "pending", windowId: "window-earlier" }
					: { state: "committed", windowId: "window-later" };
			},
		);
		expect(result).toEqual({ state: "pending" });
		expect(visited).toEqual(["sec2_0000000000000001", "sec2_0000000000000002"]);
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
		expect(first.authoritativeCoverage).toBe("pending");
		expect(first.failureCode).toBeNull();
		expect(Object.keys(first).sort()).toEqual([
			"analysisCompleteness",
			"authoritativeCoverage",
			"captureId",
			"failureCode",
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
		await harness.clock.advanceTo(capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS);
		expect(harness.settled).toEqual([
			{ fromMs: capture.fromMs, toMs: capture.toMs },
		]);
		expect((await harness.coordinator.status())?.state).toBe("ready");
		expect((await harness.coordinator.status())?.authoritativeCoverage).toBe(
			"complete",
		);

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

		await harness.clock.advanceTo(capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS);
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
			failureCode: null,
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

	test("replays an in-flight idempotent settlement after a restart", async () => {
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
			failureCode: null,
		};
		const harness = createHarness({ nowMs: 400_000, store });

		await harness.coordinator.initialize();
		await drainMicrotasks();

		expect(harness.settled).toEqual([{ fromMs: 5_000, toMs: 305_000 }]);
		expect((await harness.coordinator.status())?.state).toBe("ready");
	});

	test("persists an explicit authority failure code without leaking details", async () => {
		const errors: unknown[] = [];
		const clock = new FakeClock();
		const coordinator = new FiveMinuteAuditCaptureCoordinator({
			store: new MemoryStore(),
			scheduler: clock,
			nowMs: () => clock.now,
			createCaptureId: () => "ac1_0123456789abcdef",
			async settleRange() {
				return {
					state: "failed",
					failureCode: "timeline_job_terminal_failure",
				};
			},
			onError: (error) => errors.push(error),
		});
		await coordinator.initialize();
		const capture = await coordinator.start();

		await clock.advanceTo(capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS);

		const status = await coordinator.status();
		expect(status?.state).toBe("failed");
		expect(status?.authoritativeCoverage).toBe("unavailable");
		expect(status?.failureCode).toBe("timeline_job_terminal_failure");
		expect(JSON.stringify(status)).not.toContain("sensitive");
		expect(errors).toHaveLength(0);
	});

	test("polls until authoritative coverage is ready instead of treating the first projection as ready", async () => {
		let attempts = 0;
		const harness = createHarness({
			async settleRange() {
				attempts += 1;
				return attempts < 3 ? { state: "pending" } : { state: "ready" };
			},
		});
		await harness.coordinator.initialize();
		const capture = await harness.coordinator.start();

		await harness.clock.advanceTo(capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS);
		expect((await harness.coordinator.status())?.state).toBe("settling");
		expect(attempts).toBe(1);

		await harness.clock.advanceTo(
			capture.toMs +
				AUDIT_CAPTURE_SETTLE_DELAY_MS +
				AUDIT_CAPTURE_SETTLE_POLL_MS,
		);
		expect((await harness.coordinator.status())?.state).toBe("settling");
		expect(attempts).toBe(2);

		await harness.clock.advanceTo(
			capture.toMs +
				AUDIT_CAPTURE_SETTLE_DELAY_MS +
				2 * AUDIT_CAPTURE_SETTLE_POLL_MS,
		);
		expect((await harness.coordinator.status())?.state).toBe("ready");
		expect(attempts).toBe(3);
	});

	test("fails with a bounded authority timeout after natural-window and job grace", async () => {
		const harness = createHarness({
			async settleRange() {
				return { state: "pending" };
			},
		});
		await harness.coordinator.initialize();
		const capture = await harness.coordinator.start();
		const deadline =
			capture.toMs + AUDIT_CAPTURE_DURATION_MS + AUDIT_CAPTURE_JOB_GRACE_MS;

		await harness.clock.advanceTo(deadline - 1);
		expect((await harness.coordinator.status())?.state).toBe("settling");
		await harness.clock.advanceTo(deadline);
		expect(await harness.coordinator.status()).toMatchObject({
			state: "failed",
			authoritativeCoverage: "unavailable",
			failureCode: "authoritative_coverage_timeout",
		});
	});

	test("settlement runs outside bounded status and cancel operations", async () => {
		let finishSettlement: () => void = () => {};
		const settlement = new Promise<void>((resolve) => {
			finishSettlement = resolve;
		});
		const harness = createHarness({
			async settleRange() {
				await settlement;
				return { state: "ready" };
			},
		});
		await harness.coordinator.initialize();
		const capture = await harness.coordinator.start();
		await harness.clock.advanceTo(capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS);

		expect((await harness.coordinator.status())?.state).toBe("settling");
		expect((await harness.coordinator.cancel(capture.captureId))?.state).toBe(
			"cancelled",
		);

		finishSettlement();
		await drainMicrotasks();
		expect((await harness.coordinator.status())?.state).toBe("cancelled");
	});

	test("shutdown waits for an in-flight settlement before timeline ownership ends", async () => {
		let finishSettlement: () => void = () => {};
		const settlement = new Promise<void>((resolve) => {
			finishSettlement = resolve;
		});
		const harness = createHarness({
			async settleRange() {
				await settlement;
				return { state: "ready" };
			},
		});
		await harness.coordinator.initialize();
		const capture = await harness.coordinator.start();
		await harness.clock.advanceTo(capture.toMs + AUDIT_CAPTURE_SETTLE_DELAY_MS);
		let drained = false;
		const shutdown = harness.coordinator.shutdown().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBeFalse();
		finishSettlement();
		await shutdown;
		expect(drained).toBeTrue();
		await expect(harness.coordinator.start()).rejects.toThrow("unavailable");
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
				failureCode: null,
			};
			await store.save(capture);

			expect(await store.load()).toEqual(capture);
			const metadata = statSync(path);
			expect(metadata.isFile()).toBeTrue();
			if (process.platform !== "win32") {
				expect(metadata.mode & 0o777).toBe(0o600);
			}
			expect(readdirSync(directory)).toEqual(["audit-capture-session.v1.json"]);
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
				settleRange: async () => ({ state: "ready" }),
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

	test("migrates a legacy completed capture back through authoritative settlement", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-audit-capture-"));
		const path = join(directory, "audit-capture-session.v1.json");
		try {
			writeFileSync(
				path,
				JSON.stringify({
					schemaVersion: "audit-capture-session.v1",
					capture: {
						captureId: "ac1_0123456789abcdef",
						state: "ready",
						fromMs: 5_000,
						toMs: 305_000,
						createdAtMs: 1,
						updatedAtMs: 317_000,
						settleNotBeforeMs: 317_000,
						settleAttemptedAtMs: 317_000,
					},
				}),
			);
			expect(await new FileAuditCaptureStore(path).load()).toMatchObject({
				state: "settling",
				failureCode: null,
			});
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
