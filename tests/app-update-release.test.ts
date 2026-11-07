import { afterEach, describe, expect, test } from "bun:test";
import {
	createPrivateKey,
	generateKeyPairSync,
	sign as signBytes,
} from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSignedAppUpdateManifest,
	verifyManifestSignature,
} from "../scripts/app-update-manifest";
import {
	embeddedBunEntry,
	validateWindowsUpdateArchiveEntries,
} from "../scripts/app-update-post-package";
import {
	assertExpectedAuthenticodeSignature,
	findPortableExecutableFiles,
	parseAuthenticodeDescription,
	windowsSignCommand,
} from "../scripts/app-update-sign-windows";
import { validateStableReleaseInputs } from "../scripts/app-update-validate-release";
import { verifyStableReleaseDirectory } from "../scripts/app-update-verify-release";
import {
	type AppUpdateManifest,
	canonicalizeAppUpdateManifest,
} from "../src/shared/app-update";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Stable application update release", () => {
	test("pins one verification key and rechecks the highest Stable before publication", () => {
		const workflow = readFileSync(
			join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
			"utf8",
		);
		expect(workflow).toContain("public_key_fingerprint:");
		expect(
			workflow.match(/Pin the Stable update verification key/gu),
		).toHaveLength(3);
		expect(workflow).toContain("EXPECTED_PREVIOUS_TAG:");
		expect(workflow.match(/assert_stable_baseline/gu)).toHaveLength(3);
		expect(workflow).toContain("--previous-manifest-signature");
		expect(workflow).toContain("--previous-version");
		expect(workflow.match(/set -euo pipefail/gu)).toHaveLength(2);
		expect(workflow).toContain(
			"Validate version, floor, notes, and prior Stable release\n        id: release\n        run: |\n          set -euo pipefail",
		);
		expect(workflow).toContain(
			"Upload every asset to a draft, re-download, and publish\n        run: |\n          set -euo pipefail",
		);
		expect(workflow).toContain(
			"quality:\n    name: Re-run complete candidate checks",
		);
		expect(workflow).toContain(
			"- name: Install Linux sensor dependencies\n        run: scripts/ci/install-linux-dependencies.sh debian sensor",
		);
		expect(workflow).toContain(
			"release_scope: ${{ steps.release.outputs.release_scope }}",
		);
		expect(workflow).toContain(
			"if: ${{ needs.prepare.outputs.release_scope == 'macos-and-windows' }}",
		);
		expect(workflow).toContain(
			"DATACENTER_WHALEHALL_REPOSITORY_URL: file:///srv/datacenter-ci-sources/Sea-WhaleHall.git",
		);
		expect(workflow.split('--release-scope "$RELEASE_SCOPE"')).toHaveLength(5);
	});

	test("requires monotonic release versions and minimum supported floors", () => {
		expect(() =>
			validateStableReleaseInputs({
				version: "1.0.0",
				minimumSupportedVersion: "1.0.0",
				releaseNotes: "notes",
				releaseScope: "macos-only",
			}),
		).not.toThrow();
		const previous: AppUpdateManifest = {
			schemaVersion: "whalehall.app-update-manifest.v1",
			appId: "com.seago.whalehall",
			channel: "stable",
			platform: "macos",
			arch: "arm64",
			version: "1.2.3",
			buildHash: "abc123",
			minimumSupportedVersion: "1.1.0",
			publishedAt: "2026-08-13T08:00:00.000Z",
			releaseNotes: "notes",
			assets: [
				{
					kind: "full",
					filename: "stable-macos-arm64-WhaleHall.app.tar.zst",
					url:
						"https://github.com/Sea-Go/Sea-WhaleHall/releases/download/" +
						"v1.2.3/stable-macos-arm64-WhaleHall.app.tar.zst",
					size: 10,
					sha256: "a".repeat(64),
				},
			],
		};
		const keys = signingKeys();
		const previousManifestSignature = signBytes(
			null,
			Buffer.from(canonicalizeAppUpdateManifest(previous), "utf8"),
			createPrivateKey({
				key: Buffer.from(keys.privateKeyPkcs8Base64, "base64"),
				format: "der",
				type: "pkcs8",
			}),
		).toString("base64");
		const previousAuthority = {
			releaseScope: "macos-only" as const,
			previousManifestSignature,
			previousReleaseAssetNames: [
				"stable-macos-arm64-manifest.json",
				"stable-macos-arm64-manifest.sig",
			],
			previousVersion: previous.version,
			publicKeySpkiBase64: keys.publicKeySpkiBase64,
		};
		expect(() =>
			validateStableReleaseInputs({
				version: "1.3.0",
				minimumSupportedVersion: "1.1.0",
				releaseNotes: "notes",
				releaseScope: "macos-and-windows",
				previousManifest: previous,
				previousManifestSignature,
				previousVersion: previous.version,
				publicKeySpkiBase64: keys.publicKeySpkiBase64,
			}),
		).not.toThrow();
		expect(() =>
			validateStableReleaseInputs({
				version: "1.3.0",
				minimumSupportedVersion: "1.1.0",
				releaseNotes: "notes",
				previousManifest: previous,
				...previousAuthority,
			}),
		).not.toThrow();
		expect(() =>
			validateStableReleaseInputs({
				version: "1.2.3",
				minimumSupportedVersion: "1.1.0",
				releaseNotes: "notes",
				previousManifest: previous,
				...previousAuthority,
			}),
		).toThrow("must be newer");
		expect(() =>
			validateStableReleaseInputs({
				version: "1.3.0",
				minimumSupportedVersion: "1.0.0",
				releaseNotes: "notes",
				previousManifest: previous,
				...previousAuthority,
			}),
		).toThrow("previous Stable floor");
		expect(() =>
			validateStableReleaseInputs({
				version: "1.3.0",
				minimumSupportedVersion: "1.1.0",
				releaseNotes: "notes",
				previousManifest: { ...previous, releaseNotes: "tampered" },
				...previousAuthority,
			}),
		).toThrow("signature is invalid");
		expect(() =>
			validateStableReleaseInputs({
				version: "1.3.0",
				minimumSupportedVersion: "1.1.0",
				releaseNotes: "notes",
				previousManifest: previous,
				...previousAuthority,
				previousVersion: "1.2.2",
			}),
		).toThrow("tag and signed manifest do not match");
		expect(() =>
			validateStableReleaseInputs({
				version: "1.3.0",
				minimumSupportedVersion: "1.1.0",
				releaseNotes: "notes",
				previousManifest: previous,
				...previousAuthority,
				previousReleaseAssetNames: [
					...previousAuthority.previousReleaseAssetNames,
					"stable-win-x64-manifest.json",
					"stable-win-x64-manifest.sig",
				],
			}),
		).toThrow("cannot remove Windows");
		expect(() =>
			validateStableReleaseInputs({
				version: "1.3.0",
				minimumSupportedVersion: "1.1.0",
				releaseNotes: "notes",
				previousManifest: previous,
				...previousAuthority,
				releaseScope: "macos-and-windows",
				previousReleaseAssetNames: [
					...previousAuthority.previousReleaseAssetNames,
					"stable-win-x64-manifest.json",
				],
			}),
		).toThrow("incomplete manifest/signature pair");
	});
});

describe("Windows Stable Authenticode gate", () => {});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-release-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function signingKeys(): {
	privateKeyPkcs8Base64: string;
	publicKeySpkiBase64: string;
} {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		privateKeyPkcs8Base64: privateKey
			.export({ type: "pkcs8", format: "der" })
			.toString("base64"),
		publicKeySpkiBase64: publicKey
			.export({ type: "spki", format: "der" })
			.toString("base64"),
	};
}

function writePlatformArtifacts(
	directory: string,
	platform: "macos" | "win",
	arch: "arm64" | "x64",
	version: string,
): void {
	const prefix = `stable-${platform}-${arch}`;
	const suffix = platform === "macos" ? ".app" : "";
	writeFileSync(
		join(directory, `${prefix}-update.json`),
		JSON.stringify({ version, hash: `${platform}hash`, platform, arch }),
	);
	writeFileSync(
		join(directory, `${prefix}-WhaleHall${suffix}.tar.zst`),
		`${platform}-archive`,
	);
	writeFileSync(
		join(
			directory,
			platform === "macos"
				? `${prefix}-WhaleHall.dmg`
				: `${prefix}-WhaleHall-Setup.zip`,
		),
		`${platform}-installer`,
	);
}
