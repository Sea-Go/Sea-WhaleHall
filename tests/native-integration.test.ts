import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Rust child speaks newline-delimited JSON over stdin/stdout", async () => {
	const projectRoot = resolve(import.meta.dir, "..");
	const manifest = resolve(projectRoot, "native/whalehall-core/Cargo.toml");
	const build = Bun.spawnSync(
		["cargo", "build", "--locked", "--manifest-path", manifest],
		{ cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(build.stderr));
	}

	const binary = resolve(
		projectRoot,
		"native/whalehall-core/target/debug",
		process.platform === "win32" ? "whalehall-core.exe" : "whalehall-core",
	);
	const child = Bun.spawn({
		cmd: [binary],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write('{"id":"health","method":"health.check","params":{}}\n');
	child.stdin.write('{"id":"echo","method":"echo","params":{"message":"from bun"}}\n');
	child.stdin.end();

	const output = await new Response(child.stdout).text();
	const exitCode = await child.exited;
	expect(exitCode).toBe(0);
	const responses = output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { id: string; ok: boolean; result: Record<string, unknown> });
	expect(responses).toHaveLength(2);
	expect(responses[0]).toMatchObject({ id: "health", ok: true });
	expect(responses[1]).toMatchObject({
		id: "echo",
		ok: true,
		result: { message: "from bun", handledBy: "whalehall-core" },
	});
});
