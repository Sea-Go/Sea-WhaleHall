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

	test("streams, checks size and sha256, then stages only the verified archive", async () => {
		const archive = new Uint8Array(1_200_000).fill(31);
		const { controller, calls, directory } = await harness({ archive });
		await controller.checkForUpdate();
		const states: string[] = [];
		controller.subscribe((snapshot) => states.push(snapshot.state));
		const snapshot = await controller.downloadUpdate();
		expect(snapshot.state).toBe("ready");
		expect(calls.stages).toBe(1);
		expect(states).toContain("downloading");
		expect(states).toContain("verifying");
		expect(
			(await readdir(directory)).some((entry) =>
				entry.startsWith(".whalehall-update-"),
			),
		).toBeFalse();
	});

	test("deletes a mismatched archive and never passes it to the updater", async () => {
		const archive = new TextEncoder().encode("expected bytes");
		const corrupt = new TextEncoder().encode("corrupted file");
		const { controller, calls, directory } = await harness({
			archive,
			assetResponse: corrupt,
		});
		await controller.checkForUpdate();
		const snapshot = await controller.downloadUpdate();
		expect(snapshot.state).toBe("failed");
		if (snapshot.state !== "failed") throw new Error("expected failure");
		expect(snapshot.failure.code).toBe("archive_digest_mismatch");
		expect(calls.stages).toBe(0);
		expect(
			(await readdir(directory)).some((entry) =>
				entry.startsWith(".whalehall-update-"),
			),
		).toBeFalse();
	});

	test("deduplicates concurrent checks into one flight", async () => {
		const { controller, calls } = await harness();
		const first = controller.checkForUpdate();
		const second = controller.checkForUpdate();
		expect(first).toBe(second);
		await first;
		expect(
			calls.fetches.filter((url) => url.endsWith("-manifest.json")),
		).toHaveLength(1);
	});

	test("automatically downloads and safely installs mandatory releases", async () => {
		const scheduled: { run?: () => void } = {};
		const { controller, calls } = await harness({
			currentVersion: "1.0.0",
			scheduleMandatoryInstall: (run) => {
				scheduled.run = run;
			},
		});
		const available = await controller.checkForUpdate();
		expect(available.state).toBe("available");
		if (available.state !== "available") throw new Error("expected available");
		expect(available.release.mandatory).toBeTrue();
		expect(scheduled.run).toBeFunction();
		scheduled.run?.();
		for (let attempt = 0; attempt < 40 && calls.applies === 0; attempt += 1) {
			await Bun.sleep(5);
		}
		expect(calls.stages).toBe(1);
		expect(calls.applies).toBe(1);
	});

	test("returns immediately from renderer-facing start methods", async () => {
		const { controller } = await harness();
		await controller.checkForUpdate();
		const started = controller.startDownload();
		expect(started.state).toBe("downloading");
		for (
			let attempt = 0;
			attempt < 40 && controller.getStatus().state !== "ready";
			attempt += 1
		) {
			await Bun.sleep(5);
		}
		expect(controller.getStatus().state).toBe("ready");
	});

	test("retries a blocked installation from the retained verified release", async () => {
		let preparationCount = 0;
		const { controller, calls } = await harness({
			prepareForInstall: async () => {
				preparationCount += 1;
				return { ready: preparationCount > 1 };
			},
		});
		await controller.checkForUpdate();
		await controller.downloadUpdate();
		const blocked = await controller.installUpdateAndRestart();
		expect(blocked.state).toBe("failed");
		if (blocked.state !== "failed") throw new Error("expected failed");
		expect(blocked.failure.code).toBe("install_blocked");

		const retried = await controller.installUpdateAndRestart();
		expect(preparationCount).toBe(2);
		expect(calls.applies).toBe(1);
		expect(retried.state).toBe("installing");
	});

	test("requests a clean fallback exit when apply fails after preparation", async () => {
		let fallbackExitCount = 0;
		const adapter: AppUpdaterAdapter = {
			async getLocalInfo() {
				return {
					version: "1.1.0",
					buildHash: "localhash",
					channel: "stable",
					appId: "com.seago.whalehall",
					platform: "macos",
					arch: "arm64",
				};
			},
			async stageVerifiedFullArchive() {},
			async applyStagedUpdate() {
				throw new Error("private updater failure");
			},
		};
		const { controller } = await harness({
			adapter,
			onPreparedInstallFailure: () => {
				fallbackExitCount += 1;
			},
		});
		await controller.checkForUpdate();
		await controller.downloadUpdate();
		const snapshot = await controller.installUpdateAndRestart();
		expect(snapshot.state).toBe("failed");
		if (snapshot.state !== "failed") throw new Error("expected failed");
		expect(snapshot.failure.code).toBe("install_failed");
		expect(JSON.stringify(snapshot)).not.toContain("private updater failure");
		expect(fallbackExitCount).toBe(1);
	});

	test("ordinary shutdown cannot start a newly scheduled installation", async () => {
		const { controller, calls } = await harness();
		await controller.checkForUpdate();
		await controller.downloadUpdate();
		controller.beginShutdown();
		const snapshot = await controller.installUpdateAndRestart();
		expect(snapshot.state).toBe("ready");
		expect(calls.applies).toBe(0);
	});

	test("disables unsupported stable platform and architecture pairs", async () => {
		const { controller, calls } = await harness({
			localTarget: { platform: "macos", arch: "x64" },
		});
		const snapshot = await controller.checkForUpdate();
		expect(snapshot).toMatchObject({
			state: "disabled",
			reason: "unsupported_platform",
		});
		expect(calls.fetches).toEqual([]);
	});

	test("times out a stalled metadata request and allows a later retry", async () => {
		let requestCount = 0;
		const { controller } = await harness({
			requestTimeoutMs: 15,
			fetchOverride: (async () => {
				requestCount += 1;
				if (requestCount <= 2) return new Promise<Response>(() => {});
				return new Response("offline", { status: 503 });
			}) as unknown as typeof globalThis.fetch,
		});
		const first = await controller.checkForUpdate();
		expect(first.state).toBe("failed");
		const second = await controller.checkForUpdate();
		expect(second.state).toBe("failed");
		expect(requestCount).toBe(4);
	});

	test("never exposes adapter errors or filesystem details", async () => {
		const base = await harness();
		const adapter: AppUpdaterAdapter = {
			async getLocalInfo() {
				throw new Error("/Users/private/token=top-secret");
			},
			async stageVerifiedFullArchive() {},
			async applyStagedUpdate() {},
		};
		const controller = new AppUpdateController({
			updater: adapter,
			publicKeySpkiBase64: "secret",
			downloadDirectory: base.directory,
		});
		const snapshot = await controller.checkForUpdate();
		expect(JSON.stringify(snapshot)).not.toContain("top-secret");
		expect(JSON.stringify(snapshot)).not.toContain("/Users/private");
	});
});
