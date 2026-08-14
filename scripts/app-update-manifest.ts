import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as signBytes,
	verify as verifyBytes,
} from "node:crypto";
import {
	createReadStream,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	APP_UPDATE_MANIFEST_SCHEMA_VERSION,
	type AppUpdateArchitecture,
	type AppUpdateManifest,
	type AppUpdatePlatform,
	canonicalizeAppUpdateManifest,
	compareStableSemver,
	parseAppUpdateManifest,
	parseAppUpdateSignature,
	parseStableSemver,
} from "../src/shared/app-update";

const APP_UPDATE_APP_ID = "com.seago.whalehall" as const;

export type ReleasePlatform = AppUpdatePlatform;
export type ReleaseArchitecture = AppUpdateArchitecture;
export type { AppUpdateManifest };

export interface CreateAppUpdateManifestOptions {
	artifactDirectory: string;
	platform: ReleasePlatform;
	arch: ReleaseArchitecture;
	version: string;
	minimumSupportedVersion: string;
	publishedAt: string;
	releaseNotes: string;
	privateKeyPkcs8Base64: string;
	publicKeySpkiBase64: string;
}

export async function createSignedAppUpdateManifest(
	options: CreateAppUpdateManifestOptions,
): Promise<{
	manifestPath: string;
	signaturePath: string;
	manifest: AppUpdateManifest;
}> {
	assertSupportedTarget(options.platform, options.arch);
	parseStableSemver(options.version);
	parseStableSemver(options.minimumSupportedVersion);
	if (
		compareStableSemver(options.minimumSupportedVersion, options.version) > 0
	) {
		throw new Error("minimumSupportedVersion cannot exceed version.");
	}
	if (new Date(options.publishedAt).toISOString() !== options.publishedAt) {
		throw new Error("publishedAt must be a canonical UTC ISO timestamp.");
	}
	if (options.releaseNotes.trim() === "") {
		throw new Error("releaseNotes cannot be empty.");
	}
	const artifactDirectory = resolve(options.artifactDirectory);
	const prefix = `stable-${options.platform}-${options.arch}`;
	const bundleSuffix = options.platform === "macos" ? ".app" : "";
	const filename = `${prefix}-WhaleHall${bundleSuffix}.tar.zst`;
	const artifactPath = join(artifactDirectory, filename);
	const updateMetadataPath = join(artifactDirectory, `${prefix}-update.json`);
	const updateMetadata = readElectrobunUpdateMetadata(updateMetadataPath);
	if (
		updateMetadata.version !== options.version ||
		updateMetadata.platform !== options.platform ||
		updateMetadata.arch !== options.arch
	) {
		throw new Error(
			`Electrobun update metadata does not match ${prefix} v${options.version}.`,
		);
	}
	const stats = statSync(artifactPath);
	if (!stats.isFile() || stats.size <= 0) {
		throw new Error(`Full update archive is missing or empty: ${artifactPath}`);
	}
	const sha256 = await fileSha256(artifactPath);
	const manifest = parseAppUpdateManifest({
		schemaVersion: APP_UPDATE_MANIFEST_SCHEMA_VERSION,
		appId: APP_UPDATE_APP_ID,
		channel: "stable",
		platform: options.platform,
		arch: options.arch,
		version: options.version,
		buildHash: updateMetadata.hash,
		minimumSupportedVersion: options.minimumSupportedVersion,
		publishedAt: options.publishedAt,
		releaseNotes: options.releaseNotes,
		assets: [
			{
				kind: "full",
				filename,
				url:
					`https://github.com/Sea-Go/Sea-WhaleHall/releases/download/` +
					`v${options.version}/${filename}`,
				size: stats.size,
				sha256,
			},
		],
	});
	const privateKey = parseEd25519PrivateKey(options.privateKeyPkcs8Base64);
	const configuredPublicKey = parseEd25519PublicKey(
		options.publicKeySpkiBase64,
	);
	const derivedPublicKey = createPublicKey(
		privateKey.export({ type: "pkcs8", format: "pem" }),
	);
	const derivedSpki = derivedPublicKey
		.export({ type: "spki", format: "der" })
		.toString("base64");
	const configuredSpki = configuredPublicKey
		.export({ type: "spki", format: "der" })
		.toString("base64");
	if (derivedSpki !== configuredSpki) {
		throw new Error(
			"Manifest private key does not match the embedded public key.",
		);
	}
	const canonicalBytes = Buffer.from(
		canonicalizeAppUpdateManifest(manifest),
		"utf8",
	);
	const signature = signBytes(null, canonicalBytes, privateKey);
	if (signature.byteLength !== 64) {
		throw new Error("Ed25519 produced an invalid signature length.");
	}
	if (!verifyBytes(null, canonicalBytes, configuredPublicKey, signature)) {
		throw new Error("Generated manifest signature did not verify.");
	}
	const manifestPath = join(artifactDirectory, `${prefix}-manifest.json`);
	const signaturePath = join(artifactDirectory, `${prefix}-manifest.sig`);
	writeAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	writeAtomically(signaturePath, `${signature.toString("base64")}\n`);
	return { manifestPath, signaturePath, manifest };
}

export function verifyManifestSignature(
	manifest: AppUpdateManifest,
	signatureBase64: string,
	publicKeySpkiBase64: string,
): boolean {
	let signature: Uint8Array;
	let validatedManifest: AppUpdateManifest;
	try {
		signature = parseAppUpdateSignature(signatureBase64);
		validatedManifest = parseAppUpdateManifest(manifest);
	} catch {
		return false;
	}
	return verifyBytes(
		null,
		Buffer.from(canonicalizeAppUpdateManifest(validatedManifest), "utf8"),
		parseEd25519PublicKey(publicKeySpkiBase64),
		signature,
	);
}

export async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function readElectrobunUpdateMetadata(path: string): {
	version: string;
	hash: string;
	platform: ReleasePlatform;
	arch: ReleaseArchitecture;
} {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error(`Invalid update metadata: ${path}`);
	if (
		typeof parsed.version !== "string" ||
		typeof parsed.hash !== "string" ||
		parsed.hash.trim() === "" ||
		(parsed.platform !== "macos" && parsed.platform !== "win") ||
		(parsed.arch !== "arm64" && parsed.arch !== "x64")
	) {
		throw new Error(`Invalid update metadata fields: ${path}`);
	}
	return {
		version: parsed.version,
		hash: parsed.hash,
		platform: parsed.platform,
		arch: parsed.arch,
	};
}

function parseEd25519PrivateKey(value: string) {
	const key = createPrivateKey({
		key: decodeStrictBase64(value, "private key"),
		format: "der",
		type: "pkcs8",
	});
	if (key.asymmetricKeyType !== "ed25519") {
		throw new Error("Manifest private key must be Ed25519 PKCS8 DER.");
	}
	return key;
}

function parseEd25519PublicKey(value: string) {
	const key = createPublicKey({
		key: decodeStrictBase64(value, "public key"),
		format: "der",
		type: "spki",
	});
	if (key.asymmetricKeyType !== "ed25519") {
		throw new Error("Manifest public key must be Ed25519 SPKI DER.");
	}
	return key;
}

function decodeStrictBase64(value: string, label: string): Buffer {
	const normalized = value.trim();
	if (
		normalized === "" ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
			normalized,
		)
	) {
		throw new Error(`Invalid standard base64 ${label}.`);
	}
	const bytes = Buffer.from(normalized, "base64");
	if (bytes.toString("base64") !== normalized) {
		throw new Error(`Non-canonical standard base64 ${label}.`);
	}
	return bytes;
}

function assertSupportedTarget(
	platform: ReleasePlatform,
	arch: ReleaseArchitecture,
): void {
	if (
		(platform !== "macos" || arch !== "arm64") &&
		(platform !== "win" || arch !== "x64")
	) {
		throw new Error(`Unsupported Stable target: ${platform}-${arch}.`);
	}
}

function writeAtomically(path: string, contents: string): void {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o644 });
	renameSync(temporary, path);
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
	const platform = argumentValue("platform");
	const arch = argumentValue("arch");
	if (platform !== "macos" && platform !== "win") {
		throw new Error("--platform must be macos or win.");
	}
	if (arch !== "arm64" && arch !== "x64") {
		throw new Error("--arch must be arm64 or x64.");
	}
	const releaseNotesPath = resolve(argumentValue("release-notes-file"));
	const result = await createSignedAppUpdateManifest({
		artifactDirectory: resolve(argumentValue("artifact-directory")),
		platform,
		arch,
		version: argumentValue("version"),
		minimumSupportedVersion: argumentValue("minimum-supported-version"),
		publishedAt: argumentValue("published-at"),
		releaseNotes: readFileSync(releaseNotesPath, "utf8"),
		privateKeyPkcs8Base64:
			process.env.WHALEHALL_APP_UPDATE_PRIVATE_KEY_PKCS8_BASE64?.trim() ?? "",
		publicKeySpkiBase64:
			process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64?.trim() ?? "",
	});
	console.log(
		`[app-update] Created ${basename(result.manifestPath)} and ${basename(result.signaturePath)}.`,
	);
}
