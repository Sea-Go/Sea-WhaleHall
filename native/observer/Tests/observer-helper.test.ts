import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
	tapReady?: boolean;
	lastCallbackAtMs?: number | null;
	lastBucketAtMs?: number | null;
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
				Bun.sleep(remaining).then(() => ({
					done: true as const,
					value: undefined,
				})),
			]);
			if (result.done) break;
			this.buffered += this.decoder.decode(result.value, { stream: true });
		}
		throw new Error("Timed out waiting for a WhaleHall Observer frame.");
	}
}

let runningChild: ReturnType<typeof Bun.spawn> | undefined;
let policyTemporaryDirectory: string | undefined;
let policyExecutable: string | undefined;
let observerExecutable: string | undefined;

// Swift compilation is a build prerequisite, not part of the Observer's
// runtime response budget. Under the full Bun suite the compiler shares CPU
// with other native fixtures, so keeping it inside either 20-second protocol
// test made a healthy helper look unresponsive. Keep the build bounded here;
// the frame reader and runtime tests retain their independent, tighter bounds.
beforeAll(() => {
	if (process.platform !== "darwin") return;

	policyTemporaryDirectory = mkdtempSync(
		resolve(tmpdir(), "whalehall-observer-policy-"),
	);
	const sourceDirectory = resolve(import.meta.dir, "../Sources");
	const sources = readdirSync(sourceDirectory)
		.filter((name) => name.endsWith(".swift") && name !== "Main.swift")
		.sort()
		.map((name) => resolve(sourceDirectory, name));
	policyExecutable = resolve(
		policyTemporaryDirectory,
		"accessibility-policy-tests",
	);
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
		policyExecutable,
	]);
	expect(new TextDecoder().decode(compile.stderr)).toBe("");
	expect(compile.exitCode).toBe(0);

	const targetArchitecture = process.arch === "arm64" ? "arm64" : "x64";
	const bundle = buildObserverApp(targetArchitecture);
	observerExecutable = resolve(bundle, "Contents/MacOS/whalehall-observer");
}, 60_000);

afterEach(() => {
	runningChild?.kill();
	runningChild = undefined;
});

afterAll(() => {
	runningChild?.kill();
	runningChild = undefined;
	if (policyTemporaryDirectory) {
		rmSync(policyTemporaryDirectory, { force: true, recursive: true });
	}
	policyTemporaryDirectory = undefined;
	policyExecutable = undefined;
	observerExecutable = undefined;
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
	const setupCommandStart = runtimeSource.indexOf('case "setupPermissions":');
	const setupCommandEnd = runtimeSource.indexOf('case "shutdown":');
	expect(setupCommandStart).toBeGreaterThan(-1);
	expect(setupCommandEnd).toBeGreaterThan(setupCommandStart);
	const setupCommand = runtimeSource.slice(setupCommandStart, setupCommandEnd);
	expect(setupCommand).not.toMatch(/automation/iu);
	expect(setupCommand).not.toContain("BrowserMetadataReader");
	const automationPreflightStart = browserSource.indexOf(
		"nonisolated static func preflightAutomationAuthorization(",
	);
	const automationPreflightEnd = browserSource.indexOf(
		"private func sanitizeURL(",
	);
	expect(automationPreflightStart).toBeGreaterThan(-1);
	expect(automationPreflightEnd).toBeGreaterThan(automationPreflightStart);
	const automationPreflight = browserSource.slice(
		automationPreflightStart,
		automationPreflightEnd,
	);
	expect(automationPreflight).toContain(
		"AEDeterminePermissionToAutomateTarget(",
	);
	expect(automationPreflight).toMatch(
		/AEDeterminePermissionToAutomateTarget\([\s\S]*?false\s*\)/,
	);
});

test("keeps the Accessibility observer outside App Sandbox", () => {
	const entitlements = readFileSync(
		resolve(import.meta.dir, "../Resources/WhaleHallObserver.entitlements"),
		"utf8",
	);
	expect(entitlements).not.toContain("com.apple.security.app-sandbox");
	expect(entitlements).not.toContain(
		"com.apple.security.temporary-exception.apple-events",
	);
	expect(entitlements).toContain("com.apple.security.automation.apple-events");
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
	expect(runtimeSource.match(/CGRequestScreenCaptureAccess\(\)/g)?.length).toBe(
		1,
	);
	expect(runtimeSource).not.toContain("CGRequestListenEventAccess()");
	expect(runtimeSource.match(/AXIsProcessTrustedWithOptions\(/g)?.length).toBe(
		1,
	);

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

	expect(inputSource).toContain(
		"AXIsProcessTrusted() || CGPreflightListenEventAccess()",
	);
	expect(inputSource).not.toContain("CGRequestListenEventAccess");
	expect(ocrSource).toContain("CGPreflightScreenCaptureAccess");
	expect(ocrSource).not.toContain("CGRequestScreenCaptureAccess");
	expect(ocrSource).toContain("@preconcurrency import ScreenCaptureKit");
	expect(inputSource).toContain('onGap("input_monitoring_unavailable")');
	const inputStart = inputSource.slice(
		inputSource.indexOf("func start() -> Bool"),
		inputSource.indexOf("func healthSnapshot()"),
	);
	expect(inputStart).toContain("startup.wait(timeout: Self.startupTimeout)");
	expect(inputStart.indexOf("startup.wait")).toBeLessThan(
		inputStart.indexOf("startBucketTimer(generation:"),
	);
	expect(inputStart.indexOf("startup.wait")).toBeLessThan(
		inputStart.lastIndexOf("return startBucketTimer"),
	);
	expect(inputStart).toContain(
		"let ownsGeneration = captureGeneration == generation",
	);
	expect(inputStart).toContain(
		"let tap = !ready && ownsGeneration ? eventTap : nil",
	);
	expect(inputSource).toContain(
		"self?.sealCompletedBucket(generation: generation)",
	);
	expect(inputSource).toContain("callbackGeneration: generation");
	const bucketSeal = inputSource.slice(
		inputSource.indexOf("private func sealCompletedBucket("),
		inputSource.indexOf("private func inputEventCallback("),
	);
	const drainIndex = bucketSeal.indexOf("let values = accumulator.drain()");
	const markIndex = bucketSeal.indexOf("accumulator.markBucket(");
	const successUnlockIndex = bucketSeal.indexOf(
		"stateLock.unlock()",
		markIndex,
	);
	expect(drainIndex).toBeGreaterThan(-1);
	expect(markIndex).toBeGreaterThan(drainIndex);
	expect(successUnlockIndex).toBeGreaterThan(markIndex);
	expect(bucketSeal.indexOf("onBucket(bucket)")).toBeGreaterThan(
		successUnlockIndex,
	);
	expect(runtimeSource).toContain(
		"inputMonitor.owns(generation: bucket.generation)",
	);
	expect(ocrSource).toContain("self.onGap(Self.sanitizedCaptureError(error))");
	expect(runtimeSource).toContain("guard updated != previous else");
	expect(runtimeSource).toContain('reason: "runtime_change"');
	expect(runtimeSource).toContain(
		"inputActivityHealth: inputMonitor.healthSnapshot()",
	);
	const inputGapHandler = runtimeSource.slice(
		runtimeSource.indexOf("private func handleInputGap("),
		runtimeSource.indexOf("private func scheduleInputMonitorRetry("),
	);
	expect(inputGapHandler).toContain(
		"permissionAvailable: hasInputActivityAccess()",
	);
	expect(inputGapHandler).toContain("if disposition == .permissionRevoked {");
	expect(inputGapHandler).toContain("scheduleInputMonitorRetry()");
	expect(
		inputGapHandler.indexOf("if disposition == .permissionRevoked {"),
	).toBeLessThan(inputGapHandler.indexOf("markCachedPermissionUnavailable("));
	expect(inputGapHandler).toContain("accessibility: true");
	expect(inputGapHandler).toContain("inputMonitoring: true");
	expect(runtimeSource).toContain(
		"InputMonitorRetryPolicy.delay(forAttempt: inputRetryAttempt)",
	);
	const startInputMonitor = runtimeSource.slice(
		runtimeSource.indexOf("private func startInputMonitor()"),
		runtimeSource.indexOf("private func cancelInputMonitorRetry()"),
	);
	expect(startInputMonitor).toContain("let started = inputMonitor.start()");
	expect(startInputMonitor).toContain(
		"InputCollectionGatePolicy.enabledAfterStart(",
	);
	expect(startInputMonitor).toContain(
		"activeCaptureAllowed: activeCaptureAllowed",
	);
	const foregroundHandler = runtimeSource.slice(
		runtimeSource.indexOf("private func handleForegroundApplication("),
		runtimeSource.indexOf("private func emitBrowserBoundary("),
	);
	expect(foregroundHandler).toContain(
		"let permissionRevoked = !AXIsProcessTrusted()",
	);
	expect(foregroundHandler).toContain('"accessibility_target_unavailable"');
	expect(foregroundHandler.indexOf("if permissionRevoked {")).toBeLessThan(
		foregroundHandler.indexOf(
			"markCachedPermissionUnavailable(accessibility: true)",
		),
	);
});

macOSTest(
	"keeps AX flush, privacy, and visible-editable policies deterministic",
	() => {
		expect(policyExecutable).toBeString();
		const run = Bun.spawnSync([policyExecutable as string]);
		expect(new TextDecoder().decode(run.stderr)).toBe("");
		expect(run.exitCode).toBe(0);
	},
	20_000,
);

macOSTest(
	"builds the bundled helper and exchanges privacy-safe JSONL frames",
	async () => {
		expect(observerExecutable).toBeString();
		const child = Bun.spawn([observerExecutable as string], {
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
		expect(ready.tapReady).toBe(false);
		expect(ready.lastCallbackAtMs).toBeNull();
		expect(ready.lastBucketAtMs).toBeNull();

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
		let healthHeartbeat: ObserverFrame | undefined;
		for (
			let index = 0;
			index < 12 && (!observation || !startResult || !healthHeartbeat);
			index += 1
		) {
			const frame = await frames.next();
			if (frame.type === "observation") observation = frame;
			if (frame.type === "heartbeat") healthHeartbeat = frame;
			if (frame.type === "commandResult" && frame.id === "start-1") {
				startResult = frame;
			}
		}
		expect(startResult?.ok).toBe(true);
		expect(typeof healthHeartbeat?.tapReady).toBe("boolean");
		expect(
			healthHeartbeat?.lastCallbackAtMs === null ||
				typeof healthHeartbeat?.lastCallbackAtMs === "number",
		).toBe(true);
		expect(
			healthHeartbeat?.lastBucketAtMs === null ||
				typeof healthHeartbeat?.lastBucketAtMs === "number",
		).toBe(true);
		expect(observation?.observation?.schemaVersion).toBe("raw-observation.v2");
		// A locked/non-interactive macOS session must fail closed with an
		// explicit coverage gap. An unlocked session reports the foreground
		// workspace observation. Both are valid privacy-safe startup outcomes.
		expect(["workspace.foregroundChanged", "coverage.gap"]).toContain(
			observation?.observation?.kind,
		);
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

		// Rust owns the helper's stdin pipe. A forced whalehall-local exit closes
		// that pipe even when Rust destructors cannot run; the packaged helper must
		// treat the resulting EOF as parent disconnect and terminate itself.
		const eofChild = Bun.spawn([observerExecutable as string], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		runningChild = eofChild;
		const eofFrames = new FrameReader(eofChild.stdout);
		expect((await eofFrames.next()).type).toBe("ready");
		eofChild.stdin.end();
		const eofExitCode = await Promise.race([
			eofChild.exited,
			Bun.sleep(5_000).then(() => {
				throw new Error("Observer did not exit after its parent stdin closed.");
			}),
		]);
		expect(eofExitCode).toBe(0);
		runningChild = undefined;
	},
	20_000,
);
