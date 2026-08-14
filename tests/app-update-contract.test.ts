import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	APP_UPDATE_MANIFEST_SCHEMA_VERSION,
	type AppUpdateManifest,
	AppUpdateValidationError,
	appUpdateReleaseSummary,
	appUpdateSignatureFilename,
	canonicalizeAppUpdateManifest,
	compareStableSemver,
	parseAppUpdateManifest,
	parseAppUpdateSignature,
} from "../src/shared/app-update";

function manifest(
	override: Partial<AppUpdateManifest> = {},
): AppUpdateManifest {
	return {
		schemaVersion: APP_UPDATE_MANIFEST_SCHEMA_VERSION,
		appId: "com.seago.whalehall",
		channel: "stable",
		platform: "macos",
		arch: "arm64",
		version: "1.2.3",
		buildHash: "abc123",
		minimumSupportedVersion: "1.1.0",
		publishedAt: "2026-08-13T08:00:00.000Z",
		releaseNotes: "安全更新",
		assets: [
			{
				kind: "full",
				filename: "stable-macos-arm64-WhaleHall.app.tar.zst",
				url: "https://github.com/Sea-Go/Sea-WhaleHall/releases/download/v1.2.3/stable-macos-arm64-WhaleHall.app.tar.zst",
				size: 1024,
				sha256: "a".repeat(64),
			},
		],
		...override,
	};
}

describe("app update manifest contract", () => {
	test("uses packaged runtime metadata as the single client version source", () => {
		const composition = readFileSync(
			join(import.meta.dir, "..", "src", "bun", "index.ts"),
			"utf8",
		);
		expect(composition).toContain(
			"const runtimeVersion = await Updater.localInfo.version();",
		);
		expect(composition).toContain(
			'client: { name: "whalehall-desktop", version: runtimeVersion }',
		);
		expect(composition).not.toContain(
			'client: { name: "whalehall-desktop", version: "0.1.0" }',
		);
	});
	test("accepts the exact stable full-archive contract", () => {
		expect(parseAppUpdateManifest(manifest())).toEqual(manifest());
	});

	test("canonicalizes recursively with sorted keys and no whitespace", () => {
		const canonical = canonicalizeAppUpdateManifest(manifest());
		expect(
			canonical.startsWith('{"appId":"com.seago.whalehall","arch":"arm64"'),
		).toBeTrue();
		expect(canonical).not.toContain("\n");
		expect(canonical).not.toContain(": ");
		expect(canonical.indexOf('"filename"')).toBeLessThan(
			canonical.indexOf('"kind":"full"'),
		);
	});

	test("uses a strict stable semver and rejects rollback floor contradictions", () => {
		expect(compareStableSemver("1.10.0", "1.9.99")).toBe(1);
		expect(() =>
			parseAppUpdateManifest(manifest({ version: "1.2.3-beta.1" })),
		).toThrow(AppUpdateValidationError);
		expect(() =>
			parseAppUpdateManifest(manifest({ minimumSupportedVersion: "2.0.0" })),
		).toThrow(AppUpdateValidationError);
	});

	test("derives mandatory policy only from the signed version floor", () => {
		expect(appUpdateReleaseSummary(manifest(), "1.0.9").mandatory).toBeTrue();
		expect(appUpdateReleaseSummary(manifest(), "1.1.0").mandatory).toBeFalse();
	});

	test("rejects unknown fields, alternate hosts, and non-full archives", () => {
		expect(() =>
			parseAppUpdateManifest({ ...manifest(), forceUpdate: true }),
		).toThrow(AppUpdateValidationError);
		const badUrl = manifest();
		badUrl.assets[0].url =
			"https://example.com/Sea-Go/Sea-WhaleHall/releases/download/v1.2.3/stable-macos-arm64-WhaleHall.app.tar.zst";
		expect(() => parseAppUpdateManifest(badUrl)).toThrow(
			AppUpdateValidationError,
		);
		expect(() =>
			parseAppUpdateManifest({
				...manifest(),
				assets: [{ ...manifest().assets[0], kind: "patch" }],
			}),
		).toThrow(AppUpdateValidationError);
	});

	test("accepts only canonical base64 Ed25519 signatures", () => {
		const signature = Buffer.alloc(64, 7).toString("base64");
		expect(parseAppUpdateSignature(`${signature}\n`)).toHaveLength(64);
		expect(() => parseAppUpdateSignature("not-base64")).toThrow(
			AppUpdateValidationError,
		);
	});

	test("uses the release pipeline manifest signature filename", () => {
		expect(appUpdateSignatureFilename("macos", "arm64")).toBe(
			"stable-macos-arm64-manifest.sig",
		);
	});
});
