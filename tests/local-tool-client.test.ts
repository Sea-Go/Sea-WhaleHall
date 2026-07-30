import { describe, expect, test } from "bun:test";
import {
	JsonlParser,
	JsonlProtocolError,
	LocalClientError,
	LocalToolClient,
	STARTUP_GOAL_CHANGE_ENV,
	type ChildTransport,
} from "../src/agent/local-tool-client";
import type {
	LocalEventGoalChange,
	LocalMonitoringStatus,
	LocalToolDescriptor,
} from "../src/agent/local-protocol";
import { parseLocalMessage } from "../src/agent/local-protocol";
import type { DesktopEventV1 } from "../src/agent/reflection/types";

class FakeChild implements ChildTransport {
	pid = 4242;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	stdin: ChildTransport["stdin"];
	private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	private stderrController!: ReadableStreamDefaultController<Uint8Array>;
	private resolveExit!: (code: number) => void;
	private closed = false;
	endCalled = false;
	killCalled = false;

	constructor(private readonly onWrite: (value: string, child: FakeChild) => void = () => {}) {
		this.stdout = new ReadableStream({
			start: (controller) => {
				this.stdoutController = controller;
			},
		});
		this.stderr = new ReadableStream({
			start: (controller) => {
				this.stderrController = controller;
			},
		});
		this.exited = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.stdin = {
			write: (value) => {
				const text = typeof value === "string" ? value : new TextDecoder().decode(value);
				for (const line of text.trim().split("\n")) this.onWrite(line, this);
				return text.length;
			},
			flush: () => 0,
			end: () => {
				this.endCalled = true;
				this.exit(0);
				return 0;
			},
		};
	}

	respond(value: unknown): void {
		this.stdoutController.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
	}

	emitChunks(...values: string[]): void {
		for (const value of values) this.stdoutController.enqueue(new TextEncoder().encode(value));
	}

	exit(code: number): void {
		if (this.closed) return;
		this.closed = true;
		this.stdoutController.close();
		this.stderrController.close();
		this.resolveExit(code);
	}

	kill(): void {
		this.killCalled = true;
		this.exit(143);
	}
}

const descriptor: LocalToolDescriptor = {
	name: "system.info",
	description: "system",
	inputSchema: { type: "object" },
	risk: "read",
	requiredPermissions: [],
	supportsCancellation: false,
};

describe("JsonlParser", () => {
	const encoder = new TextEncoder();

	test("reassembles fragments and emits multiple lines", () => {
		const lines: string[] = [];
		const parser = new JsonlParser((line) => lines.push(line), 1024);
		parser.feed(encoder.encode('{"id":"1"'));
		parser.feed(encoder.encode('}\n{"id":"2"}\r\n'));
		expect(lines).toEqual(['{"id":"1"}', '{"id":"2"}']);
	});

	test("rejects an oversized line", () => {
		const parser = new JsonlParser(() => {}, 4);
		expect(() => parser.feed(encoder.encode("12345"))).toThrow(JsonlProtocolError);
	});

	test("rejects raw key fields and content hidden in metadata events", () => {
		const event = desktopEvent();
		expect(() =>
			parseLocalMessage(
				JSON.stringify({
					event: "desktop.event",
					data: { ...event, payload: { keyCount: 1, keyCode: 12 } },
				}),
			),
		).toThrow("invalid shape");
		expect(() =>
			parseLocalMessage(
				JSON.stringify({
					event: "desktop.event",
					data: {
						...event,
						kind: "browser.tabOpened",
						payload: {
							browserId: "safari",
							tabId: "tab-1",
							url: "https://private.example/",
						},
					},
				}),
			),
		).toThrow("invalid shape");
		expect(
			parseLocalMessage(
				JSON.stringify({
					event: "desktop.event",
					data: {
						...event,
						kind: "browser.tabOpened",
						sensitivity: "content",
						payload: {
							browserId: "safari",
							tabId: "tab-1",
							url: "https://example.test/",
						},
					},
				}),
			),
		).toMatchObject({ event: "desktop.event" });
	});

	test("validates each desktop payload with exact keys and sensitivity", () => {
		const event = desktopEvent();
		for (const payload of [
			{ appId: "code", appName: "Code", characters: "secret" },
			{ appId: "code", appName: "Code", sequence: ["a", "b"] },
			{ appId: "code" },
		]) {
			expect(() =>
				parseLocalMessage(
					JSON.stringify({
						event: "desktop.event",
						data: { ...event, payload },
					}),
				),
			).toThrow("invalid shape");
		}
		expect(() =>
			parseLocalMessage(
				JSON.stringify({
					event: "desktop.event",
					data: {
						...event,
						kind: "accessibility.focusChanged",
						payload: { appId: "code", role: "textBox", label: "private" },
					},
				}),
			),
		).toThrow("invalid shape");
		expect(
			parseLocalMessage(
				JSON.stringify({
					event: "desktop.event",
					data: {
						...event,
						kind: "authorization.granted",
						payload: { permissions: ["input.monitoring"] },
					},
				}),
			),
		).toMatchObject({ event: "desktop.event" });
	});
});

describe("LocalToolClient", () => {
	test("passes the isolated activity data directory to the Rust process", async () => {
		const child = new FakeChild();
		let receivedEnvironment: Readonly<Record<string, string>> | undefined;
		const client = new LocalToolClient("fake", {
			environment: {
				WHALEHALL_DATA_DIR: "/tmp/whalehall-test-data",
				[STARTUP_GOAL_CHANGE_ENV]: "stale-shell-value",
			},
			spawn: (_binaryPath, environment) => {
				receivedEnvironment = environment;
				return child;
			},
		});
		await client.start();
		expect(receivedEnvironment).toEqual({
			WHALEHALL_DATA_DIR: "/tmp/whalehall-test-data",
		});
		await client.stop();
		expect(child.endCalled).toBe(true);
		expect(child.killCalled).toBe(false);
	});

	test("injects only the explicitly prepared startup goal JSON", async () => {
		const child = new FakeChild();
		let receivedEnvironment: Readonly<Record<string, string>> | undefined;
		const change: LocalEventGoalChange = {
			previous: {
				goalId: "old-goal",
				planId: null,
				version: 1,
				text: "Old goal",
				activatedAtMs: 500,
			},
			next: null,
			occurredAtMs: 1_000,
			deduplicationKey: "startup-clear-1",
		};
		const client = new LocalToolClient("fake", {
			environment: { WHALEHALL_DATA_DIR: "/tmp/whalehall-test-data" },
			spawn: (_binaryPath, environment) => {
				receivedEnvironment = environment;
				return child;
			},
		});

		await client.prepareStartupGoalChange(change);
		await client.start();
		expect(receivedEnvironment?.[STARTUP_GOAL_CHANGE_ENV]).toBe(
			JSON.stringify(change),
		);
		await expect(client.prepareStartupGoalChange(null)).rejects.toThrow(
			"after whalehall-local has started",
		);
		await client.stop();
	});

	test("replays the exact prepared JSON when the child exits before startup acknowledgement", async () => {
		const first = new FakeChild();
		const second = new FakeChild();
		const environments: Array<Readonly<Record<string, string>> | undefined> = [];
		let spawnIndex = 0;
		const change: LocalEventGoalChange = {
			previous: null,
			next: {
				goalId: "goal-1",
				planId: null,
				version: 1,
				text: "Retry startup safely",
				activatedAtMs: 1_000,
			},
			occurredAtMs: 1_001,
			deduplicationKey: "startup-retry-1",
		};
		const client = new LocalToolClient("fake", {
			spawn: (_binaryPath, environment) => {
				environments.push(environment);
				return [first, second][spawnIndex++] as FakeChild;
			},
		});

		await client.prepareStartupGoalChange(change);
		await client.start();
		first.exit(1);
		await first.exited;
		await Bun.sleep(0);
		await client.prepareStartupGoalChange({
			...change,
			occurredAtMs: 2_000,
		});
		await client.start();
		expect(
			environments.map((environment) => environment?.[STARTUP_GOAL_CHANGE_ENV]),
		).toEqual([JSON.stringify(change), JSON.stringify(change)]);
		await client.stop();
	});

	test("clears the one-shot startup JSON only after reflection acknowledges materialization", async () => {
		const children = [
			new FakeChild((line, process) => {
				const request = JSON.parse(line) as { id: string; method: string };
				if (request.method === "runtime.health") {
					process.respond({
						id: request.id,
						ok: true,
						result: {
							service: "whalehall-local",
							version: "0.1.0",
							pid: 4242,
							status: "ok",
						},
					});
				}
			}),
			new FakeChild(),
		];
		const environments: Array<Readonly<Record<string, string>> | undefined> = [];
		let spawnIndex = 0;
		const client = new LocalToolClient("fake", {
			spawn: (_binaryPath, environment) => {
				environments.push(environment);
				return children[spawnIndex++] as FakeChild;
			},
		});
		await client.prepareStartupGoalChange({
			previous: null,
			next: {
				goalId: "goal-ack",
				planId: null,
				version: 1,
				text: "Acknowledge startup",
				activatedAtMs: 1,
			},
			occurredAtMs: 1,
			deduplicationKey: "acknowledged-startup",
		});
		await client.start();
		await client.health();
		await client.acknowledgeStartupGoalChange();
		await client.stop();
		await client.start();

		expect(environments[0]?.[STARTUP_GOAL_CHANGE_ENV]).toBeDefined();
		expect(environments[1]?.[STARTUP_GOAL_CHANGE_ENV]).toBeUndefined();
		await client.stop();
	});

	test("correlates responses and routes streamed events", async () => {
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as { id: string; method: string };
			if (request.method === "runtime.health") {
				process.respond({
					id: request.id,
					ok: true,
					result: { service: "whalehall-local", version: "0.1.0", pid: 4242, status: "ok" },
				});
			} else if (request.method === "tool.list") {
				process.respond({ id: request.id, ok: true, result: { tools: [descriptor] } });
			} else if (request.method === "tool.call") {
				const event = JSON.stringify({
					event: "tool.progress",
					callId: request.id,
					data: { progress: 50, message: "half" },
				});
				const response = JSON.stringify({
					id: request.id,
					ok: true,
					result: { callId: request.id, output: { os: "macos" } },
				});
				process.emitChunks(`${event.slice(0, 20)}`, `${event.slice(20)}\n${response}\n`);
			}
		});
		const client = new LocalToolClient("fake", { spawn: () => child });
		const events: string[] = [];
		client.onEvent((event) => events.push(event.event));
		await client.start();
		await expect(client.health()).resolves.toMatchObject({ status: "ok" });
		await expect(client.listTools()).resolves.toEqual([descriptor]);
		await expect(
			client.callTool({ callId: "call-1", name: "system.info", arguments: {} }),
		).resolves.toEqual({ callId: "call-1", output: { os: "macos" } });
		expect(events).toEqual(["tool.progress"]);
		await client.stop();
	});

	test("pulls, commits, and proactively routes durable desktop events", async () => {
		const event = desktopEvent();
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			if (request.method === "event.query") {
				process.respond({
					id: request.id,
					ok: true,
					result: { events: [event], nextCursor: event.cursor, hasMore: false },
				});
				return;
			}
			if (request.method === "event.commit") {
				process.respond({
					id: request.id,
					ok: true,
					result: {
						consumerId: request.params.consumerId,
						cursor: request.params.cursor,
						advanced: true,
					},
				});
			}
		});
		const client = new LocalToolClient("fake", { spawn: () => child });
		const pushed: DesktopEventV1[] = [];
		client.onDesktopEvent((value) => pushed.push(value));
		await client.start();
		child.respond({ event: "desktop.event", data: event });
		await Bun.sleep(0);
		expect(pushed).toEqual([event]);
		await expect(
			client.queryEvents({ consumerId: "reflection-runtime", limit: 100 }),
		).resolves.toEqual({
			events: [event],
			nextCursor: event.cursor,
			hasMore: false,
		});
		await expect(
			client.commitEventCursor("reflection-runtime", event.cursor),
		).resolves.toEqual({
			consumerId: "reflection-runtime",
			cursor: event.cursor,
			advanced: true,
		});
		await client.stop();
	});

	test("appends only the specific validated durable goal boundary", async () => {
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			if (request.method !== "event.goal.change") return;
			const previous = request.params.previous as null;
			const next = request.params.next as {
				goalId: string;
				planId: string | null;
				version: number;
				text: string;
				activatedAtMs: number;
			};
			const occurredAtMs = request.params.occurredAtMs as number;
			process.respond({
				id: request.id,
				ok: true,
				result: {
					inserted: true,
					event: {
						schemaVersion: "desktop-event.v1",
						eventId: "goal-event-1",
						cursor: "ec1_0000000000000001",
						deviceId: "native-device",
						sessionId: "native-session",
						kind: "goal.contextChanged",
						source: "planning.controller",
						occurredAtMs,
						observedAtMs: occurredAtMs,
						goalVersion: null,
						sensitivity: "content",
						payload: { previous, next },
					},
				},
			});
		});
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();
		const next = {
			goalId: "goal-1",
			planId: null,
			version: 1,
			text: "完成实现",
			activatedAtMs: 10_000,
		};

		await expect(
			client.appendGoalChange({
				previous: null,
				next,
				occurredAtMs: 10_000,
				deduplicationKey: "goal-change-1",
			}),
		).resolves.toMatchObject({
			inserted: true,
			event: {
				kind: "goal.contextChanged",
				payload: { previous: null, next },
			},
		});
		await client.stop();
	});

	test("validates and forwards every monitoring control request", async () => {
		const requests: Array<{
			method: string;
			params: Record<string, unknown>;
		}> = [];
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			if (!request.method.startsWith("monitoring.")) return;
			requests.push({ method: request.method, params: request.params });
			process.respond({
				id: request.id,
				ok: true,
				result: monitoringStatus({
					state:
						request.method === "monitoring.pause"
							? "paused"
							: request.method === "monitoring.configure" &&
								  request.params.enabled === false
								? "disabled"
								: "running",
					enabled:
						request.method === "monitoring.configure"
							? request.params.enabled === true
							: true,
				}),
			});
		});
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();

		await expect(client.getMonitoringStatus()).resolves.toMatchObject({
			state: "running",
		});
		await expect(
			client.configureMonitoring({
				enabled: false,
				captureContent: true,
				excludedBundleIds: ["com.example.private"],
			}),
		).resolves.toMatchObject({ state: "disabled", enabled: false });
		await expect(client.pauseMonitoring()).resolves.toMatchObject({
			state: "paused",
		});
		await expect(client.resumeMonitoring()).resolves.toMatchObject({
			state: "running",
		});
		await expect(
			client.refreshMonitoringPermissions({ prompt: true }),
		).resolves.toMatchObject({ state: "running" });

		expect(requests).toEqual([
			{ method: "monitoring.status", params: {} },
			{
				method: "monitoring.configure",
				params: {
					enabled: false,
					captureContent: true,
					excludedBundleIds: ["com.example.private"],
				},
			},
			{ method: "monitoring.pause", params: {} },
			{ method: "monitoring.resume", params: {} },
			{
				method: "monitoring.refreshPermissions",
				params: { prompt: true },
			},
		]);
		await expect(
			client.configureMonitoring({
				enabled: true,
				captureContent: true,
				excludedBundleIds: ["com.example.same", "com.example.same"],
			}),
		).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
		await client.stop();
	});

	test("times out a tool call and sends a best-effort cancellation", async () => {
		const methods: string[] = [];
		const child = new FakeChild((line) => {
			methods.push((JSON.parse(line) as { method: string }).method);
		});
		const client = new LocalToolClient("fake", {
			spawn: () => child,
			toolTimeoutMs: 10,
		});
		await client.start();
		await expect(
			client.callTool({ callId: "slow", name: "demo.wait", arguments: { durationMs: 5000 } }),
		).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
		expect(methods).toEqual(["tool.call", "tool.cancel"]);
		expect(client.isRunning).toBe(true);
		await client.stop();
	});

	test("rejects pending requests when the process exits", async () => {
		const child = new FakeChild();
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();
		const request = client.listTools();
		child.exit(9);
		await expect(request).rejects.toMatchObject({ code: "PROCESS_EXITED" });
		expect(client.isRunning).toBe(false);
	});

	test("kills the child on malformed stdout", async () => {
		const child = new FakeChild();
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();
		const request = client.listTools();
		child.emitChunks("not-json\n");
		await expect(request).rejects.toBeInstanceOf(LocalClientError);
		expect(client.isRunning).toBe(false);
	});
});

function desktopEvent(): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: "event-1",
		cursor: "ec1_0000000000000001",
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "application.foregroundChanged",
		source: "activity.sensor",
		occurredAtMs: 1_000,
		observedAtMs: 1_001,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { appId: "com.microsoft.VSCode", appName: "Visual Studio Code" },
	};
}

function monitoringStatus(
	overrides: Partial<LocalMonitoringStatus> = {},
): LocalMonitoringStatus {
	return {
		state: "running",
		enabled: true,
		captureContent: true,
		excludedBundleIds: [],
		helperPid: 4243,
		helperPathAvailable: true,
		bootId: "boot-test",
		lastSequence: 10,
		lastAckedSequence: 10,
		lastHeartbeatAtMs: 1_800_000_000_000,
		permissions: {
			accessibility: "granted",
			screenRecording: "granted",
			inputMonitoring: "granted",
			automation: "granted",
		},
		permissionCheckState: "current",
		permissionsCheckedAtMs: 1_800_000_000_000,
		coverage: ["content", "metadata"],
		lastError: null,
		...overrides,
	};
}
