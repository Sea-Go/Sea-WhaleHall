import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type TargetOS = "macos" | "linux" | "win";
type TargetArch = "arm64" | "x64";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(projectRoot, "whalehall-local/Cargo.toml");

function hostOS(): TargetOS {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "win32") return "win";
	return "linux";
}

function hostArch(): TargetArch {
	return process.arch === "arm64" ? "arm64" : "x64";
}

function run(command: string[]): void {
	const result = Bun.spawnSync(command, {
		cwd: projectRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) {
		throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
	}
}

export function buildNative(): string {
	const os = (process.env.ELECTROBUN_OS as TargetOS | undefined) ?? hostOS();
	const arch = (process.env.ELECTROBUN_ARCH as TargetArch | undefined) ?? hostArch();

	if (os !== hostOS() || arch !== hostArch()) {
		throw new Error(
			`Native child builds must run on their target host (host=${hostOS()}-${hostArch()}, target=${os}-${arch}).`,
		);
	}

	run([
		"cargo",
		"build",
		"--release",
		"--locked",
		"--manifest-path",
		manifestPath,
		"--package",
		"whalehall-local-server",
	]);

	const binaryName = os === "win" ? "whalehall-local.exe" : "whalehall-local";
	const source = resolve(projectRoot, "whalehall-local/target/release", binaryName);
	const destination = resolve(projectRoot, `.native/${os}-${arch}`, binaryName);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
	if (os !== "win") chmodSync(destination, 0o755);
	console.log(`[native] ${source} -> ${destination}`);
	return destination;
}

if (import.meta.main) buildNative();
