import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	developmentQaWindowSize,
	DevelopmentQaAuthSession,
	isDevelopmentQaMode,
} from "../src/bun/development-qa-auth";

const repositoryRoot = join(import.meta.dir, "..");
const configPath = join(repositoryRoot, "electrobun.config.ts");
const configUrl = pathToFileURL(configPath).href;
const TEST_UPDATE_PUBLIC_KEY =
	"MCowBQYDK2VwAyEAT6w4HVc7Jf2UdAPqVPOMecmDkMtQQx5h5K6GTYvIGrI=";

describe("stable release build gate", () => {
	test("keeps the in-memory QA login fail-closed outside an explicitly enabled dev runtime", () => {
		expect(isDevelopmentQaMode("dev", { WHALEHALL_QA_MODE: "1" })).toBe(true);
		for (const channel of ["canary", "stable"] as const) {
			expect(isDevelopmentQaMode(channel, { WHALEHALL_QA_MODE: "1" })).toBe(false);
		}
		expect(isDevelopmentQaMode("dev", {})).toBe(false);
		expect(isDevelopmentQaMode("dev", { WHALEHALL_QA_MODE: "true" })).toBe(false);
	});

	test("allows only the two visual QA sizes behind the same dev-only gate", () => {
		const enabled = {
			WHALEHALL_QA_MODE: "1",
			WHALEHALL_QA_WINDOW_WIDTH: "1440",
			WHALEHALL_QA_WINDOW_HEIGHT: "900",
		};
		expect(developmentQaWindowSize("dev", enabled)).toEqual({ width: 1440, height: 900 });
		expect(developmentQaWindowSize("stable", enabled)).toBeNull();
		expect(
			developmentQaWindowSize("dev", {
				...enabled,
				WHALEHALL_QA_WINDOW_WIDTH: "1600",
			}),
		).toBeNull();
	});

	test("QA session accepts only public experience credentials and expires in memory", () => {
		const auth = new DevelopmentQaAuthSession();
		expect(auth.signIn("demo@whalehall.local", "wrong", 1_000)).toBeNull();
		const session = auth.signIn("DEMO@WHALEHALL.LOCAL", "whalehall", 1_000);
		expect(session?.user.email).toBe("demo@whalehall.local");
		expect(auth.restore(1_001)?.id).toBe("development-qa-session");
		expect(auth.restore(1_000 + 12 * 60 * 60 * 1_000)).toBeNull();
	});
	test("terminates config evaluation before Electrobun can fall back to unsigned defaults", async () => {
		const result = await evaluateConfig("stable", {});
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("[whalehall-release-gate]");
		expect(result.output).toContain("ELECTROBUN_DEVELOPER_ID is required");
	});

	test("requires the Team ID after a Developer ID is supplied", async () => {
		const result = await evaluateConfig("stable", {
			ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Example",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("WHALEHALL_APPLE_TEAM_ID");
	});

	test("requires notarization after signing identity fields are supplied", async () => {
		const result = await evaluateConfig("stable", {
			ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Example",
			WHALEHALL_APPLE_TEAM_ID: "ABCDE12345",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("WHALEHALL_MACOS_NOTARIZE=true");
	});

	test("does not impose production signing gates on a canary config", async () => {
		const result = await evaluateConfig("canary", {});
		expect(result.exitCode).toBe(0);
		expect(result.output).not.toContain("[whalehall-release-gate]");
		for (const packagedResource of [
			"native/whalehall-local",
			"native/whalehall-credential-helper",
			"native/WhaleHall Observer.app",
			"native/whalehall-vault-broker-v2",
			"node/node",
			"agent/whalehall-agent-host.mjs",
		]) {
			expect(result.output).toContain(JSON.stringify(packagedResource));
		}
	});

	test("keeps the macOS runtime alive after the control window closes", async () => {
		const result = await evaluateConfig("canary", {});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"exitOnLastWindowClosed":false');
	});

	test("requires an explicit release version and update verification key", async () => {
		const signing = {
			ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Example",
			WHALEHALL_APPLE_TEAM_ID: "ABCDE12345",
			WHALEHALL_MACOS_NOTARIZE: "true",
		};
		const missingVersion = await evaluateConfig("stable", signing);
		expect(missingVersion.exitCode).not.toBe(0);
		expect(missingVersion.output).toContain("WHALEHALL_RELEASE_VERSION");

		const missingKey = await evaluateConfig("stable", {
			...signing,
			WHALEHALL_RELEASE_VERSION: "1.2.3",
		});
		expect(missingKey.exitCode).not.toBe(0);
		expect(missingKey.output).toContain(
			"WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64",
		);
	});

	test("embeds the Stable public key and disables delta generation", async () => {
		const result = await evaluateConfig("stable", {
			ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Example",
			WHALEHALL_APPLE_TEAM_ID: "ABCDE12345",
			WHALEHALL_MACOS_NOTARIZE: "true",
			WHALEHALL_RELEASE_VERSION: "1.2.3",
			WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64: TEST_UPDATE_PUBLIC_KEY,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"version":"1.2.3"');
		expect(result.output).toContain(
			"https://github.com/Sea-Go/Sea-WhaleHall/releases/latest/download",
		);
		expect(result.output).toContain('"generatePatch":false');
		expect(result.output).toContain(TEST_UPDATE_PUBLIC_KEY);
	});

	test("rejects a non-canonical Stable update public key encoding", async () => {
		const result = await evaluateConfig("stable", {
			ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Example",
			WHALEHALL_APPLE_TEAM_ID: "ABCDE12345",
			WHALEHALL_MACOS_NOTARIZE: "true",
			WHALEHALL_RELEASE_VERSION: "1.2.3",
			WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64: `${TEST_UPDATE_PUBLIC_KEY}!!`,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain(
			"WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64",
		);
	});

	test("fails closed when Stable Windows signing credentials are absent", async () => {
		const result = await evaluateConfig(
			"stable",
			{
				WHALEHALL_RELEASE_VERSION: "1.2.3",
				WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64: TEST_UPDATE_PUBLIC_KEY,
			},
			"win32",
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("WHALEHALL_WINDOWS_CERTIFICATE_PATH");
	});

	test("accepts only a complete Stable Windows signing configuration", async () => {
		const result = await evaluateConfig(
			"stable",
			{
				WHALEHALL_RELEASE_VERSION: "1.2.3",
				WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64: TEST_UPDATE_PUBLIC_KEY,
				WHALEHALL_WINDOWS_CERTIFICATE_PATH: "C:\\release.pfx",
				WHALEHALL_WINDOWS_CERTIFICATE_PASSWORD: "test-only",
				WHALEHALL_WINDOWS_CERTIFICATE_SHA1: "A".repeat(40),
				WHALEHALL_WINDOWS_PUBLISHER: "CN=Sea Go",
				WHALEHALL_WINDOWS_SIGNTOOL_PATH: "C:\\signtool.exe",
			},
			"win32",
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"version":"1.2.3"');
		expect(result.output).toContain('"exitOnLastWindowClosed":true');
	});
});

async function evaluateConfig(
	channel: "canary" | "stable",
	overrides: Record<string, string>,
	platform: "darwin" | "win32" = "darwin",
): Promise<{ exitCode: number; output: string }> {
	const environment = { ...process.env, ...overrides };
	for (const name of [
		"ELECTROBUN_DEVELOPER_ID",
		"WHALEHALL_APPLE_TEAM_ID",
		"WHALEHALL_MACOS_NOTARIZE",
		"WHALEHALL_RELEASE_SIGNING_REQUIRED",
		"WHALEHALL_RELEASE_VERSION",
		"WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64",
		"WHALEHALL_WINDOWS_CERTIFICATE_PATH",
		"WHALEHALL_WINDOWS_CERTIFICATE_PASSWORD",
		"WHALEHALL_WINDOWS_CERTIFICATE_SHA1",
		"WHALEHALL_WINDOWS_PUBLISHER",
		"WHALEHALL_WINDOWS_SIGNTOOL_PATH",
	]) {
		delete environment[name];
	}
	Object.assign(environment, overrides);

	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			[
				// This is a macOS release-gate fixture even when the Bun test suite
				// itself runs on a Windows or Linux hosted runner. Override the two
				// read-only process descriptors before importing the config so the
				// test cannot silently exercise a non-macOS branch.
				`Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
				`Object.defineProperty(process, "arch", { value: "x64" });`,
				`const config = (await import(${JSON.stringify(configUrl)})).default;`,
				`console.log(JSON.stringify({ app: config.app, runtime: config.runtime, copy: config.build.copy, bun: config.build.bun, release: config.release }));`,
			].join("\n"),
			"--",
			`--env=${channel}`,
		],
		{
			cwd: repositoryRoot,
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, output: `${stdout}\n${stderr}` };
}
