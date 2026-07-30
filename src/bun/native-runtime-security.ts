export const NATIVE_RUNTIME_CHANNELS = ["dev", "canary", "stable"] as const;

export type NativeRuntimeChannel = (typeof NATIVE_RUNTIME_CHANNELS)[number];

export function parseNativeRuntimeChannel(value: unknown): NativeRuntimeChannel {
	if (
		typeof value === "string" &&
		NATIVE_RUNTIME_CHANNELS.some((channel) => channel === value)
	) {
		return value as NativeRuntimeChannel;
	}
	throw new Error(
		`Unsupported WhaleHall runtime channel: ${String(value)}. `
			+ `Expected one of ${NATIVE_RUNTIME_CHANNELS.join(", ")}.`,
	);
}

export function nativeRuntimeSecurityEnvironment(
	channel: NativeRuntimeChannel,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const environment: Record<string, string> = {
		WHALEHALL_RUNTIME_CHANNEL: channel,
	};
	if (platform === "darwin" && (channel === "dev" || channel === "canary")) {
		environment.WHALEHALL_ALLOW_LEGACY_DEV_KEYCHAIN = "true";
	}
	return environment;
}

export function isObservationEncryptionUnavailable(
	error: unknown,
): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "PERMISSION_DENIED" &&
		error.message === "Observation content encryption is unavailable"
	);
}
