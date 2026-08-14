import {
	APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
	type AppUpdateFailure,
	type AppUpdateProgress,
	type AppUpdateReleaseSummary,
	type AppUpdateSnapshot,
	compareStableSemver,
	parseStableSemver,
	sanitizeAppUpdateFailure,
} from "../../../../shared/app-update";
import type {
	AppUpdateService,
	AppUpdateStatusListener,
} from "../../features/app-update/public";

export interface AppUpdateRpcClient {
	getAppUpdateStatus(): Promise<unknown>;
	checkForAppUpdate(): Promise<unknown>;
	downloadAppUpdate(): Promise<unknown>;
	installAppUpdateAndRestart(): Promise<unknown>;
	onAppUpdateStatus(listener: AppUpdateStatusListener): () => void;
}

export interface ElectrobunAppUpdateServiceOptions {
	client?: AppUpdateRpcClient;
	runtimeAvailable?: () => boolean;
	fallbackCurrentVersion?: string | null;
}

export class ElectrobunAppUpdateService implements AppUpdateService {
	private readonly listeners = new Set<AppUpdateStatusListener>();
	private readonly runtimeAvailable: () => boolean;
	private readonly fallbackCurrentVersion: string | null;
	private removeClientListener: (() => void) | null = null;
	private subscriptionAttempt: Promise<void> | null = null;

	constructor(
		private readonly options: ElectrobunAppUpdateServiceOptions = {},
	) {
		this.runtimeAvailable = options.runtimeAvailable ?? hasElectrobunRuntime;
		this.fallbackCurrentVersion = options.fallbackCurrentVersion ?? null;
	}

	async getStatus(): Promise<AppUpdateSnapshot> {
		if (!this.runtimeAvailable() && !this.options.client) {
			return disabledSnapshot(this.fallbackCurrentVersion);
		}
		return this.invoke("getAppUpdateStatus");
	}

	async check(): Promise<AppUpdateSnapshot> {
		if (!this.runtimeAvailable() && !this.options.client) {
			return disabledSnapshot(this.fallbackCurrentVersion);
		}
		return this.invoke("checkForAppUpdate");
	}

	async download(): Promise<AppUpdateSnapshot> {
		if (!this.runtimeAvailable() && !this.options.client) {
			return disabledSnapshot(this.fallbackCurrentVersion);
		}
		return this.invoke("downloadAppUpdate");
	}

	async installAndRestart(): Promise<AppUpdateSnapshot> {
		if (!this.runtimeAvailable() && !this.options.client) {
			return disabledSnapshot(this.fallbackCurrentVersion);
		}
		return this.invoke("installAppUpdateAndRestart");
	}

	subscribe(listener: AppUpdateStatusListener): () => void {
		this.listeners.add(listener);
		if (this.runtimeAvailable() || this.options.client) {
			void this.ensureSubscription();
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size !== 0) return;
			this.removeClientListener?.();
			this.removeClientListener = null;
		};
	}

	private async invoke(
		methodName:
			| "getAppUpdateStatus"
			| "checkForAppUpdate"
			| "downloadAppUpdate"
			| "installAppUpdateAndRestart",
	): Promise<AppUpdateSnapshot> {
		const client = this.options.client ?? (await loadClientApi());
		const method = client[methodName];
		if (typeof method !== "function") throw unavailable();
		const value: unknown = await Reflect.apply(method, client, []);
		return cloneSnapshot(parseAppUpdateSnapshot(value));
	}

	private async ensureSubscription(): Promise<void> {
		if (this.removeClientListener || this.subscriptionAttempt) return;
		this.subscriptionAttempt = (async () => {
			try {
				const client = this.options.client ?? (await loadClientApi());
				const subscribe = client.onAppUpdateStatus;
				if (typeof subscribe !== "function") throw unavailable();
				if (this.listeners.size === 0 || this.removeClientListener) return;
				const remove: unknown = Reflect.apply(subscribe, client, [
					(value: unknown) => {
						const snapshot = parseAppUpdateSnapshot(value);
						for (const listener of this.listeners) {
							listener(cloneSnapshot(snapshot));
						}
					},
				]);
				this.removeClientListener =
					typeof remove === "function"
						? () => {
								Reflect.apply(remove, undefined, []);
							}
						: () => {};
			} catch {
				// Explicit requests expose bridge failures through controller UI state.
			} finally {
				this.subscriptionAttempt = null;
			}
		})();
		await this.subscriptionAttempt;
	}
}

export function parseAppUpdateSnapshot(value: unknown): AppUpdateSnapshot {
	if (!isRecord(value)) throw invalidResponse();
	if (value.schemaVersion !== APP_UPDATE_SNAPSHOT_SCHEMA_VERSION) {
		throw invalidResponse();
	}
	const currentVersion = parseNullableVersion(value.currentVersion);
	if (!isNullableTimestamp(value.checkedAtMs)) throw invalidResponse();
	const base = {
		schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
		currentVersion,
		checkedAtMs: value.checkedAtMs,
	};
	if (value.state === "idle" || value.state === "checking") {
		expectExactKeys(value, BASE_SNAPSHOT_KEYS);
		return { ...base, state: value.state };
	}
	if (value.state === "disabled") {
		expectExactKeys(value, DISABLED_SNAPSHOT_KEYS);
		if (
			value.reason !== "non_stable_channel" &&
			value.reason !== "unsupported_platform"
		) {
			throw invalidResponse();
		}
		return { ...base, state: "disabled", reason: value.reason };
	}
	if (value.state === "up_to_date") {
		expectExactKeys(value, BASE_SNAPSHOT_KEYS);
		return { ...base, state: "up_to_date" };
	}
	if (value.state === "failed") {
		expectExactKeys(value, FAILED_SNAPSHOT_KEYS);
		const release =
			value.release === null
				? null
				: parseReleaseSummary(value.release, currentVersion);
		return {
			...base,
			state: "failed",
			release,
			failure: parseFailure(value.failure),
		};
	}
	if (!UPDATE_RELEASE_STATES.has(value.state)) throw invalidResponse();
	const release = parseReleaseSummary(value.release, currentVersion);
	if (value.state === "downloading") {
		expectExactKeys(value, DOWNLOADING_SNAPSHOT_KEYS);
		return {
			...base,
			state: "downloading",
			release,
			progress: parseProgress(value.progress),
		};
	}
	expectExactKeys(value, RELEASE_SNAPSHOT_KEYS);
	if (value.state === "available") {
		return { ...base, state: "available", release };
	}
	if (value.state === "verifying") {
		return { ...base, state: "verifying", release };
	}
	if (value.state === "ready") {
		return { ...base, state: "ready", release };
	}
	if (value.state === "preparing_install") {
		return { ...base, state: "preparing_install", release };
	}
	return { ...base, state: "installing", release };
}

const BASE_SNAPSHOT_KEYS = [
	"schemaVersion",
	"state",
	"currentVersion",
	"checkedAtMs",
] as const;
const DISABLED_SNAPSHOT_KEYS = [...BASE_SNAPSHOT_KEYS, "reason"] as const;
const RELEASE_SNAPSHOT_KEYS = [...BASE_SNAPSHOT_KEYS, "release"] as const;
const DOWNLOADING_SNAPSHOT_KEYS = [
	...RELEASE_SNAPSHOT_KEYS,
	"progress",
] as const;
const FAILED_SNAPSHOT_KEYS = [...RELEASE_SNAPSHOT_KEYS, "failure"] as const;
const RELEASE_SUMMARY_KEYS = [
	"version",
	"minimumSupportedVersion",
	"mandatory",
	"publishedAt",
	"releaseNotes",
] as const;
const PROGRESS_KEYS = ["receivedBytes", "totalBytes", "percent"] as const;
const FAILURE_KEYS = ["code", "message", "retryable", "operation"] as const;
const MAX_RELEASE_NOTES_LENGTH = 32_768;

const UPDATE_RELEASE_STATES = new Set<unknown>([
	"available",
	"downloading",
	"verifying",
	"ready",
	"preparing_install",
	"installing",
]);

function parseReleaseSummary(
	value: unknown,
	currentVersion: string | null,
): AppUpdateReleaseSummary {
	if (!isRecord(value)) throw invalidResponse();
	expectExactKeys(value, RELEASE_SUMMARY_KEYS);
	if (
		typeof value.mandatory !== "boolean" ||
		typeof value.releaseNotes !== "string" ||
		value.releaseNotes.length > MAX_RELEASE_NOTES_LENGTH ||
		hasForbiddenControl(value.releaseNotes)
	) {
		throw invalidResponse();
	}
	const version = parseVersion(value.version);
	const minimumSupportedVersion = parseVersion(value.minimumSupportedVersion);
	if (compareStableSemver(minimumSupportedVersion, version) > 0) {
		throw invalidResponse();
	}
	if (
		currentVersion === null ||
		compareStableSemver(version, currentVersion) <= 0
	) {
		throw invalidResponse();
	}
	const mandatory =
		compareStableSemver(currentVersion, minimumSupportedVersion) < 0;
	if (value.mandatory !== mandatory) throw invalidResponse();
	const publishedAt = parseCanonicalTimestamp(value.publishedAt);
	return {
		version,
		minimumSupportedVersion,
		mandatory,
		publishedAt,
		releaseNotes: value.releaseNotes,
	};
}

function parseProgress(value: unknown): AppUpdateProgress {
	if (!isRecord(value)) throw invalidResponse();
	expectExactKeys(value, PROGRESS_KEYS);
	if (
		!isNonNegativeSafeInteger(value.receivedBytes) ||
		!isPositiveSafeInteger(value.totalBytes) ||
		value.receivedBytes > value.totalBytes ||
		!isNonNegativeSafeInteger(value.percent) ||
		value.percent > 100 ||
		value.percent !==
			Math.min(100, Math.floor((value.receivedBytes / value.totalBytes) * 100))
	) {
		throw invalidResponse();
	}
	return {
		receivedBytes: value.receivedBytes,
		totalBytes: value.totalBytes,
		percent: value.percent,
	};
}

function parseFailure(value: unknown): AppUpdateFailure {
	if (!isRecord(value)) throw invalidResponse();
	expectExactKeys(value, FAILURE_KEYS);
	if (
		!FAILURE_CODES.has(value.code) ||
		typeof value.message !== "string" ||
		typeof value.retryable !== "boolean" ||
		(value.operation !== "check" &&
			value.operation !== "download" &&
			value.operation !== "install")
	) {
		throw invalidResponse();
	}
	const expected = sanitizeAppUpdateFailure(
		value.code as AppUpdateFailure["code"],
		value.operation,
	);
	if (
		value.message !== expected.message ||
		value.retryable !== expected.retryable
	) {
		throw invalidResponse();
	}
	return expected;
}

const FAILURE_CODES = new Set<unknown>([
	"updates_disabled",
	"network_unavailable",
	"invalid_manifest",
	"signature_invalid",
	"incompatible_release",
	"update_metadata_mismatch",
	"download_failed",
	"archive_size_mismatch",
	"archive_digest_mismatch",
	"staging_failed",
	"install_blocked",
	"install_failed",
	"internal_error",
]);

function cloneSnapshot(snapshot: AppUpdateSnapshot): AppUpdateSnapshot {
	return parseAppUpdateSnapshot(structuredClone(snapshot));
}

function disabledSnapshot(currentVersion: string | null): AppUpdateSnapshot {
	return {
		schemaVersion: APP_UPDATE_SNAPSHOT_SCHEMA_VERSION,
		state: "disabled",
		currentVersion,
		checkedAtMs: null,
		reason: "unsupported_platform",
	};
}

async function loadClientApi(): Promise<Record<string, unknown>> {
	if (!hasElectrobunRuntime()) throw unavailable();
	const imported: unknown = await import("../../rpc");
	if (!isRecord(imported) || !isRecord(imported.clientApi)) throw unavailable();
	return imported.clientApi;
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNullableVersion(value: unknown): string | null {
	return value === null ? null : parseVersion(value);
}

function parseVersion(value: unknown): string {
	if (typeof value !== "string") throw invalidResponse();
	try {
		parseStableSemver(value);
	} catch {
		throw invalidResponse();
	}
	return value;
}

function parseCanonicalTimestamp(value: unknown): string {
	if (typeof value !== "string") throw invalidResponse();
	const timestamp = Date.parse(value);
	if (
		!Number.isFinite(timestamp) ||
		new Date(timestamp).toISOString() !== value
	) {
		throw invalidResponse();
	}
	return value;
}

function isNullableTimestamp(value: unknown): value is number | null {
	return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function expectExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		throw invalidResponse();
	}
}

function hasForbiddenControl(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if ((code >= 0 && code <= 8) || code === 11 || code === 12) return true;
		if ((code >= 14 && code <= 31) || code === 127) return true;
	}
	return false;
}

function invalidResponse(): Error {
	return new Error("The app update bridge returned an invalid snapshot.");
}

function unavailable(): Error {
	return new Error("The app update bridge is unavailable.");
}
