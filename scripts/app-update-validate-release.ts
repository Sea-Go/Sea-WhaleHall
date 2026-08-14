import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	compareStableSemver,
	parseAppUpdateManifest,
	parseStableSemver,
} from "../src/shared/app-update";
import { verifyManifestSignature } from "./app-update-manifest";

export function validateStableReleaseInputs({
	version,
	minimumSupportedVersion,
	releaseNotes,
	previousManifest,
	previousManifestSignature,
	previousVersion,
	publicKeySpkiBase64,
}: {
	version: string;
	minimumSupportedVersion: string;
	releaseNotes: string;
	previousManifest?: unknown;
	previousManifestSignature?: string;
	previousVersion?: string;
	publicKeySpkiBase64?: string;
}): void {
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
	validateStableReleaseInputs({
		version: argumentValue("version"),
		minimumSupportedVersion: argumentValue("minimum-supported-version"),
		releaseNotes,
		previousManifest:
			previousManifestPath === undefined
				? undefined
				: JSON.parse(readFileSync(resolve(previousManifestPath), "utf8")),
		previousManifestSignature:
			previousSignaturePath === undefined
				? undefined
				: readFileSync(resolve(previousSignaturePath), "utf8"),
		previousVersion:
			previousManifestPath === undefined
				? undefined
				: argumentValue("previous-version"),
		publicKeySpkiBase64:
			process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64?.trim(),
	});
	console.log("[app-update] Stable release inputs validated.");
}
