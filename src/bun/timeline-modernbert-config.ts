import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import {
	ModernBertEpisodeClassifier,
	type ModernBertRuntimeOptIn,
	validatePinnedModernBertArtifactManifest,
} from "../agent/timeline-v2/modernbert-classifier";

const MAXIMUM_PINNED_MANIFEST_BYTES = 256 * 1024;
const PINNED_MANIFEST_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;

export type TimelineModernBertConfiguration = {
	modernBert: ModernBertRuntimeOptIn;
	code: "disabled" | "enabled" | "invalid_config";
};

/**
 * The environment may select only a manifest file name. The containing
 * directory is owned by desktop composition, never by the environment.
 */
export type TimelineModernBertConfigurationOptions = {
	manifestDirectory: string;
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
	options: TimelineModernBertConfigurationOptions,
): TimelineModernBertConfiguration {
	const endpoint = environment.WHALEHALL_TIMELINE_MODERNBERT_ENDPOINT?.trim();
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
		if (!PINNED_MANIFEST_FILE_NAME.test(pinnedManifestPath)) {
			return invalidConfiguration();
		}
		const manifestRoot = realpathSync(options.manifestDirectory);
		const manifestRootPrefix = manifestRoot.endsWith(sep)
			? manifestRoot
			: `${manifestRoot}${sep}`;
		const normalizedManifestPath = resolve(manifestRoot, pinnedManifestPath);
		if (
			!normalizedManifestPath.startsWith(manifestRoot) ||
			!normalizedManifestPath.startsWith(manifestRootPrefix)
		) {
			return invalidConfiguration();
		}
		const resolvedManifestPath = realpathSync(normalizedManifestPath);
		if (
			!resolvedManifestPath.startsWith(manifestRoot) ||
			!resolvedManifestPath.startsWith(manifestRootPrefix)
		) {
			return invalidConfiguration();
		}
		const descriptor = openSync(
			resolvedManifestPath,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		let expectedArtifact: ReturnType<
			typeof validatePinnedModernBertArtifactManifest
		>;
		try {
			const stat = fstatSync(descriptor);
			if (
				stat.isSymbolicLink() ||
				!stat.isFile() ||
				stat.size < 1 ||
				stat.size > MAXIMUM_PINNED_MANIFEST_BYTES
			) {
				return invalidConfiguration();
			}
			expectedArtifact = validatePinnedModernBertArtifactManifest(
				JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
			);
		} finally {
			closeSync(descriptor);
		}
		const authorizationToken = environment.WHALEHALL_TIMELINE_MODERNBERT_TOKEN;
		const modernBert = {
			enabled: true as const,
			endpoint,
			manifestEndpoint,
			expectedArtifact,
			allowedRemoteOrigins,
			...(authorizationToken === undefined ? {} : { authorizationToken }),
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
