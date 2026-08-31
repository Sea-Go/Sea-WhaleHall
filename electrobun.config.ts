import { createPublicKey } from "node:crypto";
import type { ElectrobunConfig } from "electrobun";
import { MACOS_OUTER_ENTITLEMENTS } from "./scripts/macos-build-security";

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

function currentTarget(): {
	os: "macos" | "linux" | "win";
	arch: "arm64" | "x64";
} {
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
const nativeBinary =
	target.os === "win" ? "whalehall-local.exe" : "whalehall-local";
const nativeSource = `.native/${target.os}-${target.arch}/${nativeBinary}`;
const credentialHelperBinary =
	target.os === "win"
		? "whalehall-credential-helper.exe"
		: "whalehall-credential-helper";
const credentialHelperSource = `.native/${target.os}-${target.arch}/${credentialHelperBinary}`;
const nodeBinary = target.os === "win" ? "node.exe" : "node";
const nodeSource = `.native/${target.os}-${target.arch}/${nodeBinary}`;
const agentHostSource = `.native/${target.os}-${target.arch}/whalehall-agent-host.mjs`;
const agentSkillsSource = `.native/${target.os}-${target.arch}/skills`;
const buildEnvironment =
	process.argv
		.find((argument) => argument.startsWith("--env="))
		?.slice("--env=".length) ??
	process.env.ELECTROBUN_BUILD_ENV ??
	"dev";
const stableBuild = buildEnvironment === "stable";
const stableMacBuild = target.os === "macos" && buildEnvironment === "stable";
const stableWindowsBuild = target.os === "win" && buildEnvironment === "stable";
const releaseSigningRequired =
	stableMacBuild || process.env.WHALEHALL_RELEASE_SIGNING_REQUIRED === "true";
const macCodeSigningEnabled = Boolean(
	process.env.ELECTROBUN_DEVELOPER_ID?.trim(),
);
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
if (stableMacBuild && process.env.WHALEHALL_MACOS_NOTARIZE !== "true") {
	failClosedReleaseBuild(
		"Stable macOS builds require WHALEHALL_MACOS_NOTARIZE=true; unsigned or unnotarized stable artifacts are forbidden.",
	);
}
const releaseVersion = stableBuild
	? process.env.WHALEHALL_RELEASE_VERSION?.trim()
	: "0.1.0";
if (stableBuild && !/^\d+\.\d+\.\d+$/.test(releaseVersion ?? "")) {
	failClosedReleaseBuild(
		"WHALEHALL_RELEASE_VERSION must be an exact stable SemVer (x.y.z) for a stable build.",
	);
}
if (stableBuild) {
	const publicKeySpkiBase64 =
		process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64?.trim() ?? "";
	try {
		if (
			publicKeySpkiBase64 === "" ||
			Buffer.from(publicKeySpkiBase64, "base64").toString("base64") !==
				publicKeySpkiBase64
		) {
			throw new Error("not canonical base64");
		}
		const publicKey = createPublicKey({
			key: Buffer.from(publicKeySpkiBase64, "base64"),
			format: "der",
			type: "spki",
		});
		if (publicKey.asymmetricKeyType !== "ed25519") {
			throw new Error("not Ed25519");
		}
	} catch {
		failClosedReleaseBuild(
			"WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64 must contain a valid Ed25519 SPKI DER public key for a stable build.",
		);
	}
}
if (stableWindowsBuild) {
	for (const variable of [
		"WHALEHALL_WINDOWS_CERTIFICATE_PATH",
		"WHALEHALL_WINDOWS_CERTIFICATE_PASSWORD",
		"WHALEHALL_WINDOWS_CERTIFICATE_SHA1",
		"WHALEHALL_WINDOWS_PUBLISHER",
		"WHALEHALL_WINDOWS_SIGNTOOL_PATH",
	] as const) {
		if (!process.env[variable]?.trim()) {
			failClosedReleaseBuild(
				`${variable} is required for every stable Windows build.`,
			);
		}
	}
	if (
		!/^[A-F0-9]{40}$/.test(
			process.env.WHALEHALL_WINDOWS_CERTIFICATE_SHA1?.trim().toUpperCase() ??
				"",
		)
	) {
		failClosedReleaseBuild(
			"WHALEHALL_WINDOWS_CERTIFICATE_SHA1 must be the signing certificate's 40-character SHA-1 thumbprint.",
		);
	}
}
const nativeCopies: Record<string, string> = {
	[nativeSource]: `native/${nativeBinary}`,
	[credentialHelperSource]: `native/${credentialHelperBinary}`,
	[nodeSource]: `node/${nodeBinary}`,
	[agentHostSource]: "agent/whalehall-agent-host.mjs",
	[agentSkillsSource]: "agent/skills",
};
if (target.os === "macos") {
	nativeCopies[`.native/macos-${target.arch}/WhaleHall Observer.app`] =
		"native/WhaleHall Observer.app";
	nativeCopies[`.native/macos-${target.arch}/whalehall-vault-broker-v2`] =
		"native/whalehall-vault-broker-v2";
}

export default {
	app: {
		name: "WhaleHall",
		identifier: "com.seago.whalehall",
		version: releaseVersion ?? "0.1.0",
		description: "A desktop AI agent shell with an animated whale companion.",
	},
	build: {
		targets: "current",
		bun: {
			entrypoint: "src/bun/index.ts",
			sourcemap: "external",
			define: {
				"process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64":
					JSON.stringify(
						stableBuild
							? process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64?.trim()
							: "",
					),
			},
		},
		copy: {
			"dist/views": "views",
			"config.template.yaml": "config.yaml",
			...nativeCopies,
		},
		watch: [
			"config.template.yaml",
			"src/views",
			"src/agent",
			"skills",
			"native",
			"scripts",
		],
		watchIgnore: [
			"dist/**",
			".native/**",
			"native/**/target/**",
		],
		mac: {
			bundleCEF: false,
			codesign: macCodeSigningEnabled,
			icons: "assets/app-icon.iconset",
			entitlements: MACOS_OUTER_ENTITLEMENTS,
			notarize:
				macCodeSigningEnabled &&
				process.env.WHALEHALL_MACOS_NOTARIZE === "true",
			createDmg: true,
		},
		linux: {
			bundleCEF: true,
			defaultRenderer: "native",
			icon: "assets/app-icon.png",
		},
		win: {
			bundleCEF: false,
			icon: "assets/app-icon.ico",
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
		postBuild: "scripts/app-update-sign-windows.ts",
		postWrap: "scripts/post-wrap.ts",
		postPackage: "scripts/app-update-post-package.ts",
	},
	release: {
		baseUrl: stableBuild
			? "https://github.com/Sea-Go/Sea-WhaleHall/releases/latest/download"
			: "",
		generatePatch: false,
	},
} satisfies ElectrobunConfig;
