import { canonicalJson } from "../reflection/hash";

export type TimelineVaultPurpose =
	| "timeline.collector.v2"
	| "timeline.window.v2"
	| "timeline.fact.v2"
	| "timeline.episode.v2"
	| "timeline.summary.v2"
	| "timeline.agent-input.v1";

export type TimelineVaultSealRequest = {
	recordId: string;
	purpose: TimelineVaultPurpose;
	schemaVersion: string;
	plaintext: string;
	aad: Record<string, string | number | null>;
	expiresAtMs?: number | null;
};

export type TimelineVaultOpenRequest = {
	recordId: string;
	purpose: TimelineVaultPurpose;
	schemaVersion: string;
	sealedPayload: string;
	aad: Record<string, string | number | null>;
};

export type TimelineVaultDeleteRequest = {
	purpose: TimelineVaultPurpose;
	recordIds: string[];
};

/**
 * Rust owns Keychain access, AES-256-GCM, nonce generation, and key versions.
 * The TypeScript timeline layer receives only an opaque sealed payload and can
 * never create or persist a key.
 */
export interface TimelineVault {
	seal(request: TimelineVaultSealRequest): Promise<string>;
	open(request: TimelineVaultOpenRequest): Promise<string>;
	deleteRecords(request: TimelineVaultDeleteRequest): Promise<void>;
}

export class TimelineVaultUnavailableError extends Error {
	constructor(message = "The Rust content vault is unavailable.") {
		super(message);
		this.name = "TimelineVaultUnavailableError";
	}
}

/**
 * Safe default used until the native vault transport is wired. It deliberately
 * fails closed instead of writing sensitive JSON as plaintext.
 */
export class UnavailableTimelineVault implements TimelineVault {
	async seal(_request: TimelineVaultSealRequest): Promise<string> {
		throw new TimelineVaultUnavailableError();
	}

	async open(_request: TimelineVaultOpenRequest): Promise<string> {
		throw new TimelineVaultUnavailableError();
	}

	async deleteRecords(_request: TimelineVaultDeleteRequest): Promise<void> {
		throw new TimelineVaultUnavailableError();
	}
}

export async function sealTimelineJson(
	vault: TimelineVault,
	request: Omit<TimelineVaultSealRequest, "plaintext">,
	value: unknown,
): Promise<string> {
	return vault.seal({
		...request,
		plaintext: canonicalJson(value),
	});
}

export async function openTimelineJson<T>(
	vault: TimelineVault,
	request: TimelineVaultOpenRequest,
): Promise<T> {
	const plaintext = await vault.open(request);
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		throw new TimelineVaultUnavailableError(
			`Vault returned invalid JSON for ${request.recordId}.`,
		);
	}
	return parsed as T;
}
