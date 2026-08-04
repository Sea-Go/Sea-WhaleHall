import { randomUUID } from "node:crypto";
import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const ACTIVITY_EVENT_WORKER_ENDPOINT =
	"https://model.sea-ridethewindbreakthewaves.xyz/v1/activity/analyze";
export const AGENT_RELAY_BASE_URL =
	"https://model.sea-ridethewindbreakthewaves.xyz";
export const ACTIVITY_EVENT_WORKER_MODEL = "qwen3:1.7b";
export const UNPROVISIONED_ACTIVITY_WORKER_KEY =
	"REPLACE_WITH_ACTIVITY_WORKER_KEY";
export const UNPROVISIONED_AGENT_RELAY_KEY = "REPLACE_WITH_PERSONAL_RELAY_KEY";

const LEGACY_CONFIGURATION_SCHEMA_VERSION = "whalehall-client-config.v1";
const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const MAXIMUM_ACTIVITY_WORKER_KEY_LENGTH = 4 * 1024;
const MAXIMUM_PERSONAL_RELAY_KEY_LENGTH = 1_024;

export type ModelConfiguration = {
	name: typeof ACTIVITY_EVENT_WORKER_MODEL;
	baseurl: string;
	apikey: string;
};

/** The editable desktop configuration intentionally contains only these roles. */
export type ClientConfiguration = {
	reflection: ModelConfiguration;
	agent: ModelConfiguration;
};

export const DEFAULT_CLIENT_CONFIGURATION: ClientConfiguration = {
	reflection: {
		name: ACTIVITY_EVENT_WORKER_MODEL,
		baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
		apikey: UNPROVISIONED_ACTIVITY_WORKER_KEY,
	},
	agent: {
		name: ACTIVITY_EVENT_WORKER_MODEL,
		baseurl: AGENT_RELAY_BASE_URL,
		apikey: UNPROVISIONED_AGENT_RELAY_KEY,
	},
};

export type ClientConfigurationLoadStatus =
	| "loaded"
	| "seeded"
	| "legacy-unprovisioned"
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
	name: typeof ACTIVITY_EVENT_WORKER_MODEL;
	baseurl: string;
	apikey: string;
};

export type ActivityEventWorkerRuntimeConfiguration = {
	modelName: typeof ACTIVITY_EVENT_WORKER_MODEL;
	endpoint: string;
	authorizationToken: string;
	scoreThreshold: number;
};

export type WriteProvisionedClientConfigurationOptions = {
	path: string;
	configuration: ClientConfiguration;
};

/**
 * Loads the user-owned config.yaml, seeding it once from the packaged
 * placeholder template. Invalid or legacy files are never overwritten.
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
				status: "legacy-unprovisioned",
			};
		}
		return {
			configuration: parsed.configuration,
			path,
			status: seeded ? "seeded" : "loaded",
		};
	} catch {
		return defaultConfiguration(path, "invalid");
	}
}

/**
 * Writes a validated literal-key configuration atomically with owner-only
 * permissions. It is used by the interactive owner provisioning command;
 * application startup intentionally never writes or repairs a user file.
 */
export function writeProvisionedClientConfiguration(
	options: WriteProvisionedClientConfigurationOptions,
): void {
	const normalized = normalizeClientConfiguration(options.configuration);
	if (
		isUnprovisionedKey(normalized.reflection.apikey) ||
		isUnprovisionedKey(normalized.agent.apikey)
	) {
		throw new Error(
			"Provisioned client configuration requires literal API keys.",
		);
	}
	const destination = options.path;
	const directory = dirname(destination);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	hardenPath(directory, 0o700);
	if (existsSync(destination)) {
		const stat = lstatSync(destination);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(
				"Client configuration destination must be a regular file.",
			);
		}
	}
	const temporary = join(directory, `.config.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, serializeConfiguration(normalized), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		chmodSync(temporary, 0o600);
		renameSync(temporary, destination);
		chmodSync(destination, 0o600);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

/** Returns null until the reflection Worker key is provisioned literally. */
export function reflectionModelConfigurationFromConfiguration(
	configuration: ClientConfiguration,
): ModelRuntimeConfiguration | null {
	return runtimeConfiguration(configuration.reflection);
}

/** Returns null until the personal relay key is provisioned literally. */
export function agentModelConfigurationFromConfiguration(
	configuration: ClientConfiguration,
): ModelRuntimeConfiguration | null {
	return runtimeConfiguration(configuration.agent);
}

/**
 * The reflection role is the sole sender of sealed raw activity windows. The
 * score threshold remains deterministic local policy, not editable YAML.
 */
export function activityEventWorkerConfigurationFromConfiguration(
	configuration: ClientConfiguration,
): ActivityEventWorkerRuntimeConfiguration | null {
	const reflection =
		reflectionModelConfigurationFromConfiguration(configuration);
	if (!reflection) return null;
	return {
		modelName: reflection.name,
		endpoint: reflection.baseurl,
		authorizationToken: reflection.apikey,
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

function parseConfiguration(
	source: string,
):
	| { kind: "current"; configuration: ClientConfiguration }
	| { kind: "legacy" } {
	const value = Bun.YAML.parse(source);
	if (isLegacyConfiguration(value)) return { kind: "legacy" };
	return {
		kind: "current",
		configuration: normalizeClientConfiguration(value),
	};
}

function isLegacyConfiguration(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.schemaVersion === LEGACY_CONFIGURATION_SCHEMA_VERSION &&
		isRecord(value.request)
	);
}

function normalizeClientConfiguration(value: unknown): ClientConfiguration {
	if (!isRecord(value) || !hasExactKeys(value, ["reflection", "agent"])) {
		throw new Error("Client configuration root is invalid.");
	}
	return {
		reflection: normalizeModelConfiguration(value.reflection, "reflection"),
		agent: normalizeModelConfiguration(value.agent, "agent"),
	};
}

function normalizeModelConfiguration(
	value: unknown,
	role: "reflection" | "agent",
): ModelConfiguration {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["name", "baseurl", "apikey"]) ||
		typeof value.name !== "string" ||
		typeof value.baseurl !== "string" ||
		typeof value.apikey !== "string"
	) {
		throw new Error(`${role} model configuration is invalid.`);
	}
	if (value.name.trim() !== ACTIVITY_EVENT_WORKER_MODEL) {
		throw new Error(`${role} model name is not approved.`);
	}
	const baseurl =
		role === "reflection"
			? normalizeReflectionEndpoint(value.baseurl)
			: normalizeAgentRelayBaseUrl(value.baseurl);
	return {
		name: ACTIVITY_EVENT_WORKER_MODEL,
		baseurl,
		apikey: normalizeLiteralApiKey(value.apikey, role),
	};
}

function normalizeReflectionEndpoint(value: string): string {
	const endpoint = parseRemoteHttpsUrl(value, "reflection");
	if (endpoint.toString() !== ACTIVITY_EVENT_WORKER_ENDPOINT) {
		throw new Error(
			"reflection model baseurl is not the approved activity endpoint.",
		);
	}
	return ACTIVITY_EVENT_WORKER_ENDPOINT;
}

function normalizeAgentRelayBaseUrl(value: string): string {
	const endpoint = parseRemoteHttpsUrl(value, "agent");
	if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
		throw new Error("agent model baseurl must be the relay origin.");
	}
	if (endpoint.origin !== AGENT_RELAY_BASE_URL) {
		throw new Error("agent model baseurl is not the approved relay origin.");
	}
	return AGENT_RELAY_BASE_URL;
}

function parseRemoteHttpsUrl(value: string, role: string): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(value.trim());
	} catch {
		throw new Error(`${role} model baseurl is invalid.`);
	}
	if (
		endpoint.protocol !== "https:" ||
		isLoopbackHostname(endpoint.hostname) ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.search !== "" ||
		endpoint.hash !== ""
	) {
		throw new Error(`${role} model baseurl must be a remote HTTPS URL.`);
	}
	return endpoint;
}

function normalizeLiteralApiKey(value: string, role: string): string {
	const apikey = value.trim();
	if (
		apikey.length < 1 ||
		apikey.length >
			(role === "agent"
				? MAXIMUM_PERSONAL_RELAY_KEY_LENGTH
				: MAXIMUM_ACTIVITY_WORKER_KEY_LENGTH) ||
		/[\p{Cc}\s]/u.test(apikey) ||
		apikey.includes("${")
	) {
		throw new Error(`${role} model apikey must be a literal non-empty key.`);
	}
	return apikey;
}

function runtimeConfiguration(
	model: ModelConfiguration,
): ModelRuntimeConfiguration | null {
	if (isUnprovisionedKey(model.apikey)) return null;
	return structuredClone(model);
}

function isUnprovisionedKey(value: string): boolean {
	return (
		value === UNPROVISIONED_ACTIVITY_WORKER_KEY ||
		value === UNPROVISIONED_AGENT_RELAY_KEY
	);
}

function serializeConfiguration(configuration: ClientConfiguration): string {
	return [
		"reflection:",
		`  name: ${JSON.stringify(configuration.reflection.name)}`,
		`  baseurl: ${JSON.stringify(configuration.reflection.baseurl)}`,
		`  apikey: ${JSON.stringify(configuration.reflection.apikey)}`,
		"",
		"agent:",
		`  name: ${JSON.stringify(configuration.agent.name)}`,
		`  baseurl: ${JSON.stringify(configuration.agent.baseurl)}`,
		`  apikey: ${JSON.stringify(configuration.agent.apikey)}`,
		"",
	].join("\n");
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
