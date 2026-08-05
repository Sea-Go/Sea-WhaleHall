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

/** Both desktop roles use WhaleHall's remote relay origin.  Endpoint selection
 * is fixed in Bun, never user-controlled YAML. */
export const WHALEHALL_RELAY_BASE_URL =
	"https://model.sea-ridethewindbreakthewaves.xyz";
export const REFLECTION_RELAY_COMPLETIONS_PATH = "/v1/activity/completions";
export const WHALEHALL_RELAY_MODEL = "qwen3:1.7b";
export const UNPROVISIONED_REFLECTION_RELAY_KEY =
	"REPLACE_WITH_REFLECTION_RELAY_KEY";
export const UNPROVISIONED_AGENT_RELAY_KEY = "REPLACE_WITH_PERSONAL_RELAY_KEY";

const LEGACY_CONFIGURATION_SCHEMA_VERSION = "whalehall-client-config.v1";
const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const MAXIMUM_REFLECTION_RELAY_KEY_LENGTH = 1_024;
const MAXIMUM_PERSONAL_RELAY_KEY_LENGTH = 1_024;

export type ModelConfiguration = {
	name: typeof WHALEHALL_RELAY_MODEL;
	baseurl: string;
	apikey: string;
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
};

export const DEFAULT_CLIENT_CONFIGURATION: ClientConfiguration = {
	reflection: {
		name: WHALEHALL_RELAY_MODEL,
		baseurl: WHALEHALL_RELAY_BASE_URL,
		apikey: UNPROVISIONED_REFLECTION_RELAY_KEY,
	},
	agent: {
		name: WHALEHALL_RELAY_MODEL,
		baseurl: WHALEHALL_RELAY_BASE_URL,
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
	name: typeof WHALEHALL_RELAY_MODEL;
	baseurl: string;
	apikey: string;
};

export type ActivityReflectionRuntimeConfiguration = {
	modelName: typeof WHALEHALL_RELAY_MODEL;
	relayBaseUrl: string;
	reflectionKey: string;
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

/** Returns null until the reflection relay key is provisioned literally. */
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
 * The reflection role is the sole sender of sealed raw activity windows through
 * the generic model relay. Prompt construction, raw-window aggregation and
 * result normalization stay on the desktop; the remote route only forwards
 * this OpenAI-compatible request to the approved CPU model.
 */
export function activityReflectionConfigurationFromConfiguration(
	configuration: ClientConfiguration,
): ActivityReflectionRuntimeConfiguration | null {
	const reflection =
		reflectionModelConfigurationFromConfiguration(configuration);
	if (!reflection) return null;
	return {
		modelName: reflection.name,
		relayBaseUrl: reflection.baseurl,
		reflectionKey: reflection.apikey,
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
	if (value.name.trim() !== WHALEHALL_RELAY_MODEL) {
		throw new Error(`${role} model name is not approved.`);
	}
	const baseurl = normalizeRelayBaseUrl(value.baseurl, role);
	return {
		name: WHALEHALL_RELAY_MODEL,
		baseurl,
		apikey: normalizeLiteralApiKey(value.apikey, role),
	};
}

function normalizeRelayBaseUrl(
	value: string,
	role: "reflection" | "agent",
): string {
	const endpoint = parseRemoteHttpsUrl(value, role);
	if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
		throw new Error(`${role} model baseurl must be the relay origin.`);
	}
	if (endpoint.origin !== WHALEHALL_RELAY_BASE_URL) {
		throw new Error(`${role} model baseurl is not the approved relay origin.`);
	}
	return WHALEHALL_RELAY_BASE_URL;
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
				: MAXIMUM_REFLECTION_RELAY_KEY_LENGTH) ||
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
		value === UNPROVISIONED_REFLECTION_RELAY_KEY ||
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
