import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	compareStableSemver,
	parseAppUpdateManifest,
	parseStableSemver,
} from "../src/shared/app-update";
import { verifyManifestSignature } from "./app-update-manifest";

export type StableReleaseScope = "macos-only" | "macos-and-windows";

export function validateStableReleaseInputs({
	version,
	minimumSupportedVersion,
	releaseNotes,
	releaseScope,
	previousManifest,
	previousManifestSignature,
	previousReleaseAssetNames,
	previousVersion,
	publicKeySpkiBase64,
}: {
	version: string;
	minimumSupportedVersion: string;
	releaseNotes: string;
	releaseScope: StableReleaseScope;
	previousManifest?: unknown;
	previousManifestSignature?: string;
	previousReleaseAssetNames?: readonly string[];
	previousVersion?: string;
	publicKeySpkiBase64?: string;
}): void {
	if (releaseScope !== "macos-only" && releaseScope !== "macos-and-windows") {
		throw new Error(
			"Stable release scope must be macos-only or macos-and-windows.",
		);
	}
	parseStableSemver(version);
	parseStableSemver(minimumSupportedVersion);
	if (compareStableSemver(minimumSupportedVersion, version) > 0) {
		throw new Error(
			"minimumSupportedVersion cannot exceed the release version.",
		);
	}
	if (releaseNotes.trim() === "" || releaseNotes.length > 32_768) {
		throw new Error(
			"Release notes must contain between 1 and 32768 characters.",
		);
	}
	if (previousManifest === undefined) return;
	if (previousReleaseAssetNames === undefined) {
		throw new Error(
			"The previous Stable release asset list is required for target validation.",
		);
	}
	validatePreviousReleaseTargets(releaseScope, previousReleaseAssetNames);
	const previous = parseAppUpdateManifest(previousManifest);
	if (previousVersion === undefined || previous.version !== previousVersion) {
		throw new Error(
			"The previous Stable tag and signed manifest do not match.",
		);
	}
	if (
		previousManifestSignature === undefined ||
		publicKeySpkiBase64 === undefined ||
		!verifyManifestSignature(
			previous,
			previousManifestSignature,
			publicKeySpkiBase64,
		)
	) {
		throw new Error("The previous Stable manifest signature is invalid.");
	}
	if (compareStableSemver(version, previous.version) <= 0) {
		throw new Error(
			`Release version ${version} must be newer than ${previous.version}.`,
		);
	}
	if (
		compareStableSemver(
			minimumSupportedVersion,
			previous.minimumSupportedVersion,
		) < 0
	) {
		throw new Error(
			"minimumSupportedVersion cannot move below the previous Stable floor.",
		);
	}
}

function validatePreviousReleaseTargets(
	releaseScope: StableReleaseScope,
	assetNames: readonly string[],
): void {
	const assetSet = new Set(assetNames);
	const macManifest = assetSet.has("stable-macos-arm64-manifest.json");
	const macSignature = assetSet.has("stable-macos-arm64-manifest.sig");
	if (!macManifest || !macSignature) {
		throw new Error(
			"The previous Stable release must contain the macOS manifest/signature pair.",
		);
	}

	const windowsAssets = assetNames.filter((name) =>
		name.startsWith("stable-win-x64-"),
	);
	const windowsManifest = assetSet.has("stable-win-x64-manifest.json");
	const windowsSignature = assetSet.has("stable-win-x64-manifest.sig");
	if (
		windowsManifest !== windowsSignature ||
		(windowsAssets.length > 0 && (!windowsManifest || !windowsSignature))
	) {
		throw new Error(
			"The previous Stable Windows target has an incomplete manifest/signature pair.",
		);
	}
	if (releaseScope === "macos-only" && windowsManifest) {
		throw new Error(
			"Stable release targets cannot remove Windows after it has been published.",
		);
	}
}

function argumentValue(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`--${name} is required.`);
	return value;
}

if (import.meta.main) {
	const releaseNotes = readFileSync(
		resolve(argumentValue("release-notes-file")),
		"utf8",
	);
	const previousManifestArgument = process.argv.indexOf("--previous-manifest");
	const previousManifestPath =
		previousManifestArgument >= 0
			? process.argv[previousManifestArgument + 1]
			: undefined;
	if (previousManifestArgument >= 0 && !previousManifestPath) {
		throw new Error("--previous-manifest requires a path.");
	}
	const previousSignatureArgument = process.argv.indexOf(
		"--previous-manifest-signature",
	);
	const previousSignaturePath =
		previousSignatureArgument >= 0
			? process.argv[previousSignatureArgument + 1]
			: undefined;
	if (previousSignatureArgument >= 0 && !previousSignaturePath) {
		throw new Error("--previous-manifest-signature requires a path.");
	}
	const previousAssetsArgument = process.argv.indexOf(
		"--previous-release-assets-file",
	);
	const previousAssetsPath =
		previousAssetsArgument >= 0
			? process.argv[previousAssetsArgument + 1]
			: undefined;
	if (previousAssetsArgument >= 0 && !previousAssetsPath) {
		throw new Error("--previous-release-assets-file requires a path.");
	}
	const releaseScope = argumentValue("release-scope");
	if (
		releaseScope !== "macos-only" &&
		releaseScope !== "macos-and-windows"
	) {
		throw new Error(
			"--release-scope must be macos-only or macos-and-windows.",
		);
	}
	validateStableReleaseInputs({
		version: argumentValue("version"),
		minimumSupportedVersion: argumentValue("minimum-supported-version"),
		releaseNotes,
		releaseScope,
		previousManifest:
			previousManifestPath === undefined
				? undefined
				: JSON.parse(readFileSync(resolve(previousManifestPath), "utf8")),
		previousManifestSignature:
			previousSignaturePath === undefined
				? undefined
				: readFileSync(resolve(previousSignaturePath), "utf8"),
		previousReleaseAssetNames:
			previousAssetsPath === undefined
				? undefined
				: readFileSync(resolve(previousAssetsPath), "utf8")
						.split(/\r?\n/u)
						.filter((name) => name !== ""),
		previousVersion:
			previousManifestPath === undefined
				? undefined
				: argumentValue("previous-version"),
		publicKeySpkiBase64:
			process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64?.trim(),
	});
	console.log("[app-update] Stable release inputs validated.");
}
