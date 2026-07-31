import {
	existsSync,
	mkdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
				+ "Set WHALEHALL_LOCAL_SIGNING_IDENTITY or ELECTROBUN_DEVELOPER_ID "
				+ "before collecting real content.",
		);
	}
}

export function verifyMacWrapper({
	bundlePath,
	appIdentifier,
	requireTeamIdentifier,
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
	const developerIdentity = optionalEnvironment(
		environment,
		"ELECTROBUN_DEVELOPER_ID",
	);
	prepareMacWrapper({
		bundlePath,
		buildDirectory,
		appIdentifier,
		electrobunWillSign:
			buildEnvironment !== "dev" && developerIdentity !== undefined,
		developerIdentity,
		localIdentity: optionalEnvironment(
			environment,
			"WHALEHALL_LOCAL_SIGNING_IDENTITY",
		),
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
	verifyMacWrapper({
		bundlePath: join(buildDirectory, `${appName}.app`),
		appIdentifier,
		requireTeamIdentifier:
			environment.ELECTROBUN_BUILD_ENV === "stable" ||
			environment.WHALEHALL_RELEASE_SIGNING_REQUIRED === "true",
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
