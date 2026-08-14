import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	findPortableExecutableFiles,
	readWindowsSigningConfiguration,
	signAndVerifyWindowsFile,
	verifyWindowsFileSignature,
} from "./app-update-sign-windows";
import { assertElectrobunSignalForwarding } from "./electrobun-signal-forwarding";
import {
	prepareDevelopmentMacWrapperFromEnvironment,
	verifyMacWrapperFromEnvironment,
} from "./macos-build-security";

export function finalizeStableWindowsInstaller(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	if (environment.ELECTROBUN_OS !== "win") return;
	if (environment.ELECTROBUN_BUILD_ENV !== "stable") return;
	const artifactDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_ARTIFACT_DIR",
	);
	const appName = requiredEnvironment(environment, "ELECTROBUN_APP_NAME");
	const architecture = requiredEnvironment(environment, "ELECTROBUN_ARCH");
	if (architecture !== "x64") {
		throw new Error(
			`Stable Windows release only supports x64, received ${architecture}.`,
		);
	}
	const prefix = `stable-win-${architecture}`;
	const archivePath = join(artifactDirectory, `${prefix}-${appName}.tar.zst`);
	const installerPath = join(
		artifactDirectory,
		`${prefix}-${appName}-Setup.zip`,
	);
	for (const path of [archivePath, installerPath]) {
		if (!existsSync(path) || !lstatSync(path).isFile()) {
			throw new Error(`Stable Windows release artifact is missing: ${path}`);
		}
	}
	if (readdirSync(artifactDirectory).some((name) => name.endsWith(".patch"))) {
		throw new Error(
			"Stable releases are full-archive-only and cannot contain patches.",
		);
	}
	const configuration = readWindowsSigningConfiguration(environment);
	const stagingDirectory = mkdtempSync(
		join(tmpdir(), "whalehall-win-release-"),
	);
	const extracted = join(stagingDirectory, "extracted");
	const replacement = join(stagingDirectory, basename(installerPath));
	try {
		verifyStableWindowsUpdateArchive({
			archivePath,
			appName,
			architecture,
			configuration,
			stagingDirectory,
		});
		expandArchive(installerPath, extracted);
		const installerExecutable = join(extracted, `${appName}-Setup.exe`);
		const embeddedArchive = join(
			extracted,
			".installer",
			`${appName}-Setup.tar.zst`,
		);
		if (
			!existsSync(installerExecutable) ||
			!lstatSync(installerExecutable).isFile()
		) {
			throw new Error(
				"Windows installer ZIP is missing its root setup executable.",
			);
		}
		if (!existsSync(embeddedArchive) || !lstatSync(embeddedArchive).isFile()) {
			throw new Error(
				"Windows installer ZIP is missing its embedded full archive.",
			);
		}
		if (fileSha256(embeddedArchive) !== fileSha256(archivePath)) {
			throw new Error(
				"Windows installer embedded archive differs from the updater full archive.",
			);
		}
		signAndVerifyWindowsFile(installerExecutable, configuration);
		compressArchive(extracted, replacement);
		copyFileSync(replacement, `${installerPath}.tmp`);
		rmSync(installerPath, { force: true });
		renameSync(`${installerPath}.tmp`, installerPath);

		const verificationDirectory = join(stagingDirectory, "verification");
		expandArchive(installerPath, verificationDirectory);
		verifyWindowsFileSignature(
			join(verificationDirectory, `${appName}-Setup.exe`),
			configuration,
		);
		if (
			fileSha256(
				join(verificationDirectory, ".installer", `${appName}-Setup.tar.zst`),
			) !== fileSha256(archivePath)
		) {
			throw new Error(
				"Repacked Windows installer changed its embedded archive.",
			);
		}
	} finally {
		rmSync(stagingDirectory, { recursive: true, force: true });
		if (existsSync(`${installerPath}.tmp`)) rmSync(`${installerPath}.tmp`);
	}
	console.log(
		"[app-update] Authenticode-signed and verified the Windows installer.",
	);
}

function verifyStableWindowsUpdateArchive({
	archivePath,
	appName,
	architecture,
	configuration,
	stagingDirectory,
}: {
	archivePath: string;
	appName: string;
	architecture: "x64";
	configuration: ReturnType<typeof readWindowsSigningConfiguration>;
	stagingDirectory: string;
}): void {
	const zstd = join(
		process.cwd(),
		"node_modules",
		"electrobun",
		`dist-win-${architecture}`,
		"zig-zstd.exe",
	);
	if (!existsSync(zstd) || !lstatSync(zstd).isFile()) {
		throw new Error(`Electrobun zstd helper is missing: ${zstd}`);
	}
	const tarPath = join(stagingDirectory, "windows-update.tar");
	const extractionDirectory = join(stagingDirectory, "windows-update");
	mkdirSync(extractionDirectory);
	run([zstd, "decompress", "-i", archivePath, "-o", tarPath]);
	validateWindowsUpdateArchiveEntries(
		capture(["tar", "-tf", tarPath]),
		appName,
	);
	run(["tar", "-xf", tarPath, "-C", extractionDirectory]);
	const executableFiles = findPortableExecutableFiles(
		join(extractionDirectory, appName),
	);
	assertElectrobunSignalForwarding(
		readFileSync(
			join(extractionDirectory, appName, "Resources", "main.js"),
			"utf8",
		),
	);
	if (executableFiles.length === 0) {
		throw new Error("Stable Windows update archive contains no PE files.");
	}
	for (const executable of executableFiles) {
		verifyWindowsFileSignature(executable, configuration);
	}
	console.log(
		`[app-update] Verified ${executableFiles.length} shipped Authenticode signatures.`,
	);
}

export function validateWindowsUpdateArchiveEntries(
	listing: string,
	appName: string,
): string[] {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(appName)) {
		throw new Error("A safe Windows application name is required.");
	}
	const entries = listing.split(/\r?\n/u).filter((entry) => entry.length > 0);
	if (entries.length === 0) {
		throw new Error("The Stable Windows update archive is empty.");
	}
	for (const entry of entries) {
		const normalized = entry.replace(/\/+$/u, "");
		const components = normalized.split("/");
		if (
			entry.includes("\\") ||
			entry.includes("\0") ||
			entry.startsWith("/") ||
			components[0] !== appName ||
			components.some(
				(component) =>
					component === "" || component === "." || component === "..",
			)
		) {
			throw new Error(
				"The Stable Windows update archive contains an unsafe path.",
			);
		}
	}
	for (const required of [
		`${appName}/Resources/version.json`,
		`${appName}/Resources/main.js`,
		`${appName}/Resources/app/bun/index.js`,
	]) {
		if (!entries.includes(required)) {
			throw new Error(
				`The Stable Windows update archive is missing ${required}.`,
			);
		}
	}
	return entries;
}

function expandArchive(source: string, destination: string): void {
	runPowerShell(
		`Expand-Archive -LiteralPath '${escapePowerShell(source)}' ` +
			`-DestinationPath '${escapePowerShell(destination)}' -Force`,
	);
}

function compressArchive(source: string, destination: string): void {
	runPowerShell(
		"Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
			`[System.IO.Compression.ZipFile]::CreateFromDirectory(` +
			`'${escapePowerShell(source)}','${escapePowerShell(destination)}')`,
	);
}

function runPowerShell(script: string): void {
	const result = Bun.spawnSync(
		["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (result.exitCode !== 0) {
		throw new Error(`PowerShell archive command failed (${result.exitCode}).`);
	}
}

function escapePowerShell(value: string): string {
	return value.replace(/'/gu, "''");
}

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requiredEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

if (import.meta.main) {
	verifyEmbeddedUpdatePublicKey();
	prepareDevelopmentMacWrapperFromEnvironment();
	verifyMacWrapperFromEnvironment();
	verifyPackagedElectrobunSignalForwarding();
	verifyStableMacNotarization();
	finalizeStableWindowsInstaller();
}

export function verifyPackagedElectrobunSignalForwarding(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	const buildEnvironment = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_ENV",
	);
	const os = requiredEnvironment(environment, "ELECTROBUN_OS");
	const architecture = requiredEnvironment(environment, "ELECTROBUN_ARCH");
	if (os !== "macos" && os !== "win") return;
	if (
		(os === "macos" && architecture !== "arm64" && architecture !== "x64") ||
		(os === "win" && architecture !== "x64")
	) {
		throw new Error(
			`Unsupported Electrobun signal-verification target: ${os}-${architecture}.`,
		);
	}
	if (buildEnvironment === "dev") return;
	const artifactDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_ARTIFACT_DIR",
	);
	const appName = requiredEnvironment(environment, "ELECTROBUN_APP_NAME");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(appName)) {
		throw new Error("A safe Electrobun application name is required.");
	}
	const bundleSuffix = os === "macos" ? ".app" : "";
	const archivePath = join(
		artifactDirectory,
		`${buildEnvironment}-${os}-${architecture}-${appName}${bundleSuffix}.tar.zst`,
	);
	if (!existsSync(archivePath) || !lstatSync(archivePath).isFile()) {
		throw new Error(
			`Electrobun signal-verification archive is missing: ${archivePath}`,
		);
	}
	const zstd = join(
		process.cwd(),
		"node_modules",
		"electrobun",
		`dist-${os}-${architecture}`,
		os === "win" ? "zig-zstd.exe" : "zig-zstd",
	);
	if (!existsSync(zstd) || !lstatSync(zstd).isFile()) {
		throw new Error(`Electrobun zstd helper is missing: ${zstd}`);
	}
	const stagingDirectory = mkdtempSync(
		join(tmpdir(), "whalehall-signal-package-"),
	);
	const tarPath = join(stagingDirectory, "payload.tar");
	const runtimeEntry =
		os === "macos"
			? `${appName}.app/Contents/Resources/main.js`
			: `${appName}/Resources/main.js`;
	try {
		run([zstd, "decompress", "-i", archivePath, "-o", tarPath]);
		verifyElectrobunSignalForwardingTar(tarPath, runtimeEntry);
	} finally {
		rmSync(stagingDirectory, { recursive: true, force: true });
	}
}

export function verifyElectrobunSignalForwardingTar(
	tarPath: string,
	runtimeEntry: string,
): void {
	if (
		runtimeEntry.includes("\\") ||
		runtimeEntry.includes("\0") ||
		runtimeEntry.startsWith("/") ||
		runtimeEntry
			.split("/")
			.some(
				(component) =>
					component === "" || component === "." || component === "..",
			)
	) {
		throw new Error("A safe Electrobun runtime archive entry is required.");
	}
	const entries = capture(["tar", "-tf", tarPath])
		.split(/\r?\n/u)
		.filter((entry) => entry === runtimeEntry);
	if (entries.length !== 1) {
		throw new Error(
			"Electrobun updater archive must contain one exact runtime main " +
				`(found ${entries.length}).`,
		);
	}
	assertElectrobunSignalForwarding(
		capture(["tar", "-xOf", tarPath, runtimeEntry]),
	);
}

export function verifyStableMacNotarization(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	if (environment.ELECTROBUN_OS !== "macos") return;
	if (environment.ELECTROBUN_BUILD_ENV !== "stable") return;
	const architecture = requiredEnvironment(environment, "ELECTROBUN_ARCH");
	if (architecture !== "arm64") {
		throw new Error(
			`Stable macOS release only supports arm64, received ${architecture}.`,
		);
	}
	const buildDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_DIR",
	);
	const artifactDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_ARTIFACT_DIR",
	);
	const appName = requiredEnvironment(environment, "ELECTROBUN_APP_NAME");
	const wrapper = join(buildDirectory, `${appName}.app`);
	const diskImage = join(
		artifactDirectory,
		`stable-macos-${architecture}-${appName}.dmg`,
	);
	const updateArchive = join(
		artifactDirectory,
		`stable-macos-${architecture}-${appName}.app.tar.zst`,
	);
	for (const path of [wrapper, diskImage, updateArchive]) {
		if (!existsSync(path)) {
			throw new Error(`Stable macOS notarization input is missing: ${path}`);
		}
	}
	run(["xcrun", "stapler", "validate", wrapper]);
	run(["spctl", "--assess", "--type", "execute", "--verbose=4", wrapper]);
	run(["xcrun", "stapler", "validate", diskImage]);

	const zstd = join(
		process.cwd(),
		"node_modules",
		"electrobun",
		`dist-macos-${architecture}`,
		"zig-zstd",
	);
	if (!existsSync(zstd) || !lstatSync(zstd).isFile()) {
		throw new Error(`Electrobun zstd helper is missing: ${zstd}`);
	}
	const stagingDirectory = mkdtempSync(
		join(tmpdir(), "whalehall-notary-check-"),
	);
	const tarPath = join(stagingDirectory, "payload.tar");
	try {
		run([zstd, "decompress", "-i", updateArchive, "-o", tarPath]);
		run(["tar", "-xf", tarPath, "-C", stagingDirectory]);
		const shippedApp = join(stagingDirectory, `${appName}.app`);
		run(["xcrun", "stapler", "validate", shippedApp]);
		run(["spctl", "--assess", "--type", "execute", "--verbose=4", shippedApp]);
	} finally {
		rmSync(stagingDirectory, { recursive: true, force: true });
	}
	console.log(
		"[app-update] Verified notarization tickets on every macOS package.",
	);
}

export function verifyEmbeddedUpdatePublicKey(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	if (environment.ELECTROBUN_BUILD_ENV !== "stable") return;
	const os = requiredEnvironment(environment, "ELECTROBUN_OS");
	const architecture = requiredEnvironment(environment, "ELECTROBUN_ARCH");
	if (
		(os !== "macos" || architecture !== "arm64") &&
		(os !== "win" || architecture !== "x64")
	) {
		throw new Error(
			`Unsupported stable release target: ${os}-${architecture}.`,
		);
	}
	const artifactDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_ARTIFACT_DIR",
	);
	const appName = requiredEnvironment(environment, "ELECTROBUN_APP_NAME");
	const publicKey = requiredEnvironment(
		environment,
		"WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64",
	);
	const platformPrefix = `stable-${os}-${architecture}`;
	const bundleSuffix = os === "macos" ? ".app" : "";
	const archive = join(
		artifactDirectory,
		`${platformPrefix}-${appName}${bundleSuffix}.tar.zst`,
	);
	if (!existsSync(archive) || !lstatSync(archive).isFile()) {
		throw new Error(`Stable full update archive is missing: ${archive}`);
	}
	const zstd = join(
		process.cwd(),
		"node_modules",
		"electrobun",
		`dist-${os}-${architecture}`,
		`zig-zstd${os === "win" ? ".exe" : ""}`,
	);
	if (!existsSync(zstd) || !lstatSync(zstd).isFile()) {
		throw new Error(`Electrobun zstd helper is missing: ${zstd}`);
	}
	const stagingDirectory = mkdtempSync(join(tmpdir(), "whalehall-key-check-"));
	const tarPath = join(stagingDirectory, "payload.tar");
	const mainEntry = embeddedBunEntry(os, appName);
	try {
		run([zstd, "decompress", "-i", archive, "-o", tarPath]);
		const mainBundle = capture(["tar", "-xOf", tarPath, mainEntry]);
		if (!mainBundle.includes(publicKey)) {
			throw new Error(
				"Stable application bundle does not contain the configured update public key.",
			);
		}
	} finally {
		rmSync(stagingDirectory, { recursive: true, force: true });
	}
}

export function embeddedBunEntry(os: "macos" | "win", appName: string): string {
	return os === "macos"
		? `${appName}.app/Contents/Resources/app/bun/index.js`
		: `${appName}/Resources/app/bun/index.js`;
}

function run(command: string[]): void {
	const result = Bun.spawnSync(command, {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) {
		throw new Error(`Command failed (${result.exitCode}): ${command[0]}`);
	}
}

function capture(command: string[]): string {
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (${result.exitCode}): ${command[0]}: ${result.stderr.toString().trim()}`,
		);
	}
	return result.stdout.toString();
}
