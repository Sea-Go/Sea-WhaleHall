import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, randomBytes } from "node:crypto";
import {
	MACOS_LOCAL_SIGNING_COMMON_NAME,
	readMacCodeSigningIdentities,
	readUserLoginKeychainPath,
	selectUniqueLocalSigningIdentity,
} from "./macos-signing-identity";

interface LocalSigningInspection {
	state: "missing" | "ready" | "conflict";
	keychain: string;
	validFingerprint?: string;
	certificateFingerprints: string[];
}

function inspectLocalSigningIdentity(): LocalSigningInspection {
	const keychain = readUserLoginKeychainPath(capture);
	const identities = readMacCodeSigningIdentities(capture);
	const validIdentity = selectUniqueLocalSigningIdentity(identities);
	const certificates = matchingCertificates(keychain);
	if (
		certificates.length === 1 &&
		validIdentity &&
		certificates[0]?.fingerprint === validIdentity.fingerprint
	) {
		return {
			state: "ready",
			keychain,
			validFingerprint: validIdentity.fingerprint,
			certificateFingerprints: certificates.map(
				(certificate) => certificate.fingerprint,
			),
		};
	}
	if (certificates.length > 0 || validIdentity) {
		return {
			state: "conflict",
			keychain,
			validFingerprint: validIdentity?.fingerprint,
			certificateFingerprints: certificates.map(
				(certificate) => certificate.fingerprint,
			),
		};
	}
	return { state: "missing", keychain, certificateFingerprints: [] };
}

function matchingCertificates(
	keychain: string,
): Array<{ fingerprint: string; certificate: X509Certificate }> {
	const result = spawn([
		"/usr/bin/security",
		"find-certificate",
		"-a",
		"-c",
		MACOS_LOCAL_SIGNING_COMMON_NAME,
		"-p",
		keychain,
	]);
	if (result.exitCode !== 0) {
		if (
			result.stderr.includes("could not be found") ||
			result.stderr.includes("SecKeychainSearchCopyNext")
		) {
			return [];
		}
		throw commandError(result);
	}
	const blocks =
		result.stdout.match(
			/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
		) ?? [];
	return blocks
		.map((pem) => new X509Certificate(pem))
		.filter(
			(certificate) =>
				commonName(certificate.subject) ===
				MACOS_LOCAL_SIGNING_COMMON_NAME,
		)
		.map((certificate) => ({
			fingerprint: certificate.fingerprint.replaceAll(":", "").toUpperCase(),
			certificate,
		}));
}

function createLocalSigningIdentity(keychain: string): void {
	const temporaryDirectory = mkdtempSync(
		join(tmpdir(), "whalehall-local-signing-"),
	);
	chmodSync(temporaryDirectory, 0o700);
	const previousUmask = process.umask(0o077);
	const configurationPath = join(temporaryDirectory, "openssl.cnf");
	const privateKeyPath = join(temporaryDirectory, "identity.key");
	const certificatePath = join(temporaryDirectory, "identity.pem");
	const archivePath = join(temporaryDirectory, "identity.p12");
	const passphrase = randomBytes(32).toString("base64url");
	let generatedFingerprint: string | undefined;
	let importAttempted = false;

	try {
		writeFileSync(
			configurationPath,
			`[req]\n`
				+ `prompt = no\n`
				+ `distinguished_name = subject\n`
				+ `x509_extensions = extensions\n`
				+ `[subject]\n`
				+ `CN = ${MACOS_LOCAL_SIGNING_COMMON_NAME}\n`
				+ `O = WhaleHall\n`
				+ `OU = Local Development\n`
				+ `[extensions]\n`
				+ `basicConstraints = critical,CA:false\n`
				+ `keyUsage = critical,digitalSignature\n`
				+ `extendedKeyUsage = critical,codeSigning\n`
				+ `subjectKeyIdentifier = hash\n`
				+ `authorityKeyIdentifier = keyid,issuer\n`,
			{ mode: 0o600 },
		);
		run([
			"/usr/bin/openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:3072",
			"-sha256",
			"-days",
			"3650",
			"-nodes",
			"-config",
			configurationPath,
			"-keyout",
			privateKeyPath,
			"-out",
			certificatePath,
		]);
		chmodSync(privateKeyPath, 0o600);
		chmodSync(certificatePath, 0o600);
		generatedFingerprint = verifyGeneratedCertificate(certificatePath);

		run(
			[
				"/usr/bin/openssl",
				"pkcs12",
				"-export",
				"-inkey",
				privateKeyPath,
				"-in",
				certificatePath,
				"-out",
				archivePath,
				"-passout",
				"env:WHALEHALL_SETUP_P12_PASSWORD",
			],
			{ WHALEHALL_SETUP_P12_PASSWORD: passphrase },
		);
		chmodSync(archivePath, 0o600);

		// `-T` scopes private-key use to codesign. Never replace it with `-A`.
		importAttempted = true;
		run([
			"/usr/bin/security",
			"import",
			archivePath,
			"-k",
			keychain,
			"-f",
			"pkcs12",
			"-P",
			passphrase,
			"-x",
			"-T",
			"/usr/bin/codesign",
		]);
		// User-domain trust is the only step expected to request macOS approval.
		run([
			"/usr/bin/security",
			"add-trusted-cert",
			"-r",
			"trustRoot",
			"-p",
			"codeSign",
			"-k",
			keychain,
			certificatePath,
		]);

		const inspection = inspectLocalSigningIdentity();
			if (inspection.state !== "ready" || !inspection.validFingerprint) {
				throw new Error(
					"The imported certificate was not exposed as one unique valid "
						+ "code-signing identity. Existing Keychain items were retained.",
				);
			}
			verifyPersistentSigningAccess(inspection.validFingerprint);
	} catch (error) {
		if (importAttempted && generatedFingerprint) {
			const rollbackError = rollbackCreatedIdentity(
				generatedFingerprint,
				keychain,
			);
			if (rollbackError) {
				throw new Error(
					`${error instanceof Error ? error.message : String(error)} `
						+ `Automatic rollback of the newly created identity failed: `
						+ rollbackError.message,
					{ cause: error },
				);
			}
		}
		throw error;
	} finally {
		process.umask(previousUmask);
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

/**
 * Runs two independent real codesign operations. The first use may make macOS
 * offer "Always Allow" for the `apple:` Keychain partition; the second proves
 * that the choice persisted instead of granting only one transient signature.
 * This is called only from the explicit mutating setup command.
 */
function verifyPersistentSigningAccess(fingerprint: string): void {
	const temporaryDirectory = mkdtempSync(
		join(tmpdir(), "whalehall-local-signing-check-"),
	);
	chmodSync(temporaryDirectory, 0o700);
	const previousUmask = process.umask(0o077);
	try {
		for (const target of localSigningAccessVerificationTargets(fingerprint)) {
			const executable = join(temporaryDirectory, target.fileName);
			copyFileSync("/usr/bin/true", executable);
			chmodSync(executable, 0o700);
			run([
				"/usr/bin/codesign",
				"--force",
				"--sign",
				fingerprint,
				"--identifier",
				target.identifier,
				"--requirements",
				`=designated => identifier "${target.identifier}" `
					+ `and certificate leaf = H"${fingerprint}"`,
				"--options",
				"runtime",
				"--timestamp=none",
				executable,
			]);
			run(["/usr/bin/codesign", "--verify", "--strict", executable]);
			const requirement = capture([
				"/usr/bin/codesign",
				"--display",
				"--requirements",
				"-",
				executable,
			]);
			if (
				requirement.includes("cdhash") ||
				!requirement.includes(`identifier "${target.identifier}"`) ||
				!new RegExp(
					`certificate\\s+leaf\\s*=\\s*H"${fingerprint}"`,
					"iu",
				).test(requirement)
			) {
				throw new Error(
					"The local identity produced an unstable designated requirement.",
				);
			}
		}
	} finally {
		process.umask(previousUmask);
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

export function localSigningAccessVerificationTargets(
	fingerprint: string,
): ReadonlyArray<{ identifier: string; fileName: string }> {
	if (!/^[A-F0-9]{40}$/u.test(fingerprint)) {
		throw new Error("Local signing verification requires a SHA-1 fingerprint.");
	}
	return ["primary", "persistence"].map((suffix) => ({
		identifier: `com.seago.whalehall.local-signing-check.${suffix}`,
		fileName: `signing-check-${suffix}`,
	}));
}

function verifyGeneratedCertificate(path: string): string {
	const certificate = new X509Certificate(readFileSync(path));
	if (commonName(certificate.subject) !== MACOS_LOCAL_SIGNING_COMMON_NAME) {
		throw new Error("Generated certificate common name is incorrect.");
	}
	if (!certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.3")) {
		throw new Error("Generated certificate is missing the code-signing EKU.");
	}
	// Evaluate the self-signed leaf against itself as an isolated code-signing
	// root before any Keychain write. This exercises CA:false + explicit trust
	// without modifying the user's trust settings during verification.
	run([
		"/usr/bin/security",
		"verify-cert",
		"-c",
		path,
		"-r",
		path,
		"-p",
		"codeSign",
		"-N",
		"-L",
	]);
	return certificate.fingerprint.replaceAll(":", "").toUpperCase();
}

function rollbackCreatedIdentity(
	fingerprint: string,
	keychain: string,
): Error | undefined {
	const identityDeletion = spawn([
		"/usr/bin/security",
		"delete-identity",
		"-Z",
		fingerprint,
		"-t",
		keychain,
	]);
	if (identityDeletion.exitCode === 0) return undefined;

	const certificateDeletion = spawn([
		"/usr/bin/security",
		"delete-certificate",
		"-Z",
		fingerprint,
		"-t",
		keychain,
	]);
	if (
		certificateDeletion.exitCode === 0 ||
		(isNotFound(identityDeletion) && isNotFound(certificateDeletion))
	) {
		return undefined;
	}
	return commandError(identityDeletion);
}

function commonName(subject: string): string | undefined {
	return subject
		.split(/\r?\n/u)
		.find((part) => part.startsWith("CN="))
		?.slice(3);
}

function report(inspection: LocalSigningInspection): void {
	if (inspection.state === "ready") {
		console.log(
			`[macos-signing] Ready: "${MACOS_LOCAL_SIGNING_COMMON_NAME}" `
				+ `(${inspection.validFingerprint}) in ${inspection.keychain}.`,
		);
		return;
	}
	if (inspection.state === "missing") {
		console.log(
			`[macos-signing] Missing: no "${MACOS_LOCAL_SIGNING_COMMON_NAME}" `
				+ "identity is installed. Builds remain metadata-only until you run "
				+ "`bun run setup:macos-signing -- --create`.",
		);
		return;
	}
	console.error(
		`[macos-signing] Conflict: "${MACOS_LOCAL_SIGNING_COMMON_NAME}" does `
			+ "not resolve to exactly one valid certificate/private-key pair. "
			+ "No Keychain item was changed.",
	);
}

interface SpawnResult {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawn(
	command: string[],
	additionalEnvironment: Record<string, string> = {},
): SpawnResult {
	const result = Bun.spawnSync(command, {
		env: { ...process.env, ...additionalEnvironment },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		command,
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function run(
	command: string[],
	additionalEnvironment: Record<string, string> = {},
): void {
	const result = spawn(command, additionalEnvironment);
	if (result.exitCode !== 0) throw commandError(result);
}

function capture(command: readonly string[]): string {
	const result = spawn([...command]);
	if (result.exitCode !== 0) throw commandError(result);
	return `${result.stdout}${result.stderr}`;
}

function commandError(result: SpawnResult): Error {
	const detail = result.stderr.trim().replaceAll("\n", " ");
	return new Error(
		`Command failed (${result.exitCode}): ${result.command[0]}`
			+ (detail ? `: ${detail}` : ""),
	);
}

function isNotFound(result: SpawnResult): boolean {
	return (
		result.stderr.includes("could not be found") ||
		result.stderr.includes("SecKeychainSearchCopyNext")
	);
}

function main(): void {
	if (process.platform !== "darwin") {
		throw new Error("WhaleHall local signing setup is available only on macOS.");
	}
	const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
	if (
		arguments_.some((argument) => argument !== "--create") ||
		arguments_.filter((argument) => argument === "--create").length > 1
	) {
		throw new Error(
			"Usage: bun run setup:macos-signing [-- --create]. "
				+ "Without --create the command is read-only.",
		);
	}
	const create = arguments_.includes("--create");
	const before = inspectLocalSigningIdentity();
	report(before);
	if (!create) return;
	if (before.state === "ready") {
		if (!before.validFingerprint) {
			throw new Error("The ready local identity has no fingerprint.");
		}
		console.log(
			"[macos-signing] Verifying persistent private-key access. If macOS "
				+ 'asks, choose "Always Allow"; choosing only "Allow" is transient.',
		);
		verifyPersistentSigningAccess(before.validFingerprint);
		console.log("[macos-signing] Persistent codesign access verified.");
		return;
	}
	if (before.state === "conflict") {
		throw new Error(
			"Resolve the conflicting Keychain items manually before creating "
				+ "a WhaleHall local signing identity.",
		);
	}
	console.log(
		"[macos-signing] Creating one current-user identity. macOS may request "
			+ 'private-key access; choose "Always Allow" so later builds stay silent. '
			+ "No existing item will be replaced or deleted.",
	);
	createLocalSigningIdentity(before.keychain);
	const after = inspectLocalSigningIdentity();
	report(after);
	if (after.state !== "ready") {
		throw new Error("WhaleHall local signing setup did not complete.");
	}
}

if (import.meta.main) main();
