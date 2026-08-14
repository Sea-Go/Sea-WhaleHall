import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyElectrobunSignalForwardingTar } from "../scripts/app-update-post-package";
import {
	assertElectrobunSignalForwarding,
	ELECTROBUN_VENDOR_SIGNAL_SENTINEL,
	ELECTROBUN_WHALEHALL_LEGACY_SIGNAL_FORWARDING,
	ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
	ensureElectrobunSignalForwarding,
	rewriteElectrobunSignalForwarding,
	verifyMacWrapperSignalForwardingFromEnvironment,
} from "../scripts/electrobun-signal-forwarding";
import {
	isWhaleHallLifecycleSignalMessage,
	WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
	WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION,
} from "../src/shared/app-lifecycle-signal";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "..");

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Electrobun lifecycle signal forwarding", () => {
	test("rewrites the one exact Electrobun 1.18.1 signal block", () => {
		const original = `before\n${ELECTROBUN_VENDOR_SIGNAL_SENTINEL}\nafter`;
		const rewritten = rewriteElectrobunSignalForwarding(original);

		expect(rewritten.changed).toBeTrue();
		expect(rewritten.source).not.toContain(ELECTROBUN_VENDOR_SIGNAL_SENTINEL);
		expect(rewritten.source).toContain(ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING);
		assertElectrobunSignalForwarding(rewritten.source);
		expect(rewriteElectrobunSignalForwarding(rewritten.source)).toEqual({
			source: rewritten.source,
			changed: false,
		});
	});

	test("preserves the exact Windows CRLF runtime while applying the patch", () => {
		const windowsVendor = `before\r\n${ELECTROBUN_VENDOR_SIGNAL_SENTINEL.replaceAll("\n", "\r\n")}\r\nafter`;
		const rewritten = rewriteElectrobunSignalForwarding(windowsVendor);

		expect(rewritten.changed).toBeTrue();
		expect(rewritten.source).not.toContain(
			ELECTROBUN_VENDOR_SIGNAL_SENTINEL.replaceAll("\n", "\r\n"),
		);
		expect(rewritten.source.replaceAll("\r\n", "")).not.toContain("\n");
		assertElectrobunSignalForwarding(rewritten.source);
		expect(rewriteElectrobunSignalForwarding(rewritten.source)).toEqual({
			source: rewritten.source,
			changed: false,
		});
	});

	test("accepts Windows patchedDependencies hunk line endings only after exact canonical proof", () => {
		const mixedForwarder = ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING.replace(
			"\n",
			"\r\n",
		);
		const windowsPatched = `before\r\n${mixedForwarder}\nafter`;
		expect(rewriteElectrobunSignalForwarding(windowsPatched)).toEqual({
			source: windowsPatched,
			changed: false,
		});
		assertElectrobunSignalForwarding(windowsPatched);

		expect(() =>
			rewriteElectrobunSignalForwarding(
				`before\r\n${ELECTROBUN_VENDOR_SIGNAL_SENTINEL}\nafter`,
			),
		).toThrow("mixed line endings");
		expect(() =>
			rewriteElectrobunSignalForwarding(
				`before\r\n${mixedForwarder.replace("SIGTERM", "SIGQUIT")}\nafter`,
			),
		).toThrow("mixed line endings");
	});

	test("rejects mixed or unsupported runtime line endings", () => {
		expect(() =>
			rewriteElectrobunSignalForwarding(
				ELECTROBUN_VENDOR_SIGNAL_SENTINEL.replace("\n", "\r\n"),
			),
		).toThrow("mixed line endings");
		expect(() =>
			rewriteElectrobunSignalForwarding(
				ELECTROBUN_VENDOR_SIGNAL_SENTINEL.replace("\n", "\r"),
			),
		).toThrow("unsupported line ending");
	});

	test("upgrades the previous forwarder without leaving a startup signal gap", () => {
		const upgraded = rewriteElectrobunSignalForwarding(
			ELECTROBUN_WHALEHALL_LEGACY_SIGNAL_FORWARDING,
		);
		expect(upgraded.changed).toBeTrue();
		assertElectrobunSignalForwarding(upgraded.source);
		expect(upgraded.source.indexOf('process.on("SIGTERM"')).toBeLessThan(
			upgraded.source.indexOf("new Worker("),
		);

		const handlers = new Map<string, () => void>();
		const forwarded: unknown[] = [];
		class FakeWorker {
			constructor(_entrypoint: string, _options: object) {
				expect(handlers.has("SIGINT")).toBeTrue();
				expect(handlers.has("SIGTERM")).toBeTrue();
				// Simulate a signal delivered reentrantly during Worker construction.
				handlers.get("SIGTERM")?.();
			}

			postMessage(message: unknown): void {
				forwarded.push(message);
			}
		}
		const fakeProcess = {
			on(signal: string, listener: () => void) {
				handlers.set(signal, listener);
			},
		};
		const install = new Function(
			"Worker",
			"process",
			"appEntrypointPath",
			ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
		);
		install(FakeWorker, fakeProcess, "/tmp/app.js");
		expect(forwarded).toEqual([
			{
				type: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
				version: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION,
				signal: "SIGTERM",
			},
		]);
	});

	test("fails closed on vendor drift, duplicates, or mixed blocks", () => {
		for (const source of [
			ELECTROBUN_VENDOR_SIGNAL_SENTINEL.replace("SIGTERM", "SIGQUIT"),
			`${ELECTROBUN_VENDOR_SIGNAL_SENTINEL}\n${ELECTROBUN_VENDOR_SIGNAL_SENTINEL}`,
			`${ELECTROBUN_VENDOR_SIGNAL_SENTINEL}\n${ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING}`,
			`${ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING}\n${ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING}`,
		]) {
			expect(() => rewriteElectrobunSignalForwarding(source)).toThrow(
				"did not match the one exact supported",
			);
		}
	});

	test("uses one shared exact Worker message contract", () => {
		expect(WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE).toBe(
			"com.seago.whalehall.lifecycle.signal",
		);
		expect(WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION).toBe(1);
		expect(
			isWhaleHallLifecycleSignalMessage({
				type: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
				version: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION,
				signal: "SIGTERM",
			}),
		).toBeTrue();
		for (const invalid of [
			null,
			{},
			{
				type: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
				version: 2,
				signal: "SIGTERM",
			},
			{
				type: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
				version: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION,
				signal: "SIGKILL",
			},
			{
				type: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
				version: WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION,
				signal: "SIGINT",
				extra: true,
			},
		]) {
			expect(isWhaleHallLifecycleSignalMessage(invalid)).toBeFalse();
		}
	});

	test("installs the exact patch atomically and is idempotent", () => {
		const directory = temporaryDirectory();
		const runtimeMain = join(directory, "main.js");
		writeFileSync(
			runtimeMain,
			`before\n${ELECTROBUN_VENDOR_SIGNAL_SENTINEL}\nafter`,
		);

		ensureElectrobunSignalForwarding(runtimeMain);
		const first = readFileSync(runtimeMain, "utf8");
		assertElectrobunSignalForwarding(first);
		ensureElectrobunSignalForwarding(runtimeMain);
		expect(readFileSync(runtimeMain, "utf8")).toBe(first);
	});

	test("concurrent pre-builds converge on the same patched runtime", async () => {
		const directory = temporaryDirectory();
		const runtimeMain = join(directory, "main.js");
		writeFileSync(runtimeMain, ELECTROBUN_VENDOR_SIGNAL_SENTINEL);
		const helperUrl = pathToFileURL(
			join(repositoryRoot, "scripts", "electrobun-signal-forwarding.ts"),
		).href;
		const program = [
			`const helper = await import(${JSON.stringify(helperUrl)});`,
			`helper.ensureElectrobunSignalForwarding(${JSON.stringify(runtimeMain)});`,
		].join("\n");
		const children = Array.from({ length: 4 }, () =>
			Bun.spawn([process.execPath, "-e", program], {
				cwd: repositoryRoot,
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const results = await Promise.all(
			children.map(async (child) => ({
				exitCode: await child.exited,
				stderr: await new Response(child.stderr).text(),
			})),
		);
		expect(results).toEqual(
			Array.from({ length: 4 }, () => ({ exitCode: 0, stderr: "" })),
		);
		assertElectrobunSignalForwarding(readFileSync(runtimeMain, "utf8"));
	});

	test("rejects a linked runtime input", () => {
		const directory = temporaryDirectory();
		const target = join(directory, "target.js");
		const link = join(directory, "main.js");
		writeFileSync(target, ELECTROBUN_VENDOR_SIGNAL_SENTINEL);
		symlinkSync(target, link);
		expect(() => ensureElectrobunSignalForwarding(link)).toThrow(
			"regular non-link file",
		);
	});

	test("verifies the final macOS outer wrapper without mutating it", () => {
		const directory = temporaryDirectory();
		const wrapper = join(directory, "WhaleHall.app");
		const runtimeMain = join(wrapper, "Contents", "Resources", "main.js");
		mkdirSync(join(wrapper, "Contents", "Resources"), { recursive: true });
		writeFileSync(runtimeMain, ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING);
		verifyMacWrapperSignalForwardingFromEnvironment({
			ELECTROBUN_OS: "macos",
			ELECTROBUN_WRAPPER_BUNDLE_PATH: wrapper,
		});
		expect(readFileSync(runtimeMain, "utf8")).toBe(
			ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
		);
	});

	test.skipIf(process.platform === "win32")(
		"reads the exact runtime from a real updater tar",
		() => {
			const directory = temporaryDirectory();
			const payload = join(directory, "payload");
			const runtimeEntry = "WhaleHall.app/Contents/Resources/main.js";
			const runtimeMain = join(payload, runtimeEntry);
			mkdirSync(join(payload, "WhaleHall.app", "Contents", "Resources"), {
				recursive: true,
			});
			writeFileSync(runtimeMain, ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING);
			const tarPath = join(directory, "WhaleHall.app.tar");
			const create = Bun.spawnSync(
				["tar", "-cf", tarPath, "-C", payload, "WhaleHall.app"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(create.exitCode).toBe(0);
			verifyElectrobunSignalForwardingTar(tarPath, runtimeEntry);

			writeFileSync(runtimeMain, ELECTROBUN_VENDOR_SIGNAL_SENTINEL);
			const staleTar = join(directory, "stale.app.tar");
			const createStale = Bun.spawnSync(
				["tar", "-cf", staleTar, "-C", payload, "WhaleHall.app"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(createStale.exitCode).toBe(0);
			expect(() =>
				verifyElectrobunSignalForwardingTar(staleTar, runtimeEntry),
			).toThrow("missing the one exact WhaleHall signal forwarder");
		},
	);

	test("locks the exact Electrobun package patch in the manifest and lockfile", () => {
		const packageJson = JSON.parse(
			readFileSync(join(repositoryRoot, "package.json"), "utf8"),
		) as { patchedDependencies?: Record<string, string> };
		expect(packageJson.patchedDependencies).toEqual({
			"electrobun@1.18.1": "patches/electrobun@1.18.1.patch",
		});
		const lockfile = readFileSync(join(repositoryRoot, "bun.lock"), "utf8");
		expect(lockfile).toContain(
			'"electrobun@1.18.1": "patches/electrobun@1.18.1.patch"',
		);
		assertElectrobunSignalForwarding(
			readFileSync(
				join(repositoryRoot, "node_modules", "electrobun", "dist", "main.js"),
				"utf8",
			),
		);
		const electrobunCli = readFileSync(
			join(
				repositoryRoot,
				"node_modules",
				"electrobun",
				"src",
				"cli",
				"index.ts",
			),
			"utf8",
		);
		expect(electrobunCli).toContain('MAIN_JS: join(sharedDistDir, "main.js")');
		expect(electrobunCli).toContain(
			'cpSync(targetPaths.MAIN_JS, join(appBundleFolderResourcesPath, "main.js")',
		);
	});
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-electrobun-signal-"));
	temporaryDirectories.push(directory);
	return directory;
}
