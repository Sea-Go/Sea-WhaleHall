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
	DEFAULT_CLIENT_CONFIGURATION,
	loadOrCreateClientConfiguration,
	timelineModernBertEnvironmentFromConfiguration,
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
	return `schemaVersion: whalehall-client-config.v1
request:
  teacherOllama:
    baseUrl: "http://127.0.0.1:11434"
  reflectionModernBert:
    endpoint: "http://127.0.0.1:8765/v1/reflections:infer"
  timelineModernBert:
    endpoint: ""
    manifestEndpoint: ""
    pinnedManifest: ""
${overrides}`;
}

function writeTemplate(directory: string, source = validConfiguration()): string {
	const path = join(directory, "template.yaml");
	writeFileSync(path, source, { mode: 0o600 });
	return path;
}

function expectPrivateFile(path: string): void {
	const metadata = lstatSync(path);
	expect(metadata.isFile()).toBeTrue();
	if (process.platform !== "win32") {
		expect(metadata.mode & 0o777).toBe(0o600);
	}
}

describe("WhaleHall client config.yaml", () => {
	test("seeds a private editable user copy from the bundled template", () => {
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
		expectPrivateFile(result.path);
	});

	test("loads the user copy without overwriting a configured local endpoint", () => {
		const directory = temporaryDirectory();
		const templatePath = writeTemplate(directory);
		const userDataDirectory = join(directory, "user-data");
		const path = join(userDataDirectory, "config.yaml");
		mkdirSync(userDataDirectory, { mode: 0o700 });
		writeFileSync(
			path,
			`schemaVersion: whalehall-client-config.v1
request:
  teacherOllama:
    baseUrl: "http://localhost:11437"
  reflectionModernBert:
    endpoint: "http://127.0.0.1:8765/v1/reflections:infer"
  timelineModernBert:
    endpoint: "http://127.0.0.1:8766/v2/episodes:classify"
    manifestEndpoint: "http://127.0.0.1:8766/v2/manifest"
    pinnedManifest: "/private/tmp/modernbert-manifest.json"
`,
		);

		const result = loadOrCreateClientConfiguration({
			userDataDirectory,
			bundledTemplatePath: templatePath,
		});

		expect(result.status).toBe("loaded");
		expect(result.configuration.request.teacherOllama.baseUrl).toBe(
			"http://localhost:11437",
		);
		expect(result.configuration.request.timelineModernBert).toEqual({
			endpoint: "http://127.0.0.1:8766/v2/episodes:classify",
			manifestEndpoint: "http://127.0.0.1:8766/v2/manifest",
			pinnedManifest: "/private/tmp/modernbert-manifest.json",
		});
	});

	test("fails closed on remote, partial, or unknown endpoint settings", () => {
		const sources = [
			validConfiguration().replace(
				"http://127.0.0.1:11434",
				"https://models.example.test",
			),
			validConfiguration().replace(
				"http://127.0.0.1:8765/v1/reflections:infer",
				"https://models.example.test/v1/reflections:infer",
			),
			validConfiguration().replace(
				'endpoint: ""',
				'endpoint: "http://127.0.0.1:8766/v2/episodes:classify"',
			),
			validConfiguration("unexpectedRemote: https://models.example.test\n"),
		];
		for (const source of sources) {
			const directory = temporaryDirectory();
			const templatePath = writeTemplate(directory);
			const userDataDirectory = join(directory, "user-data");
			const path = join(userDataDirectory, "config.yaml");
			mkdirSync(userDataDirectory, { mode: 0o700 });
			writeFileSync(path, source);

			const result = loadOrCreateClientConfiguration({
				userDataDirectory,
				bundledTemplatePath: templatePath,
			});

			expect(result.status).toBe("invalid");
			expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
			expect(readFileSync(path, "utf8")).toBe(source);
		}
	});

	test("uses config.yaml as the sole Timeline endpoint source and keeps tokens out of it", () => {
		const configuration = {
			...DEFAULT_CLIENT_CONFIGURATION,
			request: {
				...DEFAULT_CLIENT_CONFIGURATION.request,
				timelineModernBert: {
					endpoint:
						"http://127.0.0.1:8766/v2/episodes:classify",
					manifestEndpoint: "http://127.0.0.1:8766/v2/manifest",
					pinnedManifest: "/private/tmp/modernbert-manifest.json",
				},
			},
		};

		expect(
			timelineModernBertEnvironmentFromConfiguration(configuration, {
				WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT:
					"https://ignored.example.test/v2/episodes:classify",
				WHALEHALL_TIMELINE_MODERNBERT_TOKEN: "environment-only-token",
			}),
		).toEqual({
			WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT:
				"http://127.0.0.1:8766/v2/episodes:classify",
			WHALEHALL_TIMELINE_MODERNBERT_MANIFEST_ENDPOINT:
				"http://127.0.0.1:8766/v2/manifest",
			WHALEHALL_TIMELINE_MODERNBERT_PINNED_MANIFEST:
				"/private/tmp/modernbert-manifest.json",
			WHALEHALL_TIMELINE_MODERNBERT_TOKEN: "environment-only-token",
		});
	});

	test("rejects every removed activity worker or unknown public endpoint setting", () => {
		const sources = [
			`${validConfiguration()}  activityEventWorker:
    enabled: true
    endpoint: "https://model.sea-ridethewindbreakthewaves.xyz/v1/activity/analyze"
    scoreThreshold: 1
`,
			`${validConfiguration()}  activityEventWorker:
    enabled: false
    endpoint: "http://127.0.0.1:8767/v1/activity/analyze"
    scoreThreshold: 1
`,
			validConfiguration(
				"publicActivityAnalysis: https://other.example.test/v1/activity/analyze\n",
			),
		];

		for (const source of sources) {
			const directory = temporaryDirectory();
			const templatePath = writeTemplate(directory);
			const userDataDirectory = join(directory, "user-data");
			const path = join(userDataDirectory, "config.yaml");
			mkdirSync(userDataDirectory, { mode: 0o700 });
			writeFileSync(path, source);

			const result = loadOrCreateClientConfiguration({
				userDataDirectory,
				bundledTemplatePath: templatePath,
			});

			expect(result.status).toBe("invalid");
			expect(result.configuration).toEqual(DEFAULT_CLIENT_CONFIGURATION);
			expect(readFileSync(path, "utf8")).toBe(source);
		}
	});
});
