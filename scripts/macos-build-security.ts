import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	localDesignatedRequirement,
	readMacCodeSigningIdentities,
	resolveMacSigningPlan,
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
	NSInputMonitoringUsageDescription:
		"WhaleHall 只统计键盘和鼠标活动量，用于确定反思时机；不会读取按键内容或保存鼠标坐标。",
	NSScreenCaptureUsageDescription:
		"WhaleHall 仅在内存中识别当前前台窗口的可见文本，识别完成后立即销毁截图。",
} as const;

const MACOS_LOCAL_SERVER_IDENTIFIER = "com.seago.whalehall.local";
const MACOS_OBSERVER_IDENTIFIER = "com.seago.whalehall.observer";

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
		requireTeamIdentifier || localSigningStagedNativeDirectory !== undefined,
		(nativeDirectory) => {
			const localServerPath = join(nativeDirectory, "whalehall-local");
			const observerPath = join(nativeDirectory, "WhaleHall Observer.app");
			if (!existsSync(localServerPath) || !existsSync(observerPath)) {
				throw new Error(
					"Signed wrapper is missing a native monitoring component.",
				);
			}
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
				observerPath,
				MACOS_OBSERVER_IDENTIFIER,
				outerTeamIdentifier,
			);
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
						"WhaleHall Observer.app",
					),
					packagedPath: observerPath,
					expectedIdentifier: MACOS_OBSERVER_IDENTIFIER,
				});
			}
		},
	);
}

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
	prepareMacWrapper({
		bundlePath,
		buildDirectory,
		appIdentifier,
		electrobunWillSign:
			buildEnvironment !== "dev" && signing.kind === "developer-id",
		developerIdentity:
			signing.kind === "developer-id" ? signing.identity : undefined,
		localIdentity: signing.kind === "local" ? signing.identity : undefined,
	});
}

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
	});
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

export function normalizeDesignatedRequirement(output: string): string {
	const marker = "designated =>";
	const markerIndex = output.indexOf(marker);
	if (markerIndex < 0) {
		throw new Error("codesign did not return a designated requirement.");
	}
	const requirement = output
		.slice(markerIndex + marker.length)
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
	if (!details.includes(`Identifier=${expectedIdentifier}`)) {
		throw new Error(
			`Signed component does not use the canonical identifier ${expectedIdentifier}.`,
		);
	}
	if (
		expectedTeamIdentifier !== null &&
		!details.includes(`TeamIdentifier=${expectedTeamIdentifier}`)
	) {
		throw new Error(
			`Signed component ${expectedIdentifier} does not share the wrapper TeamIdentifier.`,
		);
	}
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
	if (
		existingBundleParent !== existingBuild &&
		!existingBundleParent.startsWith(`${existingBuild}/`)
	) {
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
