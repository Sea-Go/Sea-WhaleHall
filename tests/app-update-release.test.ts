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
		expect(workflow.split('--release-scope "$RELEASE_SCOPE"')).toHaveLength(
			5,
		);
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

	test("creates a tag-pinned one-asset manifest and detached Ed25519 signature", async () => {
		const directory = temporaryDirectory();
		const keys = signingKeys();
		writePlatformArtifacts(directory, "macos", "arm64", "1.2.3");
		const result = await createSignedAppUpdateManifest({
			artifactDirectory: directory,
			platform: "macos",
			arch: "arm64",
			version: "1.2.3",
			minimumSupportedVersion: "1.1.0",
			publishedAt: "2026-08-13T08:00:00.000Z",
			releaseNotes: "安全更新",
			...keys,
		});

		expect(result.manifest).not.toHaveProperty("forceUpdate");
		expect(result.manifest.assets).toHaveLength(1);
		expect(result.manifest.assets[0]).toMatchObject({
			kind: "full",
			filename: "stable-macos-arm64-WhaleHall.app.tar.zst",
			url:
				"https://github.com/Sea-Go/Sea-WhaleHall/releases/download/" +
				"v1.2.3/stable-macos-arm64-WhaleHall.app.tar.zst",
		});
		const signature = await Bun.file(result.signaturePath).text();
		expect(
			verifyManifestSignature(
				result.manifest,
				signature,
				keys.publicKeySpkiBase64,
			),
		).toBeTrue();
		expect(
			verifyManifestSignature(
				{ ...result.manifest, releaseNotes: "tampered" },
				signature,
				keys.publicKeySpkiBase64,
			),
		).toBeFalse();
	});

	test("rejects a minimum supported version above the release", async () => {
		const directory = temporaryDirectory();
		writePlatformArtifacts(directory, "win", "x64", "2.0.0");
		expect(
			createSignedAppUpdateManifest({
				artifactDirectory: directory,
				platform: "win",
				arch: "x64",
				version: "2.0.0",
				minimumSupportedVersion: "2.0.1",
				publishedAt: "2026-08-13T08:00:00.000Z",
				releaseNotes: "notes",
				...signingKeys(),
			}),
		).rejects.toThrow("cannot exceed");
	});

	test("requires the complete full-archive-only two-platform asset set", async () => {
		const directory = temporaryDirectory();
		const keys = signingKeys();
		for (const [platform, arch] of [
			["macos", "arm64"],
			["win", "x64"],
		] as const) {
			writePlatformArtifacts(directory, platform, arch, "3.0.0");
			await createSignedAppUpdateManifest({
				artifactDirectory: directory,
				platform,
				arch,
				version: "3.0.0",
				minimumSupportedVersion: "2.9.0",
				publishedAt: "2026-08-13T08:00:00.000Z",
				releaseNotes: "notes",
				...keys,
			});
		}
		await expect(
			verifyStableReleaseDirectory({
				artifactDirectory: directory,
				version: "3.0.0",
				publicKeySpkiBase64: keys.publicKeySpkiBase64,
			}),
		).resolves.toBeUndefined();
		writeFileSync(join(directory, "stable-win-x64-old.patch"), "patch");
		await expect(
			verifyStableReleaseDirectory({
				artifactDirectory: directory,
				version: "3.0.0",
				publicKeySpkiBase64: keys.publicKeySpkiBase64,
			}),
		).rejects.toThrow("forbidden delta patch");
	});

	test("strictly verifies a macOS-only Stable asset set", async () => {
		const directory = temporaryDirectory();
		const keys = signingKeys();
		writePlatformArtifacts(directory, "macos", "arm64", "3.1.0");
		await createSignedAppUpdateManifest({
			artifactDirectory: directory,
			platform: "macos",
			arch: "arm64",
			version: "3.1.0",
			minimumSupportedVersion: "3.0.0",
			publishedAt: "2026-08-13T08:00:00.000Z",
			releaseNotes: "notes",
			...keys,
		});
		await expect(
			verifyStableReleaseDirectory({
				artifactDirectory: directory,
				version: "3.1.0",
				publicKeySpkiBase64: keys.publicKeySpkiBase64,
				releaseScope: "macos-only",
			}),
		).resolves.toBeUndefined();

		writeFileSync(join(directory, "stable-win-x64-unexpected.txt"), "extra");
		await expect(
			verifyStableReleaseDirectory({
				artifactDirectory: directory,
				version: "3.1.0",
				publicKeySpkiBase64: keys.publicKeySpkiBase64,
				releaseScope: "macos-only",
			}),
		).rejects.toThrow("incomplete or unexpected");
	});

	test("binds every Stable asset prefix to its platform and architecture", async () => {
		const directory = temporaryDirectory();
		const keys = signingKeys();
		for (const [platform, arch] of [
			["macos", "arm64"],
			["win", "x64"],
		] as const) {
			writePlatformArtifacts(directory, platform, arch, "3.2.0");
			await createSignedAppUpdateManifest({
				artifactDirectory: directory,
				platform,
				arch,
				version: "3.2.0",
				minimumSupportedVersion: "3.0.0",
				publishedAt: "2026-08-13T08:00:00.000Z",
				releaseNotes: "notes",
				...keys,
			});
		}
		for (const suffix of ["manifest.json", "manifest.sig", "update.json"]) {
			writeFileSync(
				join(directory, `stable-macos-arm64-${suffix}`),
				readFileSync(join(directory, `stable-win-x64-${suffix}`)),
			);
		}
		await expect(
			verifyStableReleaseDirectory({
				artifactDirectory: directory,
				version: "3.2.0",
				publicKeySpkiBase64: keys.publicKeySpkiBase64,
			}),
		).rejects.toThrow("must target macos-arm64");
	});

	test("locks the embedded Bun entry paths used by the package gate", () => {
		expect(embeddedBunEntry("macos", "WhaleHall")).toBe(
			"WhaleHall.app/Contents/Resources/app/bun/index.js",
		);
		expect(embeddedBunEntry("win", "WhaleHall")).toBe(
			"WhaleHall/Resources/app/bun/index.js",
		);
	});

	test("accepts only a rooted Windows full archive with its runtime metadata", () => {
		expect(
			validateWindowsUpdateArchiveEntries(
				[
					"WhaleHall/Resources/version.json",
					"WhaleHall/Resources/main.js",
					"WhaleHall/Resources/app/bun/index.js",
					"WhaleHall/bin/launcher.exe",
				].join("\n"),
				"WhaleHall",
			),
		).toHaveLength(4);
		expect(() =>
			validateWindowsUpdateArchiveEntries(
				[
					"WhaleHall/Resources/version.json",
					"WhaleHall/Resources/main.js",
					"WhaleHall/Resources/app/bun/index.js",
					"WhaleHall/../outside.exe",
				].join("\n"),
				"WhaleHall",
			),
		).toThrow("unsafe path");
	});
});

describe("Windows Stable Authenticode gate", () => {
	test("constructs SHA-256 file and timestamp signing arguments", () => {
		const command = windowsSignCommand("C:\\release\\WhaleHall.exe", {
			certificatePath: "C:\\secrets\\release.pfx",
			certificatePassword: "secret",
			certificateSha1: "A".repeat(40),
			publisher: "CN=Sea Go",
			signtoolPath: "C:\\kits\\signtool.exe",
			timestampUrl: "https://timestamp.digicert.com",
		});
		expect(command).toContain("/fd");
		expect(command).toContain("SHA256");
		expect(command).toContain("/tr");
		expect(command).toContain("https://timestamp.digicert.com");
	});

	test("discovers PE executables and rejects linked bundle content", () => {
		const directory = temporaryDirectory();
		mkdirSync(join(directory, "bin"));
		writeFileSync(join(directory, "bin", "app.exe"), Buffer.from("MZpayload"));
		writeFileSync(join(directory, "bin", "not-pe.dll"), "plain");
		expect(findPortableExecutableFiles(directory)).toEqual([
			join(directory, "bin", "app.exe"),
		]);
	});

	test("requires Valid status, exact thumbprint, and exact publisher", () => {
		const description = parseAuthenticodeDescription(
			JSON.stringify({
				status: "Valid",
				thumbprint: "a".repeat(40),
				subject: "CN=Sea Go",
			}),
		);
		expect(() =>
			assertExpectedAuthenticodeSignature(description, {
				certificateSha1: "A".repeat(40),
				publisher: "CN=Sea Go",
			}),
		).not.toThrow();
		expect(() =>
			assertExpectedAuthenticodeSignature(description, {
				certificateSha1: "B".repeat(40),
				publisher: "CN=Sea Go",
			}),
		).toThrow("thumbprint mismatch");
	});
});

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
