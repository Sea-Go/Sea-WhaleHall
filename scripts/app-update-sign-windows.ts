import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface WindowsSigningConfiguration {
	certificatePath: string;
	certificatePassword: string;
	certificateSha1: string;
	publisher: string;
	signtoolPath: string;
	timestampUrl: string;
}

interface AuthenticodeDescription {
	status: string;
	thumbprint: string;
	subject: string;
}

export function readWindowsSigningConfiguration(
	environment: NodeJS.ProcessEnv = process.env,
): WindowsSigningConfiguration {
	const required = (name: string): string => {
		const value = environment[name]?.trim();
		if (!value)
			throw new Error(`${name} is required for stable Windows signing.`);
		return value;
	};
	const certificatePassword =
		environment.WHALEHALL_WINDOWS_CERTIFICATE_PASSWORD;
	if (certificatePassword === undefined || certificatePassword.length === 0) {
		throw new Error(
			"WHALEHALL_WINDOWS_CERTIFICATE_PASSWORD is required for stable Windows signing.",
		);
	}
	const certificateSha1 = required(
		"WHALEHALL_WINDOWS_CERTIFICATE_SHA1",
	).toUpperCase();
	if (!/^[A-F0-9]{40}$/u.test(certificateSha1)) {
		throw new Error(
			"WHALEHALL_WINDOWS_CERTIFICATE_SHA1 must be a 40-character SHA-1 thumbprint.",
		);
	}
	const timestampUrl =
		environment.WHALEHALL_WINDOWS_TIMESTAMP_URL?.trim() ??
		"https://timestamp.digicert.com";
	const parsedTimestampUrl = new URL(timestampUrl);
	if (
		parsedTimestampUrl.protocol !== "https:" ||
		parsedTimestampUrl.username !== "" ||
		parsedTimestampUrl.password !== ""
	) {
		throw new Error("The Authenticode timestamp service must use HTTPS.");
	}
	const configuration = {
		certificatePath: resolve(required("WHALEHALL_WINDOWS_CERTIFICATE_PATH")),
		certificatePassword,
		certificateSha1,
		publisher: required("WHALEHALL_WINDOWS_PUBLISHER"),
		signtoolPath: resolve(required("WHALEHALL_WINDOWS_SIGNTOOL_PATH")),
		timestampUrl: parsedTimestampUrl.toString().replace(/\/$/u, ""),
	};
	for (const path of [
		configuration.certificatePath,
		configuration.signtoolPath,
	]) {
		if (!existsSync(path) || !lstatSync(path).isFile()) {
			throw new Error(`Windows signing input is not a regular file: ${path}`);
		}
	}
	return configuration;
}

export function windowsSignCommand(
	path: string,
	configuration: WindowsSigningConfiguration,
): string[] {
	return [
		configuration.signtoolPath,
		"sign",
		"/f",
		configuration.certificatePath,
		"/p",
		configuration.certificatePassword,
		"/fd",
		"SHA256",
		"/td",
		"SHA256",
		"/tr",
		configuration.timestampUrl,
		resolve(path),
	];
}

export function parseAuthenticodeDescription(
	output: string,
): AuthenticodeDescription {
	const parsed: unknown = JSON.parse(output.trim());
	if (!isRecord(parsed)) {
		throw new Error("Authenticode verification returned an invalid result.");
	}
	const status = parsed.status;
	const thumbprint = parsed.thumbprint;
	const subject = parsed.subject;
	if (typeof status !== "string" || status.trim() === "") {
		throw new Error("Authenticode verification omitted status.");
	}
	if (typeof thumbprint !== "string" || thumbprint.trim() === "") {
		throw new Error("Authenticode verification omitted thumbprint.");
	}
	if (typeof subject !== "string" || subject.trim() === "") {
		throw new Error("Authenticode verification omitted subject.");
	}
	return {
		status,
		thumbprint: thumbprint.toUpperCase(),
		subject,
	};
}

export function assertExpectedAuthenticodeSignature(
	description: AuthenticodeDescription,
	configuration: Pick<
		WindowsSigningConfiguration,
		"certificateSha1" | "publisher"
	>,
): void {
	if (description.status !== "Valid") {
		throw new Error(`Authenticode signature status is ${description.status}.`);
	}
	if (description.thumbprint !== configuration.certificateSha1) {
		throw new Error(
			`Authenticode signer thumbprint mismatch: ${description.thumbprint}.`,
		);
	}
	if (description.subject !== configuration.publisher) {
		throw new Error(`Authenticode publisher mismatch: ${description.subject}.`);
	}
}

export function findPortableExecutableFiles(root: string): string[] {
	const resolvedRoot = resolve(root);
	if (!existsSync(resolvedRoot) || !lstatSync(resolvedRoot).isDirectory()) {
		throw new Error(`Windows application bundle is missing: ${resolvedRoot}`);
	}
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`Windows application bundle contains a link: ${path}`);
			}
			if (entry.isDirectory()) {
				visit(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const stats = lstatSync(path);
			if (stats.nlink !== 1) {
				throw new Error(
					`Windows application bundle contains a hard link: ${path}`,
				);
			}
			const descriptor = openSync(path, "r");
			const header = Buffer.alloc(2);
			let bytesRead = 0;
			try {
				bytesRead = readSync(descriptor, header, 0, header.byteLength, 0);
			} finally {
				closeSync(descriptor);
			}
			const magic = bytesRead === 2 ? header.toString("ascii") : "";
			if (magic === "MZ") files.push(path);
		}
	};
	visit(resolvedRoot);
	return files.sort();
}

export function signAndVerifyWindowsFile(
	path: string,
	configuration: WindowsSigningConfiguration,
): void {
	run(windowsSignCommand(path, configuration));
	verifyWindowsFileSignature(path, configuration);
}

export function verifyWindowsFileSignature(
	path: string,
	configuration: WindowsSigningConfiguration,
): void {
	run([
		configuration.signtoolPath,
		"verify",
		"/pa",
		"/all",
		"/v",
		resolve(path),
	]);
	const escapedPath = resolve(path).replace(/'/gu, "''");
	const output = capture([
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'; ` +
			`[pscustomobject]@{status=[string]$signature.Status; ` +
			`thumbprint=[string]$signature.SignerCertificate.Thumbprint; ` +
			`subject=[string]$signature.SignerCertificate.Subject} ` +
			"| ConvertTo-Json -Compress",
	]);
	assertExpectedAuthenticodeSignature(
		parseAuthenticodeDescription(output),
		configuration,
	);
}

export function signStableWindowsBundle(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	if (environment.ELECTROBUN_OS !== "win") return;
	if (environment.ELECTROBUN_BUILD_ENV !== "stable") return;
	const buildDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_DIR",
	);
	const appName = requiredEnvironment(environment, "ELECTROBUN_APP_NAME");
	const bundlePath = join(buildDirectory, appName);
	const configuration = readWindowsSigningConfiguration(environment);
	const executables = findPortableExecutableFiles(bundlePath);
	if (executables.length === 0) {
		throw new Error(
			"Stable Windows application bundle contains no signable PE files.",
		);
	}
	for (const executable of executables) {
		signAndVerifyWindowsFile(executable, configuration);
	}
	console.log(
		`[app-update] Authenticode-signed ${executables.length} Windows application files.`,
	);
}

function requiredEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required.`);
	return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) signStableWindowsBundle();
