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

type TargetOS = "macos" | "linux" | "win";
type TargetArch = "arm64" | "x64";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(projectRoot, "whalehall-local/Cargo.toml");
const observerRoot = resolve(projectRoot, "native/observer");
const observerBundleName = "WhaleHall Observer.app";
const observerExecutableName = "whalehall-observer";
const observerIdentifier = "com.seago.whalehall.observer";
const localServerIdentifier = "com.seago.whalehall.local";

function localSigningIdentity(): string | undefined {
	return process.env.WHALEHALL_LOCAL_SIGNING_IDENTITY?.trim() || undefined;
}

function signingIdentity(): string | undefined {
	return (
		process.env.WHALEHALL_OBSERVER_SIGNING_IDENTITY ??
		process.env.ELECTROBUN_DEVELOPER_ID ??
		process.env.WHALEHALL_LOCAL_SIGNING_IDENTITY
	)?.trim() || undefined;
}

function isLocalSigningIdentity(identity: string | undefined): boolean {
	return identity !== undefined && identity === localSigningIdentity();
}

function releaseSigningRequired(): boolean {
	return (
		process.env.ELECTROBUN_BUILD_ENV === "stable" ||
		process.env.WHALEHALL_RELEASE_SIGNING_REQUIRED === "true"
	);
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

	const identity = signingIdentity();
	if (releaseSigningRequired() && !identity) {
		throw new Error(
			"WHALEHALL_OBSERVER_SIGNING_IDENTITY is required for a signed release build.",
		);
	}
	const signingCommand = [
		"codesign",
		"--force",
		"--sign",
		identity || "-",
		"--identifier",
		observerIdentifier,
		"--entitlements",
		resolve(observerRoot, "Resources/WhaleHallObserver.entitlements"),
	];
	if (identity && !isLocalSigningIdentity(identity)) {
		signingCommand.push("--options", "runtime", "--timestamp");
	} else if (identity) {
		signingCommand.push("--options", "runtime", "--timestamp=none");
	} else {
		signingCommand.push("--timestamp=none");
	}
	signingCommand.push(bundle);
	run(signingCommand);
	run(["codesign", "--verify", "--strict", bundle]);

	console.log(`[native] ${sourceDirectory} -> ${bundle}`);
	return bundle;
}

function signNativeChild(executable: string, arch: TargetArch): void {
	const identity = signingIdentity();
	if (releaseSigningRequired() && !identity) {
		throw new Error(
			"ELECTROBUN_DEVELOPER_ID is required to sign whalehall-local.",
		);
	}
	const command = [
		"codesign",
		"--force",
		"--sign",
		identity || "-",
		"--identifier",
		localServerIdentifier,
	];
	if (identity && !isLocalSigningIdentity(identity)) {
		const teamIdentifier = process.env.WHALEHALL_APPLE_TEAM_ID?.trim();
		if (!teamIdentifier || !/^[A-Z0-9]{10}$/.test(teamIdentifier)) {
			throw new Error(
				"WHALEHALL_APPLE_TEAM_ID must be the 10-character Apple Team ID "
					+ "when signing whalehall-local.",
			);
		}
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
	} else if (identity) {
		command.push("--options", "runtime", "--timestamp=none");
	} else {
		command.push("--timestamp=none");
	}
	command.push(executable);
	run(command);
	run(["codesign", "--verify", "--strict", executable]);
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
