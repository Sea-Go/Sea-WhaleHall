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

/** Every desktop model and sync request uses this code-owned DataCenter origin. */
export const WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL =
	"https://data.sea-ridethewindbreakthewaves.xyz";
export const WHALEHALL_RELAY_MODEL = "qwen3:1.7b";

const LEGACY_CONFIGURATION_SCHEMA_VERSION = "whalehall-client-config.v1";
const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const MAXIMUM_IGNORED_LEGACY_FIELD_LENGTH = 16_384;

export type ModelConfiguration = {
	name: typeof WHALEHALL_RELAY_MODEL;
};

export type CloudSyncConsentLevel = "off" | "metadata" | "content";

export type CloudSyncConfiguration = {
	enabled: boolean;
	contentEncryptionEnabled: boolean;
	consents: {
		activity: CloudSyncConsentLevel;
		browser: CloudSyncConsentLevel;
		presence: CloudSyncConsentLevel;
	};
};

/**
 * The editable desktop configuration intentionally contains only these roles.
 *
 * Model-call policy: every `config.yaml` role is a desktop model entry point
 * and must be invoked through the bundled Mastra Sidecar boundary. `agent`
 * uses a Mastra Agent and `reflection` uses the no-persistence
 * `activity-reflection` workflow; do not add a direct HTTP client for either
 * role in Bun or a Renderer.
 */
export type ClientConfiguration = {
	reflection: ModelConfiguration;
	agent: ModelConfiguration;
	cloudSync: CloudSyncConfiguration;
};

export const DEFAULT_CLIENT_CONFIGURATION: ClientConfiguration = {
	reflection: {
		name: WHALEHALL_RELAY_MODEL,
	},
	agent: {
		name: WHALEHALL_RELAY_MODEL,
	},
	cloudSync: {
		enabled: false,
		contentEncryptionEnabled: false,
		consents: {
			activity: "off",
			browser: "off",
			presence: "off",
		},
	},
};

export type ClientConfigurationLoadStatus =
	| "loaded"
	| "seeded"
	| "legacy"
	| "invalid"
	| "defaults";

export type ClientConfigurationLoadResult = {
	configuration: ClientConfiguration;
	path: string;
	status: ClientConfigurationLoadStatus;
	/** Retired or unverifiable configuration consent never crosses origins. */
	cloudSyncConsentBlockedByRetiredOrigin: boolean;
};

export type LoadOrCreateClientConfigurationOptions = {
	userDataDirectory: string;
	bundledTemplatePath: string;
};

export type ModelRuntimeConfiguration = {
	name: typeof WHALEHALL_RELAY_MODEL;
	baseurl: string;
};

export type ActivityReflectionRuntimeConfiguration = {
	modelName: typeof WHALEHALL_RELAY_MODEL;
	scoreThreshold: number;
};

/**
 * Loads the user-owned config.yaml, seeding it once from the packaged
 * safe template. Invalid and legacy files are never overwritten. Historical
 * baseurl/apikey fields remain parseable but are discarded at this boundary.
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
		const parsed = parseConfiguration(readRegularFile(path));
		if (parsed.kind === "legacy") {
			return {
				configuration: structuredClone(DEFAULT_CLIENT_CONFIGURATION),
				path,
				status: "legacy",
				cloudSyncConsentBlockedByRetiredOrigin: true,
			};
		}
		return {
			configuration: parsed.configuration,
			path,
			status: seeded ? "seeded" : "loaded",
			cloudSyncConsentBlockedByRetiredOrigin:
				parsed.cloudSyncConsentBlockedByRetiredOrigin,
		};
	} catch {
		return defaultConfiguration(path, "invalid");
	}
}

/** Returns the code-owned DataCenter runtime configuration for this role. */
export function agentModelConfigurationFromConfiguration(
	configuration: ClientConfiguration,
): ModelRuntimeConfiguration {
	return {
		name: configuration.agent.name,
		baseurl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
	};
}

/**
 * The reflection role is the sole sender of sealed raw activity windows through
 * the generic model relay. Prompt construction, raw-window aggregation and
 * result normalization stay on the desktop; the remote route only forwards
 * this OpenAI-compatible request to the approved CPU model.
 */
export function activityReflectionConfigurationFromConfiguration(
	configuration: ClientConfiguration,
): ActivityReflectionRuntimeConfiguration {
	return {
		modelName: configuration.reflection.name,
		scoreThreshold: 1,
	};
}

function defaultConfiguration(
	path: string,
	status: "invalid" | "defaults",
): ClientConfigurationLoadResult {
	return {
		configuration: structuredClone(DEFAULT_CLIENT_CONFIGURATION),
		path,
		status,
		cloudSyncConsentBlockedByRetiredOrigin: true,
	};
}

function seedConfiguration(
	templatePath: string,
	destinationPath: string,
): void {
	const parsed = parseConfiguration(readRegularFile(templatePath));
	if (parsed.kind !== "current") {
		throw new Error(
			"Bundled client configuration must use the current schema.",
		);
	}
	mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
	hardenPath(dirname(destinationPath), 0o700);
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

function parseConfiguration(source: string):
	| {
			kind: "current";
			configuration: ClientConfiguration;
			cloudSyncConsentBlockedByRetiredOrigin: boolean;
	  }
	| { kind: "legacy" } {
	const value = Bun.YAML.parse(source);
	if (isLegacyConfiguration(value)) return { kind: "legacy" };
	return { kind: "current", ...normalizeClientConfiguration(value) };
}

function isLegacyConfiguration(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.schemaVersion === LEGACY_CONFIGURATION_SCHEMA_VERSION &&
		isRecord(value.request)
	);
}

function normalizeClientConfiguration(value: unknown): {
	configuration: ClientConfiguration;
	cloudSyncConsentBlockedByRetiredOrigin: boolean;
} {
	if (
		!isRecord(value) ||
		!(
			hasExactKeys(value, ["reflection", "agent"]) ||
			hasExactKeys(value, ["reflection", "agent", "cloudSync"])
		)
	) {
		throw new Error("Client configuration root is invalid.");
	}
	const reflection = normalizeModelConfiguration(
		value.reflection,
		"reflection",
	);
	const agent = normalizeModelConfiguration(value.agent, "agent");
	const cloudSyncConsentBlockedByRetiredOrigin = legacyAgentOriginChanged(
		value.agent,
	);
	return {
		configuration: {
			reflection,
			agent,
			cloudSync: cloudSyncConsentBlockedByRetiredOrigin
				? structuredClone(DEFAULT_CLIENT_CONFIGURATION.cloudSync)
				: value.cloudSync === undefined
					? structuredClone(DEFAULT_CLIENT_CONFIGURATION.cloudSync)
					: normalizeCloudSyncConfiguration(value.cloudSync),
		},
		cloudSyncConsentBlockedByRetiredOrigin,
	};
}

function legacyAgentOriginChanged(value: unknown): boolean {
	if (!isRecord(value) || value.baseurl === undefined) return false;
	if (typeof value.baseurl !== "string") return true;
	try {
		const endpoint = new URL(value.baseurl.trim());
		return !(
			endpoint.origin === WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL &&
			(endpoint.pathname === "" || endpoint.pathname === "/") &&
			endpoint.username === "" &&
			endpoint.password === "" &&
			endpoint.search === "" &&
			endpoint.hash === ""
		);
	} catch {
		return true;
	}
}

function normalizeModelConfiguration(
	value: unknown,
	role: "reflection" | "agent",
): ModelConfiguration {
	if (
		!isRecord(value) ||
		!hasRequiredAndOptionalKeys(value, ["name"], ["baseurl", "apikey"]) ||
		typeof value.name !== "string" ||
		(value.baseurl !== undefined && !isBoundedLegacyString(value.baseurl)) ||
		(value.apikey !== undefined && !isBoundedLegacyString(value.apikey))
	) {
		throw new Error(`${role} model configuration is invalid.`);
	}
	if (value.name.trim() !== WHALEHALL_RELAY_MODEL) {
		throw new Error(`${role} model name is not approved.`);
	}
	return {
		name: WHALEHALL_RELAY_MODEL,
	};
}

function normalizeCloudSyncConfiguration(
	value: unknown,
): CloudSyncConfiguration {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["enabled", "contentEncryptionEnabled", "consents"]) ||
		typeof value.enabled !== "boolean" ||
		typeof value.contentEncryptionEnabled !== "boolean" ||
		!isRecord(value.consents) ||
		!hasExactKeys(value.consents, ["activity", "browser", "presence"])
	) {
		throw new Error("cloudSync configuration is invalid.");
	}
	return {
		enabled: value.enabled,
		contentEncryptionEnabled: value.contentEncryptionEnabled,
		consents: {
			activity: normalizeConsentLevel(value.consents.activity),
			browser: normalizeConsentLevel(value.consents.browser),
			presence: normalizeConsentLevel(value.consents.presence),
		},
	};
}

function normalizeConsentLevel(value: unknown): CloudSyncConsentLevel {
	if (value !== "off" && value !== "metadata" && value !== "content") {
		throw new Error("cloudSync consent level is invalid.");
	}
	return value;
}

function isBoundedLegacyString(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAXIMUM_IGNORED_LEGACY_FIELD_LENGTH
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

function hasRequiredAndOptionalKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => key in value) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}

function hardenPath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Some test/virtual filesystems do not implement POSIX permissions.
	}
}

function isAlreadyExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "EEXIST"
	);
}
