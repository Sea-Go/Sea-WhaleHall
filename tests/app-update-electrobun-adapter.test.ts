import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createElectrobunAppUpdaterAdapter,
	type WindowsUpdateInstallerPlan,
	windowsUpdateInstallerLaunch,
} from "../src/bun/app-update-controller";
import {
	APP_UPDATE_MANIFEST_SCHEMA_VERSION,
	type AppUpdateManifest,
} from "../src/shared/app-update";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function manifest(): AppUpdateManifest {
	return {
		schemaVersion: APP_UPDATE_MANIFEST_SCHEMA_VERSION,
		appId: "com.seago.whalehall",
		channel: "stable",
		platform: "macos",
		arch: "arm64",
		version: "1.2.0",
		buildHash: "verifiedhash",
		minimumSupportedVersion: "1.0.0",
		publishedAt: "2026-08-13T08:00:00.000Z",
		releaseNotes: "release",
		assets: [
			{
				kind: "full",
				filename: "stable-macos-arm64-WhaleHall.app.tar.zst",
				url: "https://github.com/Sea-Go/Sea-WhaleHall/releases/download/v1.2.0/stable-macos-arm64-WhaleHall.app.tar.zst",
				size: 10,
				sha256: "a".repeat(64),
			},
		],
	};
}

function windowsManifest(): AppUpdateManifest {
	return {
		...manifest(),
		platform: "win",
		arch: "x64",
		assets: [
			{
				kind: "full",
				filename: "stable-win-x64-WhaleHall.tar.zst",
				url: "https://github.com/Sea-Go/Sea-WhaleHall/releases/download/v1.2.0/stable-win-x64-WhaleHall.tar.zst",
				size: 10,
				sha256: "a".repeat(64),
			},
		],
	};
}

async function setupRawUpdater(
	options: { recognize?: boolean; zstdExitCode?: number } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "whalehall-electrobun-adapter-"));
	directories.push(root);
	const binDirectory = join(root, "bin");
	const appData = join(root, "app-data");
	await mkdir(binDirectory, { recursive: true });
	await mkdir(join(appData, "self-extraction"), { recursive: true });
	const zstd = join(binDirectory, "zig-zstd");
	const zstdScript =
		options.zstdExitCode === undefined
			? `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -i) input="$2"; shift 2 ;;\n    -o) output="$2"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\ncp "$input" "$output"\n`
			: `#!/bin/sh\nexit ${options.zstdExitCode}\n`;
	await writeFile(zstd, zstdScript, { mode: 0o700 });
	await chmod(zstd, 0o700);
	const archivePath = join(root, "verified.tar.zst");
	await writeFile(archivePath, "new verified tar");
	const info: Record<string, unknown> = {
		version: "1.2.0",
		hash: "verifiedhash",
		updateAvailable: true,
		updateReady: false,
		error: "",
	};
	const calls = {
		networkChecks: 0,
		download: 0,
		macInstall: 0,
		appliedHashes: [] as string[],
	};
	const rawUpdater = {
		async getLocalInfo() {
			return {
				name: "WhaleHall",
				version: "1.1.0",
				hash: "localhash",
				channel: "stable",
				identifier: "com.seago.whalehall",
			};
		},
		async checkForUpdate() {
			calls.networkChecks += 1;
			return { ...info };
		},
		updateInfo() {
			return info;
		},
		async appDataFolder() {
			return appData;
		},
		async downloadUpdate() {
			calls.download += 1;
			const pinned = (await rawUpdater.checkForUpdate()) as Record<
				string,
				unknown
			>;
			if (options.recognize !== false) {
				Object.assign(info, pinned, { updateReady: true });
			}
		},
	};
	const adapter = createElectrobunAppUpdaterAdapter(rawUpdater, {
		executablePath: join(binDirectory, "WhaleHall"),
		platform: "darwin",
		arch: "arm64",
		exitForUpdate() {},
		async installMacUpdate() {
			calls.macInstall += 1;
			calls.appliedHashes.push(String(info.hash));
			throw new Error(
				"The macOS updater exit handoff returned without terminating the application.",
			);
		},
	});
	return { root, appData, archivePath, adapter, calls, rawUpdater, info };
}

describe("Electrobun app updater adapter", () => {
	test("uses only signed metadata while Electrobun recognizes the preverified full tar", async () => {
		const { adapter, archivePath, appData, calls } = await setupRawUpdater();
		await adapter.stageVerifiedFullArchive({
			archivePath,
			manifest: manifest(),
		});
		expect(calls.networkChecks).toBe(0);
		expect(calls.download).toBe(1);
		expect(
			await readFile(
				join(appData, "self-extraction", "verifiedhash.tar"),
				"utf8",
			),
		).toBe("new verified tar");
		await expect(adapter.applyStagedUpdate()).rejects.toThrow(
			"exit handoff returned",
		);
		expect(calls.networkChecks).toBe(0);
		expect(calls.macInstall).toBe(1);
	});

	test("retains an existing staged tar when decompression fails", async () => {
		const { adapter, archivePath, appData } = await setupRawUpdater({
			zstdExitCode: 9,
		});
		const target = join(appData, "self-extraction", "verifiedhash.tar");
		await writeFile(target, "previous trusted tar");
		await expect(
			adapter.stageVerifiedFullArchive({ archivePath, manifest: manifest() }),
		).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe("previous trusted tar");
	});

	test("restores an existing staged tar if Electrobun refuses recognition", async () => {
		const { adapter, archivePath, appData } = await setupRawUpdater({
			recognize: false,
		});
		const target = join(appData, "self-extraction", "verifiedhash.tar");
		await writeFile(target, "previous trusted tar");
		await expect(
			adapter.stageVerifiedFullArchive({ archivePath, manifest: manifest() }),
		).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe("previous trusted tar");
	});

	test("rechecks the decompressed staged tar immediately before apply", async () => {
		const { adapter, archivePath, appData, calls } = await setupRawUpdater();
		await adapter.stageVerifiedFullArchive({
			archivePath,
			manifest: manifest(),
		});
		await writeFile(
			join(appData, "self-extraction", "verifiedhash.tar"),
			"tampered after verification",
		);
		await expect(adapter.applyStagedUpdate()).rejects.toThrow(
			"failed integrity verification",
		);
		expect(calls.macInstall).toBe(0);
	});

	test("uses a bounded exact-process Windows swap and requires an exact ready proof before exit", async () => {
		const root = await mkdtemp(join(tmpdir(), "whalehall-windows-updater-"));
		directories.push(root);
		const binDirectory = join(root, "bin");
		const appData = join(root, "app-data");
		await mkdir(binDirectory, { recursive: true });
		await mkdir(join(appData, "self-extraction"), { recursive: true });
		const zstd = join(binDirectory, "zig-zstd.exe");
		await writeFile(
			zstd,
			`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -i) input="$2"; shift 2 ;;;\n    -o) output="$2"; shift 2 ;;;\n    *) shift ;;;\n  esac\ndone\ncp "$input" "$output"\n`.replaceAll(
				";;;",
				";;",
			),
			{ mode: 0o700 },
		);
		await chmod(zstd, 0o700);
		const archivePath = join(root, "verified.tar.zst");
		await writeFile(
			archivePath,
			await new Bun.Archive({
				"WhaleHall/bin/launcher.exe": "signed launcher",
				"WhaleHall/Resources/version.json": "{}",
			}).bytes(),
		);
		const info: Record<string, unknown> = {
			version: "1.2.0",
			hash: "verifiedhash",
			updateAvailable: true,
			updateReady: false,
			error: "",
		};
		let exitCount = 0;
		let capturedPlan: WindowsUpdateInstallerPlan | undefined;
		let capturedScript = "";
		const rawUpdater = {
			async getLocalInfo() {
				return {
					name: "WhaleHall",
					version: "1.1.0",
					hash: "localhash",
					channel: "stable",
					identifier: "com.seago.whalehall",
				};
			},
			async checkForUpdate() {
				return { ...info };
			},
			updateInfo() {
				return info;
			},
			async appDataFolder() {
				return appData;
			},
			async downloadUpdate() {
				Object.assign(info, await rawUpdater.checkForUpdate(), {
					updateReady: true,
				});
			},
		};
		const adapter = createElectrobunAppUpdaterAdapter(rawUpdater, {
			executablePath: join(binDirectory, "WhaleHall.exe"),
			platform: "win32",
			arch: "x64",
			processId: 4242,
			exitForUpdate: () => {
				exitCount += 1;
			},
			launchWindowsInstaller: async (plan) => {
				capturedPlan = plan;
				const transactionRoot = join(
					plan.appDataRoot,
					".whalehall-update",
					plan.transactionId,
				);
				capturedScript = await readFile(
					join(transactionRoot, "install.ps1"),
					"utf8",
				);
				await writeFile(
					join(transactionRoot, "armed.json"),
					JSON.stringify({
						schemaVersion: "whalehall.windows-install-ready.v1",
						transactionId: plan.transactionId,
						nonce: plan.readyNonce,
						state: "armed",
					}),
				);
				return {
					closed: new Promise<void>(() => {}),
					detach() {},
					async terminateAndWait() {},
				};
			},
		});

		await adapter.stageVerifiedFullArchive({
			archivePath,
			manifest: windowsManifest(),
		});
		await expect(adapter.applyStagedUpdate()).rejects.toThrow(
			"exit handoff returned",
		);

		expect(exitCount).toBe(1);
		expect(capturedPlan).toMatchObject({
			schemaVersion: "whalehall.windows-install-plan.v1",
			processId: 4242,
			appDataRoot: await realpath(appData),
			bundleName: "WhaleHall",
		});
		if (capturedPlan === undefined) throw new Error("Missing Windows plan.");
		expect(capturedScript).toContain("Get-Process -Id $parentProcessId");
		expect(capturedScript).toContain("$totalDeadlineSeconds = 120");
		expect(capturedScript).toContain(
			"[IO.Directory]::Move($Source, $Destination)",
		);
		expect(capturedScript).toContain(
			"Diagnostics must never change the swap or rollback state machine.",
		);
		expect(capturedScript).not.toContain("Remove-Item -LiteralPath $current");
		expect(capturedScript).not.toContain("tasklist");
		expect(capturedScript).not.toContain("goto waitloop");
		const launch = windowsUpdateInstallerLaunch(
			capturedPlan,
			join(root, "Windows"),
		);
		expect(launch.command).toBe(
			join(
				root,
				"Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			),
		);
		expect(launch.arguments).not.toContain("-Command");
		expect(launch.options).toMatchObject({
			cwd: join(
				capturedPlan.appDataRoot,
				".whalehall-update",
				capturedPlan.transactionId,
			),
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			shell: false,
		});

		let blockedExitCount = 0;
		let terminatedHelperCount = 0;
		const blockedAdapter = createElectrobunAppUpdaterAdapter(rawUpdater, {
			executablePath: join(binDirectory, "WhaleHall.exe"),
			platform: "win32",
			arch: "x64",
			processId: 4243,
			windowsInstallerReadyTimeoutMs: 25,
			exitForUpdate: () => {
				blockedExitCount += 1;
			},
			launchWindowsInstaller: async () => ({
				closed: new Promise<void>(() => {}),
				detach() {},
				async terminateAndWait() {
					terminatedHelperCount += 1;
				},
			}),
		});
		await blockedAdapter.stageVerifiedFullArchive({
			archivePath,
			manifest: windowsManifest(),
		});
		await expect(blockedAdapter.applyStagedUpdate()).rejects.toThrow(
			"did not become ready",
		);
		expect(blockedExitCount).toBe(0);
		expect(terminatedHelperCount).toBe(1);

		let resolveUnconfirmedClose!: () => void;
		const unconfirmedClose = new Promise<void>((resolve) => {
			resolveUnconfirmedClose = resolve;
		});
		let unconfirmedTerminateCount = 0;
		let unconfirmedExitCount = 0;
		const unconfirmedAdapter = createElectrobunAppUpdaterAdapter(rawUpdater, {
			executablePath: join(binDirectory, "WhaleHall.exe"),
			platform: "win32",
			arch: "x64",
			processId: 4244,
			windowsInstallerReadyTimeoutMs: 25,
			exitForUpdate: () => {
				unconfirmedExitCount += 1;
			},
			launchWindowsInstaller: async () => ({
				closed: unconfirmedClose,
				detach() {},
				async terminateAndWait() {
					unconfirmedTerminateCount += 1;
					throw new Error("close not confirmed");
				},
			}),
		});
		await unconfirmedAdapter.stageVerifiedFullArchive({
			archivePath,
			manifest: windowsManifest(),
		});
		let unconfirmedSettled = false;
		const unconfirmedApply = unconfirmedAdapter
			.applyStagedUpdate()
			.finally(() => {
				unconfirmedSettled = true;
			});
		const unconfirmedDeadline = Date.now() + 5_000;
		while (
			unconfirmedTerminateCount === 0 &&
			Date.now() < unconfirmedDeadline
		) {
			await Bun.sleep(10);
		}
		expect(unconfirmedTerminateCount).toBe(1);
		expect(unconfirmedExitCount).toBe(0);
		expect(unconfirmedSettled).toBe(false);
		resolveUnconfirmedClose();
		await expect(unconfirmedApply).rejects.toThrow("did not become ready");
		expect(unconfirmedSettled).toBe(true);

		const updateRoot = join(await realpath(appData), ".whalehall-update");
		const escapedRoot = join(root, "escaped-update-root");
		await rm(updateRoot, { recursive: true, force: true });
		await mkdir(escapedRoot);
		await symlink(escapedRoot, updateRoot, "dir");
		const reparseAdapter = createElectrobunAppUpdaterAdapter(rawUpdater, {
			executablePath: join(binDirectory, "WhaleHall.exe"),
			platform: "win32",
			arch: "x64",
			processId: 4245,
			exitForUpdate: () => {
				throw new Error("must not exit");
			},
		});
		await reparseAdapter.stageVerifiedFullArchive({
			archivePath,
			manifest: windowsManifest(),
		});
		await expect(reparseAdapter.applyStagedUpdate()).rejects.toThrow(
			"transaction root is untrusted",
		);
		expect(await readdir(escapedRoot)).toEqual([]);
	});

	test("never waits for Electrobun's uncancellable unsigned network check", async () => {
		const { adapter, archivePath, calls, rawUpdater } = await setupRawUpdater();
		rawUpdater.checkForUpdate = async () => new Promise<never>(() => {});
		await expect(
			adapter.stageVerifiedFullArchive({
				archivePath,
				manifest: manifest(),
			}),
		).resolves.toBeUndefined();
		await expect(adapter.applyStagedUpdate()).rejects.toThrow(
			"exit handoff returned",
		);
		expect(calls.networkChecks).toBe(0);
		expect(calls.appliedHashes).toEqual(["verifiedhash"]);
	});

	test("kills a stalled decompressor and preserves the previous staged tar", async () => {
		const { root, archivePath, appData } = await setupRawUpdater();
		const zstd = join(root, "bin", "zig-zstd");
		await writeFile(zstd, "#!/bin/sh\nsleep 60\n", { mode: 0o700 });
		await chmod(zstd, 0o700);
		const target = join(appData, "self-extraction", "verifiedhash.tar");
		await writeFile(target, "previous trusted tar");
		const rawUpdater = {
			async getLocalInfo() {
				return {
					version: "1.1.0",
					hash: "localhash",
					channel: "stable",
					identifier: "com.seago.whalehall",
				};
			},
			async checkForUpdate() {
				return {
					version: "1.2.0",
					hash: "verifiedhash",
					updateAvailable: true,
					updateReady: false,
					error: "",
				};
			},
			updateInfo() {
				return { hash: "verifiedhash", updateReady: false };
			},
			async appDataFolder() {
				return appData;
			},
			async downloadUpdate() {},
		};
		const adapter = createElectrobunAppUpdaterAdapter(rawUpdater, {
			executablePath: join(root, "bin", "WhaleHall"),
			platform: "darwin",
			arch: "arm64",
			processTimeoutMs: 25,
		});
		await expect(
			adapter.stageVerifiedFullArchive({ archivePath, manifest: manifest() }),
		).rejects.toThrow("timed out");
		expect(await readFile(target, "utf8")).toBe("previous trusted tar");
	});
});
