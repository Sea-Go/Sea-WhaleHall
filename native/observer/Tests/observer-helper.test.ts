import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildObserverApp } from "../../../scripts/build-native";

type ObserverFrame = {
	type: string;
	schemaVersion: string;
	bootId: string;
	sequence?: number;
	ok?: boolean;
	id?: string;
	error?: {
		code?: string;
	};
	authorizationReason?: string;
	capabilities?: Record<string, boolean>;
	permissions?: Record<string, string>;
	observation?: {
		schemaVersion: string;
		kind: string;
		content?: Record<string, unknown>;
	};
};

class FrameReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly decoder = new TextDecoder();
	private buffered = "";

	constructor(stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader();
	}

	async next(timeoutMs = 5_000): Promise<ObserverFrame> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const newline = this.buffered.indexOf("\n");
			if (newline >= 0) {
				const line = this.buffered.slice(0, newline);
				this.buffered = this.buffered.slice(newline + 1);
				if (line.length > 0) return JSON.parse(line) as ObserverFrame;
			}
			const remaining = Math.max(1, deadline - Date.now());
			const result = await Promise.race([
				this.reader.read(),
				Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
			]);
			if (result.done) break;
			this.buffered += this.decoder.decode(result.value, { stream: true });
		}
		throw new Error("Timed out waiting for a WhaleHall Observer frame.");
	}
}

let runningChild: ReturnType<typeof Bun.spawn> | undefined;

afterEach(() => {
	runningChild?.kill();
	runningChild = undefined;
});

const macOSTest = process.platform === "darwin" ? test : test.skip;

test("keeps browser Automation outside the required permission action", () => {
	const runtimeSource = readFileSync(
		resolve(import.meta.dir, "../Sources/ObserverRuntime.swift"),
		"utf8",
	);
	const browserSource = readFileSync(
		resolve(import.meta.dir, "../Sources/BrowserMetadataReader.swift"),
		"utf8",
	);

	expect(runtimeSource).not.toContain("automationAuthorization(");
	expect(runtimeSource).not.toContain("preflightAutomationAuthorization(");
	expect(browserSource).not.toContain("prompt: Bool");
	expect(browserSource).toContain(
		"static func preflightAutomationAuthorization(",
	);
	expect(browserSource).toContain(
		"WhaleHall's single\n    /// monitoring permission action",
	);
});

test("keeps display polling cached and prompt APIs explicit", () => {
	const runtimeSource = readFileSync(
		resolve(import.meta.dir, "../Sources/ObserverRuntime.swift"),
		"utf8",
	);
	const inputSource = readFileSync(
		resolve(import.meta.dir, "../Sources/InputActivityMonitor.swift"),
		"utf8",
	);
	const ocrSource = readFileSync(
		resolve(import.meta.dir, "../Sources/ScreenOCRMonitor.swift"),
		"utf8",
	);

	expect(runtimeSource).not.toContain("permissionSnapshot(prompt:");
	expect(runtimeSource).not.toContain("prompt: Bool");
	expect(runtimeSource).toContain('errorCode: "prompt_field_forbidden"');
	expect(runtimeSource.match(/passivePermissionSnapshot\(\)/g)?.length).toBe(4);
	expect(runtimeSource.match(/CGRequestScreenCaptureAccess\(\)/g)?.length).toBe(1);
	expect(runtimeSource.match(/CGRequestListenEventAccess\(\)/g)?.length).toBe(1);
	expect(runtimeSource.match(/AXIsProcessTrustedWithOptions\(/g)?.length).toBe(1);

	const startMonitoring = runtimeSource.slice(
		runtimeSource.indexOf("private func startMonitoring()"),
		runtimeSource.indexOf("private func stopMonitoring("),
	);
	const heartbeat = runtimeSource.slice(
		runtimeSource.indexOf("private func emitHeartbeat()"),
		runtimeSource.indexOf("private func handleForegroundApplication("),
	);
	const statusCommand = runtimeSource.slice(
		runtimeSource.indexOf('case "status":'),
		runtimeSource.indexOf('case "refreshPermissions":'),
	);
	for (const passivePath of [startMonitoring, heartbeat, statusCommand]) {
		expect(passivePath).toContain("cachedPermissionSnapshot()");
		expect(passivePath).not.toContain("CGPreflight");
		expect(passivePath).not.toContain("CGRequest");
		expect(passivePath).not.toContain("AXIsProcessTrusted");
	}
	const refreshCommand = runtimeSource.slice(
		runtimeSource.indexOf('case "refreshPermissions":'),
		runtimeSource.indexOf('case "setupPermissions":'),
	);
	expect(refreshCommand).toContain("passivePermissionSnapshot()");
	expect(refreshCommand).not.toContain("CGRequest");
	expect(refreshCommand).not.toContain("AXIsProcessTrustedWithOptions");
	const setupCommand = runtimeSource.slice(
		runtimeSource.indexOf('case "setupPermissions":'),
		runtimeSource.indexOf('case "shutdown":'),
	);
	expect(setupCommand).toContain("requestPermissionSetupSnapshot()");

	expect(inputSource).toContain("CGPreflightListenEventAccess");
	expect(inputSource).not.toContain("CGRequestListenEventAccess");
	expect(ocrSource).toContain("CGPreflightScreenCaptureAccess");
	expect(ocrSource).not.toContain("CGRequestScreenCaptureAccess");
	expect(inputSource).toContain('onGap("input_monitoring_unavailable")');
	expect(ocrSource).toContain(
		"self.onGap(Self.sanitizedCaptureError(error))",
	);
	expect(runtimeSource).toContain("guard updated != previous else");
	expect(runtimeSource).toContain(
		'emitter.emitPermissionStatus(updated, reason: "runtime_change")',
	);
	const foregroundHandler = runtimeSource.slice(
		runtimeSource.indexOf("private func handleForegroundApplication("),
		runtimeSource.indexOf("private func emitBrowserBoundary("),
	);
	expect(foregroundHandler).toContain(
		"let permissionRevoked = !AXIsProcessTrusted()",
	);
	expect(foregroundHandler).toContain('"accessibility_target_unavailable"');
	expect(
		foregroundHandler.indexOf("if permissionRevoked {"),
	).toBeLessThan(
		foregroundHandler.indexOf(
			"markCachedPermissionUnavailable(accessibility: true)",
		),
	);
});

macOSTest(
	"keeps AX flush, privacy, and visible-editable policies deterministic",
	() => {
		const temporaryDirectory = mkdtempSync(
			resolve(tmpdir(), "whalehall-observer-policy-"),
		);
		try {
			const sourceDirectory = resolve(import.meta.dir, "../Sources");
			const sources = readdirSync(sourceDirectory)
				.filter((name) => name.endsWith(".swift") && name !== "Main.swift")
				.sort()
				.map((name) => resolve(sourceDirectory, name));
			const executable = resolve(temporaryDirectory, "accessibility-policy-tests");
			const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
			const compile = Bun.spawnSync([
				"xcrun",
				"swiftc",
				"-swift-version",
				"6",
				"-parse-as-library",
				"-target",
				`${architecture}-apple-macos14.0`,
				"-framework",
				"AppKit",
				"-framework",
				"ApplicationServices",
				"-framework",
				"CoreGraphics",
				"-framework",
				"ScreenCaptureKit",
				"-framework",
				"Vision",
				...sources,
				resolve(import.meta.dir, "AccessibilityMonitorPolicyTests.swift"),
				"-o",
				executable,
			]);
			expect(new TextDecoder().decode(compile.stderr)).toBe("");
			expect(compile.exitCode).toBe(0);
			const run = Bun.spawnSync([executable]);
			expect(new TextDecoder().decode(run.stderr)).toBe("");
			expect(run.exitCode).toBe(0);
		} finally {
			rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	},
	20_000,
);

macOSTest(
	"builds the bundled helper and exchanges privacy-safe JSONL frames",
	async () => {
		const architecture = process.arch === "arm64" ? "arm64" : "x64";
		const bundle = buildObserverApp(architecture);
		const executable = resolve(
			bundle,
			"Contents/MacOS/whalehall-observer",
		);
		const child = Bun.spawn([executable], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		runningChild = child;
		const frames = new FrameReader(child.stdout);
		const ready = await frames.next();
		expect(ready.type).toBe("ready");
		expect(ready.schemaVersion).toBe("observer-frame.v1");
		expect(ready.authorizationReason).toBe("startup_snapshot");
		expect(ready.capabilities?.storesScreenshots).toBe(false);
		expect(ready.capabilities?.readsKeyValues).toBe(false);
		expect(ready.capabilities?.browserAppleEventsPrompted).toBe(false);
		expect(ready.permissions?.automation).toBe("unavailable");

		child.stdin.write(
			`${JSON.stringify({
				type: "command",
				id: "forbidden-prompt",
				command: "refreshPermissions",
				prompt: true,
			})}\n`,
		);
		child.stdin.flush();
		const forbiddenPrompt = await frames.next();
		expect(forbiddenPrompt.type).toBe("commandResult");
		expect(forbiddenPrompt.id).toBe("forbidden-prompt");
		expect(forbiddenPrompt.ok).toBe(false);
		expect(forbiddenPrompt.error?.code).toBe("prompt_field_forbidden");

		child.stdin.write(
			`${JSON.stringify({
				type: "command",
				id: "start-1",
				command: "start",
				config: { captureContent: false, excludedBundleIds: [] },
			})}\n`,
		);
		child.stdin.flush();

		let observation: ObserverFrame | undefined;
		let startResult: ObserverFrame | undefined;
		for (let index = 0; index < 8 && (!observation || !startResult); index += 1) {
			const frame = await frames.next();
			if (frame.type === "observation") observation = frame;
			if (frame.type === "commandResult" && frame.id === "start-1") {
				startResult = frame;
			}
		}
		expect(startResult?.ok).toBe(true);
		expect(observation?.observation?.schemaVersion).toBe("raw-observation.v2");
		// A locked/non-interactive macOS session must fail closed with an
		// explicit coverage gap. An unlocked session reports the foreground
		// workspace observation. Both are valid privacy-safe startup outcomes.
		expect([
			"workspace.foregroundChanged",
			"coverage.gap",
		]).toContain(observation?.observation?.kind);
		expect(observation?.observation?.content).toBeUndefined();

		child.stdin.write(
			`${JSON.stringify({
				type: "ack",
				bootId: ready.bootId,
				sequence: observation?.sequence,
			})}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({
				type: "command",
				id: "shutdown-1",
				command: "shutdown",
			})}\n`,
		);
		child.stdin.flush();

		let shutdownResult: ObserverFrame | undefined;
		for (let index = 0; index < 4 && !shutdownResult; index += 1) {
			const frame = await frames.next();
			if (frame.type === "commandResult" && frame.id === "shutdown-1") {
				shutdownResult = frame;
			}
		}
		expect(shutdownResult?.ok).toBe(true);
		expect(await child.exited).toBe(0);
		runningChild = undefined;
	},
	20_000,
);
