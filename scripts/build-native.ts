import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type MacSigningPlan,
	localDesignatedRequirement,
	readMacCodeSigningIdentities,
	resolveMacSigningPlan,
} from "./macos-signing-identity";
import {
	MACOS_CREDENTIAL_HELPER_IDENTIFIER,
	normalizeDesignatedRequirement,
	validateObserverEntitlements,
	validateSignedComponentDetails,
} from "./macos-build-security";

export const vaultBrokerExecutableName = "whalehall-vault-broker-v2";
export const vaultBrokerIdentifier =
	"com.seago.whalehall.vault-broker.v2";

const outerAppIdentifier = "com.seago.whalehall";

type TargetOS = "macos" | "linux" | "win";
export type TargetArch = "arm64" | "x64";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vaultBrokerRoot = resolve(projectRoot, "native/vault-broker");
const localToolManifestPath = resolve(
	projectRoot,
	"native/local-host/Cargo.toml",
);
const credentialHelperManifestPath = resolve(
	projectRoot,
	"native/credential-helper/Cargo.toml",
);
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

function run(command: string[], cwd: string = projectRoot): void {
	const result = Bun.spawnSync(command, {
		cwd,
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

export function cStringLiteral(value: string): string {
	if (/[^\x20-\x7E]/u.test(value)) {
		throw new Error("Vault Broker requirements must contain printable ASCII only.");
	}
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function vaultBrokerPeerRequirements(signing: MacSigningPlan): {
	core: string;
	outer: string;
	enabled: boolean;
} {
	if (signing.kind === "local") {
		if (!signing.identity) {
			throw new Error("Local Vault Broker signing identity is unavailable.");
		}
		const leaf = signing.identity.toUpperCase();
		if (!/^[A-F0-9]{40}$/u.test(leaf)) {
			throw new Error("Local Vault Broker signing requires a SHA-1 fingerprint.");
		}
		return {
			core: `identifier "${localServerIdentifier}" and certificate leaf = H"${leaf}"`,
			outer: `identifier "${outerAppIdentifier}" and certificate leaf = H"${leaf}"`,
			enabled: true,
		};
	}
	if (signing.kind === "developer-id") {
		if (!signing.teamIdentifier) {
			throw new Error("Developer ID Vault Broker Team ID is unavailable.");
		}
		const teamClause =
			`anchor apple generic and certificate leaf[subject.OU] = "${signing.teamIdentifier}"`;
		return {
			core: `identifier "${localServerIdentifier}" and ${teamClause}`,
			outer: `identifier "${outerAppIdentifier}" and ${teamClause}`,
			enabled: true,
		};
	}
	// An ad-hoc build may carry the executable so packaging stays structurally
	// identical, but no caller can satisfy either requirement.
	return { core: "false", outer: "false", enabled: false };
}

export function vaultBrokerCompileCommand({
	arch,
	source,
	additionalSources = [],
	output,
	signing,
}: {
	arch: TargetArch;
	source: string;
	additionalSources?: readonly string[];
	output: string;
	signing: MacSigningPlan;
}): string[] {
	const requirements = vaultBrokerPeerRequirements(signing);
	return [
		"xcrun",
		"clang",
		"-std=c17",
		"-O2",
		"-fvisibility=hidden",
		// The local-login fallback intentionally uses the only APIs that expose
		// legacy Keychain ACL behavior needed by the installed broker.
		"-Wno-deprecated-declarations",
		"-mmacosx-version-min=14.0",
		"-arch",
		arch === "x64" ? "x86_64" : "arm64",
		"-Wl,-dead_strip",
		`-DWHALEHALL_CORE_REQUIREMENT=${cStringLiteral(requirements.core)}`,
		`-DWHALEHALL_OUTER_REQUIREMENT=${cStringLiteral(requirements.outer)}`,
		`-DWHALEHALL_VAULT_ENABLED=${requirements.enabled ? "1" : "0"}`,
		source,
		...additionalSources,
		"-lbsm",
		"-framework",
		"CoreFoundation",
		"-framework",
		"Security",
		"-o",
		output,
	];
}

export function vaultBrokerCodesignCommand({
	executable,
	signing,
}: {
	executable: string;
	signing: MacSigningPlan;
}): string[] {
	const command = [
		"codesign",
		"--force",
		"--sign",
		signing.identity || "-",
		"--identifier",
		vaultBrokerIdentifier,
	];
	if (signing.kind === "developer-id") {
		if (!signing.teamIdentifier || !signing.identity) {
			throw new Error("Developer ID Vault Broker signing is incomplete.");
		}
		command.push(
			"--requirements",
			`=designated => identifier "${vaultBrokerIdentifier}" and anchor apple generic `
				+ `and certificate leaf[subject.OU] = "${signing.teamIdentifier}"`,
			"--options",
			"runtime",
			"--timestamp",
		);
	} else if (signing.kind === "local") {
		if (!signing.identity) {
			throw new Error("Local Vault Broker signing identity is unavailable.");
		}
		command.push(
			"--requirements",
			localDesignatedRequirement(vaultBrokerIdentifier, signing.identity),
			"--options",
			"runtime",
			"--timestamp=none",
		);
	} else {
		// Even metadata-only builds need a stable explicit DR. Without one,
		// codesign synthesizes an ad-hoc cdhash requirement, which is unsuitable
		// for reproducibility and can be emitted as a commented diagnostic on
		// newer macOS runners.
		command.push(
			"--requirements",
			`=designated => identifier "${vaultBrokerIdentifier}"`,
			"--timestamp=none",
		);
	}
	command.push(executable);
	return command;
}

export function codesignDesignatedRequirementCommand(
	executable: string,
	codesign = "/usr/bin/codesign",
): string[] {
	return [codesign, "--display", "--requirements", "-", executable];
}

export function parseCodeDirectoryHash(output: string): string {
	const hashes = output
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("CDHash="))
		.map((line) => line.slice("CDHash=".length).toUpperCase());
	if (hashes.length !== 1 || !/^[A-F0-9]{40,64}$/u.test(hashes[0] ?? "")) {
		throw new Error("codesign did not return one valid Vault Broker CDHash.");
	}
	return hashes[0] as string;
}

export function parseMachOUuid(output: string): string {
	const uuids = [...output.matchAll(/\buuid\s+([A-Fa-f0-9-]{36})(?:\s|$)/gu)].map(
		(match) => match[1]?.toUpperCase() ?? "",
	);
	if (
		uuids.length !== 1 ||
		!/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/u.test(
			uuids[0] ?? "",
		) ||
		uuids[0] === "00000000-0000-0000-0000-000000000000"
	) {
		throw new Error("Vault Broker must contain exactly one non-zero LC_UUID.");
	}
	return uuids[0] as string;
}

export function validateVaultBrokerReproducibility({
	firstUnsignedHash,
	secondUnsignedHash,
	firstMachODetails,
	secondMachODetails,
	firstSignedDetails,
	secondSignedDetails,
	firstSignedRequirement,
	secondSignedRequirement,
}: {
	firstUnsignedHash: string;
	secondUnsignedHash: string;
	firstMachODetails: string;
	secondMachODetails: string;
	firstSignedDetails: string;
	secondSignedDetails: string;
	firstSignedRequirement: string;
	secondSignedRequirement: string;
}): void {
	if (
		!/^[a-fA-F0-9]{64}$/u.test(firstUnsignedHash) ||
		!/^[a-fA-F0-9]{64}$/u.test(secondUnsignedHash) ||
		firstUnsignedHash.toLowerCase() !== secondUnsignedHash.toLowerCase()
	) {
		throw new Error("Vault Broker compilation is not byte-for-byte reproducible.");
	}
	if (parseMachOUuid(firstMachODetails) !== parseMachOUuid(secondMachODetails)) {
		throw new Error("Vault Broker reproducibility builds have different LC_UUIDs.");
	}
	if (
		parseCodeDirectoryHash(firstSignedDetails) !==
		parseCodeDirectoryHash(secondSignedDetails)
	) {
		throw new Error("Vault Broker signatures do not have the same CDHash.");
	}
	const firstRequirement = normalizeDesignatedRequirement(firstSignedRequirement);
	const secondRequirement = normalizeDesignatedRequirement(secondSignedRequirement);
	if (
		firstRequirement !== secondRequirement ||
		firstRequirement.match(/\bidentifier\s+"([^"]+)"/u)?.[1] !==
			vaultBrokerIdentifier
	) {
		throw new Error(
			"Vault Broker signatures do not have the same designated requirement.",
		);
	}
}

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildVaultBroker(arch: TargetArch): string {
	if (hostOS() !== "macos") {
		throw new Error("WhaleHall Vault Broker can only be built on a macOS host.");
	}
	const source = resolve(vaultBrokerRoot, "main.c");
	const destination = resolve(
		projectRoot,
		`.native/macos-${arch}`,
		vaultBrokerExecutableName,
	);
	const temporaryDirectory = mkdtempSync(
		resolve(tmpdir(), "whalehall-vault-broker-build-"),
	);
	const firstDirectory = resolve(temporaryDirectory, "first");
	const secondDirectory = resolve(temporaryDirectory, "second");
	mkdirSync(firstDirectory);
	mkdirSync(secondDirectory);
	// ld emits an arm64 ad-hoc CodeDirectory whose default identifier derives
	// from the output basename, so both reproducibility builds use the exact
	// installed basename in separate directories.
	const first = resolve(firstDirectory, vaultBrokerExecutableName);
	const second = resolve(secondDirectory, vaultBrokerExecutableName);
	const signing = macSigningPlan();
	try {
		for (const output of [first, second]) {
			run(
				vaultBrokerCompileCommand({
					arch,
					source,
					additionalSources: [
						resolve(vaultBrokerRoot, "frame.c"),
						resolve(vaultBrokerRoot, "keychain_store.c"),
						resolve(vaultBrokerRoot, "process_guard.c"),
					],
					output,
					signing,
				}),
				temporaryDirectory,
			);
			chmodSync(output, 0o755);
		}
		const firstUnsignedHash = fileSha256(first);
		const secondUnsignedHash = fileSha256(second);
		if (firstUnsignedHash !== secondUnsignedHash) {
			throw new Error("Vault Broker compilation is not byte-for-byte reproducible.");
		}
		for (const output of [first, second]) {
			run(vaultBrokerCodesignCommand({ executable: output, signing }));
			run(["codesign", "--verify", "--strict", output]);
		}
		validateVaultBrokerReproducibility({
			firstUnsignedHash,
			secondUnsignedHash,
			firstMachODetails: capture(["/usr/bin/otool", "-l", first]),
			secondMachODetails: capture(["/usr/bin/otool", "-l", second]),
			firstSignedDetails: capture([
				"codesign",
				"--display",
				"--verbose=4",
				first,
			]),
			secondSignedDetails: capture([
				"codesign",
				"--display",
				"--verbose=4",
				second,
			]),
			firstSignedRequirement: capture(codesignDesignatedRequirementCommand(first)),
			secondSignedRequirement: capture(codesignDesignatedRequirementCommand(second)),
		});
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(first, destination);
		chmodSync(destination, 0o755);
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
	console.log(`[native] ${source} -> ${destination}`);
	return destination;
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

export function credentialHelperCodesignCommand({
	executable,
	signing,
}: {
	executable: string;
	signing: MacSigningPlan;
}): string[] {
	const command = [
		"codesign",
		"--force",
		"--sign",
		signing.identity || "-",
		"--identifier",
		MACOS_CREDENTIAL_HELPER_IDENTIFIER,
	];
	if (signing.kind === "developer-id") {
		if (!signing.identity || !signing.teamIdentifier) {
			throw new Error("Developer ID credential helper signing is incomplete.");
		}
		command.push(
			"--requirements",
			`=designated => identifier "${MACOS_CREDENTIAL_HELPER_IDENTIFIER}" `
				+ "and anchor apple generic and certificate leaf[subject.OU] = "
				+ `"${signing.teamIdentifier}"`,
			"--options",
			"runtime",
			"--timestamp",
		);
	} else if (signing.kind === "local") {
		if (!signing.identity) {
			throw new Error("Local credential helper signing identity is unavailable.");
		}
		command.push(
			"--requirements",
			localDesignatedRequirement(
				MACOS_CREDENTIAL_HELPER_IDENTIFIER,
				signing.identity,
			),
			"--options",
			"runtime",
			"--timestamp=none",
		);
	} else {
		command.push("--timestamp=none");
	}
	command.push(executable);
	return command;
}

function signCredentialHelper(executable: string): void {
	const signing = macSigningPlan();
	run(credentialHelperCodesignCommand({ executable, signing }));
	run(["codesign", "--verify", "--strict", executable]);
	validateSignedComponentDetails({
		details: capture([
			"codesign",
			"--display",
			"--verbose=4",
			executable,
		]),
		expectedIdentifier: MACOS_CREDENTIAL_HELPER_IDENTIFIER,
		expectedTeamIdentifier:
			signing.kind === "developer-id" ? signing.teamIdentifier ?? null : null,
	});
	if (signing.kind === "ad-hoc") {
		console.warn(
			"[native] whalehall-credential-helper is ad-hoc signed. This build "
				+ "cannot provide reusable local signature continuity.",
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
		localToolManifestPath,
		"--package",
		"whalehall-local-server",
	]);
	run([
		"cargo",
		"build",
		"--release",
		"--locked",
		"--manifest-path",
		credentialHelperManifestPath,
		"--package",
		"whalehall-credential-helper",
	]);

	const binaryName = os === "win" ? "whalehall-local.exe" : "whalehall-local";
	const source = resolve(
		projectRoot,
		"native/local-host/target/release",
		binaryName,
	);
	const destination = resolve(projectRoot, `.native/${os}-${arch}`, binaryName);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
	if (os !== "win") chmodSync(destination, 0o755);
	if (os === "macos") {
		// Sign the nested executable before Electrobun signs the outer app.
		// Ad-hoc builds remain metadata-only; fixed local certificates use the
		// versioned Broker, while release builds require a Team ID.
		signNativeChild(destination, arch);
	}
	console.log(`[native] ${source} -> ${destination}`);

	const helperBinaryName =
		os === "win"
			? "whalehall-credential-helper.exe"
			: "whalehall-credential-helper";
	const helperSource = resolve(
		projectRoot,
		"native/credential-helper/target/release",
		helperBinaryName,
	);
	const helperDestination = resolve(
		projectRoot,
		`.native/${os}-${arch}`,
		helperBinaryName,
	);
	copyFileSync(helperSource, helperDestination);
	if (os !== "win") chmodSync(helperDestination, 0o755);
	if (os === "macos") signCredentialHelper(helperDestination);
	console.log(`[native] ${helperSource} -> ${helperDestination}`);

	if (os === "macos") {
		buildVaultBroker(arch);
		buildObserverApp(arch);
	}
	return destination;
}

if (import.meta.main) buildNative();
