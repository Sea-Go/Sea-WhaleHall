import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type TargetOS = "macos" | "linux" | "win";
type TargetArch = "arm64" | "x64";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const localToolManifestPath = resolve(projectRoot, "whalehall-local/Cargo.toml");
const credentialHelperManifestPath = resolve(
	projectRoot,
	"whalehall-credential-helper/Cargo.toml",
);

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
		localToolManifestPath,
		"--package",
		"whalehall-local-server",
	]);
	run([
		"cargo",
		"build",
		"--release",
		"--locked",
		"--manifest-path",
		credentialHelperManifestPath,
		"--package",
		"whalehall-credential-helper",
	]);

	const binaryName = os === "win" ? "whalehall-local.exe" : "whalehall-local";
	const source = resolve(projectRoot, "whalehall-local/target/release", binaryName);
	const destination = resolve(projectRoot, `.native/${os}-${arch}`, binaryName);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
	if (os !== "win") chmodSync(destination, 0o755);
	console.log(`[native] ${source} -> ${destination}`);

	const helperBinaryName =
		os === "win"
			? "whalehall-credential-helper.exe"
			: "whalehall-credential-helper";
	const helperSource = resolve(
		projectRoot,
		"whalehall-credential-helper/target/release",
		helperBinaryName,
	);
	const helperDestination = resolve(
		projectRoot,
		`.native/${os}-${arch}`,
		helperBinaryName,
	);
	copyFileSync(helperSource, helperDestination);
	if (os !== "win") chmodSync(helperDestination, 0o755);
	console.log(`[native] ${helperSource} -> ${helperDestination}`);
	return destination;
}

if (import.meta.main) buildNative();
