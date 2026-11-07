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
});

describe("file audit capture store", () => {});

async function drainMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
}
