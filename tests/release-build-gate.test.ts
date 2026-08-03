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
			[
				// This is a macOS release-gate fixture even when the Bun test suite
				// itself runs on a Windows or Linux hosted runner. Override the two
				// read-only process descriptors before importing the config so the
				// test cannot silently exercise a non-macOS branch.
				`Object.defineProperty(process, "platform", { value: "darwin" });`,
				`Object.defineProperty(process, "arch", { value: "x64" });`,
				`const config = (await import(${JSON.stringify(configUrl)})).default;`,
				`console.log(JSON.stringify({ runtime: config.runtime, copy: config.build.copy }));`,
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
