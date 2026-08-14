import { type SpawnOptions, spawn } from "node:child_process";
import {
	createHash,
	createPublicKey,
	randomBytes,
	verify as verifySignature,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
	APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
	type AppUpdateArchitecture,
	type AppUpdateFailureCode,
	type AppUpdateManifest,
	type AppUpdatePlatform,
	type AppUpdateReleaseSummary,
	type AppUpdateSnapshot,
	AppUpdateValidationError,
	appUpdateManifestFilename,
	appUpdateReleaseSummary,
	appUpdateSignatureFilename,
	canonicalizeAppUpdateManifest,
	compareStableSemver,
	parseAppUpdateManifest,
	parseAppUpdateSignature,
	parseStableSemver,
	sanitizeAppUpdateFailure,
} from "../shared/app-update";
import { prepareMacUpdateInstall } from "./app-update-macos-installer";

const DEFAULT_MANIFEST_BASE_URL =
	"https://github.com/Sea-Go/Sea-WhaleHall/releases/latest/download";
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const AUTOMATIC_CHECK_DELAY_MS = 10_000;
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_REQUEST_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const UPDATE_STAGING_TIMEOUT_MS = 5 * 60 * 1000;
const WINDOWS_INSTALLER_SPAWN_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALLER_READY_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALLER_CLOSE_TIMEOUT_MS = 5_000;
const WINDOWS_POWERSHELL_PATH =
	"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export type AppUpdaterLocalInfo = {
	version: string;
	buildHash: string;
	channel: string;
	appId: string;
	platform: AppUpdatePlatform | "unsupported";
	arch: AppUpdateArchitecture | "unsupported";
};

export type VerifiedFullArchive = {
	archivePath: string;
	manifest: AppUpdateManifest;
};

export type WindowsUpdateInstallerPlan = {
	schemaVersion: "whalehall.windows-install-plan.v1";
	transactionId: string;
	readyNonce: string;
	processId: number;
	appDataRoot: string;
	bundleName: string;
};

export type WindowsUpdateInstallerHandle = {
	closed: Promise<void>;
	detach(): void;
	terminateAndWait(): Promise<void>;
};

export type WindowsUpdateInstallerLaunch = {
	command: string;
	arguments: string[];
	options: SpawnOptions;
};

/** Electrobun is isolated behind this app-owned boundary. */
export interface AppUpdaterAdapter {
	getLocalInfo(): Promise<AppUpdaterLocalInfo>;
	stageVerifiedFullArchive(input: VerifiedFullArchive): Promise<void>;
	applyStagedUpdate(): Promise<void>;
}

export type AppUpdateInstallPreparation = { ready: true } | { ready: false };

export type AppUpdateControllerDependencies = {
	updater: AppUpdaterAdapter;
	publicKeySpkiBase64: string;
	downloadDirectory: string;
	fetch?: typeof globalThis.fetch;
	nowMs?: () => number;
	prepareForInstall?: (
		release: AppUpdateReleaseSummary,
	) => Promise<AppUpdateInstallPreparation>;
	onPreparedInstallFailure?: () => void;
	scheduleMandatoryInstall?: (run: () => void) => void;
	setTimeout?: typeof globalThis.setTimeout;
	clearTimeout?: typeof globalThis.clearTimeout;
	requestTimeoutMs?: number;
	downloadIdleTimeoutMs?: number;
};

export type AppUpdateListener = (snapshot: AppUpdateSnapshot) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, Extract<keyof T, K>>
	: never;
type AppUpdateTransition = DistributiveOmit<
	AppUpdateSnapshot,
	"schemaVersion" | "checkedAtMs"
> & { checkedAtMs?: number | null };

export class AppUpdateController {
	private readonly fetch: typeof globalThis.fetch;
	private readonly nowMs: () => number;
	private readonly prepareForInstall: NonNullable<
		AppUpdateControllerDependencies["prepareForInstall"]
	>;
	private readonly scheduleMandatoryInstall: (run: () => void) => void;
	private readonly setTimeout: typeof globalThis.setTimeout;
	private readonly clearTimeout: typeof globalThis.clearTimeout;
	private readonly requestTimeoutMs: number;
	private readonly downloadIdleTimeoutMs: number;
	private readonly listeners = new Set<AppUpdateListener>();
	private snapshot: AppUpdateSnapshot = {
		schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
		state: "idle",
		currentVersion: null,
		checkedAtMs: null,
	};
	private verifiedManifest: AppUpdateManifest | null = null;
	private localInfo: AppUpdaterLocalInfo | null = null;
	private checkFlight: Promise<AppUpdateSnapshot> | null = null;
	private downloadFlight: Promise<AppUpdateSnapshot> | null = null;
	private installFlight: Promise<AppUpdateSnapshot> | null = null;
	private automaticCheckTimer: ReturnType<typeof globalThis.setTimeout> | null =
		null;
	private shuttingDown = false;
	private installExitOwned = false;
	private disposed = false;

	constructor(private readonly dependencies: AppUpdateControllerDependencies) {
		this.fetch = dependencies.fetch ?? globalThis.fetch;
		this.nowMs = dependencies.nowMs ?? Date.now;
		this.prepareForInstall =
			dependencies.prepareForInstall ?? (async () => ({ ready: true }));
		this.scheduleMandatoryInstall =
			dependencies.scheduleMandatoryInstall ??
			((run) => void globalThis.queueMicrotask(run));
		this.setTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
		this.clearTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout;
		this.requestTimeoutMs = positiveTimeout(
			dependencies.requestTimeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS,
		);
		this.downloadIdleTimeoutMs = positiveTimeout(
			dependencies.downloadIdleTimeoutMs ?? UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS,
		);
	}

	getStatus(): AppUpdateSnapshot {
		return structuredClone(this.snapshot);
	}

	subscribe(listener: AppUpdateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	checkForUpdate(): Promise<AppUpdateSnapshot> {
		if (this.disposed || this.shuttingDown)
			return Promise.resolve(this.getStatus());
		if (this.checkFlight !== null) return this.checkFlight;
		if (this.downloadFlight !== null || this.installFlight !== null) {
			return Promise.resolve(this.getStatus());
		}
		if (
			this.snapshot.state === "ready" ||
			this.snapshot.state === "preparing_install" ||
			this.snapshot.state === "installing"
		) {
			return Promise.resolve(this.getStatus());
		}
		const flight = this.runCheck().finally(() => {
			if (this.checkFlight === flight) this.checkFlight = null;
		});
		this.checkFlight = flight;
		return flight;
	}

	/** Starts a check without keeping an RPC request open for network I/O. */
	startCheck(): AppUpdateSnapshot {
		void this.checkForUpdate().catch(() => undefined);
		return this.getStatus();
	}

	downloadUpdate(): Promise<AppUpdateSnapshot> {
		if (this.disposed || this.shuttingDown)
			return Promise.resolve(this.getStatus());
		if (this.downloadFlight !== null) return this.downloadFlight;
		if (this.installFlight !== null) return Promise.resolve(this.getStatus());
		const flight = this.runDownload().finally(() => {
			if (this.downloadFlight === flight) this.downloadFlight = null;
		});
		this.downloadFlight = flight;
		return flight;
	}

	/** Starts a verified full-archive download; progress arrives via subscribe. */
	startDownload(): AppUpdateSnapshot {
		void this.downloadUpdate().catch(() => undefined);
		return this.getStatus();
	}

	installUpdateAndRestart(): Promise<AppUpdateSnapshot> {
		if (this.disposed) return Promise.resolve(this.getStatus());
		if (this.shuttingDown && !this.installExitOwned) {
			return Promise.resolve(this.getStatus());
		}
		if (this.installFlight !== null) return this.installFlight;
		if (this.downloadFlight !== null) {
			return this.downloadFlight.then(() => this.installUpdateAndRestart());
		}
		if (isInstallableSnapshot(this.snapshot)) this.installExitOwned = true;
		const flight = this.runInstall().finally(() => {
			if (this.installFlight === flight) this.installFlight = null;
		});
		this.installFlight = flight;
		return flight;
	}

	/** Starts restart preparation and returns before the process replacement. */
	startInstallAndRestart(): AppUpdateSnapshot {
		void this.installUpdateAndRestart().catch(() => undefined);
		return this.getStatus();
	}

	startAutomaticChecks(): void {
		if (this.disposed || this.shuttingDown || this.automaticCheckTimer !== null)
			return;
		this.automaticCheckTimer = this.setTimeout(
			() => void this.runAutomaticCheck(),
			AUTOMATIC_CHECK_DELAY_MS,
		);
	}

	/** Stops background polling while preserving renderer status listeners. */
	stopAutomaticChecks(): void {
		if (this.automaticCheckTimer !== null) {
			this.clearTimeout(this.automaticCheckTimer);
			this.automaticCheckTimer = null;
		}
	}

	/** Closes background ingress without disabling install retry/status listeners. */
	beginShutdown(): void {
		this.shuttingDown = true;
		this.stopAutomaticChecks();
	}

	/** Joins checks/downloads/staging; install owns the outer shutdown itself. */
	async drainBackgroundWork(): Promise<void> {
		for (;;) {
			const check = this.checkFlight;
			const download = this.downloadFlight;
			await Promise.allSettled(
				[check, download].filter(
					(operation): operation is Promise<AppUpdateSnapshot> =>
						operation !== null,
				),
			);
			if (this.checkFlight === check && this.downloadFlight === download)
				return;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.beginShutdown();
		this.listeners.clear();
	}

	private async runAutomaticCheck(): Promise<void> {
		this.automaticCheckTimer = null;
		try {
			await this.checkForUpdate();
		} finally {
			if (!this.disposed && !this.shuttingDown) {
				this.automaticCheckTimer = this.setTimeout(
					() => void this.runAutomaticCheck(),
					AUTOMATIC_CHECK_INTERVAL_MS,
				);
			}
		}
	}

	private async runCheck(): Promise<AppUpdateSnapshot> {
		this.verifiedManifest = null;
		this.transition({
			state: "checking",
			currentVersion: this.snapshot.currentVersion,
		});
		let local: AppUpdaterLocalInfo;
		try {
			local = await withTimeout(
				this.dependencies.updater.getLocalInfo(),
				this.requestTimeoutMs,
			);
			this.validateLocalInfo(local);
			this.localInfo = local;
			this.transition({ state: "checking", currentVersion: local.version });
		} catch {
			return this.fail("incompatible_release", "check", null);
		}

		if (local.channel !== "stable") {
			return this.transition({
				state: "disabled",
				currentVersion: local.version,
				reason: "non_stable_channel",
			});
		}
		if (
			local.platform === "unsupported" ||
			local.arch === "unsupported" ||
			!isSupportedAppUpdateTarget(local.platform, local.arch)
		) {
			return this.transition({
				state: "disabled",
				currentVersion: local.version,
				reason: "unsupported_platform",
			});
		}

		let manifest: AppUpdateManifest;
		try {
			manifest = await this.fetchAndVerifyManifest(local.platform, local.arch);
		} catch (error) {
			return this.fail(classifyManifestFailure(error), "check", null);
		}
		if (
			manifest.appId !== local.appId ||
			manifest.platform !== local.platform ||
			manifest.arch !== local.arch
		) {
			return this.fail("incompatible_release", "check", null);
		}

		const versionOrder = compareStableSemver(manifest.version, local.version);
		if (versionOrder < 0) {
			return this.transition({
				state: "up_to_date",
				currentVersion: local.version,
				checkedAtMs: this.checkedNowMs(),
			});
		}
		if (versionOrder === 0) {
			if (manifest.buildHash !== local.buildHash) {
				return this.fail("update_metadata_mismatch", "check", null);
			}
			return this.transition({
				state: "up_to_date",
				currentVersion: local.version,
				checkedAtMs: this.checkedNowMs(),
			});
		}

		this.verifiedManifest = manifest;
		const release = appUpdateReleaseSummary(manifest, local.version);
		const available = this.transition({
			state: "available",
			currentVersion: local.version,
			checkedAtMs: this.checkedNowMs(),
			release,
		});
		if (release.mandatory) {
			this.scheduleMandatoryInstall(() => {
				void this.downloadUpdate()
					.then((snapshot) =>
						snapshot.state === "ready"
							? this.installUpdateAndRestart()
							: snapshot,
					)
					.catch(() => undefined);
			});
		}
		return available;
	}

	private async runDownload(): Promise<AppUpdateSnapshot> {
		if (this.verifiedManifest === null || this.localInfo === null) {
			const checked =
				this.checkFlight !== null
					? await this.checkFlight
					: await this.runCheck();
			if (checked.state !== "available") return checked;
		}
		const manifest = this.verifiedManifest;
		const local = this.localInfo;
		if (manifest === null || local === null) {
			return this.fail("internal_error", "download", null);
		}
		const release = appUpdateReleaseSummary(manifest, local.version);
		const asset = manifest.assets[0];
		this.transition({
			state: "downloading",
			currentVersion: local.version,
			release,
			progress: { receivedBytes: 0, totalBytes: asset.size, percent: 0 },
		});

		let temporaryDirectory: string | null = null;
		try {
			await mkdir(this.dependencies.downloadDirectory, {
				recursive: true,
				mode: 0o700,
			});
			await removeAbandonedDownloads(this.dependencies.downloadDirectory);
			temporaryDirectory = await mkdtemp(
				join(this.dependencies.downloadDirectory, ".whalehall-update-"),
			);
			const partialPath = join(temporaryDirectory, `${asset.filename}.part`);
			const archivePath = join(temporaryDirectory, asset.filename);
			const downloadAbort = new AbortController();
			const response = await withTimeout(
				this.fetch(asset.url, {
					method: "GET",
					redirect: "follow",
					cache: "no-store",
					signal: downloadAbort.signal,
				}),
				this.downloadIdleTimeoutMs,
				() => downloadAbort.abort(),
			);
			if (!response.ok || response.body === null) {
				return this.fail("download_failed", "download", release);
			}
			const declaredLength = response.headers.get("content-length");
			if (
				declaredLength !== null &&
				Number.parseInt(declaredLength, 10) !== asset.size
			) {
				return this.fail("archive_size_mismatch", "download", release);
			}

			const file = await open(partialPath, "wx", 0o600);
			const digest = createHash("sha256");
			let receivedBytes = 0;
			try {
				const reader = response.body.getReader();
				while (true) {
					const chunk = await withTimeout(
						reader.read(),
						this.downloadIdleTimeoutMs,
						() => downloadAbort.abort(),
					);
					if (chunk.done) break;
					receivedBytes += chunk.value.byteLength;
					if (receivedBytes > asset.size) {
						await reader.cancel();
						return this.fail("archive_size_mismatch", "download", release);
					}
					digest.update(chunk.value);
					await writeAll(file, chunk.value);
					this.transition({
						state: "downloading",
						currentVersion: local.version,
						release,
						progress: {
							receivedBytes,
							totalBytes: asset.size,
							percent: Math.min(
								100,
								Math.floor((receivedBytes / asset.size) * 100),
							),
						},
					});
				}
				await file.sync();
			} finally {
				await file.close();
			}
			this.transition({
				state: "verifying",
				currentVersion: local.version,
				release,
			});
			if (receivedBytes !== asset.size) {
				return this.fail("archive_size_mismatch", "download", release);
			}
			if (digest.digest("hex") !== asset.sha256) {
				return this.fail("archive_digest_mismatch", "download", release);
			}
			await rename(partialPath, archivePath);
			try {
				await this.dependencies.updater.stageVerifiedFullArchive({
					archivePath,
					manifest,
				});
			} catch {
				return this.fail("staging_failed", "download", release);
			}
			return this.transition({
				state: "ready",
				currentVersion: local.version,
				release,
			});
		} catch {
			return this.fail("download_failed", "download", release);
		} finally {
			if (temporaryDirectory !== null) {
				await rm(temporaryDirectory, { recursive: true, force: true }).catch(
					() => undefined,
				);
			}
		}
	}

	private async runInstall(): Promise<AppUpdateSnapshot> {
		const snapshot = this.snapshot;
		let release: AppUpdateReleaseSummary;
		if (snapshot.state === "ready") {
			release = snapshot.release;
		} else if (
			snapshot.state === "failed" &&
			snapshot.failure.operation === "install" &&
			snapshot.failure.retryable &&
			snapshot.release !== null
		) {
			release = snapshot.release;
		} else {
			return this.getStatus();
		}
		const currentVersion = snapshot.currentVersion;
		this.transition({
			state: "preparing_install",
			currentVersion,
			release,
		});
		try {
			const preparation = await this.prepareForInstall(release);
			if (!preparation.ready) {
				return this.fail("install_blocked", "install", release);
			}
		} catch {
			return this.fail("install_blocked", "install", release);
		}
		this.transition({ state: "installing", currentVersion, release });
		try {
			await this.dependencies.updater.applyStagedUpdate();
			return this.getStatus();
		} catch {
			const failed = this.fail("install_failed", "install", release);
			try {
				this.dependencies.onPreparedInstallFailure?.();
			} catch {
				// The process is already quiesced. A failed fallback-exit signal must
				// not replace the sanitized updater failure exposed to the renderer.
			}
			return failed;
		}
	}

	private async fetchAndVerifyManifest(
		platform: AppUpdatePlatform,
		arch: AppUpdateArchitecture,
	): Promise<AppUpdateManifest> {
		const filename = appUpdateManifestFilename(platform, arch);
		const signatureFilename = appUpdateSignatureFilename(platform, arch);
		const [manifestText, signatureText] = await Promise.all([
			this.fetchBoundedText(
				`${DEFAULT_MANIFEST_BASE_URL}/${filename}`,
				MAX_MANIFEST_BYTES,
			),
			this.fetchBoundedText(
				`${DEFAULT_MANIFEST_BASE_URL}/${signatureFilename}`,
				MAX_SIGNATURE_BYTES,
			),
		]);
		let manifestJson: unknown;
		try {
			manifestJson = JSON.parse(manifestText);
		} catch {
			throw new AppUpdateValidationError(
				"The update manifest is invalid JSON.",
			);
		}
		const manifest = parseAppUpdateManifest(manifestJson);
		const signature = parseAppUpdateSignature(signatureText);
		const publicKey = parseEd25519PublicKey(
			this.dependencies.publicKeySpkiBase64,
		);
		const valid = verifySignature(
			null,
			Buffer.from(canonicalizeAppUpdateManifest(manifest), "utf8"),
			publicKey,
			signature,
		);
		if (!valid) throw new SignatureVerificationError();
		return manifest;
	}

	private async fetchBoundedText(
		url: string,
		maximumBytes: number,
	): Promise<string> {
		let response: Response;
		const controller = new AbortController();
		try {
			response = await withTimeout(
				this.fetch(url, {
					method: "GET",
					redirect: "follow",
					cache: "no-store",
					signal: controller.signal,
				}),
				this.requestTimeoutMs,
				() => controller.abort(),
			);
		} catch {
			throw new UpdateNetworkError();
		}
		if (!response.ok || response.body === null) throw new UpdateNetworkError();
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const result = await withTimeout(
				reader.read(),
				this.requestTimeoutMs,
				() => controller.abort(),
			);
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maximumBytes) {
				await reader.cancel();
				throw new AppUpdateValidationError("The update metadata is too large.");
			}
			chunks.push(result.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	}

	private validateLocalInfo(local: AppUpdaterLocalInfo): void {
		parseStableSemver(local.version);
		if (
			local.appId.length === 0 ||
			local.buildHash.length === 0 ||
			local.buildHash.length > 64
		) {
			throw new AppUpdateValidationError(
				"The local release metadata is invalid.",
			);
		}
	}

	private checkedNowMs(): number {
		const now = this.nowMs();
		return Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
	}

	private fail(
		code: AppUpdateFailureCode,
		operation: "check" | "download" | "install",
		release: AppUpdateReleaseSummary | null,
	): AppUpdateSnapshot {
		return this.transition({
			state: "failed",
			currentVersion: this.localInfo?.version ?? this.snapshot.currentVersion,
			release,
			failure: sanitizeAppUpdateFailure(code, operation),
		});
	}

	private transition(state: AppUpdateTransition): AppUpdateSnapshot {
		this.snapshot = {
			...state,
			schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
			checkedAtMs: state.checkedAtMs ?? this.snapshot.checkedAtMs,
		} as AppUpdateSnapshot;
		const snapshot = this.getStatus();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// A presentation listener cannot interrupt the update state machine.
			}
		}
		return snapshot;
	}
}

class UpdateNetworkError extends Error {}
class SignatureVerificationError extends Error {}

function classifyManifestFailure(error: unknown): AppUpdateFailureCode {
	if (error instanceof UpdateNetworkError) return "network_unavailable";
	if (error instanceof SignatureVerificationError) return "signature_invalid";
	if (
		error instanceof AppUpdateValidationError &&
		error.message.toLowerCase().includes("signature")
	) {
		return "signature_invalid";
	}
	return "invalid_manifest";
}

function parseEd25519PublicKey(base64: string) {
	const normalized = base64.trim();
	if (normalized.length === 0 || /\s/u.test(normalized)) {
		throw new SignatureVerificationError();
	}
	const der = Buffer.from(normalized, "base64");
	if (der.length === 0 || der.toString("base64") !== normalized) {
		throw new SignatureVerificationError();
	}
	try {
		const key = createPublicKey({ key: der, format: "der", type: "spki" });
		if (key.asymmetricKeyType !== "ed25519")
			throw new SignatureVerificationError();
		return key;
	} catch {
		throw new SignatureVerificationError();
	}
}

type RawElectrobunUpdater = {
	getLocalInfo(): Promise<unknown>;
	checkForUpdate(): Promise<unknown>;
	downloadUpdate(): Promise<void>;
	updateInfo(): unknown;
	appDataFolder(): Promise<string>;
};

/**
 * Wrap Electrobun without exporting its unstable updater DTOs. The signed full
 * archive is decompressed directly into Electrobun's staging location. Its
 * unsigned metadata lookup is pinned only while recognizing that local tar;
 * installation itself is owned by WhaleHall's transactional platform helper.
 */
export function createElectrobunAppUpdaterAdapter(
	updaterValue: unknown,
	options: {
		executablePath?: string;
		platform?: NodeJS.Platform;
		arch?: string;
		processTimeoutMs?: number;
		processId?: number;
		exitForUpdate?: () => void;
		extractWindowsArchive?: (
			archiveBytes: Uint8Array,
			destination: string,
		) => Promise<void>;
		launchWindowsInstaller?: (
			plan: WindowsUpdateInstallerPlan,
		) => Promise<WindowsUpdateInstallerHandle>;
		windowsInstallerReadyTimeoutMs?: number;
		launcherProcessId?: number;
		installMacUpdate?: typeof prepareMacUpdateInstall;
	} = {},
): AppUpdaterAdapter {
	const updater = expectRawElectrobunUpdater(updaterValue);
	const executablePath = options.executablePath ?? process.execPath;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const processTimeoutMs = positiveTimeout(
		options.processTimeoutMs ?? UPDATE_STAGING_TIMEOUT_MS,
	);
	const processId = options.processId ?? process.pid;
	if (!Number.isSafeInteger(processId) || processId <= 0) {
		throw new TypeError("The updater process identity is invalid.");
	}
	const extractWindowsArchive =
		options.extractWindowsArchive ?? extractWindowsTarArchive;
	const launchWindowsInstaller =
		options.launchWindowsInstaller ?? spawnWindowsUpdateInstaller;
	const windowsInstallerReadyTimeoutMs = positiveTimeout(
		options.windowsInstallerReadyTimeoutMs ??
			WINDOWS_INSTALLER_READY_TIMEOUT_MS,
	);
	const launcherProcessId = options.launcherProcessId ?? process.ppid;
	if (!Number.isSafeInteger(launcherProcessId) || launcherProcessId <= 0) {
		throw new TypeError("The updater launcher identity is invalid.");
	}
	const installMacUpdate = options.installMacUpdate ?? prepareMacUpdateInstall;
	let stagingSealed = false;
	let stagedArchive: StagedArchiveProof | null = null;

	return {
		async getLocalInfo() {
			const raw = expectRecord(await updater.getLocalInfo());
			return {
				version: expectString(raw.version),
				buildHash: expectString(raw.hash),
				channel: expectString(raw.channel),
				appId: expectString(raw.identifier),
				platform:
					platform === "darwin"
						? "macos"
						: platform === "win32"
							? "win"
							: "unsupported",
				arch:
					arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : "unsupported",
			};
		},
		async stageVerifiedFullArchive({ archivePath, manifest }) {
			if (stagingSealed) {
				throw new Error("Verified update staging is already sealed.");
			}
			stagingSealed = true;
			stagedArchive = null;
			try {
				// The signed WhaleHall manifest is the only remote update authority.
				// Electrobun's own network check is intentionally never invoked: it cannot
				// be cancelled and would let a hung unsigned request poison later retries.
				const archive = await stat(archivePath);
				if (!archive.isFile())
					throw new Error("Verified update archive is missing.");
				const appDataDirectory = await updater.appDataFolder();
				const extractionDirectory = join(appDataDirectory, "self-extraction");
				await mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
				const targetPath = join(
					extractionDirectory,
					`${manifest.buildHash}.tar`,
				);
				const temporaryTargetPath = `${targetPath}.verified.tmp`;
				await rm(temporaryTargetPath, { force: true });
				const zstdBinary = join(
					dirname(executablePath),
					platform === "win32" ? "zig-zstd.exe" : "zig-zstd",
				);
				await access(zstdBinary, fsConstants.X_OK);
				try {
					await runProcess(
						zstdBinary,
						[
							"decompress",
							"-i",
							archivePath,
							"-o",
							temporaryTargetPath,
							"--no-timing",
						],
						processTimeoutMs,
					);
				} catch (error) {
					await rm(temporaryTargetPath, { force: true });
					throw error;
				}
				const staged = await stat(temporaryTargetPath);
				if (!staged.isFile() || staged.size <= 0) {
					await rm(temporaryTargetPath, { force: true });
					throw new Error("The staged update archive is invalid.");
				}
				const stagedProof = await fileIntegrityProof(temporaryTargetPath);
				// Keep the rollback copy outside self-extraction: Electrobun removes
				// every non-current file in that directory while recognizing a tar.
				const previousTargetPath = join(
					appDataDirectory,
					`.whalehall-update-${manifest.buildHash}.previous.tmp`,
				);
				const hadPreviousTarget = await fileExists(targetPath);
				await rm(previousTargetPath, { force: true });
				if (hadPreviousTarget) await rename(targetPath, previousTargetPath);
				try {
					await rename(temporaryTargetPath, targetPath);
				} catch (error) {
					if (hadPreviousTarget) await rename(previousTargetPath, targetPath);
					throw error;
				}

				// Electrobun owns updateReady. Pin its metadata read so downloadUpdate
				// can only recognize the already verified tar and cannot fetch a
				// different unsigned archive between verification and installation.
				const originalCheck = updater.checkForUpdate;
				updater.checkForUpdate = async () => ({
					version: manifest.version,
					hash: manifest.buildHash,
					updateAvailable: true,
					updateReady: false,
					error: "",
				});
				try {
					// This call is local-only because checkForUpdate is pinned above. Keep
					// the pin until Electrobun settles; racing a timeout would restore its
					// network metadata function while the same recognition call was alive.
					await updater.downloadUpdate();
					const recognized = expectRecord(updater.updateInfo());
					if (
						recognized.hash !== manifest.buildHash ||
						recognized.updateReady !== true
					) {
						throw new Error(
							"Electrobun did not recognize the verified archive.",
						);
					}
					const recognizedProof = await fileIntegrityProof(targetPath);
					if (!sameFileIntegrityProof(stagedProof, recognizedProof)) {
						throw new Error(
							"The staged update archive changed during recognition.",
						);
					}
					stagedArchive = {
						...recognizedProof,
						path: targetPath,
						version: manifest.version,
						buildHash: manifest.buildHash,
					};
					await rm(previousTargetPath, { force: true });
				} catch (error) {
					await rm(targetPath, { force: true });
					if (await fileExists(previousTargetPath)) {
						await rename(previousTargetPath, targetPath);
					}
					throw error;
				} finally {
					updater.checkForUpdate = originalCheck;
				}
			} catch (error) {
				stagingSealed = false;
				throw error;
			}
		},
		async applyStagedUpdate() {
			const staged = stagedArchive;
			if (staged === null) throw new Error("No verified update is staged.");
			const currentProof = await fileIntegrityProof(staged.path);
			if (!sameFileIntegrityProof(staged, currentProof)) {
				throw new Error(
					"The staged update archive failed integrity verification.",
				);
			}
			if (platform === "darwin") {
				if (options.exitForUpdate === undefined) {
					throw new Error("The macOS updater exit handoff is unavailable.");
				}
				await installMacUpdate({
					stagedTarPath: staged.path,
					executablePath,
					mainProcessId: processId,
					launcherProcessId,
					exitForUpdate: options.exitForUpdate,
				});
				return;
			}
			if (platform === "win32") {
				if (options.exitForUpdate === undefined) {
					throw new Error("The Windows updater exit handoff is unavailable.");
				}
				const archiveBytes = await readFile(staged.path);
				const loadedProof = bufferIntegrityProof(staged.path, archiveBytes);
				if (!sameFileIntegrityProof(staged, loadedProof)) {
					throw new Error(
						"The staged update archive changed before Windows extraction.",
					);
				}
				const rawAppDataDirectory = await updater.appDataFolder();
				if (!isAbsolute(rawAppDataDirectory)) {
					throw new Error("The Windows updater data root is invalid.");
				}
				const appDataDirectory = await realpath(rawAppDataDirectory);
				const rawLocalInfo = expectRecord(await updater.getLocalInfo());
				const bundleName = expectWindowsBundleName(rawLocalInfo.name);
				const plan: WindowsUpdateInstallerPlan = {
					schemaVersion: "whalehall.windows-install-plan.v1",
					transactionId: randomBytes(16).toString("hex"),
					readyNonce: randomBytes(16).toString("hex"),
					processId,
					appDataRoot: appDataDirectory,
					bundleName,
				};
				const paths = windowsUpdateInstallerPaths(plan);
				await prepareWindowsUpdateTransaction(paths);
				await mkdir(paths.extractionDirectory, {
					recursive: false,
					mode: 0o700,
				});
				await validateWindowsArchiveEntries(archiveBytes, bundleName);
				await extractWindowsArchive(archiveBytes, paths.extractionDirectory);
				await validateExtractedWindowsBundle(
					paths.extractionDirectory,
					bundleName,
				);
				await writeFile(paths.scriptPath, windowsUpdateInstallerScript(), {
					encoding: "utf8",
					mode: 0o600,
				});
				await writeFile(paths.planPath, JSON.stringify(plan), {
					encoding: "utf8",
					mode: 0o600,
				});
				await Promise.all([
					rm(paths.readyPath, { force: true }),
					rm(`${paths.readyPath}.tmp`, { force: true }),
				]);
				let helper: WindowsUpdateInstallerHandle | null = null;
				const cleanupUncommittedWindowsInstall = async () => {
					await Promise.all([
						rm(paths.scriptPath, { force: true }),
						rm(paths.planPath, { force: true }),
						rm(paths.readyPath, { force: true }),
						rm(paths.extractionDirectory, { recursive: true, force: true }),
					]);
				};
				const terminateWindowsInstaller = async () => {
					if (helper === null) return;
					try {
						await helper.terminateAndWait();
					} catch {
						// Never report a recoverable install failure while a helper that can
						// replace the app is still alive. Retain exact ownership until Node
						// confirms close; only then may the controller run its fallback exit.
						await helper.closed;
					}
				};
				try {
					helper = await launchWindowsInstaller(plan);
					await waitForWindowsInstallerReady(
						plan,
						helper,
						windowsInstallerReadyTimeoutMs,
					);
				} catch (error) {
					await terminateWindowsInstaller();
					await cleanupUncommittedWindowsInstall();
					throw error;
				}
				helper.detach();
				try {
					options.exitForUpdate();
				} catch (error) {
					await terminateWindowsInstaller();
					await cleanupUncommittedWindowsInstall();
					throw error;
				}
				// A successful handoff exits this process synchronously. If it returns,
				// disarm and reap the helper before exposing a retryable failure.
				await terminateWindowsInstaller();
				await cleanupUncommittedWindowsInstall();
				throw new Error(
					"The Windows updater exit handoff returned without terminating the application.",
				);
			}
			throw new Error("Application updates are unavailable on this platform.");
		},
	};
}

type FileIntegrityProof = {
	path: string;
	size: number;
	sha256: string;
};

type StagedArchiveProof = FileIntegrityProof & {
	version: string;
	buildHash: string;
};

async function fileIntegrityProof(path: string): Promise<FileIntegrityProof> {
	const file = await open(path, "r");
	const digest = createHash("sha256");
	let size = 0;
	try {
		const buffer = Buffer.allocUnsafe(256 * 1024);
		while (true) {
			const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			size += bytesRead;
			digest.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await file.close();
	}
	return { path, size, sha256: digest.digest("hex") };
}

function bufferIntegrityProof(
	path: string,
	bytes: Uint8Array,
): FileIntegrityProof {
	return {
		path,
		size: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

async function extractWindowsTarArchive(
	archiveBytes: Uint8Array,
	destination: string,
): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	if (files.size === 0) throw new Error("The Windows update archive is empty.");
	for (const [entryPath, file] of files) {
		const segments = safeWindowsArchiveSegments(entryPath);
		const target = join(destination, ...segments);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await Bun.write(target, file);
	}
}

async function spawnWindowsUpdateInstaller(
	plan: WindowsUpdateInstallerPlan,
): Promise<WindowsUpdateInstallerHandle> {
	const launch = windowsUpdateInstallerLaunch(plan);
	await access(launch.command, fsConstants.X_OK);
	return new Promise<WindowsUpdateInstallerHandle>((resolve, reject) => {
		const child = spawn(launch.command, launch.arguments, launch.options);
		let settled = false;
		let closed = false;
		let spawned = false;
		let resolveClosed!: () => void;
		const closedPromise = new Promise<void>((resolveClosedPromise) => {
			resolveClosed = resolveClosedPromise;
		});
		child.once("close", () => {
			closed = true;
			resolveClosed();
		});
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("spawn", onSpawn);
			if (error) reject(error);
			else
				resolve({
					closed: closedPromise,
					detach() {
						child.unref();
					},
					async terminateAndWait() {
						if (!closed) {
							try {
								child.kill();
							} catch {
								// Confirmed close, not kill acknowledgement, releases ownership.
							}
						}
						await withTimeout(
							closedPromise,
							WINDOWS_INSTALLER_CLOSE_TIMEOUT_MS,
						);
					},
				});
		};
		const onSpawn = () => {
			spawned = true;
			finish();
		};
		const onError = (error: Error) => {
			// Before spawn this is a launch failure. Afterwards errors (including a
			// failed kill) are diagnostic only: exact close still owns the helper.
			if (!spawned) finish(error);
		};
		const timer = setTimeout(() => {
			if (!closed) {
				try {
					child.kill();
				} catch {
					// The close event below remains the sole ownership release.
				}
			}
			// A timed-out but still-live helper remains process-owned. Do not reject
			// into the fallback-exit path until its close event is confirmed.
			void closedPromise.then(() =>
				finish(new Error("The Windows update helper did not start.")),
			);
		}, WINDOWS_INSTALLER_SPAWN_TIMEOUT_MS);
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

export function windowsUpdateInstallerLaunch(
	plan: WindowsUpdateInstallerPlan,
): WindowsUpdateInstallerLaunch {
	const paths = windowsUpdateInstallerPaths(plan);
	return {
		// The executable path is deliberately code-owned. Environment-derived
		// SystemRoot/WINDIR values would let an injected launch environment choose
		// which program receives the verified installer plan. A non-standard
		// Windows directory therefore fails closed instead of widening this trust
		// boundary.
		command: WINDOWS_POWERSHELL_PATH,
		arguments: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			paths.scriptPath,
			"-PlanPath",
			paths.planPath,
		],
		options: {
			// Never inherit WhaleHall's app/bin working directory: Windows locks a
			// process CWD against the exact directory rename performed below.
			cwd: paths.transactionRoot,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			shell: false,
		},
	};
}

type WindowsUpdateInstallerPaths = {
	updateRoot: string;
	transactionRoot: string;
	extractionDirectory: string;
	newAppPath: string;
	runningAppPath: string;
	backupAppPath: string;
	failedAppPath: string;
	launcherPath: string;
	planPath: string;
	scriptPath: string;
	readyPath: string;
	logPath: string;
};

function windowsUpdateInstallerPaths(
	plan: WindowsUpdateInstallerPlan,
): WindowsUpdateInstallerPaths {
	const updateRoot = join(plan.appDataRoot, ".whalehall-update");
	const transactionRoot = join(updateRoot, plan.transactionId);
	const extractionDirectory = join(transactionRoot, "candidate-root");
	const runningAppPath = join(plan.appDataRoot, "app");
	return {
		updateRoot,
		transactionRoot,
		extractionDirectory,
		newAppPath: join(extractionDirectory, plan.bundleName),
		runningAppPath,
		backupAppPath: join(transactionRoot, "backup"),
		failedAppPath: join(transactionRoot, "failed-candidate"),
		launcherPath: join(runningAppPath, "bin", "launcher.exe"),
		planPath: join(transactionRoot, "plan.json"),
		scriptPath: join(transactionRoot, "install.ps1"),
		readyPath: join(transactionRoot, "armed.json"),
		logPath: join(transactionRoot, "install.log"),
	};
}

async function prepareWindowsUpdateTransaction(
	paths: WindowsUpdateInstallerPaths,
): Promise<void> {
	// Creating only the fixed parent is safe even when it already exists; no
	// transaction content is written until its real path and link type agree.
	await mkdir(paths.updateRoot, { recursive: true, mode: 0o700 });
	const updateRoot = await lstat(paths.updateRoot);
	if (
		!updateRoot.isDirectory() ||
		updateRoot.isSymbolicLink() ||
		(await realpath(paths.updateRoot)) !== paths.updateRoot
	) {
		throw new Error("The Windows update transaction root is untrusted.");
	}
	await mkdir(paths.transactionRoot, { recursive: false, mode: 0o700 });
}

async function validateWindowsArchiveEntries(
	archiveBytes: Uint8Array,
	bundleName: string,
): Promise<void> {
	const files = await new Bun.Archive(archiveBytes).files();
	if (files.size === 0) throw new Error("The Windows update archive is empty.");
	let hasLauncher = false;
	for (const entryPath of files.keys()) {
		const segments = safeWindowsArchiveSegments(entryPath);
		if (segments[0] !== bundleName) {
			throw new Error("The Windows update archive has an unexpected root.");
		}
		if (
			segments.length === 3 &&
			segments[1]?.toLowerCase() === "bin" &&
			segments[2]?.toLowerCase() === "launcher.exe"
		) {
			hasLauncher = true;
		}
	}
	if (!hasLauncher) {
		throw new Error("The verified Windows launcher is missing.");
	}
}

function safeWindowsArchiveSegments(entryPath: string): string[] {
	if (
		entryPath.length === 0 ||
		entryPath.length > 1024 ||
		entryPath.includes("\\") ||
		entryPath.includes("\0") ||
		entryPath.startsWith("/") ||
		/^[A-Za-z]:/.test(entryPath)
	) {
		throw new Error("The Windows update archive contains an unsafe path.");
	}
	const segments = entryPath.split("/");
	if (
		segments.some(
			(segment) =>
				segment.length === 0 ||
				segment === "." ||
				segment === ".." ||
				segment.endsWith(".") ||
				segment.endsWith(" ") ||
				/[<>:"|?*]/.test(segment) ||
				/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment),
		)
	) {
		throw new Error("The Windows update archive contains an unsafe path.");
	}
	return segments;
}

async function validateExtractedWindowsBundle(
	extractionDirectory: string,
	bundleName: string,
): Promise<void> {
	const entries = await readdir(extractionDirectory, { withFileTypes: true });
	if (
		entries.length !== 1 ||
		entries[0]?.name !== bundleName ||
		!entries[0].isDirectory()
	) {
		throw new Error("The verified Windows app bundle root is invalid.");
	}
	const appPath = join(extractionDirectory, bundleName);
	const app = await lstat(appPath);
	const launcher = await lstat(join(appPath, "bin", "launcher.exe"));
	if (
		!app.isDirectory() ||
		app.isSymbolicLink() ||
		!launcher.isFile() ||
		launcher.isSymbolicLink()
	) {
		throw new Error("The verified Windows app bundle is invalid.");
	}
}

async function waitForWindowsInstallerReady(
	plan: WindowsUpdateInstallerPlan,
	handle: WindowsUpdateInstallerHandle,
	timeoutMs: number,
): Promise<void> {
	const paths = windowsUpdateInstallerPaths(plan);
	const deadline = Date.now() + timeoutMs;
	let helperClosed = false;
	void handle.closed.then(() => {
		helperClosed = true;
	});
	while (Date.now() < deadline) {
		if (helperClosed) {
			throw new Error("The Windows update helper exited before it was armed.");
		}
		try {
			const raw = JSON.parse(
				await readFile(paths.readyPath, "utf8"),
			) as unknown;
			const ready = expectRecord(raw);
			if (
				Object.keys(ready).sort().join(",") !==
					"nonce,schemaVersion,state,transactionId" ||
				ready.schemaVersion !== "whalehall.windows-install-ready.v1" ||
				ready.transactionId !== plan.transactionId ||
				ready.nonce !== plan.readyNonce ||
				ready.state !== "armed"
			) {
				throw new Error("The Windows update helper returned an invalid proof.");
			}
			return;
		} catch (error) {
			if (
				error instanceof Error &&
				!error.message.includes("ENOENT") &&
				!error.message.includes("no such file")
			) {
				throw error;
			}
		}
		await Bun.sleep(50);
	}
	throw new Error("The Windows update helper did not become ready.");
}

function expectWindowsBundleName(value: unknown): string {
	const name = expectString(value);
	if (
		name.length === 0 ||
		name.length > 128 ||
		name.endsWith(".") ||
		name.endsWith(" ") ||
		!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) ||
		/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)
	) {
		throw new Error("The verified Windows app bundle name is invalid.");
	}
	return name;
}

/** Returns the exact helper source used by production and the Windows CI gate. */
export function windowsUpdateInstallerScript(): string {
	return `param(
  [Parameter(Mandatory = $true)][string]$PlanPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$clock = [Diagnostics.Stopwatch]::StartNew()
$forwardDeadlineSeconds = 105
$totalDeadlineSeconds = 120
$oldMoved = $false
$candidateMoved = $false
$processExited = $false
$rollbackRestored = $false
$expectedStartTicks = 0L
$logPath = $null

function Assert-NoReparsePoint([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "A protected update path is a reparse point."
  }
}

function Test-ExactParentAlive {
  try {
    $target = Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue
    if ($null -eq $target) { return $false }
    return $target.StartTime.ToUniversalTime().Ticks -eq $expectedStartTicks
  } catch {
    return $false
  }
}

function Write-UpdateStatus([string]$Message) {
  try {
    if ($null -eq $logPath) { return }
    $timestamp = [DateTime]::UtcNow.ToString("o")
    [IO.File]::AppendAllText($logPath, "$timestamp $Message" + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  } catch {
    # Diagnostics must never change the swap or rollback state machine.
  }
}

function Move-DirectoryBefore([string]$Source, [string]$Destination, [double]$DeadlineSeconds) {
  while ($true) {
    try {
      if (-not [IO.Directory]::Exists($Source)) { throw "Update move source is missing." }
      if ([IO.Directory]::Exists($Destination) -or [IO.File]::Exists($Destination)) {
        throw "Update move destination already exists."
      }
      [IO.Directory]::Move($Source, $Destination)
      return
    } catch [IO.IOException], [UnauthorizedAccessException] {
      if ($clock.Elapsed.TotalSeconds -ge $DeadlineSeconds) { throw }
      Start-Sleep -Milliseconds 400
    }
  }
}

function Start-ExactLauncher([string]$Path) {
  if (-not [IO.File]::Exists($Path)) { throw "WhaleHall launcher is missing." }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Path
  $startInfo.UseShellExecute = $false
  $started = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $started) { throw "WhaleHall launcher could not be started." }
}

try {
  $planFullPath = [IO.Path]::GetFullPath($PlanPath)
  $plan = Get-Content -LiteralPath $planFullPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $actualKeys = @($plan.PSObject.Properties.Name | Sort-Object)
  $expectedKeys = @("appDataRoot", "bundleName", "processId", "readyNonce", "schemaVersion", "transactionId")
  if (($actualKeys -join ",") -ne ($expectedKeys -join ",")) { throw "Update plan fields are invalid." }
  if ($plan.schemaVersion -ne "whalehall.windows-install-plan.v1") { throw "Update plan schema is invalid." }
  if ($plan.transactionId -notmatch "^[0-9a-f]{32}$") { throw "Update transaction identity is invalid." }
  if ($plan.readyNonce -notmatch "^[0-9a-f]{32}$") { throw "Update readiness identity is invalid." }
  $parentProcessId = 0
  if (-not [int]::TryParse([string]$plan.processId, [ref]$parentProcessId) -or $parentProcessId -le 0) {
    throw "Update parent identity is invalid."
  }
  if ($plan.bundleName -notmatch "^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$") { throw "Update bundle name is invalid." }

  $root = [IO.Path]::GetFullPath([string]$plan.appDataRoot).TrimEnd("\\")
  if (-not [IO.Path]::IsPathRooted($root) -or -not [IO.Directory]::Exists($root)) { throw "Update root is invalid." }
  Assert-NoReparsePoint $root
  $updateRoot = [IO.Path]::Combine($root, ".whalehall-update")
  if (-not [IO.Directory]::Exists($updateRoot)) { throw "Update transaction root is missing." }
  Assert-NoReparsePoint $updateRoot
  $transactionRoot = [IO.Path]::Combine($updateRoot, $plan.transactionId)
  $expectedPlanPath = [IO.Path]::Combine($transactionRoot, "plan.json")
  if (-not [string]::Equals($planFullPath, $expectedPlanPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Update plan escaped its transaction root."
  }
  Assert-NoReparsePoint $transactionRoot

  $candidateRoot = [IO.Path]::Combine($transactionRoot, "candidate-root")
  $candidate = [IO.Path]::Combine($candidateRoot, $plan.bundleName)
  $current = [IO.Path]::Combine($root, "app")
  $backup = [IO.Path]::Combine($transactionRoot, "backup")
  $failedCandidate = [IO.Path]::Combine($transactionRoot, "failed-candidate")
  $launcher = [IO.Path]::Combine($current, "bin", "launcher.exe")
  $candidateLauncher = [IO.Path]::Combine($candidate, "bin", "launcher.exe")
  $readyPath = [IO.Path]::Combine($transactionRoot, "armed.json")
  $readyTempPath = $readyPath + ".tmp"
  $logPath = [IO.Path]::Combine($transactionRoot, "install.log")

  if ([IO.Path]::GetPathRoot($root) -ne [IO.Path]::GetPathRoot($transactionRoot)) { throw "Update paths are not on one volume." }
  if (-not [IO.Directory]::Exists($current) -or -not [IO.File]::Exists($launcher)) { throw "Current WhaleHall bundle is invalid." }
  if (-not [IO.Directory]::Exists($candidate) -or -not [IO.File]::Exists($candidateLauncher)) { throw "Candidate WhaleHall bundle is invalid." }
  if ([IO.Directory]::Exists($backup) -or [IO.Directory]::Exists($failedCandidate)) { throw "Update transaction destinations are not empty." }
  Assert-NoReparsePoint $current
  Assert-NoReparsePoint $candidateRoot
  Assert-NoReparsePoint $candidate

  $parent = Get-Process -Id $parentProcessId -ErrorAction Stop
  $expectedStartTicks = $parent.StartTime.ToUniversalTime().Ticks
  $ready = [ordered]@{
    schemaVersion = "whalehall.windows-install-ready.v1"
    transactionId = $plan.transactionId
    nonce = $plan.readyNonce
    state = "armed"
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($readyTempPath, $ready, [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($readyTempPath, $readyPath)
  Write-UpdateStatus "armed"

  while ((Test-ExactParentAlive) -and $clock.Elapsed.TotalSeconds -lt $forwardDeadlineSeconds) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-ExactParentAlive) { throw "WhaleHall process did not exit before the bounded deadline." }
  $processExited = $true

  Write-UpdateStatus "swapping"
  Move-DirectoryBefore $current $backup $forwardDeadlineSeconds
  $oldMoved = $true
  Move-DirectoryBefore $candidate $current $forwardDeadlineSeconds
  $candidateMoved = $true
  Start-ExactLauncher $launcher
  Write-UpdateStatus "completed"
  exit 0
} catch {
  try { Write-UpdateStatus ("failed " + $_.Exception.GetType().Name) } catch {}
  if ($oldMoved) {
    try {
      if ($candidateMoved -and [IO.Directory]::Exists($current) -and -not [IO.Directory]::Exists($failedCandidate)) {
        Move-DirectoryBefore $current $failedCandidate $totalDeadlineSeconds
      }
      if ([IO.Directory]::Exists($backup) -and -not [IO.Directory]::Exists($current)) {
        Move-DirectoryBefore $backup $current $totalDeadlineSeconds
        $rollbackRestored = $true
      }
    } catch {
      try { Write-UpdateStatus "rollback_failed" } catch {}
    }
  }
  if ($processExited) {
    try {
      if ($rollbackRestored) {
        Start-ExactLauncher ([IO.Path]::Combine($current, "bin", "launcher.exe"))
      } elseif ($oldMoved -and [IO.Directory]::Exists($backup)) {
        Start-ExactLauncher ([IO.Path]::Combine($backup, "bin", "launcher.exe"))
      } elseif (-not $oldMoved) {
        Start-ExactLauncher ([IO.Path]::Combine($current, "bin", "launcher.exe"))
      }
    } catch {
      try { Write-UpdateStatus "restart_failed" } catch {}
    }
  }
  exit 1
}
`;
}

function sameFileIntegrityProof(
	expected: Pick<FileIntegrityProof, "size" | "sha256">,
	actual: Pick<FileIntegrityProof, "size" | "sha256">,
): boolean {
	return expected.size === actual.size && expected.sha256 === actual.sha256;
}

function isSupportedAppUpdateTarget(
	platform: AppUpdatePlatform,
	arch: AppUpdateArchitecture,
): boolean {
	return (
		(platform === "macos" && arch === "arm64") ||
		(platform === "win" && arch === "x64")
	);
}

function isInstallableSnapshot(snapshot: AppUpdateSnapshot): boolean {
	return (
		snapshot.state === "ready" ||
		(snapshot.state === "failed" &&
			snapshot.release !== null &&
			snapshot.failure.operation === "install" &&
			snapshot.failure.retryable)
	);
}

function expectRawElectrobunUpdater(value: unknown): RawElectrobunUpdater {
	const raw = expectRecord(value);
	for (const method of [
		"getLocalInfo",
		"checkForUpdate",
		"downloadUpdate",
		"updateInfo",
		"appDataFolder",
	] as const) {
		if (typeof raw[method] !== "function") {
			throw new TypeError("The Electrobun updater adapter is unavailable.");
		}
	}
	return raw as unknown as RawElectrobunUpdater;
}

function expectRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("The updater returned invalid metadata.");
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown): string {
	if (typeof value !== "string") {
		throw new TypeError("The updater returned invalid metadata.");
	}
	return value;
}

async function writeAll(
	file: Awaited<ReturnType<typeof open>>,
	chunk: Uint8Array,
): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const { bytesWritten } = await file.write(chunk.subarray(offset));
		if (bytesWritten <= 0) throw new Error("The update archive write stalled.");
		offset += bytesWritten;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function removeAbandonedDownloads(directory: string): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	await Promise.all(
		entries
			.filter((entry) => entry.name.startsWith(".whalehall-update-"))
			.map((entry) =>
				rm(join(directory, entry.name), { recursive: true, force: true }).catch(
					() => undefined,
				),
			),
	);
}

async function runProcess(
	command: string,
	arguments_: readonly string[],
	timeoutMs: number,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, [...arguments_], { stdio: "ignore" });
		let settled = false;
		let timedOut = false;
		let processError: Error | null = null;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			// Process ownership is not released by a successful kill(2) request. Keep
			// the staging flight pending until Node confirms close so application
			// shutdown can never outlive a zstd process still holding update files.
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("error", (error) => {
			processError = error;
		});
		child.once("close", (code, signal) => {
			if (timedOut) {
				finish(new Error("The verified archive staging process timed out."));
			} else if (processError !== null) finish(processError);
			else if (code === 0 && signal === null) finish();
			else finish(new Error("The verified archive could not be staged."));
		});
	});
}

function positiveTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError("The update operation timeout is invalid.");
	}
	return value;
}

async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void = () => {},
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			try {
				onTimeout();
			} finally {
				reject(new Error("The update operation timed out."));
			}
		}, timeoutMs);
	});
	try {
		return await Promise.race([operation, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
