import { afterEach, describe, expect, test } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE,
	ACTIVITY_EVENT_WORKER_ENDPOINT,
	ACTIVITY_EVENT_WORKER_MODEL,
	DEFAULT_CLIENT_CONFIGURATION,
	activityEventWorkerConfigurationFromConfiguration,
	agentModelConfigurationFromConfiguration,
	datacenterRuntimeConfigurationFromConfiguration,
	loadOrCreateClientConfiguration,
	reflectionModelConfigurationFromConfiguration,
} from "../src/bun/client-config";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-client-config-"));
	directories.push(directory);
	return directory;
}

function validConfiguration(overrides = ""): string {
	return [
		"reflection:",
		'  name: "' + ACTIVITY_EVENT_WORKER_MODEL + '"',
		'  baseurl: "' + ACTIVITY_EVENT_WORKER_ENDPOINT + '"',
		'  apikey: "' + ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE + '"',
		"agent:",
		'  name: "' + ACTIVITY_EVENT_WORKER_MODEL + '"',
		'  baseurl: "' + ACTIVITY_EVENT_WORKER_ENDPOINT + '"',
		'  apikey: "' + ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE + '"',
		overrides,
	].join("\n");
}

function writeTemplate(directory: string, source = validConfiguration()): string {
	const path = join(directory, "template.yaml");
	writeFileSync(path, source, { mode: 0o600 });
	return path;
}

describe("WhaleHall client config.yaml", () => {
	test("seeds a private editable two-model user copy from the bundled template", () => {
		const directory = temporaryDirectory();
		const templatePath = writeTemplate(directory);
		const userDataDirectory = join(directory, "user-data");

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: templatePath,
		});

		expect(result.status).toBe("seeded");
		expect(result.path).toBe(join(userDataDirectory, "config.yaml"));
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(readFileSync(result.path, "utf8")).toBe(
			readFileSync(templatePath, "utf8"),
		);
		expect(lstatSync(result.path).mode & 0o777).toBe(0o600);
	});

	test("loads both model roles with the owner-provided endpoint and literal apikey", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(
			path,
			validConfiguration()
				.replaceAll(ACTIVITY_EVENT_WORKER_MODEL, "qwen3:custom")
				.replaceAll(ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE, "literal-key"),
		);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.reflection).toEqual({
			name: "qwen3:custom",
			baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
			apikey: "literal-key",
		});
		expect(result.configuration.agent).toEqual(result.configuration.reflection);
		expect(
			reflectionModelConfigurationFromConfiguration(result.configuration, {}),
		).toEqual({
			name: "qwen3:custom",
			baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
			apikey: "literal-key",
		});
	});

	test("resolves the constrained apikey environment reference for both roles", () => {
		const configuration = structuredClone(DEFAULT_CLIENT_CONFIGURATION);
		const environment = { WHALEHALL_ACTIVITY_WORKER_TOKEN: "worker-key" };

		expect(
			reflectionModelConfigurationFromConfiguration(configuration, environment),
		).toEqual({
			name: ACTIVITY_EVENT_WORKER_MODEL,
			baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
			apikey: "worker-key",
		});
		expect(
			agentModelConfigurationFromConfiguration(configuration, environment),
		).toEqual({
			name: ACTIVITY_EVENT_WORKER_MODEL,
			baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
			apikey: "worker-key",
		});
		expect(
			activityEventWorkerConfigurationFromConfiguration(
				configuration,
				environment,
			),
		).toEqual({
			modelName: ACTIVITY_EVENT_WORKER_MODEL,
			endpoint: ACTIVITY_EVENT_WORKER_ENDPOINT,
			authorizationToken: "worker-key",
			scoreThreshold: 1,
		});
		expect(
			activityEventWorkerConfigurationFromConfiguration(configuration, {}),
		).toBeNull();
	});

	test("fails closed on unknown fields, insecure URLs, and malformed key references", () => {
		const sources = [
			validConfiguration("unexpected: true"),
			validConfiguration().replace(
				ACTIVITY_EVENT_WORKER_ENDPOINT,
				"http://model.sea-ridethewindbreakthewaves.xyz/v1/activity/analyze",
			),
			validConfiguration().replace(
				ACTIVITY_EVENT_WORKER_ENDPOINT,
				"https://127.0.0.1/v1/activity/analyze",
			),
			validConfiguration().replace(
				ACTIVITY_EVENT_WORKER_API_KEY_REFERENCE,
				"$" + "{invalid-key}",
			),
		];
		for (const source of sources) {
			const directory = temporaryDirectory();
			const userDataDirectory = join(directory, "user-data");
			const path = join(userDataDirectory, "config.yaml");
			mkdirSync(userDataDirectory, { mode: 0o700 });
			writeFileSync(path, source);

			const result = loadOrCreateClientConfiguration({
				userDataDirectory,
				bundledTemplatePath: writeTemplate(directory),
			});

			expect(result.status).toBe("invalid");
			expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
			expect(readFileSync(path, "utf8")).toBe(source);
		}
	});

	test("migrates the prior activity Worker shape without overwriting the user file", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		const legacy = [
			"schemaVersion: whalehall-client-config.v1",
			"request:",
			"  activityEventWorker:",
			"    enabled: true",
			'    endpoint: "' + ACTIVITY_EVENT_WORKER_ENDPOINT + '"',
			"    scoreThreshold: 1",
			"",
		].join("\n");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(path, legacy);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(readFileSync(path, "utf8")).toBe(legacy);
	});

	test("keeps the checked-in home-cloud example parseable", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(
			path,
			readFileSync(join(import.meta.dir, "..", "config.example.yaml"), "utf8"),
		);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
	});
});

describe("WhaleHall DataCenter configuration", () => {
	test("defaults the datacenter block when absent", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(path, validConfiguration());

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.datacenter.baseUrl).toBe(
			"http://175.24.130.226:23012",
		);
		expect(result.configuration.datacenter.sync.enabled).toBe(false);
		expect(result.configuration.datacenter.sync.intervalMs).toBe(30_000);
	});

	test("parses an explicit datacenter block without a trailing slash", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(
			path,
			validConfiguration(
				[
					"datacenter:",
					'  baseUrl: "http://127.0.0.1:8080/"',
					"  sync:",
					"    enabled: true",
					"    intervalMs: 60000",
				].join("\n"),
			),
		);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.datacenter.baseUrl).toBe(
			"http://127.0.0.1:8080",
		);
		expect(result.configuration.datacenter.sync.enabled).toBe(true);
		expect(result.configuration.datacenter.sync.intervalMs).toBe(60_000);
	});

	test("falls back to defaults for an invalid datacenter block", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(
			path,
			validConfiguration(
				["datacenter:", '  baseUrl: "ftp://bad"', "  sync:"].join("\n"),
			),
		);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.datacenter.baseUrl).toBe(
			"http://175.24.130.226:23012",
		);
	});

	test("resolves a WHALEHALL_DATACENTER_URL environment override", () => {
		const configuration = DEFAULT_CLIENT_CONFIGURATION;
		const runtime = datacenterRuntimeConfigurationFromConfiguration(
			configuration,
			{ WHALEHALL_DATACENTER_URL: "https://dc.example.invalid:8443" },
		);
		expect(runtime.baseUrl).toBe("https://dc.example.invalid:8443");
		expect(runtime.syncEnabled).toBe(false);
		expect(runtime.syncIntervalMs).toBe(30_000);
	});

	test("ignores an invalid environment override", () => {
		const configuration = DEFAULT_CLIENT_CONFIGURATION;
		const runtime = datacenterRuntimeConfigurationFromConfiguration(
			configuration,
			{ WHALEHALL_DATACENTER_URL: "not a url" },
		);
		expect(runtime.baseUrl).toBe("http://175.24.130.226:23012");
	});
});
