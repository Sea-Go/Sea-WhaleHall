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
	ACTIVITY_EVENT_WORKER_ENDPOINT,
	ACTIVITY_EVENT_WORKER_MODEL,
	AGENT_RELAY_BASE_URL,
	activityEventWorkerConfigurationFromConfiguration,
	agentModelConfigurationFromConfiguration,
	type ClientConfiguration,
	DEFAULT_CLIENT_CONFIGURATION,
	loadOrCreateClientConfiguration,
	reflectionModelConfigurationFromConfiguration,
	UNPROVISIONED_ACTIVITY_WORKER_KEY,
	UNPROVISIONED_AGENT_RELAY_KEY,
	writeProvisionedClientConfiguration,
} from "../src/bun/client-config";

const directories: string[] = [];
const fixtureActivityWorkerKey = ["fixture", "activity", "worker"].join("-");
const fixtureRelayKey = ["fixture", "personal", "relay"].join("-");

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

function templateConfiguration(): string {
	return [
		"reflection:",
		`  name: "${ACTIVITY_EVENT_WORKER_MODEL}"`,
		`  baseurl: "${ACTIVITY_EVENT_WORKER_ENDPOINT}"`,
		`  apikey: "${UNPROVISIONED_ACTIVITY_WORKER_KEY}"`,
		"",
		"agent:",
		`  name: "${ACTIVITY_EVENT_WORKER_MODEL}"`,
		`  baseurl: "${AGENT_RELAY_BASE_URL}"`,
		`  apikey: "${UNPROVISIONED_AGENT_RELAY_KEY}"`,
		"",
	].join("\n");
}

function provisionedConfiguration(): ClientConfiguration {
	return {
		reflection: {
			name: ACTIVITY_EVENT_WORKER_MODEL,
			baseurl: ACTIVITY_EVENT_WORKER_ENDPOINT,
			apikey: fixtureActivityWorkerKey,
		},
		agent: {
			name: ACTIVITY_EVENT_WORKER_MODEL,
			baseurl: AGENT_RELAY_BASE_URL,
			apikey: fixtureRelayKey,
		},
	};
}

function writeTemplate(
	directory: string,
	source = templateConfiguration(),
): string {
	const path = join(directory, "template.yaml");
	writeFileSync(path, source, { mode: 0o600 });
	return path;
}

function expectOwnerOnlyMode(path: string): void {
	if (process.platform !== "win32")
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
}

describe("WhaleHall client config.yaml", () => {
	test("seeds a private two-role placeholder copy without enabling either remote path", () => {
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
		expectOwnerOnlyMode(result.path);
		expect(
			reflectionModelConfigurationFromConfiguration(result.configuration),
		).toBeNull();
		expect(
			agentModelConfigurationFromConfiguration(result.configuration),
		).toBeNull();
	});

	test("loads literal Worker and personal relay keys into their separate roles", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeProvisionedClientConfiguration({
			path,
			configuration: provisionedConfiguration(),
		});

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration).toEqual(provisionedConfiguration());
		expect(
			reflectionModelConfigurationFromConfiguration(result.configuration),
		).toEqual(provisionedConfiguration().reflection);
		expect(
			agentModelConfigurationFromConfiguration(result.configuration),
		).toEqual(provisionedConfiguration().agent);
		expect(
			activityEventWorkerConfigurationFromConfiguration(result.configuration),
		).toEqual({
			modelName: ACTIVITY_EVENT_WORKER_MODEL,
			endpoint: ACTIVITY_EVENT_WORKER_ENDPOINT,
			authorizationToken: fixtureActivityWorkerKey,
			scoreThreshold: 1,
		});
		expectOwnerOnlyMode(path);
	});

	test("rejects environment references, swapped endpoints, unknown fields, and non-approved models", () => {
		const sources = [
			templateConfiguration().replace(
				UNPROVISIONED_ACTIVITY_WORKER_KEY,
				"$" + "{WHALEHALL_ACTIVITY_WORKER_TOKEN}",
			),
			templateConfiguration().replace(
				AGENT_RELAY_BASE_URL,
				ACTIVITY_EVENT_WORKER_ENDPOINT,
			),
			templateConfiguration().replace(
				ACTIVITY_EVENT_WORKER_MODEL,
				"qwen3:other",
			),
			templateConfiguration().replace(
				`agent:\n  name: "${ACTIVITY_EVENT_WORKER_MODEL}"`,
				'agent:\n  name: "qwen3:other"',
			),
			templateConfiguration().replace(
				UNPROVISIONED_AGENT_RELAY_KEY,
				"a".repeat(1_025),
			),
			`${templateConfiguration()}unexpected: true\n`,
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

	test("leaves legacy configuration untouched and disables remote work until provisioned", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		const legacy = [
			"schemaVersion: whalehall-client-config.v1",
			"request:",
			"  teacherOllama:",
			'    baseUrl: "http://127.0.0.1:11434"',
			"",
		].join("\n");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(path, legacy);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("legacy-unprovisioned");
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(readFileSync(path, "utf8")).toBe(legacy);
	});

	test("keeps checked-in placeholders parseable without treating them as credentials", () => {
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
		expect(
			activityEventWorkerConfigurationFromConfiguration(result.configuration),
		).toBeNull();
	});
});
