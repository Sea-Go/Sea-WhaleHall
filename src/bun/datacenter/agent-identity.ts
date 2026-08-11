import type { DataCenterAgentIdentity } from "./types";
import type { SecureValueStore } from "./secure-store";

const AGENT_IDENTITY_KEY = "agent-identity.v1";

export type AgentSigningRequest = {
	method: string;
	path: string;
	timestamp: string;
	nonce: string;
	bodyBytes: Uint8Array<ArrayBuffer>;
};

export type Ed25519AgentIdentity = DataCenterAgentIdentity;

/**
 * Loads the persistent Ed25519 Agent identity or creates a new one. The
 * private key never leaves the SecureValueStore and is imported back into
 * WebCrypto only for the short-lived signature operation.
 */
export async function loadOrCreateAgentIdentity(
	store: SecureValueStore,
): Promise<Ed25519AgentIdentity> {
	const existing = readStoredIdentity(store);
	if (existing !== null) return existing;
	return createAndStoreIdentity(store);
}

export function readStoredIdentity(
	store: SecureValueStore,
): Ed25519AgentIdentity | null {
	const raw = store.get(AGENT_IDENTITY_KEY);
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<Ed25519AgentIdentity>;
		if (
			typeof parsed.installationId === "string" &&
			parsed.installationId.length > 0 &&
			typeof parsed.publicKeyB64 === "string" &&
			parsed.publicKeyB64.length > 0 &&
			typeof parsed.privateKeyPkcs8B64 === "string" &&
			parsed.privateKeyPkcs8B64.length > 0 &&
			typeof parsed.createdAtMs === "number"
		) {
			return parsed as Ed25519AgentIdentity;
		}
	} catch {
		// Corrupt identity is regenerated.
	}
	return null;
}

async function createAndStoreIdentity(
	store: SecureValueStore,
): Promise<Ed25519AgentIdentity> {
	const keyPair = await crypto.subtle.generateKey(
		{ name: "Ed25519" },
		true,
		["sign", "verify"],
	);
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", keyPair.publicKey),
	);
	const privateKey = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
	);
	const identity: Ed25519AgentIdentity = {
		installationId: crypto.randomUUID(),
		publicKeyB64: toBase64Std(publicKey),
		privateKeyPkcs8B64: toBase64Std(privateKey),
		createdAtMs: Date.now(),
	};
	store.set(AGENT_IDENTITY_KEY, JSON.stringify(identity));
	return identity;
}

export async function signAgentRequest(
	identity: Ed25519AgentIdentity,
	request: AgentSigningRequest,
): Promise<string> {
	const canonical = await canonicalRequestPayload(request);
	const privateKey = await importPrivateKey(identity);
	const signature = new Uint8Array(
		await crypto.subtle.sign("Ed25519", privateKey, canonical),
	);
	return toBase64Std(signature);
}

export async function canonicalRequestPayload(
	request: AgentSigningRequest,
): Promise<Uint8Array<ArrayBuffer>> {
	const bodyHash = await sha256(request.bodyBytes);
	const bodyHashB64 = toBase64RawNoPadding(bodyHash);
	const canonical = [
		request.method,
		request.path,
		request.timestamp,
		request.nonce,
		bodyHashB64,
	].join("\n");
	return new TextEncoder().encode(canonical);
}

export function generateNonce(): string {
	return (
		crypto.randomUUID().replaceAll("-", "") +
		crypto.randomUUID().replaceAll("-", "")
	);
}

export function isValidNonce(value: string): boolean {
	return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

async function importPrivateKey(
	identity: Ed25519AgentIdentity,
): Promise<CryptoKey> {
	const bytes = fromBase64Std(identity.privateKeyPkcs8B64);
	return crypto.subtle.importKey(
		"pkcs8",
		bytes,
		{ name: "Ed25519" },
		false,
		["sign"],
	);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return new Uint8Array(digest);
}

export function toBase64Std(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function toBase64RawNoPadding(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replaceAll("=", "");
}

export function fromBase64Std(value: string): Uint8Array<ArrayBuffer> {
	const source = Buffer.from(value, "base64");
	const bytes = new Uint8Array(source.length);
	bytes.set(source);
	return bytes;
}
