import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AppUpdateController,
	type AppUpdaterAdapter,
} from "../src/bun/app-update-controller";
import {
	APP_UPDATE_MANIFEST_SCHEMA_VERSION,
	type AppUpdateManifest,
	canonicalizeAppUpdateManifest,
} from "../src/shared/app-update";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function release(archive: Uint8Array): AppUpdateManifest {
	return {
		schemaVersion: APP_UPDATE_MANIFEST_SCHEMA_VERSION,
		appId: "com.seago.whalehall",
		channel: "stable",
		platform: "macos",
		arch: "arm64",
		version: "1.2.0",
		buildHash: "releasehash",
		minimumSupportedVersion: "1.1.0",
		publishedAt: "2026-08-13T08:00:00.000Z",
		releaseNotes: "更新说明",
		assets: [
			{
				kind: "full",
				filename: "stable-macos-arm64-WhaleHall.app.tar.zst",
				url: "https://github.com/Sea-Go/Sea-WhaleHall/releases/download/v1.2.0/stable-macos-arm64-WhaleHall.app.tar.zst",
				size: archive.byteLength,
				sha256: createHash("sha256").update(archive).digest("hex"),
			},
		],
	};
}

async function harness(
	options: {
		currentVersion?: string;
		archive?: Uint8Array;
		manifestTransform?: (manifest: AppUpdateManifest) => AppUpdateManifest;
		assetResponse?: Uint8Array;
		scheduleMandatoryInstall?: (run: () => void) => void;
		adapter?: AppUpdaterAdapter;
		prepareForInstall?: () => Promise<{ ready: true } | { ready: false }>;
		localTarget?: { platform: "macos" | "win"; arch: "arm64" | "x64" };
		requestTimeoutMs?: number;
		fetchOverride?: typeof globalThis.fetch;
		onPreparedInstallFailure?: () => void;
	} = {},
) {
	const archive = options.archive ?? new TextEncoder().encode("signed archive");
	const signedManifest = release(archive);
	const deliveredManifest =
		options.manifestTransform?.(structuredClone(signedManifest)) ??
		signedManifest;
	const keys = generateKeyPairSync("ed25519");
	const signature = sign(
		null,
		Buffer.from(canonicalizeAppUpdateManifest(signedManifest)),
		keys.privateKey,
	).toString("base64");
	const publicKeySpkiBase64 = keys.publicKey
		.export({ type: "spki", format: "der" })
		.toString("base64");
	const calls = {
		stages: 0,
		applies: 0,
		fetches: [] as string[],
	};
	const adapter: AppUpdaterAdapter = options.adapter ?? {
		async getLocalInfo() {
			return {
				version: options.currentVersion ?? "1.1.0",
				buildHash: "localhash",
				channel: "stable",
				appId: "com.seago.whalehall",
				platform: options.localTarget?.platform ?? "macos",
				arch: options.localTarget?.arch ?? "arm64",
			};
		},
		async stageVerifiedFullArchive({ archivePath }) {
			calls.stages += 1;
			expect(await readFile(archivePath)).toEqual(Buffer.from(archive));
		},
		async applyStagedUpdate() {
			calls.applies += 1;
		},
	};
	const directory = await mkdtemp(join(tmpdir(), "whalehall-app-update-test-"));
	temporaryDirectories.push(directory);
	const fetch = async (input: string | URL | Request) => {
		const url = String(input);
		calls.fetches.push(url);
		if (url.endsWith("-manifest.json")) {
			return new Response(JSON.stringify(deliveredManifest));
		}
		if (url.endsWith("-manifest.sig")) return new Response(signature);
		if (url === deliveredManifest.assets[0].url) {
			return new Response(Buffer.from(options.assetResponse ?? archive), {
				headers: {
					"content-length": String(
						(options.assetResponse ?? archive).byteLength,
					),
				},
			});
		}
		return new Response("missing", { status: 404 });
	};
	const controller = new AppUpdateController({
		updater: adapter,
		publicKeySpkiBase64,
		downloadDirectory: directory,
		fetch: options.fetchOverride ?? (fetch as typeof globalThis.fetch),
		nowMs: () => 1_800_000_000_000,
		scheduleMandatoryInstall: options.scheduleMandatoryInstall,
		prepareForInstall: options.prepareForInstall,
		requestTimeoutMs: options.requestTimeoutMs,
		onPreparedInstallFailure: options.onPreparedInstallFailure,
	});
	return { controller, calls, directory, signedManifest };
}

describe("AppUpdateController", () => {
	test("uses the signed manifest as the sole remote update authority", async () => {
		const { controller } = await harness();
		const snapshot = await controller.checkForUpdate();
		expect(snapshot.state).toBe("available");
		if (snapshot.state !== "available") throw new Error("expected available");
		expect(snapshot.release.version).toBe("1.2.0");
		expect(snapshot.release.mandatory).toBeFalse();
	});

	test("fails closed when signed content is changed", async () => {
		const { controller } = await harness({
			manifestTransform: (manifest) => ({
				...manifest,
				releaseNotes: "被替换的更新说明",
			}),
		});
		const snapshot = await controller.checkForUpdate();
		expect(snapshot.state).toBe("failed");
		if (snapshot.state !== "failed") throw new Error("expected failure");
		expect(snapshot.failure.code).toBe("signature_invalid");
	});
});
