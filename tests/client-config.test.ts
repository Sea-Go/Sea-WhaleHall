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
	activityReflectionConfigurationFromConfiguration,
	agentModelConfigurationFromConfiguration,
	DEFAULT_CLIENT_CONFIGURATION,
	loadOrCreateClientConfiguration,
	planningModelConfigurationFromConfiguration,
	WHALEHALL_AGENT_MODEL,
	WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
	WHALEHALL_PLANNING_MODEL,
	WHALEHALL_REFLECTION_MODEL,
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

function currentConfiguration(): string {
	return [
		"reflection:",
		`  name: "${WHALEHALL_REFLECTION_MODEL}"`,
		"",
		"planning:",
		`  name: "${WHALEHALL_PLANNING_MODEL}"`,
		"",
		"agent:",
		`  name: "${WHALEHALL_AGENT_MODEL}"`,
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

function legacyKeyConfiguration(): string {
	return [
		"reflection:",
		'  name: "qwen3:1.7b"',
		'  baseurl: "https://retired-model.example.test"',
		'  apikey: "retired-reflection-secret"',
		"",
		"agent:",
		'  name: "qwen3:1.7b"',
		'  baseurl: "https://retired-staging.example.test"',
		'  apikey: "retired-personal-relay-secret"',
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

function writeTemplate(
	directory: string,
	source = currentConfiguration(),
): string {
	const path = join(directory, "template.yaml");
	writeFileSync(path, source, { mode: 0o600 });
	return path;
}

function expectOwnerOnlyMode(path: string): void {
	if (process.platform !== "win32") {
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
	}
}

describe("WhaleHall client config.yaml", () => {
	test("seeds a private credential-free config and enables bearer-backed roles", () => {
		const directory = temporaryDirectory();
		const templatePath = writeTemplate(directory);
		const userDataDirectory = join(directory, "user-data");

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: templatePath,
		});

		expect(result.status).toBe("seeded");
		expect(result.cloudSyncConsentBlockedByRetiredOrigin).toBeFalse();
		expect(result.path).toBe(join(userDataDirectory, "config.yaml"));
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(readFileSync(result.path, "utf8")).toBe(currentConfiguration());
		expect(readFileSync(result.path, "utf8")).not.toContain("apikey");
		expect(readFileSync(result.path, "utf8")).not.toContain("baseurl");
		expect(
			agentModelConfigurationFromConfiguration(result.configuration),
		).toEqual({
			name: WHALEHALL_AGENT_MODEL,
			baseurl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
		});
		expect(
			planningModelConfigurationFromConfiguration(result.configuration),
		).toEqual({
			name: WHALEHALL_PLANNING_MODEL,
			baseurl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
		});
		expect(
			activityReflectionConfigurationFromConfiguration(result.configuration),
		).toEqual({ modelName: WHALEHALL_REFLECTION_MODEL, scoreThreshold: 1 });
		expectOwnerOnlyMode(result.path);
	});

	test("parses and discards legacy endpoints and keys without rewriting the owner file", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		const source = legacyKeyConfiguration();
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(path, source);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.cloudSyncConsentBlockedByRetiredOrigin).toBeTrue();
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(JSON.stringify(result.configuration)).not.toContain("apikey");
		expect(JSON.stringify(result.configuration)).not.toContain("baseurl");
		expect(
			agentModelConfigurationFromConfiguration(result.configuration).baseurl,
		).toBe(WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL);
		expect(readFileSync(path, "utf8")).toBe(source);
	});
});
