import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAppUpdateManifest } from "../src/shared/app-update";
import {
	type AppUpdateManifest,
	fileSha256,
	verifyManifestSignature,
} from "./app-update-manifest";

const EXPECTED_FILES = [
	"stable-macos-arm64-update.json",
	"stable-macos-arm64-WhaleHall.app.tar.zst",
	"stable-macos-arm64-WhaleHall.dmg",
	"stable-macos-arm64-manifest.json",
	"stable-macos-arm64-manifest.sig",
	"stable-win-x64-update.json",
	"stable-win-x64-WhaleHall.tar.zst",
	"stable-win-x64-WhaleHall-Setup.zip",
	"stable-win-x64-manifest.json",
	"stable-win-x64-manifest.sig",
] as const;

export async function verifyStableReleaseDirectory({
	artifactDirectory,
	version,
	publicKeySpkiBase64,
}: {
	artifactDirectory: string;
	version: string;
	publicKeySpkiBase64: string;
}): Promise<void> {
	const directory = resolve(artifactDirectory);
	const entries = readdirSync(directory).sort();
	if (entries.some((entry) => entry.endsWith(".patch"))) {
		throw new Error(
			"Stable release directory contains a forbidden delta patch.",
		);
	}
	if (
		entries.length !== EXPECTED_FILES.length ||
		EXPECTED_FILES.some((entry) => !entries.includes(entry))
	) {
		throw new Error(
			`Stable release assets are incomplete or unexpected: ${entries.join(", ")}`,
		);
	}
	for (const entry of entries) {
		const stats = statSync(join(directory, entry));
		if (!stats.isFile() || stats.size <= 0) {
			throw new Error(`Stable release asset is missing or empty: ${entry}`);
		}
	}
	for (const prefix of ["stable-macos-arm64", "stable-win-x64"] as const) {
		const manifestPath = join(directory, `${prefix}-manifest.json`);
		const signaturePath = join(directory, `${prefix}-manifest.sig`);
		const manifest: AppUpdateManifest = parseAppUpdateManifest(
			JSON.parse(readFileSync(manifestPath, "utf8")),
		);
		if (manifest.version !== version) {
			throw new Error(`${prefix} manifest version does not match v${version}.`);
		}
		const updateMetadata: unknown = JSON.parse(
			readFileSync(join(directory, `${prefix}-update.json`), "utf8"),
		);
		if (
			!isRecord(updateMetadata) ||
			updateMetadata.version !== manifest.version ||
			updateMetadata.hash !== manifest.buildHash ||
			updateMetadata.platform !== manifest.platform ||
			updateMetadata.arch !== manifest.arch
		) {
			throw new Error(
				`${prefix} updater metadata does not match its manifest.`,
			);
		}
		if (
			!verifyManifestSignature(
				manifest,
				readFileSync(signaturePath, "utf8"),
				publicKeySpkiBase64,
			)
		) {
			throw new Error(`${prefix} manifest signature is invalid.`);
		}
		if (manifest.assets.length !== 1 || manifest.assets[0]?.kind !== "full") {
			throw new Error(
				`${prefix} manifest must contain exactly one full asset.`,
			);
		}
		const asset = manifest.assets[0];
		const assetPath = join(directory, asset.filename);
		const stats = statSync(assetPath);
		if (!stats.isFile() || stats.size !== asset.size) {
			throw new Error(`${asset.filename} size does not match its manifest.`);
		}
		if ((await fileSha256(assetPath)) !== asset.sha256) {
			throw new Error(`${asset.filename} digest does not match its manifest.`);
		}
		const expectedUrl =
			`https://github.com/Sea-Go/Sea-WhaleHall/releases/download/` +
			`v${version}/${asset.filename}`;
		if (asset.url !== expectedUrl) {
			throw new Error(`${prefix} manifest asset URL is not tag-pinned.`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argumentValue(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`--${name} is required.`);
	return value;
}

if (import.meta.main) {
	await verifyStableReleaseDirectory({
		artifactDirectory: argumentValue("artifact-directory"),
		version: argumentValue("version"),
		publicKeySpkiBase64:
			process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64?.trim() ?? "",
	});
	console.log("[app-update] Stable release assets and signatures verified.");
}
