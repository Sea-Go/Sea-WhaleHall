import { basename } from "node:path";

export const MACOS_LOCAL_SIGNING_COMMON_NAME =
	"WhaleHall Local Development";

export type MacSigningKind = "developer-id" | "local" | "ad-hoc";

export interface CodeSigningIdentity {
	fingerprint: string;
	name: string;
}

export interface MacSigningPlan {
	kind: MacSigningKind;
	identity?: string;
	teamIdentifier?: string;
	releaseRequired: boolean;
}

interface ResolveMacSigningPlanOptions {
	environment: NodeJS.ProcessEnv;
	buildEnvironment: string;
	identities: readonly CodeSigningIdentity[];
}

type CaptureCommand = (command: readonly string[]) => string;

export function parseCodeSigningIdentities(
	output: string,
): CodeSigningIdentity[] {
	const identities: CodeSigningIdentity[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const match = line.match(
			/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*$/u,
		);
		if (!match?.[1] || !match[2]) continue;
		identities.push({
			fingerprint: match[1].toUpperCase(),
			name: match[2],
		});
	}
	return identities;
}

export function selectUniqueIdentity(
	identities: readonly CodeSigningIdentity[],
	configuredIdentity: string,
): CodeSigningIdentity {
	const normalized = configuredIdentity.trim();
	const matches = identities.filter(
		(identity) =>
			identity.fingerprint === normalized.toUpperCase() ||
			identity.name === normalized,
	);
	if (matches.length === 0) {
		throw new Error(
			`The configured macOS signing identity is not a valid code-signing identity: ${normalized}.`,
		);
	}
	if (matches.length !== 1) {
		throw new Error(
			`The configured macOS signing identity is ambiguous (${matches.length} valid matches): ${normalized}.`,
		);
	}
	const identity = matches[0];
	if (!identity) throw new Error("The macOS signing identity could not be resolved.");
	return identity;
}

export function selectUniqueLocalSigningIdentity(
	identities: readonly CodeSigningIdentity[],
): CodeSigningIdentity | undefined {
	const matches = identities.filter(
		(identity) => identity.name === MACOS_LOCAL_SIGNING_COMMON_NAME,
	);
	if (matches.length > 1) {
		throw new Error(
			`Found ${matches.length} valid identities named exactly `
				+ `"${MACOS_LOCAL_SIGNING_COMMON_NAME}". Refusing an ambiguous local signature.`,
		);
	}
	return matches[0];
}

export function resolveMacSigningPlan({
	environment,
	buildEnvironment,
	identities,
}: ResolveMacSigningPlanOptions): MacSigningPlan {
	const releaseRequired =
		buildEnvironment === "stable" ||
		environment.WHALEHALL_RELEASE_SIGNING_REQUIRED === "true";
	const developerIdentity = resolveConfiguredDeveloperIdentity(environment);

	if (developerIdentity) {
		const selected = selectUniqueIdentity(identities, developerIdentity);
		const teamIdentifier = developerIdTeamIdentifier(selected.name);
		if (!teamIdentifier) {
			throw new Error(
				"ELECTROBUN_DEVELOPER_ID must resolve to a valid "
					+ '"Developer ID Application: … (TEAMID)" identity.',
			);
		}
		const configuredTeam = environment.WHALEHALL_APPLE_TEAM_ID?.trim();
		if (!configuredTeam || !/^[A-Z0-9]{10}$/u.test(configuredTeam)) {
			throw new Error(
				"WHALEHALL_APPLE_TEAM_ID must be the 10-character Apple Team ID "
					+ "when using a Developer ID Application identity.",
			);
		}
		if (configuredTeam !== teamIdentifier) {
			throw new Error(
				`Developer ID Team ${teamIdentifier} does not match `
					+ `WHALEHALL_APPLE_TEAM_ID=${configuredTeam}.`,
			);
		}
		return {
			kind: "developer-id",
			identity: selected.fingerprint,
			teamIdentifier,
			releaseRequired,
		};
	}

	if (releaseRequired) {
		throw new Error(
			"Stable and explicitly signed macOS builds require a valid "
				+ "Developer ID Application identity; the local development "
				+ "identity is never a release fallback.",
		);
	}

	const localIdentity = selectUniqueLocalSigningIdentity(identities);
	const configuredLocal = environment.WHALEHALL_LOCAL_SIGNING_IDENTITY?.trim();
	if (
		configuredLocal &&
		configuredLocal !== MACOS_LOCAL_SIGNING_COMMON_NAME &&
		configuredLocal.toUpperCase() !== localIdentity?.fingerprint
	) {
		throw new Error(
			`WHALEHALL_LOCAL_SIGNING_IDENTITY may only refer to the exact `
				+ `"${MACOS_LOCAL_SIGNING_COMMON_NAME}" identity. `
				+ "Manual arbitrary local identities are not accepted.",
		);
	}
	if (localIdentity) {
		return {
			kind: "local",
			identity: localIdentity.fingerprint,
			releaseRequired,
		};
	}
	return { kind: "ad-hoc", releaseRequired };
}

export function readMacCodeSigningIdentities(
	captureCommand: CaptureCommand = capture,
): CodeSigningIdentity[] {
	const keychain = readUserLoginKeychainPath(captureCommand);
	return parseCodeSigningIdentities(
		captureCommand([
			"/usr/bin/security",
			"find-identity",
			"-v",
			"-p",
			"codesigning",
			keychain,
		]),
	);
}

export function readUserLoginKeychainPath(
	captureCommand: CaptureCommand = capture,
): string {
	return parseUserLoginKeychainPath(
		captureCommand([
			"/usr/bin/security",
			"list-keychains",
			"-d",
			"user",
		]),
	);
}

export function parseUserLoginKeychainPath(output: string): string {
	const candidates = output
		.split(/\r?\n/u)
		.map((line) => line.trim().replace(/^"(.*)"$/u, "$1"))
		.filter((path) => basename(path) === "login.keychain-db");
	if (candidates.length !== 1 || !candidates[0]) {
		throw new Error(
			`Expected exactly one current-user login.keychain-db, found ${candidates.length}.`,
		);
	}
	return candidates[0];
}

export function developerIdTeamIdentifier(name: string): string | undefined {
	return name.match(/^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/u)?.[1];
}

export function localDesignatedRequirement(
	identifier: string,
	fingerprint: string,
): string {
	if (!/^[A-Za-z0-9.-]+$/u.test(identifier)) {
		throw new Error(`Invalid macOS code-signing identifier: ${identifier}.`);
	}
	const normalizedFingerprint = fingerprint.trim().toUpperCase();
	if (!/^[A-F0-9]{40}$/u.test(normalizedFingerprint)) {
		throw new Error("Local code-signing identity must use a SHA-1 fingerprint.");
	}
	return (
		`=designated => identifier "${identifier}" `
		+ `and certificate leaf = H"${normalizedFingerprint}"`
	);
}

function resolveConfiguredDeveloperIdentity(
	environment: NodeJS.ProcessEnv,
): string | undefined {
	const primary = environment.ELECTROBUN_DEVELOPER_ID?.trim();
	const observer = environment.WHALEHALL_OBSERVER_SIGNING_IDENTITY?.trim();
	if (primary && observer && primary !== observer) {
		throw new Error(
			"WHALEHALL_OBSERVER_SIGNING_IDENTITY must match "
				+ "ELECTROBUN_DEVELOPER_ID; mixed native signatures are forbidden.",
		);
	}
	return primary || observer || undefined;
}

function capture(command: readonly string[]): string {
	const result = Bun.spawnSync([...command], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const detail = result.stderr.toString().trim().replaceAll("\n", " ");
		throw new Error(
			`Command failed (${result.exitCode}): ${command[0]}`
				+ (detail ? `: ${detail}` : ""),
		);
	}
	return `${result.stdout.toString()}${result.stderr.toString()}`;
}
