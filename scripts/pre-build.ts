import { buildAgentHost } from "./build-agent-host";
import { buildNative } from "./build-native";
import { ensureElectrobunSignalForwarding } from "./electrobun-signal-forwarding";
import { stageViewAssets } from "./stage-view-assets";

function run(command: string[]): void {
	const result = Bun.spawnSync(command, {
		cwd: process.cwd(),
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (${result.exitCode}): ${command.join(" ")}`,
		);
	}
}

console.log("[prebuild] verifying Electrobun lifecycle signal forwarding");
ensureElectrobunSignalForwarding();
console.log("[prebuild] building React views");
run(["bun", "x", "vite", "build"]);
stageViewAssets();
console.log("[prebuild] building Rust child processes");
buildNative();
console.log("[prebuild] staging pinned Node and building local Mastra sidecar");
await buildAgentHost();
