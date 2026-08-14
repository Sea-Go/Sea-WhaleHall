import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	LocalEventCommitResult,
	LocalEventGoalChange,
	LocalEventGoalChangeResult,
	LocalEventQuery,
	LocalEventQueryResult,
} from "../src/agent/local-protocol";
import {
	type DesktopEventTransport,
	DesktopReflectionService,
} from "../src/agent/reflection/service";
import { SqliteReflectionRepository } from "../src/agent/reflection/sqlite-repository";
import type { DesktopEventV1 } from "../src/agent/reflection/types";
import {
	createOwnedWhaleHallReflectionRuntime,
	stopNativeAgentWithReflection,
} from "../src/bun/reflection-runtime";

describe("WhaleHall reflection shutdown ownership", () => {
	test("native stop releases a pending Reflection RPC before the single-flight repository close", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-reflection-stop-"));
		const order: string[] = [];
		const repository = new CountingSqliteReflectionRepository(
			join(directory, "reflection.sqlite3"),
			order,
		);
		const transport = new BlockingTransport();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: {
				infer: async () => {
					throw new Error("no reflection job expected");
				},
			},
			identity: {
				collectorId: "collector-1",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			jobPollMs: 60_000,
			eventPollMs: 60_000,
		});

		try {
			await service.start();
			transport.blockNextQuery();
			const pendingPull = service.pullNow();
			const observedPull = pendingPull.catch((error: unknown) => error);
			await transport.queryStarted;

			const runtime = createOwnedWhaleHallReflectionRuntime({
				service,
				repository,
				teacherVerified: false,
			});
			runtime.beginShutdown();
			runtime.beginShutdown();
			let firstClose: Promise<void> | null = null;
			let secondClose: Promise<void> | null = null;

			await stopNativeAgentWithReflection({
				drainProducers: async () => {
					order.push("producer-drain");
				},
				stopNativeAgent: async () => {
					order.push("native-stop");
					transport.rejectPending(new Error("local process stopped"));
				},
				closeReflection: () => {
					order.push("reflection-close");
					firstClose = runtime.close();
					secondClose = runtime.close();
					return firstClose;
				},
			});

			expect(firstClose).toBe(secondClose);
			expect(repository.closeCalls).toBe(1);
			expect(order).toEqual([
				"producer-drain",
				"native-stop",
				"reflection-close",
				"repository-close",
			]);
			expect(await observedPull).toBeInstanceOf(Error);
		} finally {
			if (repository.closeCalls === 0) repository.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

class CountingSqliteReflectionRepository extends SqliteReflectionRepository {
	closeCalls = 0;

	constructor(
		path: string,
		private readonly order: string[],
	) {
		super(path);
	}

	override close(): void {
		this.closeCalls += 1;
		this.order.push("repository-close");
		super.close();
	}
}

class BlockingTransport implements DesktopEventTransport {
	private readonly listeners = new Set<(event: DesktopEventV1) => void>();
	private shouldBlock = false;
	private queryStartedResolve: (() => void) | null = null;
	private rejectQuery: ((error: Error) => void) | null = null;
	queryStarted: Promise<void> = Promise.resolve();

	blockNextQuery(): void {
		this.shouldBlock = true;
		this.queryStarted = new Promise<void>((resolve) => {
			this.queryStartedResolve = resolve;
		});
	}

	rejectPending(error: Error): void {
		const reject = this.rejectQuery;
		this.rejectQuery = null;
		reject?.(error);
	}

	async prepareStartupGoalChange(
		_change: LocalEventGoalChange | null,
	): Promise<void> {}

	async acknowledgeStartupGoalChange(): Promise<void> {}

	async start(): Promise<void> {}

	queryDesktopEvents(_query: LocalEventQuery): Promise<LocalEventQueryResult> {
		if (!this.shouldBlock) {
			return Promise.resolve({ events: [], nextCursor: null, hasMore: false });
		}
		this.shouldBlock = false;
		this.queryStartedResolve?.();
		this.queryStartedResolve = null;
		return new Promise<LocalEventQueryResult>((_resolve, reject) => {
			this.rejectQuery = reject;
		});
	}

	async commitDesktopEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult> {
		return { consumerId, cursor, advanced: true };
	}

	async appendDesktopGoalChange(
		_change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult> {
		throw new Error("goal append not expected");
	}

	onDesktopEvent(listener: (event: DesktopEventV1) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
