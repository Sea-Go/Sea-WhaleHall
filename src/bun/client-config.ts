import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const CLIENT_CONFIGURATION_SCHEMA_VERSION =
	"whalehall-client-config.v1" as const;
export const ACTIVITY_EVENT_WORKER_ENDPOINT =
	"https://model.sea-ridethewindbreakthewaves.xyz/v1/activity/analyze";

const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;

export type ClientConfiguration = {
	schemaVersion: typeof CLIENT_CONFIGURATION_SCHEMA_VERSION;
	request: {
		teacherOllama: {
			baseUrl: string;
		};
		reflectionModernBert: {
			endpoint: string;
		};
		timelineModernBert: {
			endpoint: string;
			manifestEndpoint: string;
			pinnedManifest: string;
		};
		activityEventWorker: {
			enabled: boolean;
			endpoint: string;
			scoreThreshold: number;
		};
	};
};

export const DEFAULT_CLIENT_CONFIGURATION: ClientConfiguration = {
	schemaVersion: CLIENT_CONFIGURATION_SCHEMA_VERSION,
	request: {
		teacherOllama: {
			baseUrl: "http://127.0.0.1:11434",
		},
		reflectionModernBert: {
			endpoint: "http://127.0.0.1:8765/v1/reflections:infer",
		},
		timelineModernBert: {
			endpoint: "",
			manifestEndpoint: "",
			pinnedManifest: "",
		},
		activityEventWorker: {
			enabled: true,
			endpoint: ACTIVITY_EVENT_WORKER_ENDPOINT,
			scoreThreshold: 1,
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

export type ActivityEventWorkerRuntimeConfiguration = {
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
 * Builds the only Timeline v2 endpoint inputs accepted by the application.
 * Endpoint environment variables are intentionally not inherited; the YAML
 * user copy is the single source of request addresses. The token remains an
 * environment-only secret and is never persisted to config.yaml.
 */
export function timelineModernBertEnvironmentFromConfiguration(
	configuration: ClientConfiguration,
	environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
	return {
		WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT:
			nonEmptyOrUndefined(
				configuration.request.timelineModernBert.endpoint,
			),
		WHALEHALL_TIMELINE_MODERNBERT_MANIFEST_ENDPOINT:
			nonEmptyOrUndefined(
				configuration.request.timelineModernBert.manifestEndpoint,
			),
		WHALEHALL_TIMELINE_MODERNBERT_PINNED_MANIFEST:
			nonEmptyOrUndefined(
				configuration.request.timelineModernBert.pinnedManifest,
			),
		WHALEHALL_TIMELINE_MODERNBERT_TOKEN:
			environment.WHALEHALL_TIMELINE_MODERNBERT_TOKEN,
	};
}

/**
 * The activity worker is the one reviewed cloud exception to the otherwise
 * local-only request configuration. Its exact HTTPS endpoint is pinned here;
 * a dedicated token remains environment-only and is never copied to YAML or
 * passed to whalehall-local.
 */
export function activityEventWorkerConfigurationFromConfiguration(
	configuration: ClientConfiguration,
	environment: Readonly<Record<string, string | undefined>>,
): ActivityEventWorkerRuntimeConfiguration | null {
	const worker = configuration.request.activityEventWorker;
	const authorizationToken = environment.WHALEHALL_ACTIVITY_WORKER_TOKEN?.trim() ?? "";
	if (
		!worker.enabled ||
		authorizationToken.length === 0 ||
		Array.from(authorizationToken).some((character) => /\s/u.test(character))
	) {
		return null;
	}
	return {
		endpoint: worker.endpoint,
		authorizationToken,
		scoreThreshold: worker.scoreThreshold,
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

function seedConfiguration(templatePath: string, destinationPath: string): void {
	// Validate before copying so a corrupted app resource can never become a
	// trusted user configuration file.
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
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "request"])) {
		throw new Error("Client configuration root is invalid.");
	}
	if (value.schemaVersion !== CLIENT_CONFIGURATION_SCHEMA_VERSION) {
		throw new Error("Client configuration schema version is unsupported.");
	}
	if (
		!isRecord(value.request) ||
		!hasRequiredAndAllowedKeys(value.request, [
			"teacherOllama",
			"reflectionModernBert",
			"timelineModernBert",
		], ["activityEventWorker"])
	) {
		throw new Error("Client request configuration is invalid.");
	}
	const teacherOllama = value.request.teacherOllama;
	const reflectionModernBert = value.request.reflectionModernBert;
	const timelineModernBert = value.request.timelineModernBert;
	const activityEventWorker = parseActivityEventWorker(
		value.request.activityEventWorker,
	);
	if (
		!isRecord(teacherOllama) ||
		!hasExactKeys(teacherOllama, ["baseUrl"]) ||
		typeof teacherOllama.baseUrl !== "string" ||
		!isRecord(reflectionModernBert) ||
		!hasExactKeys(reflectionModernBert, ["endpoint"]) ||
		typeof reflectionModernBert.endpoint !== "string" ||
		!isRecord(timelineModernBert) ||
		!hasExactKeys(timelineModernBert, [
			"endpoint",
			"manifestEndpoint",
			"pinnedManifest",
		]) ||
		typeof timelineModernBert.endpoint !== "string" ||
		typeof timelineModernBert.manifestEndpoint !== "string" ||
		typeof timelineModernBert.pinnedManifest !== "string"
	) {
		throw new Error("Client request endpoint configuration is invalid.");
	}
	const endpoint = timelineModernBert.endpoint.trim();
	const manifestEndpoint = timelineModernBert.manifestEndpoint.trim();
	const pinnedManifest = timelineModernBert.pinnedManifest.trim();
	const configuredTimelineValues = [
		endpoint,
		manifestEndpoint,
		pinnedManifest,
	].filter((entry) => entry.length > 0).length;
	if (configuredTimelineValues !== 0 && configuredTimelineValues !== 3) {
		throw new Error("Timeline ModernBERT configuration must be complete.");
	}
	if (configuredTimelineValues === 3) {
		const normalizedEndpoint = normalizeLoopbackHttpUrl(endpoint);
		const normalizedManifestEndpoint =
			normalizeLoopbackHttpUrl(manifestEndpoint);
		if (
			new URL(normalizedEndpoint).origin !==
			new URL(normalizedManifestEndpoint).origin ||
			!isAbsolute(pinnedManifest)
		) {
			throw new Error("Timeline ModernBERT configuration is unsafe.");
		}
		return {
			schemaVersion: CLIENT_CONFIGURATION_SCHEMA_VERSION,
			request: {
				teacherOllama: {
					baseUrl: normalizeLoopbackOllamaBaseUrl(
						teacherOllama.baseUrl,
					),
				},
				reflectionModernBert: {
					endpoint: normalizeLoopbackHttpUrl(
						reflectionModernBert.endpoint.trim(),
					),
				},
				timelineModernBert: {
					endpoint: normalizedEndpoint,
					manifestEndpoint: normalizedManifestEndpoint,
					pinnedManifest,
				},
				activityEventWorker,
			},
		};
	}
	return {
		schemaVersion: CLIENT_CONFIGURATION_SCHEMA_VERSION,
		request: {
			teacherOllama: {
				baseUrl: normalizeLoopbackOllamaBaseUrl(teacherOllama.baseUrl),
			},
			reflectionModernBert: {
				endpoint: normalizeLoopbackHttpUrl(
					reflectionModernBert.endpoint.trim(),
				),
			},
			timelineModernBert: {
				endpoint: "",
				manifestEndpoint: "",
				pinnedManifest: "",
			},
			activityEventWorker,
		},
	};
}

function parseActivityEventWorker(
	value: unknown,
): ClientConfiguration["request"]["activityEventWorker"] {
	if (value === undefined) {
		return structuredClone(DEFAULT_CLIENT_CONFIGURATION.request.activityEventWorker);
	}
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["enabled", "endpoint", "scoreThreshold"]) ||
		typeof value.enabled !== "boolean" ||
		typeof value.endpoint !== "string" ||
		typeof value.scoreThreshold !== "number" ||
		!Number.isFinite(value.scoreThreshold) ||
		value.scoreThreshold <= 0 ||
		value.scoreThreshold > 10_000
	) {
		throw new Error("Activity event worker configuration is invalid.");
	}
	return {
		enabled: value.enabled,
		endpoint: normalizeActivityEventWorkerEndpoint(value.endpoint),
		scoreThreshold: value.scoreThreshold,
	};
}

function normalizeActivityEventWorkerEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Activity event worker endpoint is invalid.");
	}
	if (url.toString() !== ACTIVITY_EVENT_WORKER_ENDPOINT) {
		throw new Error("Activity event worker endpoint is not allowlisted.");
	}
	return ACTIVITY_EVENT_WORKER_ENDPOINT;
}

function normalizeLoopbackOllamaBaseUrl(value: string): string {
	const url = new URL(value.trim());
	if (
		url.protocol !== "http:" ||
		!isLoopbackHostname(url.hostname) ||
		url.username !== "" ||
		url.password !== "" ||
		(url.pathname !== "" && url.pathname !== "/") ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("Teacher Ollama URL must be a loopback HTTP origin.");
	}
	return url.origin;
}

function normalizeLoopbackHttpUrl(value: string): string {
	const url = new URL(value);
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		!isLoopbackHostname(url.hostname) ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("Timeline ModernBERT URLs must be loopback HTTP(S).");
	}
	return url.toString();
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

function hasRequiredAndAllowedKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return (
		required.every((key) => key in value) &&
		actual.every((key) => required.includes(key) || optional.includes(key))
	);
}

function nonEmptyOrUndefined(value: string): string | undefined {
	return value.length > 0 ? value : undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "EEXIST"
	);
}
