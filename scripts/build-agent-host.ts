import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	nodeRuntimeTarget,
	stageNodeRuntime,
} from "./node-runtime-manifest";

type TargetOS = "macos" | "linux" | "win";
type TargetArch = "arm64" | "x64";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function hostOS(): TargetOS {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "win32") return "win";
	if (process.platform === "linux") return "linux";
	throw new Error(`Unsupported host platform: ${process.platform}`);
}

function hostArch(): TargetArch {
	if (process.arch === "arm64") return "arm64";
	if (process.arch === "x64") return "x64";
	throw new Error(`Unsupported host architecture: ${process.arch}`);
}

function targetFromEnvironment(): { os: TargetOS; arch: TargetArch } {
	const os = process.env.ELECTROBUN_OS ?? hostOS();
	const arch = process.env.ELECTROBUN_ARCH ?? hostArch();
	if (os !== "macos" && os !== "linux" && os !== "win") {
		throw new Error(`Unsupported ELECTROBUN_OS value: ${os}`);
	}
	if (arch !== "arm64" && arch !== "x64") {
		throw new Error(`Unsupported ELECTROBUN_ARCH value: ${arch}`);
	}
	return { os, arch };
}

export async function buildAgentHost(): Promise<string> {
	const { os, arch } = targetFromEnvironment();
	if (os !== hostOS() || arch !== hostArch()) {
		throw new Error(
			`The Mastra sidecar and its pinned Node runtime must be staged on their target host (host=${hostOS()}-${hostArch()}, target=${os}-${arch}).`,
		);
	}
	const targetDirectory = resolve(projectRoot, `.native/${os}-${arch}`);
	const nodeRuntime = await stageNodeRuntime({
		target: nodeRuntimeTarget(os, arch),
		projectRoot,
		stageDirectory: targetDirectory,
	});
	const output = resolve(
		targetDirectory,
		"whalehall-agent-host.mjs",
	);
	const skillsSource = resolve(projectRoot, "skills");
	const stagedSkillsDirectory = resolve(targetDirectory, "skills");
	mkdirSync(dirname(output), { recursive: true });
	const result = await Bun.build({
		entrypoints: [resolve(projectRoot, "src/agent/mastra-host/main.ts")],
		outdir: dirname(output),
		naming: "whalehall-agent-host.mjs",
		target: "node",
		format: "esm",
		packages: "bundle",
		splitting: false,
		minify: false,
		sourcemap: "external",
	});
	if (!result.success) {
		throw new AggregateError(
			result.logs.map((log) => new Error(log.message)),
			"Failed to bundle the Mastra Node sidecar.",
		);
	}
	// Agent-level filesystem Skills are evaluated by the Node Sidecar at runtime.
	// Stage the canonical project directories next to the generated host so the
	// packaged app never relies on its launch working directory or source tree.
	cpSync(skillsSource, stagedSkillsDirectory, { recursive: true, force: true });
	const check = Bun.spawnSync([nodeRuntime.executablePath, "--check", output], {
		cwd: projectRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (check.exitCode !== 0) {
		throw new Error(`Node rejected the generated ESM sidecar (${check.exitCode}).`);
	}
	console.log(
		`[agent-host] pinned Node v${nodeRuntime.version}: ${nodeRuntime.executablePath}`,
	);
	console.log(`[agent-host] ${output}`);
	console.log(`[agent-host] ${stagedSkillsDirectory}`);
	return output;
}

if (import.meta.main) await buildAgentHost();
