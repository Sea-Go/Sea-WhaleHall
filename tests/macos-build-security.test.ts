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
	normalizeDesignatedRequirement,
	prepareMacWrapper,
	validateLocalDesignatedRequirementContinuity,
	verifyMacWrapper,
} from "../scripts/macos-build-security";
import {
	MACOS_LOCAL_SIGNING_COMMON_NAME,
	localDesignatedRequirement,
	parseCodeSigningIdentities,
	parseUserLoginKeychainPath,
	resolveMacSigningPlan,
	selectUniqueLocalSigningIdentity,
} from "../scripts/macos-signing-identity";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("macOS signing identity selection", () => {
	const localFingerprint = "A".repeat(40);
	const developerFingerprint = "B".repeat(40);
	const identities = parseCodeSigningIdentities(
		`  1) ${localFingerprint} "${MACOS_LOCAL_SIGNING_COMMON_NAME}"\n`
			+ `  2) ${developerFingerprint} `
			+ '"Developer ID Application: WhaleHall (ABCDE12345)"\n'
			+ "     2 valid identities found\n",
	);

	test("selects the one exact fixed local identity for a development build", () => {
		expect(selectUniqueLocalSigningIdentity(identities)).toEqual({
			fingerprint: localFingerprint,
			name: MACOS_LOCAL_SIGNING_COMMON_NAME,
		});
		expect(
			resolveMacSigningPlan({
				environment: {},
				buildEnvironment: "canary",
				identities,
			}),
		).toEqual({
			kind: "local",
			identity: localFingerprint,
			releaseRequired: false,
		});
	});

	test("selects only the current-user login keychain and binds the leaf hash", () => {
		expect(
			parseUserLoginKeychainPath(
				'    "/Users/example/Library/Keychains/login.keychain-db"\n'
					+ '    "/Users/example/Library/Keychains/other.keychain-db"\n',
			),
		).toBe("/Users/example/Library/Keychains/login.keychain-db");
		expect(
			localDesignatedRequirement(
				"com.seago.whalehall.observer",
				localFingerprint.toLowerCase(),
			),
		).toBe(
			'=designated => identifier "com.seago.whalehall.observer" '
				+ `and certificate leaf = H"${localFingerprint}"`,
		);
	});

	test("fails closed when the fixed local name is ambiguous", () => {
		expect(() =>
			selectUniqueLocalSigningIdentity([
				...identities,
				{ fingerprint: "C".repeat(40), name: MACOS_LOCAL_SIGNING_COMMON_NAME },
			]),
		).toThrow("ambiguous local signature");
	});

	test("allows only a valid matching Developer ID and Team for release", () => {
		expect(
			resolveMacSigningPlan({
				environment: {
					ELECTROBUN_DEVELOPER_ID:
						"Developer ID Application: WhaleHall (ABCDE12345)",
					WHALEHALL_APPLE_TEAM_ID: "ABCDE12345",
				},
				buildEnvironment: "stable",
				identities,
			}),
		).toEqual({
			kind: "developer-id",
			identity: developerFingerprint,
			teamIdentifier: "ABCDE12345",
			releaseRequired: true,
		});
	});

	test("never falls back to the local identity for release", () => {
		expect(() =>
			resolveMacSigningPlan({
				environment: {},
				buildEnvironment: "stable",
				identities,
			}),
		).toThrow("never a release fallback");
	});

	test("keeps development metadata-only when no fixed identity exists", () => {
		expect(
			resolveMacSigningPlan({
				environment: {},
				buildEnvironment: "dev",
				identities: [],
			}),
		).toEqual({ kind: "ad-hoc", releaseRequired: false });
	});
});

describe("local designated requirement continuity", () => {
	const requirement =
		'designated => identifier "com.seago.whalehall.local" '
		+ `and certificate leaf = H"${"A".repeat(40)}"`;

	test("accepts an unchanged certificate-anchored requirement", () => {
		expect(
			validateLocalDesignatedRequirementContinuity({
				stagedOutput: `Executable=/tmp/staged\n${requirement}\n`,
				packagedOutput: `Executable=/tmp/packaged\n${requirement}\n`,
				expectedIdentifier: "com.seago.whalehall.local",
			}),
		).toBe(normalizeDesignatedRequirement(requirement));
	});

	test("rejects ad-hoc cdhash requirements", () => {
		expect(() =>
			validateLocalDesignatedRequirementContinuity({
				stagedOutput:
					'designated => identifier "com.seago.whalehall.local" '
					+ 'and cdhash H"1234"',
				packagedOutput:
					'designated => identifier "com.seago.whalehall.local" '
					+ 'and cdhash H"1234"',
				expectedIdentifier: "com.seago.whalehall.local",
			}),
		).toThrow("ad-hoc cdhash");
	});

	test("rejects packaged identifier rewrites and changed requirements", () => {
		expect(() =>
			validateLocalDesignatedRequirementContinuity({
				stagedOutput: requirement,
				packagedOutput: requirement.replace(
					"com.seago.whalehall.local",
					"com.seago.whalehall.rewritten",
				),
				expectedIdentifier: "com.seago.whalehall.local",
			}),
		).toThrow("rewrote identifier");
		expect(() =>
			validateLocalDesignatedRequirementContinuity({
				stagedOutput: requirement,
				packagedOutput: requirement.replace(
					"A".repeat(40),
					"B".repeat(40),
				),
				expectedIdentifier: "com.seago.whalehall.local",
			}),
		).toThrow("differs from the staged");
	});
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

	test("fails closed when local-signing verification cannot find packaged native artifacts", () => {
		const buildDirectory = mkdtempSync(join(tmpdir(), "whalehall-local-gate-"));
		temporaryDirectories.push(buildDirectory);
		const bundlePath = join(buildDirectory, "WhaleHall-canary.app");
		const contents = join(bundlePath, "Contents");
		const executableDirectory = join(contents, "MacOS");
		mkdirSync(executableDirectory, { recursive: true });
		copyFileSync("/usr/bin/true", join(executableDirectory, "launcher"));
		chmodSync(join(executableDirectory, "launcher"), 0o755);
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

		expect(() =>
			verifyMacWrapper({
				bundlePath,
				appIdentifier: "com.seago.whalehall",
				requireTeamIdentifier: false,
				localSigningStagedNativeDirectory: join(
					buildDirectory,
					"staged-native",
				),
			}),
		).toThrow("missing application resources");
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
