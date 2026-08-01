import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type MacSigningPlan,
	localDesignatedRequirement,
	readMacCodeSigningIdentities,
	resolveMacSigningPlan,
} from "./macos-signing-identity";
import { validateObserverEntitlements } from "./macos-build-security";

type TargetOS = "macos" | "linux" | "win";
type TargetArch = "arm64" | "x64";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(projectRoot, "whalehall-local/Cargo.toml");
const observerRoot = resolve(projectRoot, "native/observer");
const observerBundleName = "WhaleHall Observer.app";
const observerExecutableName = "whalehall-observer";
const observerIdentifier = "com.seago.whalehall.observer";
const localServerIdentifier = "com.seago.whalehall.local";

let cachedMacSigningPlan: MacSigningPlan | undefined;

function macSigningPlan(): MacSigningPlan {
	cachedMacSigningPlan ??= resolveMacSigningPlan({
		environment: process.env,
		buildEnvironment: process.env.ELECTROBUN_BUILD_ENV ?? "dev",
		identities: readMacCodeSigningIdentities(),
	});
	return cachedMacSigningPlan;
}

function hostOS(): TargetOS {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "win32") return "win";
	return "linux";
}

function hostArch(): TargetArch {
	return process.arch === "arm64" ? "arm64" : "x64";
}

function run(command: string[]): void {
	const result = Bun.spawnSync(command, {
		cwd: projectRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) {
		throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
	}
}

function capture(command: string[]): string {
	const result = Bun.spawnSync(command, {
		cwd: projectRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
	}
	return `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(
		result.stderr,
	)}`;
}

export function buildObserverApp(arch: TargetArch): string {
	if (hostOS() !== "macos") {
		throw new Error("WhaleHall Observer can only be built on a macOS host.");
	}

	const sourceDirectory = resolve(observerRoot, "Sources");
	const swiftArchitecture = arch === "x64" ? "x86_64" : "arm64";
	const sources = readdirSync(sourceDirectory)
		.filter((name) => name.endsWith(".swift"))
		.sort()
		.map((name) => resolve(sourceDirectory, name));
	if (sources.length === 0) {
		throw new Error(`No Swift observer sources found under ${sourceDirectory}.`);
	}

	const bundle = resolve(
		projectRoot,
		`.native/macos-${arch}`,
		observerBundleName,
	);
	const contents = resolve(bundle, "Contents");
	const executable = resolve(contents, "MacOS", observerExecutableName);
	rmSync(bundle, { force: true, recursive: true });
	mkdirSync(dirname(executable), { recursive: true });
	mkdirSync(resolve(contents, "Resources"), { recursive: true });

	run([
		"xcrun",
		"swiftc",
		"-swift-version",
		"6",
		"-parse-as-library",
		"-O",
		"-target",
		`${swiftArchitecture}-apple-macos14.0`,
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
		"-o",
		executable,
	]);
	chmodSync(executable, 0o755);
	copyFileSync(
		resolve(observerRoot, "Resources/Info.plist"),
		resolve(contents, "Info.plist"),
	);

	const signing = macSigningPlan();
	const signingCommand = [
		"codesign",
		"--force",
		"--sign",
		signing.identity || "-",
		"--identifier",
		observerIdentifier,
		"--entitlements",
		resolve(observerRoot, "Resources/WhaleHallObserver.entitlements"),
	];
	if (signing.kind === "developer-id") {
		signingCommand.push("--options", "runtime", "--timestamp");
	} else if (signing.kind === "local") {
		if (!signing.identity) throw new Error("Local signing identity is unavailable.");
		signingCommand.push(
			"--requirements",
			localDesignatedRequirement(observerIdentifier, signing.identity),
			"--options",
			"runtime",
			"--timestamp=none",
		);
	} else {
		signingCommand.push("--timestamp=none");
	}
	signingCommand.push(bundle);
	run(signingCommand);
	run(["codesign", "--verify", "--strict", bundle]);
	const signedEntitlements = capture([
		"codesign",
		"--display",
		"--entitlements",
		":-",
		bundle,
	]);
	validateObserverEntitlements(signedEntitlements);
	if (signing.kind === "ad-hoc") {
		console.warn(
			"[native] WhaleHall Observer is ad-hoc signed. This metadata-only "
				+ "build cannot reuse real monitoring or content-vault authorization. "
				+ "Run `bun run setup:macos-signing -- --create` explicitly.",
		);
	}

	console.log(`[native] ${sourceDirectory} -> ${bundle}`);
	return bundle;
}

function signNativeChild(executable: string, arch: TargetArch): void {
	const signing = macSigningPlan();
	const command = [
		"codesign",
		"--force",
		"--sign",
		signing.identity || "-",
		"--identifier",
		localServerIdentifier,
	];
	if (signing.kind === "developer-id") {
		const teamIdentifier = signing.teamIdentifier;
		if (!teamIdentifier) throw new Error("Developer ID Team ID is unavailable.");
		const entitlements = resolve(
			projectRoot,
			`.native/macos-${arch}/WhaleHallLocal.entitlements`,
		);
		writeFileSync(
			entitlements,
			`<?xml version="1.0" encoding="UTF-8"?>\n`
				+ `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" `
				+ `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
				+ `<plist version="1.0"><dict>\n`
				+ `<key>com.apple.application-identifier</key>\n`
				+ `<string>${teamIdentifier}.com.seago.whalehall.local</string>\n`
				+ `<key>keychain-access-groups</key><array>\n`
				+ `<string>${teamIdentifier}.com.seago.whalehall.local</string>\n`
				+ `</array></dict></plist>\n`,
			{ mode: 0o600 },
		);
		command.push(
			"--entitlements",
			entitlements,
			"--options",
			"runtime",
			"--timestamp",
		);
	} else if (signing.kind === "local") {
		if (!signing.identity) throw new Error("Local signing identity is unavailable.");
		command.push(
			"--requirements",
			localDesignatedRequirement(localServerIdentifier, signing.identity),
			"--options",
			"runtime",
			"--timestamp=none",
		);
	} else {
		command.push("--timestamp=none");
	}
	command.push(executable);
	run(command);
	run(["codesign", "--verify", "--strict", executable]);
	if (signing.kind === "ad-hoc") {
		console.warn(
			"[native] whalehall-local is ad-hoc signed. Sensitive content remains "
				+ "metadata-only until the fixed local identity is explicitly installed.",
		);
	}
}

export function buildNative(): string {
	const os = (process.env.ELECTROBUN_OS as TargetOS | undefined) ?? hostOS();
	const arch = (process.env.ELECTROBUN_ARCH as TargetArch | undefined) ?? hostArch();

	if (os !== hostOS() || arch !== hostArch()) {
		throw new Error(
			`Native child builds must run on their target host (host=${hostOS()}-${hostArch()}, target=${os}-${arch}).`,
		);
	}

	run([
		"cargo",
		"build",
		"--release",
		"--locked",
		"--manifest-path",
		manifestPath,
		"--package",
		"whalehall-local-server",
	]);

	const binaryName = os === "win" ? "whalehall-local.exe" : "whalehall-local";
	const source = resolve(projectRoot, "whalehall-local/target/release", binaryName);
	const destination = resolve(projectRoot, `.native/${os}-${arch}`, binaryName);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
	if (os !== "win") chmodSync(destination, 0o755);
	if (os === "macos") {
		// Sign the nested executable before Electrobun signs the outer app.
		// Ad-hoc local builds are explicitly identifiable by the Rust
		// development-only Keychain fallback; release builds require a Team ID.
		signNativeChild(destination, arch);
	}
	console.log(`[native] ${source} -> ${destination}`);
	if (os === "macos") {
		buildObserverApp(arch);
	}
	return destination;
}

if (import.meta.main) buildNative();
