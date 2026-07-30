import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = join(import.meta.dir, "..");
const configPath = join(repositoryRoot, "electrobun.config.ts");
const configUrl = pathToFileURL(configPath).href;

describe("stable macOS release build gate", () => {
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
			`await import(${JSON.stringify(configUrl)})`,
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
