import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	atomicSwapMacDirectories,
	prepareMacUpdateInstall,
	prepareMacUpdateTransaction,
} from "../src/bun/app-update-macos-installer";

const macTest = process.platform === "darwin" ? test : test.skip;
const temporaryRoots: string[] = [];
const launchedProcessIds = new Set<number>();

afterEach(async () => {
	for (const processId of launchedProcessIds) {
		try {
			process.kill(processId, "SIGKILL");
		} catch {
			// The short-lived probe process already closed.
		}
	}
	launchedProcessIds.clear();
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

type AppFixture = {
	readonly root: string;
	readonly currentAppPath: string;
	readonly executablePath: string;
	readonly stagedTarPath: string;
	readonly newLaunchMarker: string;
	readonly oldLaunchMarker: string;
};

async function createAppFixture(
	candidateLauncher: string,
): Promise<AppFixture> {
	const root = await mkdtemp(join(tmpdir(), "whalehall-mac-update-test-"));
	temporaryRoots.push(root);
	const apps = join(root, "Applications");
	const source = join(root, "archive-source");
	const bundleName = "WhaleHall.app";
	const currentAppPath = join(apps, bundleName);
	const candidateAppPath = join(source, bundleName);
	const newLaunchMarker = join(root, "new-launch.json");
	const oldLaunchMarker = join(root, "old-launch.json");
	await mkdir(apps, { recursive: true });
	await createBundle(currentAppPath, "old", launcherScript(oldLaunchMarker, 6));
	await createBundle(candidateAppPath, "new", candidateLauncher);
	const stagedTarPath = join(root, "verified-update.tar");
	await runProcess("/usr/bin/tar", [
		"-cf",
		stagedTarPath,
		"-C",
		source,
		bundleName,
	]);
	return {
		root,
		currentAppPath,
		executablePath: join(currentAppPath, "Contents", "MacOS", "bun"),
		stagedTarPath,
		newLaunchMarker,
		oldLaunchMarker,
	};
}

async function createBundle(
	appPath: string,
	version: string,
	launcher: string,
): Promise<void> {
	const macOS = join(appPath, "Contents", "MacOS");
	const resources = join(appPath, "Contents", "Resources");
	await mkdir(macOS, { recursive: true });
	await mkdir(resources, { recursive: true });
	await writeFile(join(appPath, "Contents", "Info.plist"), "<plist/>");
	await writeFile(join(resources, "version.json"), JSON.stringify({ version }));
	await writeFile(join(resources, "fixture-version"), version);
	await writeFile(join(macOS, "bun"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	await writeFile(join(macOS, "launcher"), launcher, { mode: 0o700 });
	await Promise.all([
		chmod(join(macOS, "bun"), 0o700),
		chmod(join(macOS, "launcher"), 0o700),
	]);
}

function launcherScript(markerPath: string, seconds: number): string {
	return `#!/bin/sh\nprintf '{"processId":%s}\\n' "$$" > '${markerPath}'\nexec /bin/sleep ${seconds}\n`;
}

async function runProcess(
	command: string,
	arguments_: readonly string[],
): Promise<void> {
	await new Promise<void>((resolveProcess, rejectProcess) => {
		const child = spawn(command, [...arguments_], {
			stdio: "ignore",
			shell: false,
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		let failure: Error | null = null;
		child.once("error", (error) => {
			failure = error;
		});
		child.once("close", (code) => {
			if (failure !== null) rejectProcess(failure);
			else if (code !== 0)
				rejectProcess(new Error(`${basename(command)} failed with ${code}.`));
			else resolveProcess();
		});
	});
}

async function readJsonWhenReady(
	path: string,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const value = JSON.parse(await readFile(path, "utf8")) as unknown;
			if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
			) {
				return value as Record<string, unknown>;
			}
		} catch (error) {
			if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
		}
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${basename(path)}.`);
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

async function rememberLaunchedProcess(markerPath: string): Promise<void> {
	const marker = await readJsonWhenReady(markerPath, 10_000);
	const processId = marker.processId;
	if (typeof processId !== "number") {
		throw new Error("Launcher marker has no process identity.");
	}
	launchedProcessIds.add(processId);
}

async function waitForProcessExit(
	processId: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(processId, 0);
		} catch {
			return;
		}
		await Bun.sleep(25);
	}
	throw new Error(`Process ${processId} remained alive.`);
}

async function runRealHelperScenario(fixture: AppFixture): Promise<{
	result: Record<string, unknown>;
	transactionRoot: string;
	helperProcessId: number;
}> {
	const moduleUrl = pathToFileURL(
		join(process.cwd(), "src", "bun", "app-update-macos-installer.ts"),
	).href;
	const mainHarnessPath = join(fixture.root, "main-harness.mjs");
	const launcherHarnessPath = join(fixture.root, "launcher-harness.mjs");
	const configPath = join(fixture.root, "harness-config.json");
	const statusPath = join(fixture.root, "harness-status.json");
	const exitSignalPath = join(fixture.root, "exit-main");
	await writeFile(
		mainHarnessPath,
		`import { writeFile } from "node:fs/promises";
import { prepareMacUpdateTransaction, launchMacUpdateInstaller, waitForMacUpdateInstallerReady } from ${JSON.stringify(moduleUrl)};
const config = await Bun.file(process.argv[2]).json();
try {
  const prepared = await prepareMacUpdateTransaction({
    stagedTarPath: config.stagedTarPath,
    executablePath: config.executablePath,
    helperRuntimePath: process.execPath,
    mainProcessId: process.pid,
    launcherProcessId: process.ppid,
    verifyCandidate: async () => {},
  });
  const helper = await launchMacUpdateInstaller(prepared);
  await waitForMacUpdateInstallerReady(prepared, helper, 10000);
  helper.detach();
  await writeFile(config.statusPath, JSON.stringify({ transactionRoot: prepared.paths.transactionRoot, resultPath: prepared.paths.resultPath, helperProcessId: helper.processId }));
  while (!(await Bun.file(config.exitSignalPath).exists())) await Bun.sleep(25);
  process.exit(0);
} catch (error) {
  await writeFile(config.statusPath, JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }));
  process.exit(2);
}
`,
	);
	await writeFile(
		launcherHarnessPath,
		`import { spawn } from "node:child_process";
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore", shell: false });
child.once("error", () => process.exit(3));
child.once("close", (code) => process.exit(code ?? 4));
`,
	);
	await writeFile(
		configPath,
		JSON.stringify({
			stagedTarPath: fixture.stagedTarPath,
			executablePath: fixture.executablePath,
			statusPath,
			exitSignalPath,
		}),
	);
	const harness = spawn(
		process.execPath,
		[launcherHarnessPath, mainHarnessPath, configPath],
		{ stdio: "ignore", shell: false },
	);
	const harnessClosed = new Promise<number | null>((resolveClose) => {
		harness.once("close", resolveClose);
	});
	const status = await readJsonWhenReady(statusPath, 15_000);
	if (typeof status.error === "string") throw new Error(status.error);
	const transactionRoot = status.transactionRoot;
	const resultPath = status.resultPath;
	const helperProcessId = status.helperProcessId;
	if (
		typeof transactionRoot !== "string" ||
		typeof resultPath !== "string" ||
		typeof helperProcessId !== "number"
	) {
		throw new Error("Harness did not return the prepared transaction.");
	}
	await writeFile(exitSignalPath, "exit");
	expect(await harnessClosed).toBe(0);
	const result = await readJsonWhenReady(resultPath, 15_000);
	await waitForProcessExit(helperProcessId, 5_000);
	return { result, transactionRoot, helperProcessId };
}

describe("app-owned macOS updater", () => {
	macTest("uses Darwin's atomic directory exchange", async () => {
		const root = await mkdtemp(join(tmpdir(), "whalehall-mac-swap-test-"));
		temporaryRoots.push(root);
		const first = join(root, "first");
		const second = join(root, "second");
		await Promise.all([mkdir(first), mkdir(second)]);
		await Promise.all([
			writeFile(join(first, "old"), "old"),
			writeFile(join(second, "new"), "new"),
		]);

		await atomicSwapMacDirectories(first, second);

		expect(await readdir(first)).toEqual(["new"]);
		expect(await readdir(second)).toEqual(["old"]);
	});

	macTest(
		"runs the detached helper after both exact owners exit and starts the new launcher",
		async () => {
			const fixture = await createAppFixture(
				launcherScript(join(tmpdir(), `unused-${crypto.randomUUID()}`), 6),
			);
			// Rebuild with the fixture-owned marker now that its root is known.
			const sourceApp = join(
				dirname(fixture.stagedTarPath),
				"archive-source",
				"WhaleHall.app",
			);
			await writeFile(
				join(sourceApp, "Contents", "MacOS", "launcher"),
				launcherScript(fixture.newLaunchMarker, 6),
				{ mode: 0o700 },
			);
			await runProcess("/usr/bin/tar", [
				"-cf",
				fixture.stagedTarPath,
				"-C",
				join(fixture.root, "archive-source"),
				"WhaleHall.app",
			]);

			const { result, transactionRoot } = await runRealHelperScenario(fixture);
			expect(result.state).toBe("installed");
			await rememberLaunchedProcess(fixture.newLaunchMarker);
			expect(
				await readFile(
					join(
						fixture.currentAppPath,
						"Contents",
						"Resources",
						"fixture-version",
					),
					"utf8",
				),
			).toBe("new");
			expect(
				await readFile(
					join(
						transactionRoot,
						"backup.app",
						"Contents",
						"Resources",
						"fixture-version",
					),
					"utf8",
				),
			).toBe("old");
		},
		30_000,
	);

	macTest(
		"atomically rolls back a launcher that exits early and starts the old launcher",
		async () => {
			const fixture = await createAppFixture("#!/bin/sh\nexit 19\n");
			const { result, transactionRoot } = await runRealHelperScenario(fixture);
			expect(result.state).toBe("rolled_back");
			await rememberLaunchedProcess(fixture.oldLaunchMarker);
			expect(
				await readFile(
					join(
						fixture.currentAppPath,
						"Contents",
						"Resources",
						"fixture-version",
					),
					"utf8",
				),
			).toBe("old");
			expect(
				await readFile(
					join(
						transactionRoot,
						"failed-candidate.app",
						"Contents",
						"Resources",
						"fixture-version",
					),
					"utf8",
				),
			).toBe("new");
		},
		30_000,
	);

	macTest("rejects link entries before Bun extracts them", async () => {
		const fixture = await createAppFixture("#!/bin/sh\nexit 0\n");
		const sourceApp = join(fixture.root, "archive-source", "WhaleHall.app");
		await symlink(
			"version.json",
			join(sourceApp, "Contents", "Resources", "unsafe-link"),
		);
		await runProcess("/usr/bin/tar", [
			"-cf",
			fixture.stagedTarPath,
			"-C",
			join(fixture.root, "archive-source"),
			"WhaleHall.app",
		]);

		await expect(
			prepareMacUpdateTransaction({
				stagedTarPath: fixture.stagedTarPath,
				executablePath: fixture.executablePath,
				helperRuntimePath: process.execPath,
				mainProcessId: process.pid,
				launcherProcessId: process.ppid,
				verifyCandidate: async () => {},
			}),
		).rejects.toThrow("link or special entry");
		expect(
			(await readdir(dirname(fixture.currentAppPath))).filter((entry) =>
				entry.startsWith(".whalehall-update-"),
			),
		).toEqual([]);
	});

	macTest("does not exit when the exact helper never arms", async () => {
		const fixture = await createAppFixture("#!/bin/sh\nexit 0\n");
		let exitCount = 0;
		let terminateCount = 0;
		await expect(
			prepareMacUpdateInstall({
				stagedTarPath: fixture.stagedTarPath,
				executablePath: fixture.executablePath,
				helperRuntimePath: process.execPath,
				mainProcessId: process.pid,
				launcherProcessId: process.ppid,
				verifyCandidate: async () => {},
				readyTimeoutMs: 25,
				exitForUpdate() {
					exitCount += 1;
				},
				launchInstaller: async () => ({
					processId: 987_654,
					closed: new Promise<void>(() => {}),
					isClosed: () => false,
					detach() {},
					async terminateAndWait() {
						terminateCount += 1;
					},
				}),
			}),
		).rejects.toThrow("did not become ready");
		expect(exitCount).toBe(0);
		expect(terminateCount).toBe(1);
	});

	macTest(
		"does not exit for a durable ready proof from a closed helper",
		async () => {
			const fixture = await createAppFixture("#!/bin/sh\nexit 0\n");
			let exitCount = 0;
			let terminateCount = 0;
			await expect(
				prepareMacUpdateInstall({
					stagedTarPath: fixture.stagedTarPath,
					executablePath: fixture.executablePath,
					helperRuntimePath: process.execPath,
					mainProcessId: process.pid,
					launcherProcessId: process.ppid,
					verifyCandidate: async () => {},
					exitForUpdate() {
						exitCount += 1;
					},
					launchInstaller: async (prepared) => {
						const helperProcessId = 987_655;
						await writeFile(
							prepared.paths.readyPath,
							JSON.stringify({
								schemaVersion: "whalehall.macos-install-ready.v1",
								transactionId: prepared.plan.transactionId,
								nonce: prepared.plan.readyNonce,
								state: "armed",
								helperProcessId,
							}),
						);
						return {
							processId: helperProcessId,
							closed: new Promise<void>(() => {}),
							isClosed: () => true,
							detach() {},
							async terminateAndWait() {
								terminateCount += 1;
							},
						};
					},
				}),
			).rejects.toThrow("closed after becoming ready");
			expect(exitCount).toBe(0);
			expect(terminateCount).toBe(1);
		},
	);

	test("fails closed off macOS", async () => {
		if (process.platform === "darwin") {
			expect(process.platform).toBe("darwin");
			return;
		}
		await expect(
			prepareMacUpdateTransaction({
				stagedTarPath: "/unavailable",
				executablePath: "/unavailable",
				mainProcessId: 2,
				launcherProcessId: 3,
			}),
		).rejects.toThrow("unavailable on this platform");
	});
});
