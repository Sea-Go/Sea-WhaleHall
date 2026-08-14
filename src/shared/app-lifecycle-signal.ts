export const WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE =
	"com.seago.whalehall.lifecycle.signal" as const;
export const WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION = 1 as const;

export type WhaleHallLifecycleSignal = "SIGINT" | "SIGTERM";

export type WhaleHallLifecycleSignalMessage = {
	readonly type: typeof WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE;
	readonly version: typeof WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION;
	readonly signal: WhaleHallLifecycleSignal;
};

export function isWhaleHallLifecycleSignalMessage(
	value: unknown,
): value is WhaleHallLifecycleSignalMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		Object.keys(candidate).length === 3 &&
		candidate.type === WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE &&
		candidate.version === WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION &&
		(candidate.signal === "SIGINT" || candidate.signal === "SIGTERM")
	);
}
