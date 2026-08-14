import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	localDesignatedRequirement,
	readMacCodeSigningIdentities,
	resolveMacSigningPlan,
	type MacSigningKind,
} from "./macos-signing-identity";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const MACOS_OUTER_ENTITLEMENTS = {
	"com.apple.security.cs.allow-jit": true,
	"com.apple.security.cs.allow-unsigned-executable-memory": true,
	"com.apple.security.cs.disable-library-validation": true,
	"com.apple.security.automation.apple-events": true,
} as const;

export const MACOS_USAGE_DESCRIPTIONS = {
	NSAccessibilityUsageDescription:
		"WhaleHall 需要读取当前前台应用中明确授权的可见控件和文本，以在本机整理活动事件。",
	NSAppleEventsUsageDescription:
		"WhaleHall 需要读取当前前台浏览器标签页的标题和网址；不会读取后台标签页、Cookie 或历史记录。",
	NSScreenCaptureUsageDescription:
		"WhaleHall 仅在内存中识别当前前台窗口的可见文本，识别完成后立即销毁截图。",
} as const;

const MACOS_LOCAL_SERVER_IDENTIFIER = "com.seago.whalehall.local";
const MACOS_OBSERVER_IDENTIFIER = "com.seago.whalehall.observer";
export const MACOS_CREDENTIAL_HELPER_IDENTIFIER =
	"com.seago.whalehall.credential-helper";
export const MACOS_CREDENTIAL_HELPER_EXECUTABLE =
	"whalehall-credential-helper";
export const MACOS_VAULT_BROKER_IDENTIFIER =
	"com.seago.whalehall.vault-broker.v2";
export const MACOS_VAULT_BROKER_EXECUTABLE = "whalehall-vault-broker-v2";

export function shouldMaterializeMacUpdateArchive(
	signingKind: MacSigningKind,
): boolean {
	return signingKind !== "developer-id";
}

interface PrepareMacWrapperOptions {
	bundlePath: string;
	buildDirectory: string;
	appIdentifier: string;
	electrobunWillSign: boolean;
	developerIdentity?: string;
	localIdentity?: string;
}

interface VerifyMacWrapperOptions {
	bundlePath: string;
	appIdentifier: string;
	requireTeamIdentifier: boolean;
	localSigningStagedNativeDirectory?: string;
	stagedVaultBrokerDirectory?: string;
}

export function prepareMacWrapper({
	bundlePath,
	buildDirectory,
	appIdentifier,
	electrobunWillSign,
	developerIdentity,
	localIdentity,
}: PrepareMacWrapperOptions): void {
	assertSafeBundlePath(bundlePath, buildDirectory);
	const infoPlist = join(bundlePath, "Contents", "Info.plist");
	if (!existsSync(infoPlist)) {
		throw new Error(`Missing macOS wrapper Info.plist: ${infoPlist}`);
	}
	const actualIdentifier = readPlistString(infoPlist, "CFBundleIdentifier");
	if (actualIdentifier !== appIdentifier) {
		throw new Error(
			`Wrapper identifier mismatch: expected ${appIdentifier}, received ${actualIdentifier}.`,
		);
	}
	for (const [key, description] of Object.entries(
		MACOS_USAGE_DESCRIPTIONS,
	)) {
		setPlistString(infoPlist, key, description);
	}

	if (electrobunWillSign) return;

	const entitlementsPath = writeOuterEntitlements(buildDirectory);
	const identity = developerIdentity ?? localIdentity ?? "-";
	const command = [
		"/usr/bin/codesign",
		"--force",
		"--sign",
		identity,
		"--identifier",
		appIdentifier,
		"--entitlements",
		entitlementsPath,
		"--options",
		"runtime",
	];
	if (developerIdentity) {
		command.push("--timestamp");
	} else if (localIdentity) {
		command.push(
			"--requirements",
			localDesignatedRequirement(appIdentifier, localIdentity),
			"--timestamp=none",
		);
	} else {
		command.push("--timestamp=none");
	}
	command.push(bundlePath);
	run(command);
	run([
		"/usr/bin/codesign",
		"--verify",
		"--deep",
		"--strict",
		bundlePath,
	]);
	if (identity === "-") {
		console.warn(
			"[macos-build-security] Canary wrapper uses a per-build ad-hoc TCC identity. "
				+ "This build is metadata-only; run "
				+ "`bun run setup:macos-signing -- --create` explicitly before "
				+ "collecting real content.",
		);
	}
}

export function verifyMacWrapper({
	bundlePath,
	appIdentifier,
	requireTeamIdentifier,
	localSigningStagedNativeDirectory,
	stagedVaultBrokerDirectory,
}: VerifyMacWrapperOptions): void {
	const infoPlist = join(bundlePath, "Contents", "Info.plist");
	run([
		"/usr/bin/codesign",
		"--verify",
		"--deep",
		"--strict",
		bundlePath,
	]);
	const details = capture([
		"/usr/bin/codesign",
		"--display",
		"--verbose=4",
		bundlePath,
	]);
	if (!details.includes(`Identifier=${appIdentifier}`)) {
		throw new Error(
			`Signed wrapper does not use the canonical identifier ${appIdentifier}.`,
		);
	}
	if (
		requireTeamIdentifier &&
		(!/TeamIdentifier=[A-Z0-9]{10}(?:\n|$)/.test(details) ||
			details.includes("TeamIdentifier=not set"))
	) {
		throw new Error("Signed release wrapper is missing a valid TeamIdentifier.");
	}
	const outerTeamIdentifier =
		details.match(/TeamIdentifier=([A-Z0-9]{10})(?:\n|$)/)?.[1] ?? null;
	for (const [key, expected] of Object.entries(MACOS_USAGE_DESCRIPTIONS)) {
		if (readPlistString(infoPlist, key) !== expected) {
			throw new Error(`Signed wrapper is missing ${key}.`);
		}
	}
	const entitlements = capture([
		"/usr/bin/codesign",
		"--display",
		"--entitlements",
		":-",
		bundlePath,
	]);
	if (
		!entitlements.includes(
			"<key>com.apple.security.automation.apple-events</key>",
		) ||
		!entitlements.includes("<true/>")
	) {
		throw new Error(
			"Signed wrapper is missing the Apple Events automation entitlement.",
		);
	}

	withPackagedNativeDirectory(
		bundlePath,
		requireTeamIdentifier ||
			localSigningStagedNativeDirectory !== undefined ||
			stagedVaultBrokerDirectory !== undefined,
		(nativeDirectory) => {
			const localServerPath = join(nativeDirectory, "whalehall-local");
			const credentialHelperPath = join(
				nativeDirectory,
				MACOS_CREDENTIAL_HELPER_EXECUTABLE,
			);
			const observerPath = join(nativeDirectory, "WhaleHall Observer.app");
			const vaultBrokerPath = join(
				nativeDirectory,
				MACOS_VAULT_BROKER_EXECUTABLE,
			);
			assertRequiredMacNativeComponents(nativeDirectory);
			verifySignedComponent(
				localServerPath,
				MACOS_LOCAL_SERVER_IDENTIFIER,
				outerTeamIdentifier,
			);
			if (requireTeamIdentifier && outerTeamIdentifier !== null) {
				const localEntitlements = capture([
					"/usr/bin/codesign",
					"--display",
					"--entitlements",
					":-",
					localServerPath,
				]);
				for (const requiredValue of [
					`${outerTeamIdentifier}.${MACOS_LOCAL_SERVER_IDENTIFIER}`,
					"keychain-access-groups",
				]) {
					if (!localEntitlements.includes(requiredValue)) {
						throw new Error(
							`Signed local server is missing ${requiredValue}.`,
						);
					}
				}
			}
			verifySignedComponent(
				credentialHelperPath,
				MACOS_CREDENTIAL_HELPER_IDENTIFIER,
				outerTeamIdentifier,
			);
			verifySignedComponent(
				observerPath,
				MACOS_OBSERVER_IDENTIFIER,
				outerTeamIdentifier,
			);
			const observerEntitlements = capture([
				"/usr/bin/codesign",
				"--display",
				"--entitlements",
				":-",
				observerPath,
			]);
			validateObserverEntitlements(observerEntitlements);
			verifySignedComponent(
				vaultBrokerPath,
				MACOS_VAULT_BROKER_IDENTIFIER,
				outerTeamIdentifier,
			);
			if (stagedVaultBrokerDirectory) {
				verifyVaultBrokerContinuity({
					stagedPath: join(
						stagedVaultBrokerDirectory,
						MACOS_VAULT_BROKER_EXECUTABLE,
					),
					packagedPath: vaultBrokerPath,
				});
			}
			if (localSigningStagedNativeDirectory) {
				verifyLocalSigningContinuity({
					stagedPath: join(
						localSigningStagedNativeDirectory,
						"whalehall-local",
					),
					packagedPath: localServerPath,
					expectedIdentifier: MACOS_LOCAL_SERVER_IDENTIFIER,
				});
				verifyLocalSigningContinuity({
					stagedPath: join(
						localSigningStagedNativeDirectory,
						MACOS_CREDENTIAL_HELPER_EXECUTABLE,
					),
					packagedPath: credentialHelperPath,
					expectedIdentifier: MACOS_CREDENTIAL_HELPER_IDENTIFIER,
				});
				verifyLocalSigningContinuity({
					stagedPath: join(
						localSigningStagedNativeDirectory,
						"WhaleHall Observer.app",
					),
					packagedPath: observerPath,
					expectedIdentifier: MACOS_OBSERVER_IDENTIFIER,
				});
				verifyLocalSigningContinuity({
					stagedPath: join(
						localSigningStagedNativeDirectory,
						MACOS_VAULT_BROKER_EXECUTABLE,
					),
					packagedPath: vaultBrokerPath,
					expectedIdentifier: MACOS_VAULT_BROKER_IDENTIFIER,
				});
			}
		},
	);
}

/**
 * Prepares the macOS application wrapper using the configured build environment and signing plan.
 *
 * @param environment - Environment variables that define the wrapper path, build settings, and signing configuration.
 */
export function prepareMacWrapperFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	if (environment.ELECTROBUN_OS !== "macos") return;
	const bundlePath = requiredEnvironment(
		environment,
		"ELECTROBUN_WRAPPER_BUNDLE_PATH",
	);
	const buildDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_DIR",
	);
	const appIdentifier = requiredEnvironment(
		environment,
		"ELECTROBUN_APP_IDENTIFIER",
	);
	const buildEnvironment = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_ENV",
	);
	const signing = resolveMacSigningPlan({
		environment,
		buildEnvironment,
		identities: readMacCodeSigningIdentities(),
	});
	if (shouldMaterializeMacUpdateArchive(signing.kind)) {
		const localIdentity =
			signing.kind === "local" ? signing.identity : undefined;
		if (signing.kind === "local" && !localIdentity) {
			throw new Error("The local signing identity is unavailable.");
		}
		const architecture =
			optionalEnvironment(environment, "ELECTROBUN_ARCH") ??
			(process.arch === "arm64" ? "arm64" : "x64");
		if (architecture !== "arm64" && architecture !== "x64") {
			throw new Error(`Unsupported macOS architecture: ${architecture}.`);
		}
		materializeNonDeveloperSignedWrapper({
			bundlePath,
			buildDirectory,
			appIdentifier,
			localIdentity,
			architecture,
		});
		return;
	}
	prepareMacWrapper({
		bundlePath,
		buildDirectory,
		appIdentifier,
		electrobunWillSign:
			buildEnvironment !== "dev" && signing.kind === "developer-id",
		developerIdentity:
			signing.kind === "developer-id" ? signing.identity : undefined,
	});
}

/**
 * Signs a completed macOS development application bundle.
 */
export function prepareDevelopmentMacWrapperFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	readIdentities: () => ReturnType<typeof readMacCodeSigningIdentities> =
		readMacCodeSigningIdentities,
): void {
	if (
		environment.ELECTROBUN_OS !== "macos" ||
		environment.ELECTROBUN_BUILD_ENV !== "dev"
	) {
		return;
	}
	const buildDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_DIR",
	);
	const appName = requiredEnvironment(environment, "ELECTROBUN_APP_NAME");
	const appIdentifier = requiredEnvironment(
		environment,
		"ELECTROBUN_APP_IDENTIFIER",
	);
	const signing = resolveMacSigningPlan({
		environment,
		buildEnvironment: "dev",
		identities: readIdentities(),
	});
	prepareMacWrapper({
		bundlePath: join(buildDirectory, `${appName}.app`),
		buildDirectory,
		appIdentifier,
		electrobunWillSign: false,
		developerIdentity:
			signing.kind === "developer-id" ? signing.identity : undefined,
		localIdentity: signing.kind === "local" ? signing.identity : undefined,
	});
}

/**
 * Electrobun signs its archived inner app only when a Developer ID is
 * configured. A non-Developer-ID build therefore cannot safely ship the
 * default self-extracting wrapper: its full update archive contains an
 * unsigned outer app (or the resource envelope inherited from the launcher),
 * while a local-certificate first launch would also change the TCC identity.
 * Expand the locally-produced archive during postWrap, sign the immutable
 * flat app, rebuild the full archive, and atomically install the same app in
 * place of the extractor.
 */
function materializeNonDeveloperSignedWrapper({
	bundlePath,
	buildDirectory,
	appIdentifier,
	localIdentity,
	architecture,
}: {
	bundlePath: string;
	buildDirectory: string;
	appIdentifier: string;
	localIdentity?: string;
	architecture: "arm64" | "x64";
}): void {
	assertSafeBundlePath(bundlePath, buildDirectory);
	const resourcesDirectory = join(bundlePath, "Contents", "Resources");
	const archives = readdirSync(resourcesDirectory)
		.filter((name) => name.endsWith(".tar.zst"))
		.map((name) => join(resourcesDirectory, name));
	if (archives.length !== 1 || archives[0] === undefined) {
		throw new Error(
			"The local Canary wrapper must contain exactly one application archive.",
		);
	}
	const archive = archives[0];
	const archiveStats = lstatSync(archive);
	if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) {
		throw new Error("The local Canary application archive is not a regular file.");
	}

	const zigZstd = join(
		projectRoot,
		"node_modules",
		"electrobun",
		`dist-macos-${architecture}`,
		"zig-zstd",
	);
	if (!existsSync(zigZstd)) {
		throw new Error(`Missing Electrobun zstd helper: ${zigZstd}`);
	}

	const stagingDirectory = mkdtempSync(
		join(buildDirectory, ".whalehall-local-wrapper-"),
	);
	const tarPath = join(stagingDirectory, "payload.tar");
	const payloadBundle = join(stagingDirectory, basename(bundlePath));
	const backupBundle = join(stagingDirectory, "self-extractor-backup.app");
	const signedTarPath = join(stagingDirectory, "signed-payload.tar");
	const signedArchivePath = join(stagingDirectory, "signed-payload.tar.zst");
	const updateArchives = readdirSync(buildDirectory)
		.filter((name) => name.endsWith(".app.tar.zst"))
		.map((name) => join(buildDirectory, name));
	if (updateArchives.length !== 1 || updateArchives[0] === undefined) {
		rmSync(stagingDirectory, { force: true, recursive: true });
		throw new Error(
			"The local Canary build must contain exactly one full update archive.",
		);
	}
	if (readdirSync(buildDirectory).some((name) => name.endsWith(".patch"))) {
		rmSync(stagingDirectory, { force: true, recursive: true });
		throw new Error(
			"Non-Developer-ID Canary builds cannot publish delta patches; use the signed full archive.",
		);
	}
	const updateArchive = updateArchives[0];
	const updateArchiveReplacement = join(
		buildDirectory,
		`.${basename(updateArchive)}.whalehall-signed.tmp`,
	);
	let backupInstalled = false;
	let payloadInstalled = false;
	try {
		run([zigZstd, "decompress", "-i", archive, "-o", tarPath]);
		const archiveEntries = validateLocalWrapperArchiveEntries(
			capture(["/usr/bin/tar", "-tf", tarPath]),
			basename(bundlePath),
		);
		validateLocalWrapperArchiveEntryTypes(
			capture(["/usr/bin/tar", "-tvf", tarPath]),
			archiveEntries.length,
		);
		run([
			"/usr/bin/tar",
			"-xf",
			tarPath,
			"-C",
			stagingDirectory,
		]);
		assertSafeBundlePath(payloadBundle, stagingDirectory);
		assertArchiveTreeContainsNoLinks(payloadBundle);
		assertRequiredMacNativeComponents(
			join(
				payloadBundle,
				"Contents",
				"Resources",
				"app",
				"native",
			),
		);
		prepareMacWrapper({
			bundlePath: payloadBundle,
			buildDirectory: stagingDirectory,
			appIdentifier,
			electrobunWillSign: false,
			localIdentity,
		});
		verifyMacWrapper({
			bundlePath: payloadBundle,
			appIdentifier,
			requireTeamIdentifier: false,
			localSigningStagedNativeDirectory: localIdentity
				? join(projectRoot, `.native/macos-${architecture}`)
				: undefined,
			stagedVaultBrokerDirectory: join(
				projectRoot,
				`.native/macos-${architecture}`,
			),
		});
		run([
			"/usr/bin/env",
			"COPYFILE_DISABLE=1",
			"/usr/bin/tar",
			"-cf",
			signedTarPath,
			"-C",
			stagingDirectory,
			basename(payloadBundle),
		]);
		run([
			zigZstd,
			"compress",
			"-i",
			signedTarPath,
			"-o",
			signedArchivePath,
			"--threads",
			"max",
		]);
		copyFileSync(signedArchivePath, updateArchiveReplacement);
		renameSync(updateArchiveReplacement, updateArchive);

		renameSync(bundlePath, backupBundle);
		backupInstalled = true;
		renameSync(payloadBundle, bundlePath);
		payloadInstalled = true;
		run(["/usr/bin/codesign", "--verify", "--deep", "--strict", bundlePath]);
	} catch (error) {
		if (backupInstalled) {
			if (payloadInstalled && existsSync(bundlePath)) {
				rmSync(bundlePath, { force: true, recursive: true });
			}
			if (existsSync(backupBundle)) renameSync(backupBundle, bundlePath);
		}
		throw error;
	} finally {
		if (existsSync(updateArchiveReplacement)) {
			rmSync(updateArchiveReplacement, { force: true });
		}
		rmSync(stagingDirectory, { force: true, recursive: true });
	}
}

export function validateLocalWrapperArchiveEntries(
	listing: string,
	expectedBundleName: string,
): string[] {
	if (
		!expectedBundleName.endsWith(".app") ||
		expectedBundleName.trim() !== expectedBundleName ||
		expectedBundleName.includes("/") ||
		expectedBundleName.includes("\\") ||
		expectedBundleName.includes("\0")
	) {
		throw new Error("A safe local Canary bundle name is required.");
	}
	const entries = listing
		.split(/\r?\n/u)
		.filter((entry) => entry.length > 0);
	if (entries.length === 0) {
		throw new Error("The local Canary application archive is empty.");
	}
	for (const entry of entries) {
		const withoutTrailingSlash = entry.replace(/\/+$/u, "");
		const components = withoutTrailingSlash.split("/");
		if (
			entry.includes("\0") ||
			entry.startsWith("/") ||
			components[0] !== expectedBundleName ||
			components.some(
				(component) => component === "" || component === "." || component === "..",
			)
		) {
			throw new Error(
				"The local Canary application archive contains an unsafe path.",
			);
		}
	}
	if (
		!entries.some(
			(entry) =>
				entry === `${expectedBundleName}/Contents/Info.plist`,
		)
	) {
		throw new Error(
			"The local Canary application archive is missing its Info.plist.",
		);
	}
	return entries;
}

export function validateLocalWrapperArchiveEntryTypes(
	verboseListing: string,
	expectedEntryCount: number,
): void {
	if (!Number.isSafeInteger(expectedEntryCount) || expectedEntryCount <= 0) {
		throw new Error("A positive local Canary archive entry count is required.");
	}
	const entries = verboseListing
		.split(/\r?\n/u)
		.filter((entry) => entry.length > 0);
	if (entries.length !== expectedEntryCount) {
		throw new Error(
			"The local Canary application archive entry types could not be verified.",
		);
	}
	for (const entry of entries) {
		const type = entry[0];
		if (type !== "-" && type !== "d") {
			throw new Error(
				"The local Canary application archive contains a link or special entry.",
			);
		}
	}
}

function assertArchiveTreeContainsNoLinks(root: string): void {
	const resolvedRoot = realpathSync(root);
	for (const entry of readdirSync(root, { recursive: true })) {
		const path = join(root, entry.toString());
		const stats = lstatSync(path);
		if (
			stats.isSymbolicLink() ||
			(!stats.isDirectory() && !stats.isFile()) ||
			(stats.isFile() && stats.nlink !== 1)
		) {
			throw new Error(
				"The local Canary application archive contains a link entry.",
			);
		}
		const resolved = realpathSync(path);
		if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}/`)) {
			throw new Error(
				"The local Canary application archive resolves outside its bundle.",
			);
		}
	}
}

/**
 * Verifies the macOS application wrapper and, for packaged builds, its update archive.
 *
 * Development builds verify only the runnable application bundle; packaged builds also
 * require a valid update archive and apply signing-specific archive checks.
 *
 * @param environment - Environment variables that define the build and signing configuration
 */
export function verifyMacWrapperFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	if (environment.ELECTROBUN_OS !== "macos") return;
	const buildDirectory = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_DIR",
	);
	const appName = requiredEnvironment(environment, "ELECTROBUN_APP_NAME");
	const appIdentifier = requiredEnvironment(
		environment,
		"ELECTROBUN_APP_IDENTIFIER",
	);
	const buildEnvironment = requiredEnvironment(
		environment,
		"ELECTROBUN_BUILD_ENV",
	);
	const signing = resolveMacSigningPlan({
		environment,
		buildEnvironment,
		identities: readMacCodeSigningIdentities(),
	});
	const architecture =
		optionalEnvironment(environment, "ELECTROBUN_ARCH") ??
		(process.arch === "arm64" ? "arm64" : "x64");
	if (architecture !== "arm64" && architecture !== "x64") {
		throw new Error(`Unsupported macOS architecture: ${architecture}.`);
	}
	verifyMacWrapper({
		bundlePath: join(buildDirectory, `${appName}.app`),
		appIdentifier,
		requireTeamIdentifier:
			buildEnvironment === "stable" ||
			environment.WHALEHALL_RELEASE_SIGNING_REQUIRED === "true",
		localSigningStagedNativeDirectory:
			signing.kind === "local"
				? join(projectRoot, `.native/macos-${architecture}`)
				: undefined,
		stagedVaultBrokerDirectory: join(
			projectRoot,
			`.native/macos-${architecture}`,
		),
	});
	// Electrobun dev produces only the runnable bundle. It does not create an
	// update archive, so stale canary/stable artifacts must not be mistaken for
	// a dev deliverable. Packaged channels continue through the archive gate.
	if (buildEnvironment === "dev") return;
	verifyUpdateArchive({
		artifactDirectory: requiredEnvironment(
			environment,
			"ELECTROBUN_ARTIFACT_DIR",
		),
		appName,
		appIdentifier,
		architecture,
		requireTeamIdentifier: signing.kind === "developer-id",
		localSigningStagedNativeDirectory:
			signing.kind === "local"
				? join(projectRoot, `.native/macos-${architecture}`)
				: undefined,
		rejectDeltaPatches: shouldMaterializeMacUpdateArchive(signing.kind),
	});
}

function verifyUpdateArchive({
	artifactDirectory,
	appName,
	appIdentifier,
	architecture,
	requireTeamIdentifier,
	localSigningStagedNativeDirectory,
	rejectDeltaPatches,
}: {
	artifactDirectory: string;
	appName: string;
	appIdentifier: string;
	architecture: "arm64" | "x64";
	requireTeamIdentifier: boolean;
	localSigningStagedNativeDirectory?: string;
	rejectDeltaPatches: boolean;
}): void {
	const artifactEntries = readdirSync(artifactDirectory);
	const archives = artifactEntries
		.filter((name) => name.endsWith(".app.tar.zst"))
		.map((name) => join(artifactDirectory, name));
	if (archives.length !== 1 || archives[0] === undefined) {
		throw new Error(
			"The macOS artifacts must contain exactly one full update archive.",
		);
	}
	if (
		rejectDeltaPatches &&
		artifactEntries.some((name) => name.endsWith(".patch"))
	) {
		throw new Error(
			"Local-certificate Canary artifacts cannot contain delta patches.",
		);
	}
	const archive = archives[0];
	const archiveStats = lstatSync(archive);
	if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) {
		throw new Error("The local Canary update archive is not a regular file.");
	}

	const zigZstd = join(
		projectRoot,
		"node_modules",
		"electrobun",
		`dist-macos-${architecture}`,
		"zig-zstd",
	);
	if (!existsSync(zigZstd)) {
		throw new Error(`Missing Electrobun zstd helper: ${zigZstd}`);
	}
	const stagingDirectory = mkdtempSync(
		join(artifactDirectory, ".whalehall-update-verify-"),
	);
	const tarPath = join(stagingDirectory, "payload.tar");
	const expectedBundleName = `${appName}.app`;
	const payloadBundle = join(stagingDirectory, expectedBundleName);
	try {
		run([zigZstd, "decompress", "-i", archive, "-o", tarPath]);
		const archiveEntries = validateLocalWrapperArchiveEntries(
			capture(["/usr/bin/tar", "-tf", tarPath]),
			expectedBundleName,
		);
		validateLocalWrapperArchiveEntryTypes(
			capture(["/usr/bin/tar", "-tvf", tarPath]),
			archiveEntries.length,
		);
		run(["/usr/bin/tar", "-xf", tarPath, "-C", stagingDirectory]);
		assertSafeBundlePath(payloadBundle, stagingDirectory);
		assertArchiveTreeContainsNoLinks(payloadBundle);
		verifyMacWrapper({
			bundlePath: payloadBundle,
			appIdentifier,
			requireTeamIdentifier,
			localSigningStagedNativeDirectory,
			stagedVaultBrokerDirectory: join(
				projectRoot,
				`.native/macos-${architecture}`,
			),
		});
	} finally {
		rmSync(stagingDirectory, { force: true, recursive: true });
	}
}

export function validateLocalDesignatedRequirementContinuity({
	stagedOutput,
	packagedOutput,
	expectedIdentifier,
}: {
	stagedOutput: string;
	packagedOutput: string;
	expectedIdentifier: string;
}): string {
	const staged = normalizeDesignatedRequirement(stagedOutput);
	const packaged = normalizeDesignatedRequirement(packagedOutput);
	for (const [location, requirement] of [
		["staged", staged],
		["packaged", packaged],
	] as const) {
		if (/\bcdhash\b/iu.test(requirement)) {
			throw new Error(
				`The ${location} ${expectedIdentifier} component has an ad-hoc `
					+ "cdhash designated requirement.",
			);
		}
		const identifier = requirement.match(/\bidentifier\s+"([^"]+)"/u)?.[1];
		if (identifier !== expectedIdentifier) {
			throw new Error(
				`The ${location} component designated requirement rewrote `
					+ `identifier ${expectedIdentifier}.`,
			);
		}
		if (
			!/\bcertificate\s+leaf\s*=\s*H"[A-F0-9]{40}"/iu.test(
				requirement,
			)
		) {
			throw new Error(
				`The ${location} ${expectedIdentifier} component does not have `
					+ "an explicit leaf-certificate designated requirement.",
			);
		}
	}
	if (staged !== packaged) {
		throw new Error(
			`Packaged ${expectedIdentifier} designated requirement differs `
				+ "from the staged local signature.",
		);
	}
	return packaged;
}

export function parseMacCodeDirectoryHash(output: string): string {
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

export function validateVaultBrokerContinuity({
	stagedDigest,
	packagedDigest,
	stagedDetails,
	packagedDetails,
	stagedRequirement,
	packagedRequirement,
}: {
	stagedDigest: string;
	packagedDigest: string;
	stagedDetails: string;
	packagedDetails: string;
	stagedRequirement: string;
	packagedRequirement: string;
}): void {
	if (
		!/^[A-Fa-f0-9]{64}$/u.test(stagedDigest) ||
		!/^[A-Fa-f0-9]{64}$/u.test(packagedDigest) ||
		stagedDigest.toLowerCase() !== packagedDigest.toLowerCase()
	) {
		throw new Error(
			"Packaged Vault Broker bytes differ from the staged executable.",
		);
	}
	if (
		parseMacCodeDirectoryHash(stagedDetails) !==
		parseMacCodeDirectoryHash(packagedDetails)
	) {
		throw new Error(
			"Packaged Vault Broker CDHash differs from the staged executable.",
		);
	}
	const staged = normalizeDesignatedRequirement(stagedRequirement);
	const packaged = normalizeDesignatedRequirement(packagedRequirement);
	for (const [location, requirement] of [
		["staged", staged],
		["packaged", packaged],
	] as const) {
		if (
			requirement.match(/\bidentifier\s+"([^"]+)"/u)?.[1] !==
			MACOS_VAULT_BROKER_IDENTIFIER
		) {
			throw new Error(
				`The ${location} Vault Broker has an unexpected identifier.`,
			);
		}
	}
	if (staged !== packaged) {
		throw new Error(
			"Packaged Vault Broker designated requirement differs from the staged executable.",
		);
	}
}

export function validateObserverEntitlements(entitlements: string): void {
	if (entitlements.includes("com.apple.security.app-sandbox")) {
		throw new Error(
			"Signed Observer cannot use App Sandbox because it requires macOS Accessibility APIs.",
		);
	}
	if (
		!/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/u.test(
			entitlements,
		)
	) {
		throw new Error(
			"Signed Observer is missing its Apple Events automation entitlement.",
		);
	}
}

export function normalizeDesignatedRequirement(output: string): string {
	const marker = "designated =>";
	const requirementLines = output
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.map((line) =>
			line.startsWith(`# ${marker}`) ? line.slice(2) : line,
		)
		.filter((line) => line.startsWith(marker));
	if (requirementLines.length !== 1) {
		throw new Error("codesign did not return a designated requirement.");
	}
	const requirementLine = requirementLines[0];
	if (requirementLine === undefined) {
		throw new Error("codesign did not return a designated requirement.");
	}
	const requirement = requirementLine
		.slice(marker.length)
		.trim()
		.replace(/\s+/gu, " ");
	if (!requirement) {
		throw new Error("codesign returned an empty designated requirement.");
	}
	return requirement;
}

function verifyLocalSigningContinuity({
	stagedPath,
	packagedPath,
	expectedIdentifier,
}: {
	stagedPath: string;
	packagedPath: string;
	expectedIdentifier: string;
}): void {
	if (!existsSync(stagedPath)) {
		throw new Error(
			`Missing staged ${expectedIdentifier} component for signature comparison.`,
		);
	}
	validateLocalDesignatedRequirementContinuity({
		stagedOutput: capture([
			"/usr/bin/codesign",
			"--display",
			"--requirements",
			"-",
			stagedPath,
		]),
		packagedOutput: capture([
			"/usr/bin/codesign",
			"--display",
			"--requirements",
			"-",
			packagedPath,
		]),
		expectedIdentifier,
	});
}

function verifyVaultBrokerContinuity({
	stagedPath,
	packagedPath,
}: {
	stagedPath: string;
	packagedPath: string;
}): void {
	if (!existsSync(stagedPath)) {
		throw new Error("Missing staged Vault Broker for package verification.");
	}
	const digest = (path: string) =>
		createHash("sha256").update(readFileSync(path)).digest("hex");
	validateVaultBrokerContinuity({
		stagedDigest: digest(stagedPath),
		packagedDigest: digest(packagedPath),
		stagedDetails: capture([
			"/usr/bin/codesign",
			"--display",
			"--verbose=4",
			stagedPath,
		]),
		packagedDetails: capture([
			"/usr/bin/codesign",
			"--display",
			"--verbose=4",
			packagedPath,
		]),
		stagedRequirement: capture([
			"/usr/bin/codesign",
			"--display",
			"--requirements",
			"-",
			stagedPath,
		]),
		packagedRequirement: capture([
			"/usr/bin/codesign",
			"--display",
			"--requirements",
			"-",
			packagedPath,
		]),
	});
}

function writeOuterEntitlements(buildDirectory: string): string {
	mkdirSync(buildDirectory, { recursive: true });
	const path = join(buildDirectory, "whalehall-wrapper.entitlements.plist");
	const entries = Object.entries(MACOS_OUTER_ENTITLEMENTS)
		.map(
			([key, value]) =>
				`\t<key>${escapeXml(key)}</key>\n\t<${value ? "true" : "false"}/>`,
		)
		.join("\n");
	writeFileSync(
		path,
		`<?xml version="1.0" encoding="UTF-8"?>\n`
			+ `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" `
			+ `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
			+ `<plist version="1.0">\n<dict>\n${entries}\n</dict>\n</plist>\n`,
		{ mode: 0o600 },
	);
	return path;
}

export function assertRequiredMacNativeComponents(
	nativeDirectory: string,
): void {
	for (const component of [
		{ name: "whalehall-local", kind: "file" },
		{ name: MACOS_CREDENTIAL_HELPER_EXECUTABLE, kind: "file" },
		{ name: "WhaleHall Observer.app", kind: "directory" },
		{ name: MACOS_VAULT_BROKER_EXECUTABLE, kind: "file" },
	] as const) {
		const path = join(nativeDirectory, component.name);
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch {
			throw new Error(
				`Signed wrapper is missing required native component ${component.name}.`,
			);
		}
		if (
			stats.isSymbolicLink() ||
			(component.kind === "file" && !stats.isFile()) ||
			(component.kind === "directory" && !stats.isDirectory())
		) {
			throw new Error(
				`Signed wrapper native component ${component.name} has an unsafe type.`,
			);
		}
	}
}

export function validateSignedComponentDetails({
	details,
	expectedIdentifier,
	expectedTeamIdentifier,
}: {
	details: string;
	expectedIdentifier: string;
	expectedTeamIdentifier: string | null;
}): void {
	const identifiers = details
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("Identifier="))
		.map((line) => line.slice("Identifier=".length));
	if (identifiers.length !== 1 || identifiers[0] !== expectedIdentifier) {
		throw new Error(
			`Signed component does not use the canonical identifier ${expectedIdentifier}.`,
		);
	}
	if (expectedTeamIdentifier === null) return;
	const teamIdentifiers = details
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("TeamIdentifier="))
		.map((line) => line.slice("TeamIdentifier=".length));
	if (
		teamIdentifiers.length !== 1 ||
		teamIdentifiers[0] !== expectedTeamIdentifier
	) {
		throw new Error(
			`Signed component ${expectedIdentifier} does not share the wrapper TeamIdentifier.`,
		);
	}
}

function verifySignedComponent(
	path: string,
	expectedIdentifier: string,
	expectedTeamIdentifier: string | null,
): string {
	run(["/usr/bin/codesign", "--verify", "--strict", path]);
	const details = capture([
		"/usr/bin/codesign",
		"--display",
		"--verbose=4",
		path,
	]);
	validateSignedComponentDetails({
		details,
		expectedIdentifier,
		expectedTeamIdentifier,
	});
	return details;
}

function withPackagedNativeDirectory(
	bundlePath: string,
	required: boolean,
	verify: (nativeDirectory: string) => void,
): void {
	const resourcesDirectory = join(bundlePath, "Contents", "Resources");
	const expandedDirectory = join(resourcesDirectory, "app", "native");
	if (existsSync(expandedDirectory)) {
		verify(expandedDirectory);
		return;
	}

	if (!existsSync(resourcesDirectory)) {
		if (required) {
			throw new Error("Signed wrapper is missing application resources.");
		}
		return;
	}
	const archives = readdirSync(resourcesDirectory)
		.filter((name) => name.endsWith(".tar.zst"))
		.map((name) => join(resourcesDirectory, name));
	if (archives.length === 0 && !required) return;
	if (archives.length !== 1) {
		throw new Error(
			"Signed wrapper must contain exactly one Electrobun application archive.",
		);
	}
	const archive = archives[0];
	if (archive === undefined) {
		throw new Error("Signed wrapper application archive could not be resolved.");
	}
	const extractionDirectory = mkdtempSync(
		join(tmpdir(), "whalehall-native-verify-"),
	);
	try {
		run([
			"/usr/bin/tar",
			"--use-compress-program=unzstd",
			"-xf",
			archive,
			"-C",
			extractionDirectory,
		]);
		verify(
			join(
				extractionDirectory,
				basename(bundlePath),
				"Contents",
				"Resources",
				"app",
				"native",
			),
		);
	} finally {
		rmSync(extractionDirectory, { force: true, recursive: true });
	}
}

function assertSafeBundlePath(
	bundlePath: string,
	buildDirectory: string,
): void {
	if (!isAbsolute(bundlePath) || !isAbsolute(buildDirectory)) {
		throw new Error("Electrobun macOS build paths must be absolute.");
	}
	const resolvedBundle = resolve(bundlePath);
	const resolvedBuild = resolve(buildDirectory);
	if (
		resolvedBundle === resolvedBuild ||
		!resolvedBundle.startsWith(`${resolvedBuild}/`) ||
		basename(resolvedBundle).endsWith(".app") === false
	) {
		throw new Error("Electrobun wrapper path must be one app inside its build directory.");
	}
	const existingBuild = realpathSync(resolvedBuild);
	const existingBundleParent = realpathSync(dirname(resolvedBundle));
	const bundleStats = lstatSync(resolvedBundle);
	if (
		existingBundleParent !== existingBuild &&
		!existingBundleParent.startsWith(`${existingBuild}/`)
	) {
		throw new Error("Electrobun wrapper resolves outside its build directory.");
	}
	if (!bundleStats.isDirectory() || bundleStats.isSymbolicLink()) {
		throw new Error("Electrobun wrapper must be a regular app directory.");
	}
	const existingBundle = realpathSync(resolvedBundle);
	if (!existingBundle.startsWith(`${existingBuild}/`)) {
		throw new Error("Electrobun wrapper resolves outside its build directory.");
	}
}

function setPlistString(path: string, key: string, value: string): void {
	const replace = Bun.spawnSync(
		["/usr/bin/plutil", "-replace", key, "-string", value, path],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (replace.exitCode === 0) return;
	run(["/usr/bin/plutil", "-insert", key, "-string", value, path]);
}

function readPlistString(path: string, key: string): string {
	return capture([
		"/usr/bin/plutil",
		"-extract",
		key,
		"raw",
		"-o",
		"-",
		path,
	]).trim();
}

function requiredEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
): string {
	const value = optionalEnvironment(environment, name);
	if (value === undefined) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const value = environment[name]?.trim();
	return value ? value : undefined;
}

function run(command: string[]): void {
	const result = Bun.spawnSync(command, {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const detail = new TextDecoder()
			.decode(result.stderr)
			.trim()
			.replaceAll("\n", " ");
		throw new Error(
			`Command failed (${result.exitCode}): ${command[0]}${detail ? `: ${detail}` : ""}`,
		);
	}
}

function capture(command: string[]): string {
	const result = Bun.spawnSync(command, {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`Command failed (${result.exitCode}): ${command[0]}`);
	}
	return `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(
		result.stderr,
	)}`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
