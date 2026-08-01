import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cStringLiteral } from "../scripts/build-native";
import { normalizeDesignatedRequirement } from "../scripts/macos-build-security";

const projectRoot = resolve(import.meta.dir, "..");
const brokerRoot = join(projectRoot, "native", "vault-broker");
const sanitizerEnvironment = {
	...process.env,
	// LeakSanitizer is not supported by Apple's ASan runtime. Address and
	// undefined-behavior checks still run for every native regression binary.
	ASAN_OPTIONS: "abort_on_error=1:detect_leaks=0",
	UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
};

function run(command: string[]): string {
	const result = Bun.spawnSync(command, {
		cwd: projectRoot,
		env: sanitizerEnvironment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(
		result.stderr,
	)}`;
	if (result.exitCode !== 0) {
		throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}\n${output}`);
	}
	return output;
}

function withTemporaryDirectory(runTest: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-vault-native-test-"));
	try {
		runTest(directory);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

function readAdHocDesignatedRequirement(path: string): string {
	// codesign prefixes ad-hoc requirement output with "# ", while production
	// Developer ID/local-certificate output is consumed without that marker.
	return normalizeDesignatedRequirement(
		run(["/usr/bin/codesign", "-dr", "-", path]).replace(/^# /gmu, ""),
	);
}

describe.skipIf(process.platform !== "darwin")(
	"native Vault Broker security tests",
	() => {
		test("executes the exact frame and delayed-byte socket regressions", () => {
			withTemporaryDirectory((directory) => {
				const executable = join(directory, "frame-tests");
				run([
					"/usr/bin/xcrun",
					"clang",
					"-std=c17",
					"-Wall",
					"-Wextra",
					"-Werror",
					"-fsanitize=address,undefined",
					join(brokerRoot, "frame.c"),
					join(brokerRoot, "Tests", "frame_tests.c"),
					"-o",
					executable,
				]);
				run([executable]);
			});
		});

		test("executes migration conflict, duplicate, and idempotency policy regressions", () => {
			withTemporaryDirectory((directory) => {
				const executable = join(directory, "keychain-policy-tests");
				run([
					"/usr/bin/xcrun",
					"clang",
					"-std=c17",
					"-Wall",
					"-Wextra",
					"-Werror",
					"-Wno-deprecated-declarations",
					"-fsanitize=address,undefined",
					join(brokerRoot, "frame.c"),
					join(brokerRoot, "keychain_store.c"),
					join(brokerRoot, "Tests", "keychain_policy_tests.c"),
					"-framework",
					"CoreFoundation",
					"-framework",
					"Security",
					"-o",
					executable,
				]);
				run([executable]);
			});
		});

		test("executes static core and complete-app signature validation", () => {
			withTemporaryDirectory((directory) => {
				const core = join(directory, "core-fixture");
				copyFileSync("/usr/bin/true", core);
				chmodSync(core, 0o755);
				run([
					"/usr/bin/codesign",
					"--force",
					"--sign",
					"-",
					"--identifier",
					"com.seago.whalehall.vault-test-core",
					"--timestamp=none",
					core,
				]);

				const app = join(directory, "VaultTest.app");
				const contents = join(app, "Contents");
				const executableDirectory = join(contents, "MacOS");
				mkdirSync(executableDirectory, { recursive: true });
				writeFileSync(
					join(contents, "Info.plist"),
					`<?xml version="1.0" encoding="UTF-8"?>\n`
						+ `<plist version="1.0"><dict>`
						+ `<key>CFBundleExecutable</key><string>fixture</string>`
						+ `<key>CFBundleIdentifier</key><string>com.seago.whalehall.vault-test-app</string>`
						+ `<key>CFBundlePackageType</key><string>APPL</string>`
						+ `</dict></plist>\n`,
					{ mode: 0o600 },
				);
				const launcher = join(executableDirectory, "fixture");
				copyFileSync("/usr/bin/true", launcher);
				chmodSync(launcher, 0o755);
				run([
					"/usr/bin/codesign",
					"--force",
					"--sign",
					"-",
					"--identifier",
					"com.seago.whalehall.vault-test-app",
					"--timestamp=none",
					app,
				]);

				const coreRequirement = readAdHocDesignatedRequirement(core);
				const appRequirement = readAdHocDesignatedRequirement(app);
				const testExecutable = join(directory, "static-code-tests");
				run([
					"/usr/bin/xcrun",
					"clang",
					"-std=c17",
					"-Wall",
					"-Wextra",
					"-Werror",
					"-Wno-deprecated-declarations",
					`-DWHALEHALL_CORE_REQUIREMENT=${cStringLiteral(coreRequirement)}`,
					`-DWHALEHALL_OUTER_REQUIREMENT=${cStringLiteral(appRequirement)}`,
					join(brokerRoot, "process_guard.c"),
					join(brokerRoot, "Tests", "static_code_tests.c"),
					"-lbsm",
					"-framework",
					"CoreFoundation",
					"-framework",
					"Security",
					"-o",
					testExecutable,
				]);
				run([testExecutable, core, app]);
			});
		});
	},
);
