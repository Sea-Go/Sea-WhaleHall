import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LocalMessage } from "../src/agent/local-protocol";

const projectRoot = resolve(import.meta.dir, "..");
const sensorDirectory = resolve(projectRoot, "whalehall-local/core/src/sensors");

type SensorCiProbe = {
	sourceFile: string;
	callId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	verify: (output: unknown, context: SensorCiContext) => void;
};

type SensorCiContext = {
	dataDirectory: string;
	displayMode: "auto" | "degraded" | "required";
	foregroundMode: "auto" | "degraded" | "required";
	presenceMode: "auto" | "complete" | "degraded" | "idle";
};

const sensorCiContext: SensorCiContext = {
	dataDirectory: "",
	displayMode: expectation("WHALEHALL_CI_DISPLAY_MODE", ["auto", "degraded", "required"]),
	foregroundMode: expectation("WHALEHALL_CI_FOREGROUND_MODE", ["auto", "degraded", "required"]),
	presenceMode: expectation("WHALEHALL_CI_PRESENCE_MODE", [
		"auto",
		"complete",
		"degraded",
		"idle",
	]),
};

const sensorCiProbes: SensorCiProbe[] = [
	{
		sourceFile: "activity.rs",
		callId: "sensor-activity",
		toolName: "activity.status",
		arguments: {},
		verify: (output, context) => {
			const status = output as {
				state: string;
				currentSession: unknown | null;
				lastError: string | null;
			};
			console.info(
				`[sensor-ci] activity state=${status.state} currentSession=${status.currentSession !== null}`,
			);
			if (context.foregroundMode === "required") {
				expect(status.state).toBe("running");
				expect(status.currentSession).not.toBeNull();
			}
			if (context.foregroundMode === "degraded") {
				expect(status.state).toBe("degraded");
				expect(typeof status.lastError).toBe("string");
			}

			expect(output).toMatchObject({
				state: expect.stringMatching(/^(starting|running|degraded|stopped)$/),
				databasePath: join(context.dataDirectory, "usage.sqlite3"),
				pollIntervalMs: 50,
			});
		},
	},
	{
		sourceFile: "application_inventory.rs",
		callId: "sensor-application-inventory",
		toolName: "applications.status",
		arguments: {},
		verify: (output, context) => {
			const status = output as {
				state: string;
				installedApplicationCount: number;
				runningProcessCount: number;
				lastProcessScanAtMs: number | null;
				lastInstalledScanAtMs: number | null;
				lastError: string | null;
			};
			console.info(
				`[sensor-ci] applications state=${status.state} installed=${status.installedApplicationCount} running=${status.runningProcessCount}`,
			);
			expect(status.state).toBe("running");
			expect(status.runningProcessCount > 0).toBe(true);
			expect(status.installedApplicationCount >= 0).toBe(true);
			expect(typeof status.lastProcessScanAtMs).toBe("number");
			expect(typeof status.lastInstalledScanAtMs).toBe("number");
			expect(status.lastError).toBeNull();
			expect(output).toMatchObject({
				databasePath: join(context.dataDirectory, "applications.sqlite3"),
				processPollIntervalMs: 50,
			});
		},
	},
	{
		sourceFile: "browser_activity.rs",
		callId: "sensor-browser",
		toolName: "browser.status",
		arguments: {},
		verify: (output, context) => {
			const status = output as {
				state: string;
				currentTabCount: number;
				historyCount: number;
				searchCount: number;
				downloadCount: number;
				profilesScanned: number;
				lastTabScanAtMs: number | null;
				lastHistoryScanAtMs: number | null;
				capabilities: {
					currentTabs: boolean;
					history: boolean;
					downloads: boolean;
				};
				currentTabs: Array<{
					title: string;
					url: string;
					domain: string;
					audible: boolean | null;
					startedAtMs: number;
					endedAtMs: number | null;
				}>;
				warnings: string[];
				lastError: string | null;
			};
			console.info(
				[
					`[sensor-ci] browser state=${status.state}`,
					`tabs=${status.currentTabCount}`,
					`history=${status.historyCount}`,
					`searches=${status.searchCount}`,
					`downloads=${status.downloadCount}`,
				].join(" "),
			);
			expect(status.state).toBe("running");
			expect(status.capabilities).toEqual({
				currentTabs: true,
				history: true,
				downloads: true,
			});
			expect(status.profilesScanned).toBe(1);
			expect(typeof status.lastTabScanAtMs).toBe("number");
			expect(typeof status.lastHistoryScanAtMs).toBe("number");
			expect(status.currentTabCount).toBe(1);
			expect(status.historyCount).toBe(1);
			expect(status.searchCount).toBe(1);
			expect(status.downloadCount).toBe(1);
			expect(status.currentTabs[0]).toMatchObject({
				title: "WhaleHall Browser Probe",
				url: "https://search.example/?q=whalehall+sensor",
				domain: "search.example",
				audible: true,
				startedAtMs: expect.any(Number),
				endedAtMs: null,
			});
			expect(status.warnings).toEqual([]);
			expect(status.lastError).toBeNull();
			expect(output).toMatchObject({
				databasePath: join(context.dataDirectory, "browser.sqlite3"),
				bridgePath: join(context.dataDirectory, "browser-current-tabs.json"),
				tabPollIntervalMs: 50,
				historyRefreshIntervalMs: 1000,
			});
		},
	},
	{
		sourceFile: "device_environment.rs",
		callId: "sensor-device-environment",
		toolName: "device.environment",
		arguments: {},
		verify: (output, context) => {
			const snapshot = output as {
				operatingSystem: { name: string; version: string };
				deviceName: string;
				localUsername: string;
				languages: unknown[];
				screenCount: number;
				screens: Array<{ widthPx: number; heightPx: number }>;
				cpu: { logicalCores: number };
				memory: { totalBytes: number };
				networkInterfaces: unknown[];
				warnings: Array<{ component: string; message: string }>;
			};
			const resolutions =
				snapshot.screens.map((screen) => `${screen.widthPx}x${screen.heightPx}`).join(",") || "none";
			console.info(
				[
					`[sensor-ci] device os=${snapshot.operatingSystem.name} ${snapshot.operatingSystem.version}`,
					`screens=${resolutions}`,
					`cpuCores=${snapshot.cpu.logicalCores}`,
					`networkInterfaces=${snapshot.networkInterfaces.length}`,
					`warnings=${snapshot.warnings.length}`,
				].join(" "),
			);
			expect(snapshot.deviceName.length > 0).toBe(true);
			expect(snapshot.localUsername.length > 0).toBe(true);
			expect(snapshot.languages.length > 0).toBe(true);
			expect(snapshot.screenCount).toBe(snapshot.screens.length);
			expect(snapshot.cpu.logicalCores > 0).toBe(true);
			expect(snapshot.memory.totalBytes > 0).toBe(true);
			expect(snapshot.networkInterfaces.length > 0).toBe(true);
			for (const screen of snapshot.screens) {
				expect(screen.widthPx > 0).toBe(true);
				expect(screen.heightPx > 0).toBe(true);
			}
			if (context.displayMode === "required") {
				expect(snapshot.screenCount > 0).toBe(true);
			}
			if (snapshot.screenCount === 0) {
				expect(snapshot.warnings.some((warning) => warning.component === "screens")).toBe(true);
			}
			if (context.displayMode === "degraded") {
				expect(snapshot.screenCount).toBe(0);
			}

			expect(output).toMatchObject({
				operatingSystem: {
					name: expect.any(String),
					version: expect.any(String),
					architecture: expect.any(String),
				},
				deviceName: expect.any(String),
				localUsername: expect.any(String),
				languages: expect.any(Array),
				timezone: { utcOffsetMinutes: expect.any(Number) },
				screenCount: expect.any(Number),
				screens: expect.any(Array),
				cpu: { logicalCores: expect.any(Number) },
				memory: { totalBytes: expect.any(Number) },
				batteries: expect.any(Array),
				networkInterfaces: expect.any(Array),
				warnings: expect.any(Array),
			});
		},
	},
	{
		sourceFile: "presence.rs",
		callId: "sensor-presence",
		toolName: "presence.status",
		arguments: {},
		verify: (output, context) => {
			const status = output as {
				state: string;
				observedAtMs: number | null;
				lastInputAtMs: number | null;
				idleDurationMs: number | null;
				isAfk: boolean;
				isLocked: boolean | null;
				capabilities: {
					lastInput: boolean;
					lockState: boolean;
					sleepWake: boolean;
				};
				warnings: string[];
				lastError: string | null;
			};
			console.info(
				[
					`[sensor-ci] presence state=${status.state}`,
					`lastInput=${status.capabilities.lastInput}`,
					`lockState=${status.capabilities.lockState}`,
					`locked=${status.isLocked ?? "unknown"}`,
					`warnings=${status.warnings.length}`,
				].join(" "),
			);
			expect(typeof status.observedAtMs).toBe("number");
			expect(typeof status.isAfk).toBe("boolean");
			expect(status.capabilities.sleepWake).toBe(true);
			if (context.presenceMode === "complete") {
				expect(status.state).toBe("running");
				expect(status.capabilities.lastInput).toBe(true);
				expect(status.capabilities.lockState).toBe(true);
				expect(typeof status.lastInputAtMs).toBe("number");
				expect(typeof status.idleDurationMs).toBe("number");
				expect(typeof status.isLocked).toBe("boolean");
				expect(status.lastError).toBeNull();
			}
			if (context.presenceMode === "idle") {
				expect(status.capabilities.lastInput).toBe(true);
				expect(typeof status.lastInputAtMs).toBe("number");
				expect(typeof status.idleDurationMs).toBe("number");
			}
			if (context.presenceMode === "degraded") {
				expect(status.state).toBe("degraded");
				expect(status.capabilities.lastInput).toBe(false);
				expect(status.capabilities.lockState).toBe(false);
				expect(status.warnings.length > 0).toBe(true);
				expect(typeof status.lastError).toBe("string");
			}
			expect(output).toMatchObject({
				databasePath: join(context.dataDirectory, "presence.sqlite3"),
				pollIntervalMs: 50,
				afkThresholdMs: 1000,
				suspendGapThresholdMs: 1000,
				capabilities: {
					lastInput: expect.any(Boolean),
					lockState: expect.any(Boolean),
					sleepWake: true,
				},
				warnings: expect.any(Array),
			});
		},
	},
];

test("every public Rust sensor has exactly one native CI probe", () => {
	const sensorFiles = readdirSync(sensorDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".rs") && entry.name !== "mod.rs")
		.map((entry) => entry.name)
		.sort();
	const coveredFiles = sensorCiProbes.map((probe) => probe.sourceFile).sort();

	expect(coveredFiles).toEqual(sensorFiles);
	expect(new Set(sensorCiProbes.map((probe) => probe.callId)).size).toBe(sensorCiProbes.length);
	expect(new Set(sensorCiProbes.map((probe) => probe.toolName)).size).toBe(sensorCiProbes.length);
});

test("whalehall-local lists, calls, streams, and cancels tools over JSONL", async () => {
	const manifest = resolve(projectRoot, "whalehall-local/Cargo.toml");
	const build = Bun.spawnSync(
		[
			"cargo",
			"build",
			"--locked",
			"--manifest-path",
			manifest,
			"--package",
			"whalehall-local-server",
		],
		{ cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr));

	const binary = resolve(
		projectRoot,
		"whalehall-local/target/debug",
		process.platform === "win32" ? "whalehall-local.exe" : "whalehall-local",
	);
	const dataDirectory = mkdtempSync(join(tmpdir(), "whalehall-activity-integration-"));
	const browserProfileRoot = createBrowserFixture(dataDirectory);
	const context = { ...sensorCiContext, dataDirectory };
	const child = Bun.spawn({
		cmd: [binary],
		env: {
			...process.env,
			WHALEHALL_DATA_DIR: dataDirectory,
			WHALEHALL_ACTIVITY_POLL_MS: "50",
			WHALEHALL_APPLICATION_POLL_MS: "50",
			WHALEHALL_PRESENCE_POLL_MS: "50",
			WHALEHALL_AFK_THRESHOLD_MS: "1000",
			WHALEHALL_SUSPEND_GAP_THRESHOLD_MS: "1000",
			WHALEHALL_BROWSER_PROFILE_ROOT: browserProfileRoot,
			WHALEHALL_BROWSER_TAB_POLL_MS: "50",
			WHALEHALL_BROWSER_HISTORY_REFRESH_MS: "1000",
			WHALEHALL_BROWSER_BRIDGE_MAX_AGE_MS: "60000",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const messages: LocalMessage[] = [];
	const waitStarted = deferred();
	const waitProgress = deferred();
	const sensorCompleted = new Map(
		sensorCiProbes.map((probe) => [probe.callId, deferred()] as const),
	);
	const outputComplete = collectMessages(child.stdout, messages, (message) => {
		if ("id" in message && typeof message.id === "string") {
			sensorCompleted.get(message.id)?.resolve();
		}
		if ("event" in message && message.callId === "wait" && message.event === "tool.started") {
			waitStarted.resolve();
		}
		if ("event" in message && message.callId === "wait" && message.event === "tool.progress") {
			waitProgress.resolve();
		}
	});
	child.stdin.write('{"id":"list","method":"tool.list","params":{}}\n');
	child.stdin.write(
		'{"id":"system","method":"tool.call","params":{"name":"system.info","arguments":{}}}\n',
	);
	for (const probe of sensorCiProbes) {
		if (probe.sourceFile === "activity.rs" && context.foregroundMode !== "auto") {
			let readinessOutput: unknown;
			let readinessReached = false;
			for (let attempt = 0; attempt < 60; attempt += 1) {
				const readinessCallId = `sensor-activity-readiness-${attempt}`;
				const readinessCompleted = deferred();
				sensorCompleted.set(readinessCallId, readinessCompleted);
				child.stdin.write(
					`${JSON.stringify({
						id: readinessCallId,
						method: "tool.call",
						params: { name: probe.toolName, arguments: probe.arguments },
					})}\n`,
				);
				await child.stdin.flush();
				await withTimeout(readinessCompleted.promise, `${probe.toolName} readiness response`);
				readinessOutput = successfulToolOutput(messages, readinessCallId);
				if (activityCapabilityReady(readinessOutput, context.foregroundMode)) {
					readinessReached = true;
					break;
				}
				await Bun.sleep(250);
			}
			if (!readinessReached) {
				throw new Error(
					`Activity sensor did not reach ${context.foregroundMode} capability: ${JSON.stringify(readinessOutput)}`,
				);
			}
		}
		if (probe.sourceFile === "application_inventory.rs") {
			let readinessOutput: unknown;
			let readinessReached = false;
			for (let attempt = 0; attempt < 120; attempt += 1) {
				const readinessCallId = `sensor-applications-readiness-${attempt}`;
				const readinessCompleted = deferred();
				sensorCompleted.set(readinessCallId, readinessCompleted);
				child.stdin.write(
					`${JSON.stringify({
						id: readinessCallId,
						method: "tool.call",
						params: { name: probe.toolName, arguments: probe.arguments },
					})}\n`,
				);
				await child.stdin.flush();
				await withTimeout(readinessCompleted.promise, `${probe.toolName} readiness response`);
				readinessOutput = successfulToolOutput(messages, readinessCallId);
				if (applicationInventoryReady(readinessOutput)) {
					readinessReached = true;
					break;
				}
				await Bun.sleep(250);
			}
			if (!readinessReached) {
				throw new Error(
					`Application inventory did not become ready: ${JSON.stringify(readinessOutput)}`,
				);
			}
		}
		if (probe.sourceFile === "browser_activity.rs") {
			let readinessOutput: unknown;
			let readinessReached = false;
			for (let attempt = 0; attempt < 120; attempt += 1) {
				const readinessCallId = `sensor-browser-readiness-${attempt}`;
				const readinessCompleted = deferred();
				sensorCompleted.set(readinessCallId, readinessCompleted);
				child.stdin.write(
					`${JSON.stringify({
						id: readinessCallId,
						method: "tool.call",
						params: { name: probe.toolName, arguments: probe.arguments },
					})}\n`,
				);
				await child.stdin.flush();
				await withTimeout(readinessCompleted.promise, `${probe.toolName} readiness response`);
				readinessOutput = successfulToolOutput(messages, readinessCallId);
				if (browserSensorReady(readinessOutput)) {
					readinessReached = true;
					break;
				}
				await Bun.sleep(250);
			}
			if (!readinessReached) {
				throw new Error(
					`Browser sensor did not import its native fixture: ${JSON.stringify(readinessOutput)}`,
				);
			}
		}
		if (probe.sourceFile === "presence.rs") {
			let readinessOutput: unknown;
			let readinessReached = false;
			for (let attempt = 0; attempt < 60; attempt += 1) {
				const readinessCallId = `sensor-presence-readiness-${attempt}`;
				const readinessCompleted = deferred();
				sensorCompleted.set(readinessCallId, readinessCompleted);
				child.stdin.write(
					`${JSON.stringify({
						id: readinessCallId,
						method: "tool.call",
						params: { name: probe.toolName, arguments: probe.arguments },
					})}\n`,
				);
				await child.stdin.flush();
				await withTimeout(readinessCompleted.promise, `${probe.toolName} readiness response`);
				readinessOutput = successfulToolOutput(messages, readinessCallId);
				if (presenceCapabilityReady(readinessOutput, context.presenceMode)) {
					readinessReached = true;
					break;
				}
				await Bun.sleep(250);
			}
			if (!readinessReached) {
				throw new Error(
					`Presence sensor did not reach ${context.presenceMode} capability: ${JSON.stringify(readinessOutput)}`,
				);
			}
		}
		child.stdin.write(
			`${JSON.stringify({
				id: probe.callId,
				method: "tool.call",
				params: { name: probe.toolName, arguments: probe.arguments },
			})}\n`,
		);
		await child.stdin.flush();
		await withTimeout(sensorCompleted.get(probe.callId)!.promise, `${probe.toolName} response`, 15_000);
	}
	child.stdin.write(
		'{"id":"activity-sessions","method":"tool.call","params":{"name":"activity.sessions","arguments":{"limit":10}}}\n',
	);
	child.stdin.write(
		'{"id":"activity-cleanup","method":"tool.call","params":{"name":"activity.cleanup","arguments":{"scope":"shortTerm"}}}\n',
	);
	child.stdin.write(
		'{"id":"installed-applications","method":"tool.call","params":{"name":"applications.installed","arguments":{"limit":20}}}\n',
	);
	child.stdin.write(
		'{"id":"application-processes","method":"tool.call","params":{"name":"applications.processes","arguments":{"limit":1000,"runningOnly":true}}}\n',
	);
	child.stdin.write(
		'{"id":"presence-events","method":"tool.call","params":{"name":"presence.events","arguments":{"limit":100,"eventTypes":["afkStarted","afkEnded","screenLocked","screenUnlocked","sleepStarted","wokeUp"]}}}\n',
	);
	child.stdin.write(
		'{"id":"browser-tabs","method":"tool.call","params":{"name":"browser.tabs","arguments":{"limit":10,"currentOnly":true}}}\n',
	);
	child.stdin.write(
		'{"id":"browser-history","method":"tool.call","params":{"name":"browser.history","arguments":{"limit":10,"domainContains":"search.example"}}}\n',
	);
	child.stdin.write(
		'{"id":"browser-searches","method":"tool.call","params":{"name":"browser.searches","arguments":{"limit":10,"termContains":"whalehall"}}}\n',
	);
	child.stdin.write(
		'{"id":"browser-downloads","method":"tool.call","params":{"name":"browser.downloads","arguments":{"limit":10,"state":"complete"}}}\n',
	);
	child.stdin.write(
		'{"id":"wait","method":"tool.call","params":{"name":"demo.wait","arguments":{"durationMs":2000}}}\n',
	);
	await child.stdin.flush();
	await withTimeout(waitStarted.promise, "tool.started");
	await withTimeout(waitProgress.promise, "tool.progress");
	child.stdin.write(
		'{"id":"cancel","method":"tool.cancel","params":{"callId":"wait"}}\n',
	);
	child.stdin.end();

	await outputComplete;
	const exitCode = await child.exited;
	expect(exitCode).toBe(0);

	const listResponse = messages.find(
		(message) => "id" in message && message.id === "list" && message.ok,
	) as { result: { tools: Array<{ name: string }> } } | undefined;
	expect(listResponse?.result.tools.map((tool) => tool.name)).toEqual([
		"activity.cleanup",
		"activity.sessions",
		"activity.status",
		"applications.installed",
		"applications.processes",
		"applications.status",
		"browser.downloads",
		"browser.history",
		"browser.searches",
		"browser.status",
		"browser.tabs",
		"demo.wait",
		"device.environment",
		"presence.events",
		"presence.status",
		"system.info",
	]);
	const systemOutput = toolOutput(messages, "system") as { pid: number };
	expect(typeof systemOutput.pid).toBe("number");
	for (const probe of sensorCiProbes) {
		probe.verify(toolOutput(messages, probe.callId), context);
	}
	expect(
		messages.find((message) => "id" in message && message.id === "activity-sessions"),
	).toMatchObject({
		ok: true,
		result: {
			callId: "activity-sessions",
			output: { count: expect.any(Number), sessions: expect.any(Array) },
		},
	});
	expect(
		messages.find((message) => "id" in message && message.id === "activity-cleanup"),
	).toMatchObject({
		ok: true,
		result: {
			callId: "activity-cleanup",
			output: {
				scope: "shortTerm",
				deletedSessions: expect.any(Number),
				retentionDays: 7,
				cutoffAtMs: expect.any(Number),
			},
		},
	});
	const installedOutput = toolOutput(messages, "installed-applications") as {
		count: number;
		applications: Array<{ name: string; executablePath: string; source: string }>;
	};
	expect(installedOutput.count).toBe(installedOutput.applications.length);
	for (const application of installedOutput.applications) {
		expect(application.name.length > 0).toBe(true);
		expect(application.executablePath.length > 0).toBe(true);
		expect(application.source.length > 0).toBe(true);
	}
	const processOutput = toolOutput(messages, "application-processes") as {
		count: number;
		processes: Array<{
			processId: number;
			name: string;
			executablePath: string;
			startedAtMs: number;
			exitedAt: string | null;
			cpuUsagePercent: number;
			memoryBytes: number;
			isRunning: boolean;
		}>;
	};
	expect(processOutput.count).toBe(processOutput.processes.length);
	expect(processOutput.processes.length > 0).toBe(true);
	const localServerProcess = processOutput.processes.find(
		(process) => process.processId === systemOutput.pid,
	);
	console.info(
		`[sensor-ci] process query count=${processOutput.count} serverPid=${systemOutput.pid} serverFound=${localServerProcess !== undefined}`,
	);
	expect(localServerProcess).toBeDefined();
	expect(localServerProcess!.name.length > 0).toBe(true);
	expect(localServerProcess!.executablePath.length > 0).toBe(true);
	expect(typeof localServerProcess!.startedAtMs).toBe("number");
	expect(localServerProcess!.exitedAt).toBeNull();
	expect(typeof localServerProcess!.cpuUsagePercent).toBe("number");
	expect(typeof localServerProcess!.memoryBytes).toBe("number");
	expect(localServerProcess!.isRunning).toBe(true);
	const presenceEventsOutput = toolOutput(messages, "presence-events") as {
		count: number;
		events: Array<{
			eventType: string;
			occurredAtMs: number;
			observedAtMs: number;
		}>;
	};
	expect(presenceEventsOutput.count).toBe(presenceEventsOutput.events.length);
	for (const event of presenceEventsOutput.events) {
		expect(event.eventType).toMatch(
			/^(afkStarted|afkEnded|screenLocked|screenUnlocked|sleepStarted|wokeUp)$/,
		);
		expect(typeof event.occurredAtMs).toBe("number");
		expect(typeof event.observedAtMs).toBe("number");
	}
	expect(toolOutput(messages, "browser-tabs")).toMatchObject({
		count: 1,
		tabs: [
			{
				title: "WhaleHall Browser Probe",
				url: "https://search.example/?q=whalehall+sensor",
				domain: "search.example",
				audible: true,
				endedAtMs: null,
				isCurrent: true,
			},
		],
	});
	expect(toolOutput(messages, "browser-history")).toMatchObject({
		count: 1,
		history: [
			{
				title: "WhaleHall Search",
				url: "https://search.example/?q=whalehall+sensor",
				domain: "search.example",
				visitCount: 3,
			},
		],
	});
	expect(toolOutput(messages, "browser-searches")).toMatchObject({
		count: 1,
		searches: [
			{
				searchTerm: "whalehall sensor",
				url: "https://search.example/?q=whalehall+sensor",
			},
		],
	});
	expect(toolOutput(messages, "browser-downloads")).toMatchObject({
		count: 1,
		downloads: [
			{
				url: "https://downloads.example/whalehall.zip",
				domain: "downloads.example",
				targetPath: expect.stringContaining("whalehall.zip"),
				receivedBytes: 1024,
				totalBytes: 1024,
				state: "complete",
			},
		],
	});
	expect(messages.some((message) => "event" in message && message.event === "tool.started")).toBe(
		true,
	);
	expect(messages.some((message) => "event" in message && message.event === "tool.progress")).toBe(
		true,
	);
	expect(
		messages.some((message) => "event" in message && message.event === "tool.cancelled"),
	).toBe(true);
	expect(messages.find((message) => "id" in message && message.id === "cancel")).toMatchObject({
		ok: true,
		result: { callId: "wait", cancelled: true },
	});
	expect(messages.find((message) => "id" in message && message.id === "wait")).toMatchObject({
		ok: false,
		error: { code: "CANCELLED" },
	});
	expect(existsSync(join(dataDirectory, "usage.sqlite3"))).toBe(true);
	expect(existsSync(join(dataDirectory, "applications.sqlite3"))).toBe(true);
	expect(existsSync(join(dataDirectory, "presence.sqlite3"))).toBe(true);
	expect(existsSync(join(dataDirectory, "browser.sqlite3"))).toBe(true);
	rmSync(dataDirectory, { recursive: true, force: true });
}, 60_000);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function expectation<const T extends string>(name: string, allowed: readonly T[]): T {
	const value = process.env[name] ?? allowed[0];
	if (!allowed.includes(value as T)) {
		throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

function toolOutput(messages: LocalMessage[], callId: string): unknown {
	const response = messages.find((message) => "id" in message && message.id === callId);
	expect(response).toMatchObject({ ok: true, result: { callId } });
	return successfulToolOutput(messages, callId);
}

function successfulToolOutput(messages: LocalMessage[], callId: string): unknown {
	const response = messages.find((message) => "id" in message && message.id === callId);
	if (!response || !("ok" in response) || !response.ok) {
		throw new Error(`Missing successful sensor response for ${callId}`);
	}
	return (response.result as { output: unknown }).output;
}

function activityCapabilityReady(
	output: unknown,
	mode: SensorCiContext["foregroundMode"],
): boolean {
	const status = output as {
		state: string;
		currentSession: unknown | null;
		lastError: string | null;
	};
	if (mode === "required") {
		return status.state === "running" && status.currentSession !== null;
	}
	if (mode === "degraded") {
		return status.state === "degraded" && typeof status.lastError === "string";
	}
	return true;
}

function applicationInventoryReady(output: unknown): boolean {
	const status = output as {
		state: string;
		runningProcessCount: number;
		lastProcessScanAtMs: number | null;
		lastInstalledScanAtMs: number | null;
		lastError: string | null;
	};
	return (
		status.state === "running" &&
		status.runningProcessCount > 0 &&
		typeof status.lastProcessScanAtMs === "number" &&
		typeof status.lastInstalledScanAtMs === "number" &&
		status.lastError === null
	);
}

function browserSensorReady(output: unknown): boolean {
	const status = output as {
		state: string;
		currentTabCount: number;
		historyCount: number;
		searchCount: number;
		downloadCount: number;
		lastTabScanAtMs: number | null;
		lastHistoryScanAtMs: number | null;
		capabilities: { currentTabs: boolean; history: boolean; downloads: boolean };
	};
	return (
		status.state === "running" &&
		status.currentTabCount === 1 &&
		status.historyCount === 1 &&
		status.searchCount === 1 &&
		status.downloadCount === 1 &&
		typeof status.lastTabScanAtMs === "number" &&
		typeof status.lastHistoryScanAtMs === "number" &&
		status.capabilities.currentTabs &&
		status.capabilities.history &&
		status.capabilities.downloads
	);
}

function createBrowserFixture(dataDirectory: string): string {
	const root = join(dataDirectory, "ci-browser-profile");
	const profile = join(root, "Default");
	mkdirSync(profile, { recursive: true });
	const historyPath = join(profile, "History");
	const database = new Database(historyPath, { create: true });
	database.exec(`
		CREATE TABLE urls (
			id INTEGER PRIMARY KEY,
			url TEXT,
			title TEXT,
			visit_count INTEGER,
			last_visit_time INTEGER
		);
		CREATE TABLE downloads (
			id INTEGER PRIMARY KEY,
			tab_url TEXT,
			site_url TEXT,
			target_path TEXT,
			start_time INTEGER,
			end_time INTEGER,
			received_bytes INTEGER,
			total_bytes INTEGER,
			state INTEGER
		);
		CREATE TABLE downloads_url_chains (
			id INTEGER,
			chain_index INTEGER,
			url TEXT
		);
	`);
	const chromiumEpochOffsetMicroseconds = 11_644_473_600_000_000;
	const visitTime = chromiumEpochOffsetMicroseconds + Date.now() * 1000;
	database
		.query(
			"INSERT INTO urls VALUES (1, ?, ?, 3, ?)",
		)
		.run("https://search.example/?q=whalehall+sensor", "WhaleHall Search", visitTime);
	database
		.query("INSERT INTO downloads VALUES (7, '', '', ?, ?, ?, 1024, 1024, 1)")
		.run(
			join(dataDirectory, "downloads", "whalehall.zip"),
			visitTime,
			visitTime + 1_000_000,
		);
	database
		.query("INSERT INTO downloads_url_chains VALUES (7, 0, ?)")
		.run("https://downloads.example/whalehall.zip");
	database.close();
	writeFileSync(
		join(dataDirectory, "browser-current-tabs.json"),
		JSON.stringify({
			observedAtMs: Date.now(),
			tabs: [
				{
					browser: "CI Chromium",
					profile: "Default",
					windowId: "window-1",
					tabId: "tab-1",
					title: "WhaleHall Browser Probe",
					url: "https://search.example/?q=whalehall+sensor",
					audible: true,
				},
			],
		}),
	);
	return root;
}

function presenceCapabilityReady(
	output: unknown,
	mode: SensorCiContext["presenceMode"],
): boolean {
	const status = output as {
		state: string;
		observedAtMs: number | null;
		capabilities: { lastInput: boolean; lockState: boolean };
		warnings: string[];
	};
	if (typeof status.observedAtMs !== "number") return false;
	if (mode === "complete") {
		return (
			status.state === "running" &&
			status.capabilities.lastInput &&
			status.capabilities.lockState
		);
	}
	if (mode === "idle") return status.capabilities.lastInput;
	if (mode === "degraded") {
		return (
			status.state === "degraded" &&
			!status.capabilities.lastInput &&
			!status.capabilities.lockState &&
			status.warnings.length > 0
		);
	}
	return true;
}

async function withTimeout(
	promise: Promise<void>,
	label: string,
	timeoutMs = 3000,
): Promise<void> {
	await Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function collectMessages(
	stream: ReadableStream<Uint8Array>,
	messages: LocalMessage[],
	onMessage: (message: LocalMessage) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trimEnd();
				buffer = buffer.slice(newline + 1);
				if (line) {
					const message = JSON.parse(line) as LocalMessage;
					messages.push(message);
					onMessage(message);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}
