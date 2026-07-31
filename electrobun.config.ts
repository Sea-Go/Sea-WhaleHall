import type { ElectrobunConfig } from "electrobun";

/**
 * Electrobun currently falls back to its default config when this module
 * throws during loading. Release preconditions must therefore terminate the
 * build process instead of throwing, otherwise an unsigned stable artifact
 * can be produced after a visible configuration error.
 */
function failClosedReleaseBuild(message: string): never {
	console.error(`[whalehall-release-gate] ${message}`);
	process.exit(1);
}

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
const buildEnvironment =
	process.argv
		.find((argument) => argument.startsWith("--env="))
		?.slice("--env=".length) ??
	process.env.ELECTROBUN_BUILD_ENV ??
	"dev";
const stableMacBuild = target.os === "macos" && buildEnvironment === "stable";
const releaseSigningRequired =
	stableMacBuild ||
	process.env.WHALEHALL_RELEASE_SIGNING_REQUIRED === "true";
const macCodeSigningEnabled = Boolean(process.env.ELECTROBUN_DEVELOPER_ID?.trim());
if (target.os === "macos" && releaseSigningRequired && !macCodeSigningEnabled) {
	failClosedReleaseBuild(
		"ELECTROBUN_DEVELOPER_ID is required for every stable or explicitly signed macOS build.",
	);
}
if (
	target.os === "macos" &&
	releaseSigningRequired &&
	!/^[A-Z0-9]{10}$/.test(process.env.WHALEHALL_APPLE_TEAM_ID?.trim() ?? "")
) {
	failClosedReleaseBuild(
		"WHALEHALL_APPLE_TEAM_ID must be the 10-character Apple Team ID for a signed macOS build.",
	);
}
if (
	stableMacBuild &&
	process.env.WHALEHALL_MACOS_NOTARIZE !== "true"
) {
	failClosedReleaseBuild(
		"Stable macOS builds require WHALEHALL_MACOS_NOTARIZE=true; unsigned or unnotarized stable artifacts are forbidden.",
	);
}
const nativeCopies: Record<string, string> = {
	[nativeSource]: `native/${nativeBinary}`,
};
if (target.os === "macos") {
	nativeCopies[`.native/macos-${target.arch}/WhaleHall Observer.app`] =
		"native/WhaleHall Observer.app";
}

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
			...nativeCopies,
		},
		watch: [
			"src/views",
			"src/agent",
			"whalehall-local/protocol/src",
			"whalehall-local/core/src",
			"whalehall-local/server/src",
			"native/observer",
			"scripts",
		],
		watchIgnore: ["dist/**", ".native/**", "whalehall-local/target/**"],
		mac: {
			bundleCEF: false,
			codesign: macCodeSigningEnabled,
			notarize:
				macCodeSigningEnabled &&
				process.env.WHALEHALL_MACOS_NOTARIZE === "true",
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
		// On macOS the control window is presentation state. The Bun process,
		// Timeline runtime, whalehall-local, and Observer remain resident until
		// the user explicitly quits WhaleHall.
		exitOnLastWindowClosed: target.os !== "macos",
	},
	scripts: {
		preBuild: "scripts/pre-build.ts",
	},
} satisfies ElectrobunConfig;
