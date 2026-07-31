import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MACOS_USAGE_DESCRIPTIONS,
	prepareMacWrapper,
	verifyMacWrapper,
} from "../scripts/macos-build-security";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe.skipIf(process.platform !== "darwin")("macOS wrapper security", () => {
	test("binds the canonical identity, permission descriptions, and automation entitlement", () => {
		const buildDirectory = mkdtempSync(join(tmpdir(), "whalehall-wrapper-"));
		temporaryDirectories.push(buildDirectory);
		const bundlePath = join(buildDirectory, "WhaleHall-canary.app");
		const contents = join(bundlePath, "Contents");
		const executableDirectory = join(contents, "MacOS");
		mkdirSync(executableDirectory, { recursive: true });
		copyFileSync("/usr/bin/true", join(executableDirectory, "launcher"));
		chmodSync(join(executableDirectory, "launcher"), 0o755);
		const nativeDirectory = join(contents, "Resources", "app", "native");
		mkdirSync(nativeDirectory, { recursive: true });
		const localServerPath = join(nativeDirectory, "whalehall-local");
		copyFileSync("/usr/bin/true", localServerPath);
		chmodSync(localServerPath, 0o755);
		signAdHoc(localServerPath, "com.seago.whalehall.local");

		const observerPath = join(nativeDirectory, "WhaleHall Observer.app");
		const observerContents = join(observerPath, "Contents");
		const observerExecutableDirectory = join(observerContents, "MacOS");
		mkdirSync(observerExecutableDirectory, { recursive: true });
		copyFileSync(
			"/usr/bin/true",
			join(observerExecutableDirectory, "whalehall-observer"),
		);
		chmodSync(
			join(observerExecutableDirectory, "whalehall-observer"),
			0o755,
		);
		writeFileSync(
			join(observerContents, "Info.plist"),
			`<?xml version="1.0" encoding="UTF-8"?>\n`
				+ `<plist version="1.0"><dict>\n`
				+ `<key>CFBundleExecutable</key><string>whalehall-observer</string>\n`
				+ `<key>CFBundleIdentifier</key><string>com.seago.whalehall.observer</string>\n`
				+ `<key>CFBundlePackageType</key><string>APPL</string>\n`
				+ `</dict></plist>\n`,
		);
		signAdHoc(observerPath, "com.seago.whalehall.observer");
		writeFileSync(
			join(contents, "Info.plist"),
			`<?xml version="1.0" encoding="UTF-8"?>\n`
				+ `<plist version="1.0"><dict>\n`
				+ `<key>CFBundleExecutable</key><string>launcher</string>\n`
				+ `<key>CFBundleIdentifier</key><string>com.seago.whalehall</string>\n`
				+ `<key>CFBundlePackageType</key><string>APPL</string>\n`
				+ `</dict></plist>\n`,
		);

		prepareMacWrapper({
			bundlePath,
			buildDirectory,
			appIdentifier: "com.seago.whalehall",
			electrobunWillSign: false,
		});
		verifyMacWrapper({
			bundlePath,
			appIdentifier: "com.seago.whalehall",
			requireTeamIdentifier: false,
		});

		const plist = readFileSync(join(contents, "Info.plist"), "utf8");
		for (const [key, description] of Object.entries(
			MACOS_USAGE_DESCRIPTIONS,
		)) {
			expect(plist).toContain(`<key>${key}</key>`);
			expect(plist).toContain(description);
		}
	});

	test("rejects a wrapper outside the declared build directory", () => {
		const buildDirectory = mkdtempSync(join(tmpdir(), "whalehall-build-"));
		const otherDirectory = mkdtempSync(join(tmpdir(), "whalehall-other-"));
		temporaryDirectories.push(buildDirectory, otherDirectory);

		expect(() =>
			prepareMacWrapper({
				bundlePath: join(otherDirectory, "WhaleHall.app"),
				buildDirectory,
				appIdentifier: "com.seago.whalehall",
				electrobunWillSign: false,
			}),
		).toThrow("inside its build directory");
	});
});

function signAdHoc(path: string, identifier: string): void {
	const result = Bun.spawnSync(
		[
			"/usr/bin/codesign",
			"--force",
			"--sign",
			"-",
			"--identifier",
			identifier,
			"--timestamp=none",
			path,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString());
	}
}
