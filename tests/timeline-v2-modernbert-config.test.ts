import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MODERNBERT_ACTIVITY_LABELS,
	MODERNBERT_EVIDENCE_PROJECTOR_VERSION,
	MODERNBERT_GOAL_RELEVANCE_LABELS,
	MODERNBERT_INPUT_SCHEMA_VERSION,
	MODERNBERT_MANIFEST_SCHEMA_VERSION,
	MODERNBERT_MODEL_INPUT_FORMAT,
	MODERNBERT_REQUEST_SCHEMA_VERSION,
	MODERNBERT_RESPONSE_SCHEMA_VERSION,
	MODERNBERT_RUNTIME_SCHEMA_VERSION,
	type ModernBertArtifactManifestV1,
} from "../src/agent/timeline-v2";
import { loadTimelineModernBertConfiguration } from "../src/bun/timeline-modernbert-config";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(
		join(tmpdir(), "whalehall-modernbert-config-"),
	);
	directories.push(directory);
	return directory;
}

function manifest(): ModernBertArtifactManifestV1 {
	const artifactSha256 = "a".repeat(64);
	return {
		schemaVersion: MODERNBERT_MANIFEST_SCHEMA_VERSION,
		artifactId: `modernbert_episode_${artifactSha256}`,
		artifactSha256,
		runtime: {
			schemaVersion: MODERNBERT_RUNTIME_SCHEMA_VERSION,
			modelVersion: "modernbert-config-test",
			modelFamily: "ModernBERT",
			maximumTokens: 8_192,
			tokenizerSha256: "b".repeat(64),
			inputFormat: MODERNBERT_MODEL_INPUT_FORMAT,
			projectorVersion: MODERNBERT_EVIDENCE_PROJECTOR_VERSION,
			architecture: {
				activityClasses: 12,
				relevanceClasses: 4,
				embeddingDimensions: 256,
				heads: [
					"boundary",
					"activity",
					"relevance",
					"evidence",
					"summary",
					"embedding",
				],
			},
			taxonomy: {
				version: "activity-taxonomy.v2",
				activities: [...MODERNBERT_ACTIVITY_LABELS],
				goalRelevance: [
					...MODERNBERT_GOAL_RELEVANCE_LABELS,
				],
			},
			oodScoring:
				"calibrated-energy-plus-cluster-distance.v1",
			calibrationVersion: "temperature-scaling.v1",
		},
		requestSchemaVersion: MODERNBERT_REQUEST_SCHEMA_VERSION,
		inputSchemaVersion: MODERNBERT_INPUT_SCHEMA_VERSION,
		responseSchemaVersion: MODERNBERT_RESPONSE_SCHEMA_VERSION,
		maximumFacts: 128,
		maximumInputBytes: 256 * 1024,
	};
}

function completeEnvironment(path: string): Record<string, string> {
	return {
		WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT:
			"http://127.0.0.1:8766/v2/episodes:classify",
		WHALEHALL_TIMELINE_MODERNBERT_MANIFEST_ENDPOINT:
			"http://127.0.0.1:8766/v2/manifest",
		WHALEHALL_TIMELINE_MODERNBERT_PINNED_MANIFEST: path,
	};
}

describe("Timeline v2 ModernBERT Bun configuration", () => {
	test("stays explicitly disabled when configuration is absent", () => {
		expect(loadTimelineModernBertConfiguration({})).toEqual({
			modernBert: { enabled: false },
			code: "disabled",
		});
	});

	test("fails closed for partial, relative, symlink, and invalid manifests", () => {
		expect(
			loadTimelineModernBertConfiguration({
				WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT:
					"http://127.0.0.1:8766/v2/episodes:classify",
			}),
		).toEqual({
			modernBert: { enabled: false },
			code: "invalid_config",
		});
		expect(
			loadTimelineModernBertConfiguration(
				completeEnvironment("manifest.json"),
			),
		).toMatchObject({ code: "invalid_config" });

		const directory = temporaryDirectory();
		const targetDirectory = join(directory, "manifest-target");
		const linkedDirectory = join(directory, "manifest-link");
		mkdirSync(targetDirectory);
		const target = join(targetDirectory, "manifest.json");
		const link = join(linkedDirectory, "manifest.json");
		writeFileSync(target, JSON.stringify(manifest()));
		symlinkSync(
			targetDirectory,
			linkedDirectory,
			process.platform === "win32" ? "junction" : "dir",
		);
		expect(
			loadTimelineModernBertConfiguration(
				completeEnvironment(link),
			),
		).toMatchObject({ code: "invalid_config" });

		writeFileSync(target, '{"schemaVersion":"wrong"}');
		expect(
			loadTimelineModernBertConfiguration(
				completeEnvironment(target),
			),
		).toMatchObject({ code: "invalid_config" });
	});

	test("propagates YAML-owned remote origins while keeping the token environment-only", () => {
		const directory = temporaryDirectory();
		const path = join(directory, "manifest.json");
		writeFileSync(path, JSON.stringify(manifest()));
		const result = loadTimelineModernBertConfiguration({
			...completeEnvironment(path),
			WHALEHALL_TIMELINE_MODERNBERT_TOKEN: "local-token",
			WHALEHALL_TIMELINE_MODERNBERT_ALLOWED_ORIGINS:
				"https://model.example",
			WHALEHALL_TIMELINE_MODERNBERT_ALLOW_INSECURE_REMOTE: "1",
		});
		expect(result.code).toBe("enabled");
		expect(result.modernBert).toMatchObject({
			enabled: true,
			endpoint:
				"http://127.0.0.1:8766/v2/episodes:classify",
			manifestEndpoint:
				"http://127.0.0.1:8766/v2/manifest",
			expectedArtifact: manifest(),
			authorizationToken: "local-token",
			allowedRemoteOrigins: ["https://model.example"],
		});
		expect(result.modernBert).not.toHaveProperty(
			"allowInsecureRemote",
		);
	});

	test("enables a complete remote configuration only with its exact HTTPS origin", () => {
		const directory = temporaryDirectory();
		const path = join(directory, "manifest.json");
		writeFileSync(path, JSON.stringify(manifest()));
		const remoteEnvironment = {
			WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT:
				"https://models.example.test/v2/episodes:classify",
			WHALEHALL_TIMELINE_MODERNBERT_MANIFEST_ENDPOINT:
				"https://models.example.test/v2/manifest",
			WHALEHALL_TIMELINE_MODERNBERT_PINNED_MANIFEST: path,
		};

		expect(loadTimelineModernBertConfiguration(remoteEnvironment)).toEqual({
			modernBert: { enabled: false },
			code: "invalid_config",
		});
		expect(
			loadTimelineModernBertConfiguration({
				...remoteEnvironment,
				WHALEHALL_TIMELINE_MODERNBERT_ALLOWED_ORIGINS:
					"https://models.example.test",
			}),
		).toMatchObject({
			code: "enabled",
			modernBert: {
				enabled: true,
				endpoint: "https://models.example.test/v2/episodes:classify",
				manifestEndpoint: "https://models.example.test/v2/manifest",
				allowedRemoteOrigins: ["https://models.example.test"],
			},
		});
	});
});
