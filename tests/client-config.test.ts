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
	WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
	WHALEHALL_RELAY_MODEL,
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
		`  name: "${WHALEHALL_RELAY_MODEL}"`,
		"",
		"agent:",
		`  name: "${WHALEHALL_RELAY_MODEL}"`,
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
		`  name: "${WHALEHALL_RELAY_MODEL}"`,
		'  baseurl: "https://retired-model.example.test"',
		'  apikey: "retired-reflection-secret"',
		"",
		"agent:",
		`  name: "${WHALEHALL_RELAY_MODEL}"`,
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
		expect(result.path).toBe(join(userDataDirectory, "config.yaml"));
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(readFileSync(result.path, "utf8")).toBe(currentConfiguration());
		expect(readFileSync(result.path, "utf8")).not.toContain("apikey");
		expect(readFileSync(result.path, "utf8")).not.toContain("baseurl");
		expect(
			agentModelConfigurationFromConfiguration(result.configuration),
		).toEqual({
			name: WHALEHALL_RELAY_MODEL,
			baseurl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
		});
		expect(
			activityReflectionConfigurationFromConfiguration(result.configuration),
		).toEqual({ modelName: WHALEHALL_RELAY_MODEL, scoreThreshold: 1 });
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
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(JSON.stringify(result.configuration)).not.toContain("apikey");
		expect(JSON.stringify(result.configuration)).not.toContain("baseurl");
		expect(
			agentModelConfigurationFromConfiguration(result.configuration).baseurl,
		).toBe(WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL);
		expect(readFileSync(path, "utf8")).toBe(source);
	});

	test("loads a pre-cloudSync two-role file with safe defaults", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		const source = [
			"reflection:",
			`  name: "${WHALEHALL_RELAY_MODEL}"`,
			"agent:",
			`  name: "${WHALEHALL_RELAY_MODEL}"`,
			"",
		].join("\n");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(path, source);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.cloudSync).toEqual(
			DEFAULT_CLIENT_CONFIGURATION.cloudSync,
		);
		expect(readFileSync(path, "utf8")).toBe(source);
	});

	test("keeps legacy v1 files untouched while using safe bearer defaults", () => {
		const directory = temporaryDirectory();
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		const source = [
			"schemaVersion: whalehall-client-config.v1",
			"request:",
			"  teacherOllama:",
			'    baseUrl: "http://127.0.0.1:11434"',
			"",
		].join("\n");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(path, source);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: writeTemplate(directory),
		});

		expect(result.status).toBe("legacy");
		expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		expect(
			agentModelConfigurationFromConfiguration(result.configuration),
		).not.toBeNull();
		expect(readFileSync(path, "utf8")).toBe(source);
	});

	test("leaves invalid files untouched and applies code-owned defaults in memory", () => {
		for (const source of [
			currentConfiguration().replace(WHALEHALL_RELAY_MODEL, "qwen3:other"),
			`${currentConfiguration()}unexpected: true\n`,
			currentConfiguration().replace('name: "qwen3:1.7b"', "name: 42"),
			legacyKeyConfiguration().replace(
				'apikey: "retired-personal-relay-secret"',
				"apikey:\n    nested: invalid",
			),
		]) {
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

	test("keeps both checked-in templates credential and endpoint free", () => {
		for (const name of ["config.template.yaml", "config.example.yaml"]) {
			const source = readFileSync(join(import.meta.dir, "..", name), "utf8");
			expect(source).not.toContain("apikey");
			expect(source).not.toContain("baseurl");
			const directory = temporaryDirectory();
			const result = loadOrCreateClientConfiguration({
				userDataDirectory: join(directory, "user-data"),
				bundledTemplatePath: writeTemplate(directory, source),
			});
			expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
		}
	});
});
