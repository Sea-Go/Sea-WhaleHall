import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const ACTIVITY_EVENT_WORKER_ENDPOINT =
	"https://model.sea-ridethewindbreakthewaves.xyz/v1/activity/analyze";
export const ACTIVITY_EVENT_WORKER_MODEL = "qwen3:1.7b";
export const ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE =
	"${WHALEHALL_ACTIVITY_WORKER_TOKEN}";

export const DATACENTER_DEFAULT_BASE_URL = "http://175.24.130.226:23012";
export const DATACENTER_DEFAULT_SYNC_ENABLED = false;
export const DATACENTER_DEFAULT_SYNC_INTERVAL_MS = 30_000;
export const DATACENTER_URL_ENVIRONMENT_REFERENCE =
	"WHALEHALL_DATACENTER_URL";

const LEGACY_CONFIGURATION_SCHEMA_VERSION = "whalehall-client-config.v1";
const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const MAXIMUM_MODEL_NAME_LENGTH = 160;
const MAXIMUM_API_KEY_LENGTH = 4 * 1024;
const ENVIRONMENT_REFERENCE = /^\$\{([A-Z][A-Z0-9_]*)\}$/u;

export type ModelConfiguration = {
	name: string;
	baseurl: string;
	apikey: string;
};

export type DataCenterSyncConfiguration = {
	enabled: boolean;
	intervalMs: number;
};

export type DataCenterConfiguration = {
	baseUrl: string;
	sync: DataCenterSyncConfiguration;
};

export type DataCenterRuntimeConfiguration = {
	baseUrl: string;
	syncEnabled: boolean;
	syncIntervalMs: number;
};

/**
 * The editable user configuration intentionally contains only the two model
 * roles WhaleHall needs. Both roles may use the same endpoint and key.
 */
export type ClientConfiguration = {
	reflection: ModelConfiguration;
	agent: ModelConfiguration;
	datacenter: DataCenterConfiguration;
};

export const DEFAULT_CLIENT_CONFIGURATION: ClientConfiguration = {
	reflection: {
		name: ACTIVITY_EVENT_WORKER_MODEL,
		baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
		apikey: ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE,
	},
	agent: {
		name: ACTIVITY_EVENT_WORKER_MODEL,
		baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
		apikey: ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE,
	},
	datacenter: {
		baseUrl: DATACENTER_DEFAULT_BASE_URL,
		sync: {
			enabled: DATACENTER_DEFAULT_SYNC_ENABLED,
			intervalMs: DATACENTER_DEFAULT_SYNC_INTERVAL_MS,
		},
	},
};

export type ClientConfigurationLoadStatus =
	| "loaded"
	| "seeded"
	| "invalid"
	| "defaults";

export type ClientConfigurationLoadResult = {
	configuration: ClientConfiguration;
	path: string;
	status: ClientConfigurationLoadStatus;
};

export type LoadOrCreateClientConfigurationOptions = {
	userDataDirectory: string;
	bundledTemplatePath: string;
};

export type ModelRuntimeConfiguration = {
	name: string;
	baseurl: string;
	apikey: string;
};

export type ActivityEventWorkerRuntimeConfiguration = {
	modelName: string;
	endpoint: string;
	authorizationToken: string;
	scoreThreshold: number;
};

/**
 * Loads the user's editable config.yaml, seeding it once from the signed app
 * bundle. Invalid, non-regular, oversized, or unsafe configuration falls back
 * to safe defaults; the existing user file is never overwritten.
 */
export function loadOrCreateClientConfiguration(
	options: LoadOrCreateClientConfigurationOptions,
): ClientConfigurationLoadResult {
	const path = join(options.userDataDirectory, "config.yaml");
	let seeded = false;
	if (!existsSync(path)) {
		try {
			seedConfiguration(options.bundledTemplatePath, path);
			seeded = true;
		} catch {
			return defaultConfiguration(path, "defaults");
		}
	}
	try {
		const configuration = parseConfiguration(readRegularFile(path));
		return {
			configuration,
			path,
			status: seeded ? "seeded" : "loaded",
		};
	} catch {
		return defaultConfiguration(path, "invalid");
	}
}

/**
 * Resolves the reflection model for the activity-event analysis protocol.
 * A key may be a literal owner-only value or a constrained environment
 * variable reference. Missing or malformed runtime keys disable delivery
 * safely.
 */
export function reflectionModelConfigurationFromConfiguration(
	configuration: ClientConfiguration,
	environment: Readonly<Record<string, string | undefined>>,
): ModelRuntimeConfiguration | null {
	return resolveModelRuntimeConfiguration(configuration.reflection, environment);
}

/**
 * Resolves the model reserved for the local Agent executor. The current
 * activity Worker protocol remains an analysis protocol; loading this role
 * does not itself start a generic chat request.
 */
export function agentModelConfigurationFromConfiguration(
	configuration: ClientConfiguration,
	environment: Readonly<Record<string, string | undefined>>,
): ModelRuntimeConfiguration | null {
	return resolveModelRuntimeConfiguration(configuration.agent, environment);
}

/**
 * The reflection role is the only role that currently sends sealed raw
 * activity windows. Its score threshold deliberately stays deterministic and
 * local instead of becoming another YAML setting.
 */
export function activityEventWorkerConfigurationFromConfiguration(
	configuration: ClientConfiguration,
	environment: Readonly<Record<string, string | undefined>>,
): ActivityEventWorkerRuntimeConfiguration | null {
	const reflection = reflectionModelConfigurationFromConfiguration(
		configuration,
		environment,
	);
	if (reflection === null) return null;
	return {
		modelName: reflection.name,
		endpoint: reflection.baseurl,
		authorizationToken: reflection.apikey,
		scoreThreshold: 1,
	};
}

/**
 * Resolves the Sea DataCenter runtime configuration. A valid
 * WHALEHALL_DATACENTER_URL environment override wins over the editable
 * config.yaml value; syncEnabled and syncIntervalMs come from config.yaml.
 */
export function datacenterRuntimeConfigurationFromConfiguration(
	configuration: ClientConfiguration,
	environment: Readonly<Record<string, string | undefined>>,
): DataCenterRuntimeConfiguration {
	return {
		baseUrl: resolveDataCenterBaseUrl(
			configuration.datacenter.baseUrl,
			environment,
		),
		syncEnabled: configuration.datacenter.sync.enabled,
		syncIntervalMs: configuration.datacenter.sync.intervalMs,
	};
}

function resolveDataCenterBaseUrl(
	configured: string,
	environment: Readonly<Record<string, string | undefined>>,
): string {
	const override = environment[DATACENTER_URL_ENVIRONMENT_REFERENCE];
	if (override !== undefined && override.trim() !== "") {
		try {
			return normalizeDataCenterBaseUrl(override);
		} catch {
			// An invalid environment override falls back to the configured URL.
		}
	}
	return configured;
}

function parseDataCenterConfiguration(value: unknown): DataCenterConfiguration {
	const defaults = DEFAULT_CLIENT_CONFIGURATION.datacenter;
	if (value === undefined) return structuredClone(defaults);
	if (!isRecord(value)) {
		throw new Error("datacenter configuration is invalid.");
	}
	const baseUrl =
		typeof value.baseUrl === "string"
			? safeDataCenterBaseUrl(value.baseUrl, defaults.baseUrl)
			: defaults.baseUrl;
	const sync = isRecord(value.sync)
		? parseDataCenterSyncConfiguration(value.sync, defaults.sync)
		: structuredClone(defaults.sync);
	return { baseUrl, sync };
}

function safeDataCenterBaseUrl(
	value: string,
	fallback: string,
): string {
	try {
		return normalizeDataCenterBaseUrl(value);
	} catch {
		return fallback;
	}
}

function normalizeDataCenterBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("datacenter baseUrl is invalid.");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.hostname.length === 0 ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("datacenter baseUrl must be an HTTP(S) URL.");
	}
	let path = url.pathname;
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (path === "/") path = "";
	return url.origin + path;
}

function parseDataCenterSyncConfiguration(
	value: Record<string, unknown>,
	defaults: DataCenterSyncConfiguration,
): DataCenterSyncConfiguration {
	const enabled =
		typeof value.enabled === "boolean" ? value.enabled : defaults.enabled;
	const intervalMs =
		typeof value.intervalMs === "number" &&
		Number.isSafeInteger(value.intervalMs) &&
		value.intervalMs >= 1_000 &&
		value.intervalMs <= 3_600_000
			? value.intervalMs
			: defaults.intervalMs;
	return { enabled, intervalMs };
}

function defaultConfiguration(
	path: string,
	status: "invalid" | "defaults",
): ClientConfigurationLoadResult {
	return {
		configuration: structuredClone(DEFAULT_CLIENT_CONFIGURATION),
		path,
		status,
	};
}

function seedConfiguration(templatePath: string, destinationPath: string): void {
	parseConfiguration(readRegularFile(templatePath));
	mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
	try {
		copyFileSync(templatePath, destinationPath, constants.COPYFILE_EXCL);
		chmodSync(destinationPath, 0o600);
	} catch (error) {
		if (isAlreadyExistsError(error)) return;
		throw error;
	}
}

function readRegularFile(path: string): string {
	const stat = lstatSync(path);
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		stat.size < 1 ||
		stat.size > MAXIMUM_CONFIGURATION_BYTES
	) {
		throw new Error("Client configuration must be a bounded regular file.");
	}
	return readFileSync(path, "utf8");
}

function parseConfiguration(source: string): ClientConfiguration {
	const value = Bun.YAML.parse(source);
	if (
		isRecord(value) &&
		(hasExactKeys(value, ["reflection", "agent"]) ||
			hasExactKeys(value, ["reflection", "agent", "datacenter"]))
	) {
		return {
			reflection: parseModelConfiguration(value.reflection, "reflection"),
			agent: parseModelConfiguration(value.agent, "agent"),
			datacenter: parseDataCenterConfiguration(value.datacenter),
		};
	}
	const migrated = parseLegacyConfiguration(value);
	if (migrated !== null) return migrated;
	throw new Error("Client configuration root is invalid.");
}

function parseLegacyConfiguration(value: unknown): ClientConfiguration | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== LEGACY_CONFIGURATION_SCHEMA_VERSION ||
		!isRecord(value.request)
	) {
		return null;
	}
	const worker = value.request.activityEventWorker;
	if (
		worker !== undefined &&
		(!isRecord(worker) || typeof worker.endpoint !== "string")
	) {
		throw new Error("Legacy activity Worker configuration is invalid.");
	}
	const endpoint =
		worker === undefined ? ACTIVITY_EVENT_WORKER_ENDPOINT : worker.endpoint;
	const model = parseModelConfiguration(
		{
			name: ACTIVITY_EVENT_WORKER_MODEL,
			baseurl: endpoint,
			apikey: ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE,
		},
		"legacy activity Worker",
	);
	return {
		reflection: model,
		agent: { ...model },
		datacenter: structuredClone(DEFAULT_CLIENT_CONFIGURATION.datacenter),
	};
}

function parseModelConfiguration(
	value: unknown,
	role: string,
): ModelConfiguration {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["name", "baseurl", "apikey"]) ||
		typeof value.name !== "string" ||
		typeof value.baseurl !== "string" ||
		typeof value.apikey !== "string"
	) {
		throw new Error(role + " model configuration is invalid.");
	}
	return {
		name: normalizeModelName(value.name, role),
		baseurl: normalizeModelEndpoint(value.baseurl, role),
		apikey: normalizeApiKey(value.apikey, role),
	};
}

function normalizeModelName(value: string, role: string): string {
	const name = value.trim();
	if (
		name.length === 0 ||
		name.length > MAXIMUM_MODEL_NAME_LENGTH ||
		Array.from(name).some((character) => /\s/u.test(character))
	) {
		throw new Error(role + " model name is invalid.");
	}
	return name;
}

function normalizeModelEndpoint(value: string, role: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(role + " model baseurl is invalid.");
	}
	if (
		url.protocol !== "https:" ||
		isLoopbackHostname(url.hostname) ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error(role + " model baseurl must be a remote HTTPS URL.");
	}
	return url.toString();
}

function normalizeApiKey(value: string, role: string): string {
	const apikey = value.trim();
	if (
		apikey.length === 0 ||
		apikey.length > MAXIMUM_API_KEY_LENGTH ||
		Array.from(apikey).some((character) => /\s/u.test(character))
	) {
		throw new Error(role + " model apikey is invalid.");
	}
	if (apikey.startsWith("${") && !ENVIRONMENT_REFERENCE.test(apikey)) {
		throw new Error(role + " model apikey environment reference is invalid.");
	}
	return apikey;
}

function resolveModelRuntimeConfiguration(
	model: ModelConfiguration,
	environment: Readonly<Record<string, string | undefined>>,
): ModelRuntimeConfiguration | null {
	const apikey = resolveApiKey(model.apikey, environment);
	if (apikey === null) return null;
	return {
		name: model.name,
		baseurl: model.baseurl,
		apikey,
	};
}

function resolveApiKey(
	value: string,
	environment: Readonly<Record<string, string | undefined>>,
): string | null {
	const reference = ENVIRONMENT_REFERENCE.exec(value);
	const candidate =
		reference === null ? value : environment[reference[1] ?? ""] ?? "";
	const apikey = candidate.trim();
	if (
		apikey.length === 0 ||
		Array.from(apikey).some((character) => /\s/u.test(character))
	) {
		return null;
	}
	return apikey;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname
		.toLowerCase()
		.replace(/^\[/u, "")
		.replace(/\]$/u, "");
	return (
		normalized === "127.0.0.1" ||
		normalized === "localhost" ||
		normalized === "::1"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function isAlreadyExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "EEXIST"
	);
}
