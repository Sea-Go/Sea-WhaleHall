import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type WindowsUpdateInstallerPlan,
	windowsUpdateInstallerLaunch,
	windowsUpdateInstallerScript,
} from "../src/bun/app-update-controller";

const REQUIRE_WINDOWS_INTEGRATION =
	process.env.WHALEHALL_REQUIRE_WINDOWS_UPDATE_INTEGRATION === "1";
const CHILD_EXIT_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;

if (REQUIRE_WINDOWS_INTEGRATION && process.platform !== "win32") {
	throw new Error(
		"The required Windows updater integration gate is not running on Windows.",
	);
}

type WindowsInstallerScenario = {
	root: string;
	markerPath: string;
	plan: WindowsUpdateInstallerPlan;
	currentPath: string;
	backupPath: string;
	failedCandidatePath: string;
	readyPath: string;
	logPath: string;
};

let fixtureRoot = "";
let markerLauncherTemplate = "";

describe.skipIf(process.platform !== "win32")(
	"app-owned Windows update installer integration",
	() => {
		beforeAll(async () => {
			fixtureRoot = await mkdtemp(
				join(tmpdir(), "whalehall-windows-installer-fixture-"),
			);
			const sourcePath = join(fixtureRoot, "marker-launcher.ts");
			markerLauncherTemplate = join(fixtureRoot, "marker-launcher.exe");
			await writeFile(
				sourcePath,
				`import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const executableDirectory = dirname(process.execPath);
const bundleDirectory = dirname(executableDirectory);
const outputPath = readFileSync(join(bundleDirectory, "marker-output.txt"), "utf8").trim();
const marker = readFileSync(join(bundleDirectory, "marker-value.txt"), "utf8");
writeFileSync(outputPath, marker, "utf8");
`,
				"utf8",
			);
			const compile = await runProcess(
				process.execPath,
				["build", sourcePath, "--compile", "--outfile", markerLauncherTemplate],
				fixtureRoot,
			);
			if (compile.exitCode !== 0) {
				throw new Error(
					`Unable to compile the Windows launcher fixture:\n${compile.output}`,
				);
			}
			const launcher = await stat(markerLauncherTemplate);
			if (!launcher.isFile() || launcher.size === 0) {
				throw new Error("The compiled Windows launcher fixture is missing.");
			}
		}, 60_000);

		afterAll(async () => {
			if (fixtureRoot.length > 0) {
				await removeTree(fixtureRoot);
			}
		});

		test("arms, waits only for the exact parent, swaps twice, and starts the new launcher", async () => {
			const ownedChildren: ChildProcess[] = [];
			let scenario: WindowsInstallerScenario | null = null;
			try {
				const parent = await spawnStarted(process.execPath, [
					"-e",
					"setInterval(() => {}, 1_000)",
				]);
				ownedChildren.push(parent);
				if (parent.pid === undefined)
					throw new Error("Missing exact parent PID.");

				const unrelatedBun = await spawnStarted(process.execPath, [
					"-e",
					"setInterval(() => {}, 1_000)",
				]);
				ownedChildren.push(unrelatedBun);

				scenario = await createScenario(parent.pid, true);
				const unrelatedLauncherPath = join(
					scenario.root,
					"unrelated",
					"launcher.exe",
				);
				await mkdir(dirname(unrelatedLauncherPath), { recursive: true });
				const systemRoot = requiredSystemRoot();
				await copyFile(
					join(systemRoot, "System32", "PING.EXE"),
					unrelatedLauncherPath,
				);
				const unrelatedLauncher = await spawnStarted(unrelatedLauncherPath, [
					"-t",
					"127.0.0.1",
				]);
				ownedChildren.push(unrelatedLauncher);

				expect(await windowsProcessName(unrelatedBun.pid)).toBe("bun");
				expect(await windowsProcessName(unrelatedLauncher.pid)).toBe(
					"launcher",
				);

				const helper = await launchInstaller(scenario.plan);
				ownedChildren.push(helper);
				await waitForArmed(scenario);
				await stopChild(parent);
				const helperExit = await waitForExit(helper, CHILD_EXIT_TIMEOUT_MS);
				expect(helperExit).toBe(0);
				await waitForFileValue(scenario.markerPath, "new");

				expect(
					await readFile(
						join(scenario.currentPath, "marker-value.txt"),
						"utf8",
					),
				).toBe("new");
				expect(
					await readFile(join(scenario.backupPath, "marker-value.txt"), "utf8"),
				).toBe("old");
				await expect(stat(scenario.failedCandidatePath)).rejects.toThrow();
				expect(await readFile(scenario.logPath, "utf8")).toContain("completed");
				expect(isChildAlive(unrelatedBun)).toBe(true);
				expect(isChildAlive(unrelatedLauncher)).toBe(true);
			} finally {
				await Promise.allSettled(
					ownedChildren.map((child) => stopChild(child)),
				);
				if (scenario !== null) {
					await removeTree(scenario.root);
				}
			}
		}, 90_000);

		test("rolls back the old bundle and restarts it when the candidate launcher fails", async () => {
			const ownedChildren: ChildProcess[] = [];
			let scenario: WindowsInstallerScenario | null = null;
			try {
				const parent = await spawnStarted(process.execPath, [
					"-e",
					"setInterval(() => {}, 1_000)",
				]);
				ownedChildren.push(parent);
				if (parent.pid === undefined)
					throw new Error("Missing exact parent PID.");

				scenario = await createScenario(parent.pid, false);
				const helper = await launchInstaller(scenario.plan);
				ownedChildren.push(helper);
				await waitForArmed(scenario);
				await stopChild(parent);
				const helperExit = await waitForExit(helper, CHILD_EXIT_TIMEOUT_MS);
				expect(helperExit).toBe(1);
				await waitForFileValue(scenario.markerPath, "old");

				expect(
					await readFile(
						join(scenario.currentPath, "marker-value.txt"),
						"utf8",
					),
				).toBe("old");
				expect(
					await readFile(
						join(scenario.failedCandidatePath, "marker-value.txt"),
						"utf8",
					),
				).toBe("new");
				await expect(stat(scenario.backupPath)).rejects.toThrow();
				const log = await readFile(scenario.logPath, "utf8");
				expect(log).toContain("failed");
				expect(log).not.toContain("completed");
			} finally {
				await Promise.allSettled(
					ownedChildren.map((child) => stopChild(child)),
				);
				if (scenario !== null) {
					await removeTree(scenario.root);
				}
			}
		}, 90_000);
	},
);

async function createScenario(
	parentProcessId: number,
	validCandidateLauncher: boolean,
): Promise<WindowsInstallerScenario> {
	const root = await mkdtemp(join(tmpdir(), "whalehall-windows-installer-"));
	const appDataRoot = join(root, "app-data");
	const transactionId = randomBytes(16).toString("hex");
	const transactionRoot = join(appDataRoot, ".whalehall-update", transactionId);
	const currentPath = join(appDataRoot, "app");
	const candidatePath = join(transactionRoot, "candidate-root", "WhaleHall");
	const markerPath = join(root, "launched-marker.txt");
	const plan: WindowsUpdateInstallerPlan = {
		schemaVersion: "whalehall.windows-install-plan.v1",
		transactionId,
		readyNonce: randomBytes(16).toString("hex"),
		processId: parentProcessId,
		appDataRoot,
		bundleName: "WhaleHall",
	};

	await Promise.all([
		createBundle(currentPath, markerPath, "old", true),
		createBundle(candidatePath, markerPath, "new", validCandidateLauncher),
	]);
	await writeFile(
		join(transactionRoot, "install.ps1"),
		windowsUpdateInstallerScript(),
		"utf8",
	);
	await writeFile(
		join(transactionRoot, "plan.json"),
		JSON.stringify(plan),
		"utf8",
	);

	return {
		root,
		markerPath,
		plan,
		currentPath,
		backupPath: join(transactionRoot, "backup"),
		failedCandidatePath: join(transactionRoot, "failed-candidate"),
		readyPath: join(transactionRoot, "armed.json"),
		logPath: join(transactionRoot, "install.log"),
	};
}

async function createBundle(
	bundlePath: string,
	markerPath: string,
	markerValue: string,
	validLauncher: boolean,
): Promise<void> {
	const binPath = join(bundlePath, "bin");
	await mkdir(binPath, { recursive: true });
	const launcherPath = join(binPath, "launcher.exe");
	if (validLauncher) {
		await copyFile(markerLauncherTemplate, launcherPath);
	} else {
		await writeFile(launcherPath, "not a Windows executable", "utf8");
	}
	await Promise.all([
		writeFile(join(bundlePath, "marker-output.txt"), markerPath, "utf8"),
		writeFile(join(bundlePath, "marker-value.txt"), markerValue, "utf8"),
	]);
}

async function removeTree(path: string): Promise<void> {
	await rm(path, {
		recursive: true,
		force: true,
		maxRetries: 20,
		retryDelay: 100,
	});
}

async function launchInstaller(
	plan: WindowsUpdateInstallerPlan,
): Promise<ChildProcess> {
	const launch = windowsUpdateInstallerLaunch(plan);
	const child = spawn(launch.command, launch.arguments, launch.options);
	await waitForSpawn(child);
	return child;
}

function requiredSystemRoot(): string {
	const systemRoot = process.env.SystemRoot?.trim();
	if (systemRoot === undefined || systemRoot.length === 0) {
		throw new Error("The Windows system root is unavailable.");
	}
	return systemRoot;
}

async function windowsProcessName(
	processId: number | undefined,
): Promise<string> {
	if (processId === undefined) throw new Error("The test process has no PID.");
	const powerShell = join(
		requiredSystemRoot(),
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const result = await runProcess(
		powerShell,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-Process -Id ${processId} -ErrorAction Stop).ProcessName`,
		],
		dirname(powerShell),
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Unable to inspect test process ${processId}:\n${result.output}`,
		);
	}
	return result.output.trim().toLowerCase();
}

async function waitForArmed(scenario: WindowsInstallerScenario): Promise<void> {
	await waitUntil(async () => {
		try {
			const proof = JSON.parse(await readFile(scenario.readyPath, "utf8")) as {
				schemaVersion?: unknown;
				transactionId?: unknown;
				nonce?: unknown;
				state?: unknown;
			};
			return (
				proof.schemaVersion === "whalehall.windows-install-ready.v1" &&
				proof.transactionId === scenario.plan.transactionId &&
				proof.nonce === scenario.plan.readyNonce &&
				proof.state === "armed"
			);
		} catch {
			return false;
		}
	}, "the Windows helper to arm");
}

async function waitForFileValue(path: string, expected: string): Promise<void> {
	await waitUntil(async () => {
		try {
			return (await readFile(path, "utf8")) === expected;
		} catch {
			return false;
		}
	}, `file ${path} to contain ${expected}`);
}

async function waitUntil(
	probe: () => Promise<boolean>,
	description: string,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await probe()) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

async function spawnStarted(
	command: string,
	arguments_: string[],
): Promise<ChildProcess> {
	const child = spawn(command, arguments_, {
		stdio: "ignore",
		windowsHide: true,
	});
	await waitForSpawn(child);
	return child;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
	if (child.pid !== undefined) return;
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
}

function isChildAlive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (!isChildAlive(child)) return;
	const close = waitForClose(child, 5_000);
	child.kill();
	await close.catch(() => undefined);
}

async function waitForExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<number | null> {
	if (child.exitCode !== null || child.signalCode !== null)
		return child.exitCode;
	return waitForClose(child, timeoutMs);
}

function waitForClose(
	child: ChildProcess,
	timeoutMs: number,
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.removeListener("close", onClose);
			reject(new Error(`Process ${child.pid ?? "unknown"} did not exit.`));
		}, timeoutMs);
		const onClose = (code: number | null) => {
			clearTimeout(timer);
			resolve(code);
		};
		child.once("close", onClose);
	});
}

async function runProcess(
	command: string,
	arguments_: string[],
	cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
	const child = spawn(command, arguments_, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const output: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
	const exitCode = await waitForExit(child, 60_000);
	return { exitCode, output: Buffer.concat(output).toString("utf8") };
}
