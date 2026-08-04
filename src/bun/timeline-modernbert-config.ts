import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
	ModernBertEpisodeClassifier,
	type ModernBertRuntimeOptIn,
	validatePinnedModernBertArtifactManifest,
} from "../agent/timeline-v2/modernbert-classifier";

const MAXIMUM_PINNED_MANIFEST_BYTES = 256 * 1024;

export type TimelineModernBertConfiguration = {
	modernBert: ModernBertRuntimeOptIn;
	code: "disabled" | "enabled" | "invalid_config";
};

/**
 * Loads only an explicit Timeline v2 deployment configuration.
 *
 * A partial or invalid environment never falls back to the legacy v1 endpoint
 * and never enables an unpinned model. The returned status contains no path,
 * token, endpoint, or artifact material and is safe to log.
 */
export function loadTimelineModernBertConfiguration(
	environment: Readonly<Record<string, string | undefined>>,
): TimelineModernBertConfiguration {
	const endpoint =
		environment.WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT?.trim();
	const manifestEndpoint =
		environment.WHALEHALL_TIMELINE_MODERNBERT_MANIFEST_ENDPOINT?.trim();
	const pinnedManifestPath =
		environment.WHALEHALL_TIMELINE_MODERNBERT_PINNED_MANIFEST?.trim();
	const allowedRemoteOrigins = parseAllowedRemoteOrigins(
		environment.WHALEHALL_TIMELINE_MODERNBERT_ALLOWED_ORIGINS,
	);
	const configured = [endpoint, manifestEndpoint, pinnedManifestPath].filter(
		(value) => value !== undefined && value.length > 0,
	).length;
	if (configured === 0) {
		return {
			modernBert: { enabled: false },
			code: "disabled",
		};
	}
	if (
		configured !== 3 ||
		endpoint === undefined ||
		manifestEndpoint === undefined ||
		pinnedManifestPath === undefined
	) {
		return invalidConfiguration();
	}
	try {
		if (!isAbsolute(pinnedManifestPath)) {
			return invalidConfiguration();
		}
		if (pathContainsSymbolicLink(pinnedManifestPath)) {
			return invalidConfiguration();
		}
		const stat = lstatSync(pinnedManifestPath);
		if (
			stat.isSymbolicLink() ||
			!stat.isFile() ||
			stat.size < 1 ||
			stat.size > MAXIMUM_PINNED_MANIFEST_BYTES
		) {
			return invalidConfiguration();
		}
		const expectedArtifact =
			validatePinnedModernBertArtifactManifest(
				JSON.parse(
					readFileSync(pinnedManifestPath, "utf8"),
				) as unknown,
			);
		const authorizationToken =
			environment.WHALEHALL_TIMELINE_MODERNBERT_TOKEN;
		const modernBert = {
			enabled: true as const,
			endpoint,
			manifestEndpoint,
			expectedArtifact,
			allowedRemoteOrigins,
			...(authorizationToken === undefined
				? {}
				: { authorizationToken }),
		};
		// Constructor validation is metadata-only and requires an exact HTTPS
		// allowlist entry before a remote deployment can report "enabled".
		new ModernBertEpisodeClassifier(modernBert);
		return {
			modernBert,
			code: "enabled",
		};
	} catch {
		return invalidConfiguration();
	}
}

function pathContainsSymbolicLink(path: string): boolean {
	const absolutePath = resolve(path);
	const root = parse(absolutePath).root;
	let current = root;
	for (const segment of absolutePath.slice(root.length).split(sep)) {
		if (segment.length === 0) continue;
		current = join(current, segment);
		// macOS exposes the system-owned /var alias as a symlink to /private/var.
		// It is part of the platform pathname, not a caller-controlled manifest
		// indirection; descendants are still checked individually.
		if (
			lstatSync(current).isSymbolicLink() &&
			!(process.platform === "darwin" && current === "/var")
		) {
			return true;
		}
	}
	return false;
}

function parseAllowedRemoteOrigins(value: string | undefined): string[] {
	if (value === undefined || value.trim().length === 0) return [];
	return value
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
}

function invalidConfiguration(): TimelineModernBertConfiguration {
	return {
		modernBert: { enabled: false },
		code: "invalid_config",
	};
}
