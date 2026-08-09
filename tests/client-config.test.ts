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
	REFLECTION_RELAY_COMPLETIONS_PATH,
	WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
	WHALEHALL_DATA_CENTER_STAGING_BASE_URL,
	WHALEHALL_RELAY_BASE_URL,
	WHALEHALL_RELAY_MODEL,
	activityReflectionConfigurationFromConfiguration,
	agentModelConfigurationFromConfiguration,
	type ClientConfiguration,
	DEFAULT_CLIENT_CONFIGURATION,
	loadOrCreateClientConfiguration,
	reflectionModelConfigurationFromConfiguration,
	UNPROVISIONED_REFLECTION_RELAY_KEY,
	UNPROVISIONED_AGENT_RELAY_KEY,
	writeProvisionedClientConfiguration,
} from "../src/bun/client-config";

const directories: string[] = [];
const fixtureReflectionRelayKey = [
	"whref_0123456789abcdef0123456789abcdef",
	"fixture-reflection-secret-0123456789",
].join(".");
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
		`  name: "${WHALEHALL_RELAY_MODEL}"`,
		`  baseurl: "${WHALEHALL_RELAY_BASE_URL}"`,
		`  apikey: "${UNPROVISIONED_REFLECTION_RELAY_KEY}"`,
		"",
		"agent:",
		`  name: "${WHALEHALL_RELAY_MODEL}"`,
		`  baseurl: "${WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL}"`,
		`  apikey: "${UNPROVISIONED_AGENT_RELAY_KEY}"`,
		"",
		"cloudSync:",
		"  enabled: false",
		"  contentEncryptionEnabled: false",
		"  consents:",
		"    activity: off",
		"    browser: off",
		"    presence: off",
		"",
	].join("\n");
}

function provisionedConfiguration(): ClientConfiguration {
	return {
		reflection: {
			name: WHALEHALL_RELAY_MODEL,
			baseurl: WHALEHALL_RELAY_BASE_URL,
			apikey: fixtureReflectionRelayKey,
		},
		agent: {
			name: WHALEHALL_RELAY_MODEL,
			baseurl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
			apikey: fixtureRelayKey,
		},
		cloudSync: structuredClone(DEFAULT_CLIENT_CONFIGURATION.cloudSync),
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

	test("accepts staging only as an explicit DataCenter origin and keeps sync disabled", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(
			path,
			templateConfiguration().replace(
				WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
				WHALEHALL_DATA_CENTER_STAGING_BASE_URL,
			),
		);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.agent.baseurl).toBe(
			WHALEHALL_DATA_CENTER_STAGING_BASE_URL,
		);
		expect(result.configuration.cloudSync.enabled).toBeFalse();
	});

	test("normalizes a pre-split two-role model origin without enabling cloud sync", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		const oldConfiguration = templateConfiguration()
			.replace(
				WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
				WHALEHALL_RELAY_BASE_URL,
			)
			.split("\ncloudSync:")[0];
		writeFileSync(path, `${oldConfiguration}\n`);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.agent.baseurl).toBe(
			WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
		);
		expect(result.configuration.cloudSync).toEqual(
			DEFAULT_CLIENT_CONFIGURATION.cloudSync,
		);
	});

	test("loads literal reflection and personal relay keys into their separate roles", () => {
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
			activityReflectionConfigurationFromConfiguration(result.configuration),
		).toEqual({
			modelName: WHALEHALL_RELAY_MODEL,
			relayBaseUrl: WHALEHALL_RELAY_BASE_URL,
			reflectionKey: fixtureReflectionRelayKey,
			scoreThreshold: 1,
		});
		expectOwnerOnlyMode(path);
	});

	test("rejects environment references, swapped endpoints, unknown fields, and non-approved models", () => {
		const sources = [
			templateConfiguration().replace(
				UNPROVISIONED_REFLECTION_RELAY_KEY,
				"$" + "{WHALEHALL_REFLECTION_RELAY_KEY}",
			),
			templateConfiguration().replace(
				WHALEHALL_RELAY_BASE_URL,
				`${WHALEHALL_RELAY_BASE_URL}${REFLECTION_RELAY_COMPLETIONS_PATH}`,
			),
			templateConfiguration().replace(
				WHALEHALL_RELAY_MODEL,
				"qwen3:other",
			),
			templateConfiguration().replace(
				`agent:\n  name: "${WHALEHALL_RELAY_MODEL}"`,
				'agent:\n  name: "qwen3:other"',
			),
			templateConfiguration().replace(
				UNPROVISIONED_AGENT_RELAY_KEY,
				"a".repeat(1_025),
			),
			templateConfiguration().replace(
				UNPROVISIONED_AGENT_RELAY_KEY,
				"too-short",
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
			activityReflectionConfigurationFromConfiguration(result.configuration),
		).toBeNull();
	});
});
