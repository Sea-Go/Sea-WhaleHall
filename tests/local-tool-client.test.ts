import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	LocalEventGoalChange,
	LocalMonitoringStatus,
	LocalToolDescriptor,
} from "../src/agent/local-protocol";
import { parseLocalMessage } from "../src/agent/local-protocol";
import {
	type ChildTransport,
	createLocalToolProcessEnvironment,
	JsonlParser,
	JsonlProtocolError,
	LocalClientError,
	LocalToolClient,
	STARTUP_GOAL_CHANGE_ENV,
} from "../src/agent/local-tool-client";
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
	readonly killSignals: Array<number | NodeJS.Signals | undefined> = [];

	constructor(
		private readonly onWrite: (
			value: string,
			child: FakeChild,
		) => void = () => {},
		private readonly lifecycle: {
			exitOnEnd?: boolean;
			exitOnKill?: boolean;
			throwOnKill?: boolean;
		} = {},
	) {
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
				const text =
					typeof value === "string" ? value : new TextDecoder().decode(value);
				for (const line of text.trim().split("\n")) this.onWrite(line, this);
				return text.length;
			},
			flush: () => 0,
			end: () => {
				this.endCalled = true;
				if (this.lifecycle.exitOnEnd !== false) this.exit(0);
				return 0;
			},
		};
	}

	respond(value: unknown): void {
		this.stdoutController.enqueue(
			new TextEncoder().encode(`${JSON.stringify(value)}\n`),
		);
	}

	emitChunks(...values: string[]): void {
		for (const value of values)
			this.stdoutController.enqueue(new TextEncoder().encode(value));
	}

	exit(code: number): void {
		if (this.closed) return;
		this.closed = true;
		this.stdoutController.close();
		this.stderrController.close();
		this.resolveExit(code);
	}

	kill(signal?: number | NodeJS.Signals): void {
		this.killCalled = true;
		this.killSignals.push(signal);
		if (this.lifecycle.throwOnKill) throw new Error("kill failed");
		if (this.lifecycle.exitOnKill !== false) this.exit(137);
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
		expect(() => parser.feed(encoder.encode("12345"))).toThrow(
			JsonlProtocolError,
		);
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
	test("builds a closed Rust environment and scrubs inherited and explicit credentials", () => {
		const environment = createLocalToolProcessEnvironment(
			{
				Path: "/inherited/bin",
				SystemRoot: "C:\\Windows",
				HOME: "/home/whalehall",
				WHALEHALL_ACTIVITY_POLL_MS: "75",
				WHALEHALL_TIMELINE_MODERNBERT_TOKEN: "timeline-token",
				OPENAI_API_KEY: "provider-key",
				SERVICE_SECRET: "service-secret",
				DATABASE_PASSWORD: "database-password",
				AUTHORIZATION: "Bearer access-token",
				HTTP_COOKIE: "session=cookie",
				UNREVIEWED_RUNTIME_SETTING: "must-not-pass",
				[STARTUP_GOAL_CHANGE_ENV]: "stale-inherited-goal",
			},
			{
				PATH: "/explicit/bin",
				WHALEHALL_DATA_DIR: "/tmp/whalehall-test-data",
				WHALEHALL_BROWSER_EVENT_MONITORING_ENABLED: "true",
				WHALEHALL_TIMELINE_MODERNBERT_TOKEN: "explicit-token",
				SERVICE_PASSWORD: "explicit-password",
				[STARTUP_GOAL_CHANGE_ENV]: "stale-explicit-goal",
			},
			'{"deduplicationKey":"prepared-goal"}',
		);

		expect(environment).toEqual({
			PATH: "/explicit/bin",
			SystemRoot: "C:\\Windows",
			HOME: "/home/whalehall",
			WHALEHALL_ACTIVITY_POLL_MS: "75",
			WHALEHALL_DATA_DIR: "/tmp/whalehall-test-data",
			WHALEHALL_BROWSER_EVENT_MONITORING_ENABLED: "true",
			[STARTUP_GOAL_CHANGE_ENV]: '{"deduplicationKey":"prepared-goal"}',
		});
	});

	test("passes only reviewed runtime and sensor options to the Rust process", async () => {
		const child = new FakeChild();
		let receivedEnvironment: Readonly<Record<string, string>> | undefined;
		const client = new LocalToolClient("fake", {
			environment: {
				WHALEHALL_DATA_DIR: "/tmp/whalehall-test-data",
				WHALEHALL_ACTIVITY_POLL_MS: "75",
				WHALEHALL_BROWSER_EVENT_MONITORING_ENABLED: "true",
				WHALEHALL_TIMELINE_MODERNBERT_TOKEN: "timeline-token",
				OPENAI_API_KEY: "provider-key",
				SERVICE_SECRET: "service-secret",
				DATABASE_PASSWORD: "database-password",
				AUTHORIZATION: "Bearer access-token",
				HTTP_COOKIE: "session=cookie",
				UNREVIEWED_RUNTIME_SETTING: "must-not-pass",
				[STARTUP_GOAL_CHANGE_ENV]: "stale-shell-value",
			},
			spawn: (_binaryPath, environment) => {
				receivedEnvironment = environment;
				return child;
			},
		});
		await client.start();
		expect(receivedEnvironment).toMatchObject({
			WHALEHALL_DATA_DIR: "/tmp/whalehall-test-data",
			WHALEHALL_ACTIVITY_POLL_MS: "75",
			WHALEHALL_BROWSER_EVENT_MONITORING_ENABLED: "true",
		});
		expect(receivedEnvironment).not.toHaveProperty(
			"WHALEHALL_TIMELINE_MODERNBERT_TOKEN",
		);
		expect(receivedEnvironment).not.toHaveProperty("OPENAI_API_KEY");
		expect(receivedEnvironment).not.toHaveProperty("SERVICE_SECRET");
		expect(receivedEnvironment).not.toHaveProperty("DATABASE_PASSWORD");
		expect(receivedEnvironment).not.toHaveProperty("AUTHORIZATION");
		expect(receivedEnvironment).not.toHaveProperty("HTTP_COOKIE");
		expect(receivedEnvironment).not.toHaveProperty(
			"UNREVIEWED_RUNTIME_SETTING",
		);
		expect(receivedEnvironment).not.toHaveProperty(STARTUP_GOAL_CHANGE_ENV);
		await client.stop();
		expect(child.endCalled).toBe(true);
		expect(child.killCalled).toBe(false);
	});

	test("waits for process exit after the graceful window requires a kill", async () => {
		const child = new FakeChild(() => {}, {
			exitOnEnd: false,
			exitOnKill: false,
		});
		let gracefulWindowMs: number | undefined;
		const shutdownSleeps: number[] = [];
		const client = new LocalToolClient("fake", {
			spawn: () => child,
			shutdownSleep: async (durationMs) => {
				gracefulWindowMs ??= durationMs;
				shutdownSleeps.push(durationMs);
				if (durationMs === 2_000) await new Promise(() => {});
			},
		});
		await client.start();

		let settled = false;
		const stopping = client.stop();
		expect(client.stop()).toBe(stopping);
		void stopping.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (let attempt = 0; attempt < 100 && !child.killCalled; attempt += 1) {
			await Bun.sleep(1);
		}

		expect(child.endCalled).toBe(true);
		expect(gracefulWindowMs).toBe(10_000);
		expect(shutdownSleeps).toEqual([10_000, 2_000]);
		expect(child.killCalled).toBe(true);
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(settled).toBe(false);
		child.exit(137);
		await expect(stopping).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	test("retains ownership when a successful kill does not produce an exit", async () => {
		const child = new FakeChild(() => {}, {
			exitOnEnd: false,
			exitOnKill: false,
		});
		const shutdownSleeps: number[] = [];
		const client = new LocalToolClient("fake", {
			spawn: () => child,
			shutdownSleep: async (durationMs) => {
				shutdownSleeps.push(durationMs);
			},
		});
		await client.start();

		await expect(client.stop()).rejects.toMatchObject({ code: "STOP_FAILED" });
		expect(shutdownSleeps).toEqual([10_000, 2_000]);
		expect(child.killCalled).toBe(true);
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(client.isRunning).toBe(true);
		child.exit(143);
		await waitForClientStopped(client);
		expect(client.isRunning).toBe(false);
	});

	test("reports a kill failure after the graceful window", async () => {
		const child = new FakeChild(() => {}, {
			exitOnEnd: false,
			throwOnKill: true,
		});
		const shutdownSleeps: number[] = [];
		const client = new LocalToolClient("fake", {
			spawn: () => child,
			shutdownSleep: async (durationMs) => {
				shutdownSleeps.push(durationMs);
			},
		});
		await client.start();

		await expect(client.stop()).rejects.toMatchObject({ code: "STOP_FAILED" });
		expect(shutdownSleeps).toEqual([10_000, 2_000]);
		expect(child.endCalled).toBe(true);
		expect(child.killCalled).toBe(true);
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(client.isRunning).toBe(true);
		child.exit(143);
		await waitForClientStopped(client);
		expect(client.isRunning).toBe(false);
	});

	test("restart waits for failed tree cleanup and never writes to the failed owner", async () => {
		const failed = new FakeChild(() => {}, {
			exitOnEnd: false,
			exitOnKill: false,
		});
		const replacement = new FakeChild();
		replacement.pid = 4343;
		let spawnCalls = 0;
		let replacementEnvironment: Readonly<Record<string, string>> | undefined;
		const client = new LocalToolClient("fake", {
			spawn: (_binaryPath, environment) => {
				spawnCalls += 1;
				if (spawnCalls === 2) replacementEnvironment = environment;
				return spawnCalls === 1 ? failed : replacement;
			},
			shutdownSleep: async (durationMs) => {
				if (durationMs === 2_000) await new Promise(() => {});
			},
		});
		await client.start();
		const pending = client.listTools();
		failed.emitChunks("not-json\n");
		await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		// The failed process tree remains privately owned until cleanup settles,
		// but must never be projected as a usable native runtime.
		expect(client.isRunning).toBeFalse();
		expect(client.pid).toBeNull();
		await expect(client.health()).rejects.toMatchObject({
			code: "PROCESS_EXITED",
		});

		const change: LocalEventGoalChange = {
			previous: null,
			next: {
				goalId: "goal-after-cleanup",
				planId: null,
				version: 1,
				text: "Restart only after exact cleanup",
				activatedAtMs: 1_000,
			},
			occurredAtMs: 1_000,
			deduplicationKey: "failed-owner-restart",
		};
		let preparationSettled = false;
		const preparation = client.prepareStartupGoalChange(change).then(() => {
			preparationSettled = true;
		});
		await Bun.sleep(1);
		expect(spawnCalls).toBe(1);
		expect(preparationSettled).toBeFalse();

		failed.exit(137);
		await preparation;
		expect(spawnCalls).toBe(1);
		await client.start();
		expect(spawnCalls).toBe(2);
		expect(client.pid).toBe(4343);
		expect(replacementEnvironment?.[STARTUP_GOAL_CHANGE_ENV]).toBe(
			JSON.stringify(change),
		);
		await client.stop();
	});

	test.skipIf(process.platform === "win32")(
		"detects an Observer survivor after graceful leader exit and removes its group",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "whalehall-local-tree-"));
			const fixture = join(
				import.meta.dir,
				"fixtures",
				"local-tool-process-tree.sh",
			);
			const client = new LocalToolClient(fixture, {
				environment: { WHALEHALL_DATA_DIR: directory },
				shutdownSleep: (durationMs) =>
					durationMs === 10_000 ? Bun.sleep(250) : Bun.sleep(durationMs),
			});
			try {
				await client.start();
				const leaderPid = client.pid;
				if (leaderPid === null) throw new Error("fixture leader did not start");
				const observerPid = await waitForFixtureProcessId(
					join(directory, "observer.pid"),
				);
				expect(isProcessAlive(leaderPid)).toBeTrue();
				expect(isProcessAlive(observerPid)).toBeTrue();

				await client.stop();

				expect(
					readFileSync(join(directory, "leader-exited"), "utf8").trim(),
				).toBe("leader-exited");
				expect(client.isRunning).toBeFalse();
				expect(isProcessAlive(leaderPid)).toBeFalse();
				expect(isProcessAlive(observerPid)).toBeFalse();
				expect(isProcessGroupAlive(leaderPid)).toBeFalse();
			} finally {
				if (client.isRunning) await client.stop().catch(() => undefined);
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"protocol failure retains ownership until the detached process tree is gone",
		async () => {
			const directory = mkdtempSync(
				join(tmpdir(), "whalehall-local-protocol-"),
			);
			const failures: LocalClientError[] = [];
			const client = new LocalToolClient(
				join(
					import.meta.dir,
					"fixtures",
					"local-tool-protocol-failure-tree.sh",
				),
				{ environment: { WHALEHALL_DATA_DIR: directory } },
			);
			client.onFailure((error) => failures.push(error));
			try {
				await client.start();
				const { leaderPid, observerPid } = await waitForFixtureTree(directory);
				await waitForClientStopped(client);

				expect(
					failures.some((error) => error.code === "PROTOCOL_ERROR"),
				).toBeTrue();
				expect(isProcessAlive(leaderPid)).toBeFalse();
				expect(isProcessAlive(observerPid)).toBeFalse();
				expect(isProcessGroupAlive(leaderPid)).toBeFalse();
			} finally {
				if (client.isRunning) await client.stop().catch(() => undefined);
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"unexpected leader crash retains ownership until its Observer is reaped",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "whalehall-local-crash-"));
			const failures: LocalClientError[] = [];
			const client = new LocalToolClient(
				join(import.meta.dir, "fixtures", "local-tool-crash-tree.sh"),
				{ environment: { WHALEHALL_DATA_DIR: directory } },
			);
			client.onFailure((error) => failures.push(error));
			try {
				await client.start();
				const { leaderPid, observerPid } = await waitForFixtureTree(directory);
				expect(isProcessAlive(observerPid)).toBeTrue();
				await waitForClientStopped(client);

				expect(
					failures.some((error) => error.code === "PROCESS_EXITED"),
				).toBeTrue();
				expect(isProcessAlive(leaderPid)).toBeFalse();
				expect(isProcessAlive(observerPid)).toBeFalse();
				expect(isProcessGroupAlive(leaderPid)).toBeFalse();
			} finally {
				if (client.isRunning) await client.stop().catch(() => undefined);
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test("locks the Rust process Job and EOF cleanup behind Windows tree completion", () => {
		const mainSource = readFileSync(
			join(
				import.meta.dir,
				"..",
				"whalehall-local",
				"server",
				"src",
				"main.rs",
			),
			"utf8",
		);
		const serverSource = readFileSync(
			join(import.meta.dir, "..", "whalehall-local", "server", "src", "lib.rs"),
			"utf8",
		);
		const observerSource = readFileSync(
			join(
				import.meta.dir,
				"..",
				"whalehall-local",
				"server",
				"src",
				"observer.rs",
			),
			"utf8",
		);
		const windowsTreeSource = readFileSync(
			join(
				import.meta.dir,
				"..",
				"whalehall-local",
				"server",
				"src",
				"windows_process_tree.rs",
			),
			"utf8",
		);
		const eofCleanupStart = serverSource.indexOf("calls.abort_all();");
		const supervisorShutdown = serverSource.indexOf(
			"observer.shutdown().await;",
			eofCleanupStart,
		);
		const remainingServicesShutdown = serverSource.indexOf(
			"services.shutdown().await;",
			eofCleanupStart,
		);
		expect(eofCleanupStart).toBeGreaterThanOrEqual(0);
		expect(supervisorShutdown).toBeGreaterThan(eofCleanupStart);
		expect(remainingServicesShutdown).toBeGreaterThan(supervisorShutdown);

		const childShutdownStart = observerSource.indexOf(
			'let _ = send_simple_command(&mut stdin, "shutdown-parent", "shutdown").await;',
		);
		const boundedWait = observerSource.indexOf(
			"tokio::time::timeout(Duration::from_secs(2), child.wait()).await",
			childShutdownStart,
		);
		const forcedKill = observerSource.indexOf(
			"let _ = child.kill().await;",
			boundedWait,
		);
		const exactReap = observerSource.indexOf(
			"let _ = child.wait().await;",
			forcedKill,
		);
		expect(childShutdownStart).toBeGreaterThanOrEqual(0);
		expect(boundedWait).toBeGreaterThan(childShutdownStart);
		expect(forcedKill).toBeGreaterThan(boundedWait);
		expect(exactReap).toBeGreaterThan(forcedKill);

		const jobInstallation = mainSource.indexOf(
			"install_current_process_tree_job()?;",
		);
		const serveCompletion = mainSource.indexOf(
			"let result = serve(BufReader::new(tokio::io::stdin()), tokio::io::stdout()).await;",
		);
		const returnResult = mainSource.indexOf("result", serveCompletion + 1);
		expect(jobInstallation).toBeGreaterThanOrEqual(0);
		expect(serveCompletion).toBeGreaterThan(jobInstallation);
		expect(returnResult).toBeGreaterThan(serveCompletion);
		expect(windowsTreeSource).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
		expect(windowsTreeSource).toContain("AssignProcessToJobObject(");
		expect(windowsTreeSource).toContain("GetCurrentProcess()");
		expect(windowsTreeSource).toContain(
			"static CURRENT_PROCESS_TREE_JOB: Mutex<Option<OwnedHandle>>",
		);
	});

	test("locks Windows forced tree close to exact taskkill and leader confirmation", () => {
		const source = readFileSync(
			join(import.meta.dir, "..", "src", "agent", "local-tool-client.ts"),
			"utf8",
		);
		expect(source).toContain(
			'const WINDOWS_TASKKILL_PATH = "C:\\\\Windows\\\\System32\\\\taskkill.exe";',
		);
		const windowsTreeStart = source.indexOf(
			"function createWindowsProcessTree(processId: number)",
		);
		const exactTreeCommand = source.indexOf(
			'cmd: [WINDOWS_TASKKILL_PATH, "/PID", String(processId), "/T", "/F"]',
			windowsTreeStart,
		);
		const helperExitWait = source.indexOf("taskkill.exited", exactTreeCommand);
		const unsuccessfulCommandGate = source.indexOf(
			"if (exitCode !== 0)",
			helperExitWait,
		);
		const treeConfirmation = source.indexOf(
			"taskkillConfirmed = true",
			unsuccessfulCommandGate,
		);
		expect(windowsTreeStart).toBeGreaterThanOrEqual(0);
		expect(exactTreeCommand).toBeGreaterThan(windowsTreeStart);
		expect(helperExitWait).toBeGreaterThan(exactTreeCommand);
		expect(unsuccessfulCommandGate).toBeGreaterThan(helperExitWait);
		expect(treeConfirmation).toBeGreaterThan(unsuccessfulCommandGate);

		expect(source).toContain("leaderExitCode !== null &&");
		expect(source).toContain("treeExited ||");
		expect(source).toContain(
			"ownedTree.leaderExitCompletesTree(leaderExitCode)",
		);
		expect(source).toContain("await taskkill.exited;");
		expect(source).toContain("leaderExitCompletesTree: () => true");
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
		const environments: Array<Readonly<Record<string, string>> | undefined> =
			[];
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
		const environments: Array<Readonly<Record<string, string>> | undefined> =
			[];
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
					result: {
						service: "whalehall-local",
						version: "0.1.0",
						pid: 4242,
						status: "ok",
					},
				});
			} else if (request.method === "tool.list") {
				process.respond({
					id: request.id,
					ok: true,
					result: { tools: [descriptor] },
				});
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
				process.emitChunks(
					`${event.slice(0, 20)}`,
					`${event.slice(20)}\n${response}\n`,
				);
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
			if (request.method === "event.tailCursor") {
				process.respond({
					id: request.id,
					ok: true,
					result: { cursor: event.cursor },
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
		await expect(client.getEventTailCursor()).resolves.toEqual({
			cursor: event.cursor,
		});
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

	test("accepts only signed i64 desktop tail cursors", async () => {
		for (const cursor of ["ec1_0000000000000000", "ec1_7fffffffffffffff"]) {
			const child = new FakeChild((line, process) => {
				const request = JSON.parse(line) as { id: string; method: string };
				if (request.method === "event.tailCursor") {
					process.respond({ id: request.id, ok: true, result: { cursor } });
				}
			});
			const client = new LocalToolClient("fake", { spawn: () => child });
			await client.start();
			await expect(client.getEventTailCursor()).resolves.toEqual({ cursor });
			await client.stop();
		}

		for (const cursor of ["ec1_8000000000000000", "ec1_ffffffffffffffff"]) {
			const child = new FakeChild((line, process) => {
				const request = JSON.parse(line) as { id: string; method: string };
				if (request.method === "event.tailCursor") {
					process.respond({ id: request.id, ok: true, result: { cursor } });
				}
			});
			const client = new LocalToolClient("fake", { spawn: () => child });
			await client.start();
			await expect(client.getEventTailCursor()).rejects.toMatchObject({
				code: "PROTOCOL_ERROR",
			});
			expect(client.isRunning).toBe(false);
		}
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
					tapReady:
						request.method !== "monitoring.pause" &&
						!(
							request.method === "monitoring.configure" &&
							request.params.enabled === false
						),
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
		await expect(client.refreshMonitoringPermissions()).resolves.toMatchObject({
			state: "running",
		});
		await expect(client.setupMonitoringPermissions()).resolves.toMatchObject({
			state: "running",
		});

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
				params: {},
			},
			{
				method: "monitoring.setupPermissions",
				params: {},
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

	test("reads vault status without interaction and migrates only with explicit confirmation", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const status = {
			availability: "migration_required",
			storageMode: null,
			keyVersion: null,
			interactiveMigrationAvailable: true,
		} as const;
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as {
				id: string;
				method: string;
				params: unknown;
			};
			requests.push({ method: request.method, params: request.params });
			process.respond({
				id: request.id,
				ok: true,
				result:
					request.method === "vault.status"
						? status
						: {
								migrated: true,
								status: {
									availability: "available",
									storageMode: "local_login_keychain",
									keyVersion: "keychain-dev-legacy-v1",
									interactiveMigrationAvailable: false,
								},
							},
			});
		});
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();

		await expect(client.getVaultKeyStatus()).resolves.toEqual(status);
		await expect(client.migrateLegacyVaultKey()).resolves.toMatchObject({
			migrated: true,
			status: {
				availability: "available",
				storageMode: "local_login_keychain",
			},
		});
		expect(requests).toEqual([
			{ method: "vault.status", params: {} },
			{ method: "vault.migrateLegacyKey", params: { confirm: true } },
		]);
		await client.stop();
	});

	test("deletes exact vault records through the bounded internal batch", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const child = new FakeChild((line, process) => {
			const request = JSON.parse(line) as {
				id: string;
				method: string;
				params: { namespace: string; recordIds: string[] };
			};
			requests.push({ method: request.method, params: request.params });
			process.respond({
				id: request.id,
				ok: true,
				result: {
					records: request.params.recordIds.map((recordId) => ({
						recordId,
						deleted: recordId === "collector-r1",
					})),
				},
			});
		});
		const client = new LocalToolClient("fake", { spawn: () => child });
		await client.start();

		await expect(
			client.deleteVaultBatch({
				namespace: "timeline.collector.v2",
				recordIds: ["collector-r1", "collector-r2"],
			}),
		).resolves.toEqual({
			records: [
				{ recordId: "collector-r1", deleted: true },
				{ recordId: "collector-r2", deleted: false },
			],
		});
		expect(requests).toEqual([
			{
				method: "vault.deleteBatch",
				params: {
					namespace: "timeline.collector.v2",
					recordIds: ["collector-r1", "collector-r2"],
				},
			},
		]);
		await expect(
			client.deleteVaultBatch({
				namespace: "timeline.collector.v2",
				recordIds: [],
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
			client.callTool({
				callId: "slow",
				name: "demo.wait",
				arguments: { durationMs: 5000 },
			}),
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

async function waitForFixtureProcessId(path: string): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const processId = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
			if (Number.isSafeInteger(processId) && processId > 0) return processId;
		} catch {}
		await Bun.sleep(10);
	}
	throw new Error("fixture Observer process identifier was not published");
}

async function waitForFixtureTree(directory: string): Promise<{
	leaderPid: number;
	observerPid: number;
}> {
	const [leaderPid, observerPid] = await Promise.all([
		waitForFixtureProcessId(join(directory, "leader.pid")),
		waitForFixtureProcessId(join(directory, "observer.pid")),
	]);
	return { leaderPid, observerPid };
}

async function waitForClientStopped(client: LocalToolClient): Promise<void> {
	for (let attempt = 0; attempt < 300 && client.isRunning; attempt += 1) {
		await Bun.sleep(10);
	}
	if (client.isRunning) {
		throw new Error("LocalToolClient retained its process-tree owner too long");
	}
}

function isProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		if (isNoSuchProcess(error)) return false;
		throw error;
	}
}

function isProcessGroupAlive(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (isNoSuchProcess(error)) return false;
		throw error;
	}
}

function isNoSuchProcess(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ESRCH"
	);
}

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
		tapReady: true,
		lastCallbackAtMs: 1_799_999_999_999,
		lastBucketAtMs: 1_799_999_995_000,
		permissions: {
			accessibility: "granted",
			screenRecording: "granted",
			inputMonitoring: "granted",
			automation: "granted",
		},
		permissionCheckState: "current",
		permissionsCheckedAtMs: 1_800_000_000_000,
		permissionSetupAvailable: true,
		permissionSetupAttempted: true,
		coverage: ["content", "metadata"],
		lastError: null,
		...overrides,
	};
}
