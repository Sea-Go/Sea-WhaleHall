import type { ElectrobunConfig } from "electrobun";

function currentTarget(): { os: "macos" | "linux" | "win"; arch: "arm64" | "x64" } {
	const os =
		process.platform === "darwin"
			? "macos"
			: process.platform === "win32"
				? "win"
				: "linux";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return { os, arch };
}

const target = currentTarget();
const nativeBinary = target.os === "win" ? "whalehall-local.exe" : "whalehall-local";
const nativeSource = `.native/${target.os}-${target.arch}/${nativeBinary}`;

export default {
	app: {
		name: "WhaleHall",
		identifier: "com.seago.whalehall",
		version: "0.1.0",
		description: "A desktop AI agent shell with an animated whale companion.",
	},
	build: {
		targets: "current",
		bun: {
			entrypoint: "src/bun/index.ts",
			sourcemap: "external",
		},
		copy: {
			"dist/views": "views",
			[nativeSource]: `native/${nativeBinary}`,
		},
		watch: [
			"src/views",
			"src/agent",
			"whalehall-local/protocol/src",
			"whalehall-local/core/src",
			"whalehall-local/server/src",
			"scripts",
		],
		watchIgnore: ["dist/**", ".native/**", "whalehall-local/target/**"],
		mac: {
			bundleCEF: false,
			codesign: false,
			createDmg: true,
		},
		linux: {
			bundleCEF: true,
			defaultRenderer: "native",
		},
		win: {
			bundleCEF: false,
		},
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
	scripts: {
		preBuild: "scripts/pre-build.ts",
	},
} satisfies ElectrobunConfig;
