export const APP_UPDATE_MANIFEST_SCHEMA_VERSION =
	"whalehall.app-update-manifest.v1" as const;
export const APP_UPDATE_SNAPSHOT_SCHEMA_VERSION =
	"whalehall.app-update-snapshot.v1" as const;

export type AppUpdatePlatform = "macos" | "win";
export type AppUpdateArchitecture = "arm64" | "x64";

export type AppUpdateAsset = {
	kind: "full";
	filename: string;
	url: string;
	size: number;
	sha256: string;
};

/**
 * Signed, stable-channel release metadata. The signature is stored in a
 * sibling `.sig` file and covers canonicalizeAppUpdateManifest(manifest).
 */
export type AppUpdateManifest = {
	schemaVersion: typeof APP_UPDATE_MANIFEST_SCHEMA_VERSION;
	appId: string;
	channel: "stable";
	platform: AppUpdatePlatform;
	arch: AppUpdateArchitecture;
	version: string;
	buildHash: string;
	minimumSupportedVersion: string;
	publishedAt: string;
	releaseNotes: string;
	assets: readonly [AppUpdateAsset];
};

export type AppUpdateReleaseSummary = {
	version: string;
	minimumSupportedVersion: string;
	mandatory: boolean;
	publishedAt: string;
	releaseNotes: string;
};

export type AppUpdateProgress = {
	receivedBytes: number;
	totalBytes: number;
	percent: number;
};

export type AppUpdateFailureCode =
	| "updates_disabled"
	| "network_unavailable"
	| "invalid_manifest"
	| "signature_invalid"
	| "incompatible_release"
	| "update_metadata_mismatch"
	| "download_failed"
	| "archive_size_mismatch"
	| "archive_digest_mismatch"
	| "staging_failed"
	| "install_blocked"
	| "install_failed"
	| "internal_error";

export type AppUpdateFailure = {
	code: AppUpdateFailureCode;
	message: string;
	retryable: boolean;
	operation: "check" | "download" | "install";
};

type AppUpdateSnapshotBase = {
	schemaVersion: typeof APP_UPDATE_SNAPSHOT_SCHEMA_VERSION;
	currentVersion: string | null;
	checkedAtMs: number | null;
};

export type AppUpdateSnapshot =
	| (AppUpdateSnapshotBase & { state: "idle" })
	| (AppUpdateSnapshotBase & { state: "checking" })
	| (AppUpdateSnapshotBase & {
			state: "disabled";
			reason: "non_stable_channel" | "unsupported_platform";
	  })
	| (AppUpdateSnapshotBase & { state: "up_to_date" })
	| (AppUpdateSnapshotBase & {
			state: "available";
			release: AppUpdateReleaseSummary;
	  })
	| (AppUpdateSnapshotBase & {
			state: "downloading";
			release: AppUpdateReleaseSummary;
			progress: AppUpdateProgress;
	  })
	| (AppUpdateSnapshotBase & {
			state: "verifying";
			release: AppUpdateReleaseSummary;
	  })
	| (AppUpdateSnapshotBase & {
			state: "ready";
			release: AppUpdateReleaseSummary;
	  })
	| (AppUpdateSnapshotBase & {
			state: "preparing_install";
			release: AppUpdateReleaseSummary;
	  })
	| (AppUpdateSnapshotBase & {
			state: "installing";
			release: AppUpdateReleaseSummary;
	  })
	| (AppUpdateSnapshotBase & {
			state: "failed";
			release: AppUpdateReleaseSummary | null;
			failure: AppUpdateFailure;
	  });

const MANIFEST_KEYS = [
	"schemaVersion",
	"appId",
	"channel",
	"platform",
	"arch",
	"version",
	"buildHash",
	"minimumSupportedVersion",
	"publishedAt",
	"releaseNotes",
	"assets",
] as const;
const ASSET_KEYS = ["kind", "filename", "url", "size", "sha256"] as const;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const BUILD_HASH_PATTERN = /^[a-z0-9]{1,64}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const MAX_RELEASE_NOTES_LENGTH = 32_768;
const MAX_ASSET_SIZE = 8 * 1024 * 1024 * 1024;
const TRUSTED_RELEASE_ASSET_HOST = "github.com";
const TRUSTED_RELEASE_ASSET_PREFIX = "/Sea-Go/Sea-WhaleHall/releases/download/";

export class AppUpdateValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AppUpdateValidationError";
	}
}

export function parseStableSemver(
	value: string,
): readonly [number, number, number] {
	const match = SEMVER_PATTERN.exec(value);
	if (match === null) {
		throw new AppUpdateValidationError(
			"A stable semantic version is required.",
		);
	}
	const parts = match.slice(1).map(Number);
	const major = parts[0];
	const minor = parts[1];
	const patch = parts[2];
	if (
		major === undefined ||
		minor === undefined ||
		patch === undefined ||
		![major, minor, patch].every(Number.isSafeInteger)
	) {
		throw new AppUpdateValidationError("The semantic version is out of range.");
	}
	return [major, minor, patch];
}

export function compareStableSemver(left: string, right: string): -1 | 0 | 1 {
	const leftParts = parseStableSemver(left);
	const rightParts = parseStableSemver(right);
	for (let index = 0; index < leftParts.length; index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		if (leftPart === undefined || rightPart === undefined) break;
		if (leftPart < rightPart) return -1;
		if (leftPart > rightPart) return 1;
	}
	return 0;
}

export function parseAppUpdateManifest(value: unknown): AppUpdateManifest {
	const manifest = expectRecord(
		value,
		"The update manifest must be an object.",
	);
	expectExactKeys(
		manifest,
		MANIFEST_KEYS,
		"The update manifest shape is invalid.",
	);
	if (manifest.schemaVersion !== APP_UPDATE_MANIFEST_SCHEMA_VERSION) {
		throw new AppUpdateValidationError(
			"The update manifest schema is unsupported.",
		);
	}
	const appId = expectBoundedString(
		manifest.appId,
		1,
		128,
		"The app id is invalid.",
	);
	if (manifest.channel !== "stable") {
		throw new AppUpdateValidationError(
			"Only the stable update channel is supported.",
		);
	}
	const platform = parsePlatform(manifest.platform);
	const arch = parseArchitecture(manifest.arch);
	if (
		(platform === "macos" && arch !== "arm64") ||
		(platform === "win" && arch !== "x64")
	) {
		throw new AppUpdateValidationError("The release target is unsupported.");
	}
	const version = expectStableSemver(manifest.version);
	const minimumSupportedVersion = expectStableSemver(
		manifest.minimumSupportedVersion,
	);
	if (compareStableSemver(minimumSupportedVersion, version) > 0) {
		throw new AppUpdateValidationError(
			"The minimum supported version exceeds the release version.",
		);
	}
	const buildHash = expectBoundedString(
		manifest.buildHash,
		1,
		64,
		"The build hash is invalid.",
	);
	if (!BUILD_HASH_PATTERN.test(buildHash)) {
		throw new AppUpdateValidationError("The build hash is invalid.");
	}
	const publishedAt = expectCanonicalTimestamp(manifest.publishedAt);
	const releaseNotes = expectBoundedString(
		manifest.releaseNotes,
		0,
		MAX_RELEASE_NOTES_LENGTH,
		"The release notes are invalid.",
	);
	if (hasForbiddenReleaseNoteControl(releaseNotes)) {
		throw new AppUpdateValidationError("The release notes are invalid.");
	}
	if (!Array.isArray(manifest.assets) || manifest.assets.length !== 1) {
		throw new AppUpdateValidationError(
			"The stable manifest must contain exactly one full archive.",
		);
	}
	const asset = parseAppUpdateAsset(manifest.assets[0]);
	const expectedFilename =
		platform === "macos"
			? "stable-macos-arm64-WhaleHall.app.tar.zst"
			: "stable-win-x64-WhaleHall.tar.zst";
	const expectedUrl =
		`https://github.com/Sea-Go/Sea-WhaleHall/releases/download/` +
		`v${version}/${expectedFilename}`;
	if (asset.filename !== expectedFilename || asset.url !== expectedUrl) {
		throw new AppUpdateValidationError(
			"The update archive is not the expected release asset.",
		);
	}
	return {
		schemaVersion: APP_UPDATE_MANIFEST_SCHEMA_VERSION,
		appId,
		channel: "stable",
		platform,
		arch,
		version,
		buildHash,
		minimumSupportedVersion,
		publishedAt,
		releaseNotes,
		assets: [asset],
	};
}

function hasForbiddenReleaseNoteControl(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if ((code >= 0 && code <= 8) || code === 11 || code === 12) return true;
		if ((code >= 14 && code <= 31) || code === 127) return true;
	}
	return false;
}

export function parseAppUpdateSignature(value: unknown): Uint8Array {
	if (typeof value !== "string") {
		throw new AppUpdateValidationError("The update signature is invalid.");
	}
	const normalized = value.trim();
	if (normalized.length === 0 || /\s/u.test(normalized)) {
		throw new AppUpdateValidationError("The update signature is invalid.");
	}
	const bytes = Buffer.from(normalized, "base64");
	if (bytes.byteLength !== 64 || bytes.toString("base64") !== normalized) {
		throw new AppUpdateValidationError("The update signature is invalid.");
	}
	return bytes;
}

/**
 * Deterministic JSON used by both the release signer and the desktop verifier.
 * Object keys are recursively sorted by JavaScript's UTF-16 string ordering;
 * arrays retain their manifest order and no insignificant whitespace is added.
 */
export function canonicalizeAppUpdateManifest(
	manifest: AppUpdateManifest,
): string {
	return canonicalJson(parseAppUpdateManifest(manifest));
}

export function appUpdateManifestFilename(
	platform: AppUpdatePlatform,
	arch: AppUpdateArchitecture,
): string {
	if (
		(platform === "macos" && arch !== "arm64") ||
		(platform === "win" && arch !== "x64")
	) {
		throw new AppUpdateValidationError("The release target is unsupported.");
	}
	return `stable-${platform}-${arch}-manifest.json`;
}

export function appUpdateSignatureFilename(
	platform: AppUpdatePlatform,
	arch: AppUpdateArchitecture,
): string {
	return appUpdateManifestFilename(platform, arch).replace(/\.json$/u, ".sig");
}

export function appUpdateReleaseSummary(
	manifest: AppUpdateManifest,
	currentVersion: string,
): AppUpdateReleaseSummary {
	parseStableSemver(currentVersion);
	return {
		version: manifest.version,
		minimumSupportedVersion: manifest.minimumSupportedVersion,
		mandatory:
			compareStableSemver(currentVersion, manifest.minimumSupportedVersion) < 0,
		publishedAt: manifest.publishedAt,
		releaseNotes: manifest.releaseNotes,
	};
}

export function sanitizeAppUpdateFailure(
	code: AppUpdateFailureCode,
	operation: AppUpdateFailure["operation"],
): AppUpdateFailure {
	const descriptions: Record<
		AppUpdateFailureCode,
		{ message: string; retryable: boolean }
	> = {
		updates_disabled: { message: "当前版本未启用自动更新。", retryable: false },
		network_unavailable: {
			message: "暂时无法连接更新服务，请稍后重试。",
			retryable: true,
		},
		invalid_manifest: {
			message: "更新信息无效，已停止安装。",
			retryable: true,
		},
		signature_invalid: {
			message: "更新签名校验失败，已停止安装。",
			retryable: true,
		},
		incompatible_release: {
			message: "此更新不适用于当前客户端。",
			retryable: false,
		},
		update_metadata_mismatch: {
			message: "更新文件与发布信息不一致，已停止安装。",
			retryable: true,
		},
		download_failed: {
			message: "更新下载失败，请检查网络后重试。",
			retryable: true,
		},
		archive_size_mismatch: {
			message: "更新文件大小校验失败，已删除下载文件。",
			retryable: true,
		},
		archive_digest_mismatch: {
			message: "更新文件完整性校验失败，已删除下载文件。",
			retryable: true,
		},
		staging_failed: { message: "更新文件准备失败，请重试。", retryable: true },
		install_blocked: {
			message: "客户端暂时无法安全重启，请稍后重试。",
			retryable: true,
		},
		install_failed: {
			message: "更新安装失败，当前版本仍可继续使用。",
			retryable: true,
		},
		internal_error: {
			message: "更新过程中发生内部错误，请稍后重试。",
			retryable: true,
		},
	};
	return { code, operation, ...descriptions[code] };
}

function parseAppUpdateAsset(value: unknown): AppUpdateAsset {
	const asset = expectRecord(value, "The update asset must be an object.");
	expectExactKeys(asset, ASSET_KEYS, "The update asset shape is invalid.");
	if (asset.kind !== "full") {
		throw new AppUpdateValidationError(
			"Only a full update archive is supported.",
		);
	}
	const filename = expectBoundedString(
		asset.filename,
		1,
		255,
		"The update filename is invalid.",
	);
	if (!SAFE_FILENAME_PATTERN.test(filename) || !filename.endsWith(".tar.zst")) {
		throw new AppUpdateValidationError("The update filename is invalid.");
	}
	const url = expectHttpsUrl(asset.url);
	if (
		typeof asset.size !== "number" ||
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		asset.size > MAX_ASSET_SIZE
	) {
		throw new AppUpdateValidationError("The update archive size is invalid.");
	}
	if (typeof asset.sha256 !== "string" || !SHA256_PATTERN.test(asset.sha256)) {
		throw new AppUpdateValidationError("The update archive digest is invalid.");
	}
	return {
		kind: "full",
		filename,
		url,
		size: asset.size,
		sha256: asset.sha256,
	};
}

function parsePlatform(value: unknown): AppUpdatePlatform {
	if (value !== "macos" && value !== "win") {
		throw new AppUpdateValidationError("The update platform is invalid.");
	}
	return value;
}

function parseArchitecture(value: unknown): AppUpdateArchitecture {
	if (value !== "arm64" && value !== "x64") {
		throw new AppUpdateValidationError("The update architecture is invalid.");
	}
	return value;
}

function expectStableSemver(value: unknown): string {
	if (typeof value !== "string") {
		throw new AppUpdateValidationError(
			"A stable semantic version is required.",
		);
	}
	parseStableSemver(value);
	return value;
}

function expectCanonicalTimestamp(value: unknown): string {
	if (typeof value !== "string") {
		throw new AppUpdateValidationError("The publication timestamp is invalid.");
	}
	const timestamp = Date.parse(value);
	if (
		!Number.isFinite(timestamp) ||
		new Date(timestamp).toISOString() !== value
	) {
		throw new AppUpdateValidationError("The publication timestamp is invalid.");
	}
	return value;
}

function expectHttpsUrl(value: unknown): string {
	const raw = expectBoundedString(
		value,
		1,
		2_048,
		"The update URL is invalid.",
	);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new AppUpdateValidationError("The update URL is invalid.");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== TRUSTED_RELEASE_ASSET_HOST ||
		!parsed.pathname.startsWith(TRUSTED_RELEASE_ASSET_PREFIX) ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.hash !== "" ||
		parsed.search !== ""
	) {
		throw new AppUpdateValidationError("The update URL is invalid.");
	}
	return parsed.toString();
}

function expectRecord(
	value: unknown,
	message: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AppUpdateValidationError(message);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	message: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw new AppUpdateValidationError(message);
	}
}

function expectBoundedString(
	value: unknown,
	minimumLength: number,
	maximumLength: number,
	message: string,
): string {
	if (
		typeof value !== "string" ||
		value.length < minimumLength ||
		value.length > maximumLength
	) {
		throw new AppUpdateValidationError(message);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new AppUpdateValidationError(
				"Canonical JSON cannot contain non-finite numbers.",
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new AppUpdateValidationError(
		"Canonical JSON contains an unsupported value.",
	);
}
