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

describe("stable macOS release build gate", () => {
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
	});

	test("keeps the macOS runtime alive after the control window closes", async () => {
		const result = await evaluateConfig("canary", {});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"exitOnLastWindowClosed":false');
	});
});

async function evaluateConfig(
	channel: "canary" | "stable",
	overrides: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
	const environment = { ...process.env, ...overrides };
	delete environment.ELECTROBUN_DEVELOPER_ID;
	delete environment.WHALEHALL_APPLE_TEAM_ID;
	delete environment.WHALEHALL_MACOS_NOTARIZE;
	delete environment.WHALEHALL_RELEASE_SIGNING_REQUIRED;
	Object.assign(environment, overrides);

	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`console.log(JSON.stringify((await import(${JSON.stringify(configUrl)})).default.runtime))`,
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
