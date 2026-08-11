import {
	createCipheriv,
	createHash,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { canonicalJson } from "../agent/reflection/hash";
import type { DesktopEventV1 } from "../agent/reflection/types";

export const DATA_CENTER_ENCRYPTION_CONTEXT_PATH =
	"/api/v1/agent/crypto/encryption-context?purpose=telemetry-sensitive";
export const DATA_CENTER_ENCRYPTION_PURPOSE = "telemetry-sensitive";
export const DATA_CENTER_TRANSPORT_ALGORITHM = "X25519-HKDF-SHA256+A256GCM";
export const DATA_CENTER_CONTENT_ALGORITHM = "A256GCM";
export const DATA_CENTER_AAD_VERSION = "desktop-event-aad.v1";
export const DATA_CENTER_TRANSPORT_AAD_VERSION = "dek-transport-aad.v1";
export const DATA_CENTER_CONTEXT_REFRESH_WINDOW_MS = 5 * 60 * 1_000;

const DATA_CENTER_CONTEXT_SCHEMA_VERSION = "encryption-context.v1";
const DATA_CENTER_CLIENT_ENVELOPE_VERSION = "client-envelope.v1";
const DATA_CENTER_MAX_CONTENT_BYTES = 256 << 10;
const DATA_CENTER_GCM_NONCE_BYTES = 12;
const DATA_CENTER_KEY_BYTES = 32;
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const TRANSPORT_HKDF_INFO = Buffer.from("whalehall/dek-transport/v1", "utf8");

export type DataCenterEncryptionContext = {
	schemaVersion: typeof DATA_CENTER_CONTEXT_SCHEMA_VERSION;
	contextId: string;
	purpose: typeof DATA_CENTER_ENCRYPTION_PURPOSE;
	keyRef: string;
	publicKey: string;
	transportAlgorithm: typeof DATA_CENTER_TRANSPORT_ALGORITHM;
	contentAlgorithm: typeof DATA_CENTER_CONTENT_ALGORITHM;
	aadVersion: typeof DATA_CENTER_AAD_VERSION;
	issuedAt: string;
	expiresAt: string;
	environment: string;
	userId: string;
	issuedAtMs: number;
	expiresAtMs: number;
};

export type DataCenterClientEncryptionEnvelope = {
	schemaVersion: typeof DATA_CENTER_CLIENT_ENVELOPE_VERSION;
	contextId: string;
	purpose: typeof DATA_CENTER_ENCRYPTION_PURPOSE;
	transportAlgorithm: typeof DATA_CENTER_TRANSPORT_ALGORITHM;
	contentAlgorithm: typeof DATA_CENTER_CONTENT_ALGORITHM;
	ephemeralPublicKey: string;
	wrappedDekNonce: string;
	wrappedDek: string;
	contentNonce: string;
	ciphertext: string;
	aadHash: string;
};

export interface DataCenterCryptoMaterialSource {
	/** The caller transfers ownership of publicKeyRaw to the encryptor. */
	createEphemeralKeyPair(): {
		privateKey: KeyObject;
		publicKeyRaw: Buffer;
	};
	/** The caller transfers ownership of the returned buffer to the encryptor. */
	randomBytes(length: number): Buffer;
}

export type DataCenterContentEncryptionInput = {
	context: DataCenterEncryptionContext;
	userId: string;
	agentId: string;
	event: DesktopEventV1;
	publicPayload: Record<string, unknown>;
	nowMs: number;
};

/** DataCenterContentCrypto creates the client-envelope.v1 accepted by DataCenter. */
export class DataCenterContentCrypto {
	constructor(
		private readonly materialSource: DataCenterCryptoMaterialSource = defaultMaterialSource,
	) {}

	encrypt(
		input: DataCenterContentEncryptionInput,
	): DataCenterClientEncryptionEnvelope {
		validateEncryptionInput(input);
		const plaintext = Buffer.from(canonicalJson(input.event.payload), "utf8");
		if (
			plaintext.byteLength < 2 ||
			plaintext.byteLength > DATA_CENTER_MAX_CONTENT_BYTES
		) {
			plaintext.fill(0);
			throw new Error("DataCenter content plaintext has an invalid length.");
		}

		const eventAAD = dataCenterDesktopEventAAD(input);
		const aadHash = base64UrlSha256(eventAAD);
		const transportAAD = dataCenterDEKTransportAAD(input.context, aadHash);
		let ephemeralPrivateKey: KeyObject | null = null;
		let ephemeralPublicKey: Buffer | null = null;
		let dek: Buffer | null = null;
		let wrappedDekNonce: Buffer | null = null;
		let contentNonce: Buffer | null = null;
		let serverPublicRaw: Buffer | null = null;
		let serverPublicDER: Buffer | null = null;
		let shared: Buffer | null = null;
		let salt: Buffer | null = null;
		let transportKey: Buffer | null = null;
		let wrappedDEK: Buffer | null = null;
		let ciphertext: Buffer | null = null;

		try {
			const ephemeral = this.materialSource.createEphemeralKeyPair();
			ephemeralPrivateKey = ephemeral.privateKey;
			ephemeralPublicKey = ephemeral.publicKeyRaw;
			dek = this.materialSource.randomBytes(DATA_CENTER_KEY_BYTES);
			wrappedDekNonce = this.materialSource.randomBytes(
				DATA_CENTER_GCM_NONCE_BYTES,
			);
			contentNonce = this.materialSource.randomBytes(
				DATA_CENTER_GCM_NONCE_BYTES,
			);
			assertLength(ephemeralPublicKey, DATA_CENTER_KEY_BYTES, "ephemeral key");
			assertLength(dek, DATA_CENTER_KEY_BYTES, "content key");
			assertLength(
				wrappedDekNonce,
				DATA_CENTER_GCM_NONCE_BYTES,
				"wrapped key nonce",
			);
			assertLength(contentNonce, DATA_CENTER_GCM_NONCE_BYTES, "content nonce");

			serverPublicRaw = decodeBase64UrlStrict(
				input.context.publicKey,
				DATA_CENTER_KEY_BYTES,
			);
			serverPublicDER = Buffer.concat([X25519_SPKI_PREFIX, serverPublicRaw]);
			const serverPublicKey = createPublicKey({
				key: serverPublicDER,
				format: "der",
				type: "spki",
			});
			shared = diffieHellman({
				privateKey: ephemeralPrivateKey,
				publicKey: serverPublicKey,
			});
			assertLength(shared, DATA_CENTER_KEY_BYTES, "shared secret");
			salt = createHash("sha256")
				.update("whalehall/encryption-context/v1\0", "utf8")
				.update(input.context.contextId, "utf8")
				.digest();
			transportKey = Buffer.from(
				hkdfSync(
					"sha256",
					shared,
					salt,
					TRANSPORT_HKDF_INFO,
					DATA_CENTER_KEY_BYTES,
				),
			);
			wrappedDEK = sealA256GCM(
				transportKey,
				wrappedDekNonce,
				dek,
				transportAAD,
			);
			ciphertext = sealA256GCM(dek, contentNonce, plaintext, eventAAD);
			return {
				schemaVersion: DATA_CENTER_CLIENT_ENVELOPE_VERSION,
				contextId: input.context.contextId,
				purpose: DATA_CENTER_ENCRYPTION_PURPOSE,
				transportAlgorithm: DATA_CENTER_TRANSPORT_ALGORITHM,
				contentAlgorithm: DATA_CENTER_CONTENT_ALGORITHM,
				ephemeralPublicKey: ephemeralPublicKey.toString("base64url"),
				wrappedDekNonce: wrappedDekNonce.toString("base64url"),
				wrappedDek: wrappedDEK.toString("base64url"),
				contentNonce: contentNonce.toString("base64url"),
				ciphertext: ciphertext.toString("base64url"),
				aadHash,
			};
		} catch {
			throw new Error("DataCenter content encryption failed.");
		} finally {
			plaintext.fill(0);
			eventAAD.fill(0);
			transportAAD.fill(0);
			ephemeralPublicKey?.fill(0);
			dek?.fill(0);
			wrappedDekNonce?.fill(0);
			contentNonce?.fill(0);
			serverPublicRaw?.fill(0);
			serverPublicDER?.fill(0);
			shared?.fill(0);
			salt?.fill(0);
			transportKey?.fill(0);
			wrappedDEK?.fill(0);
			ciphertext?.fill(0);
		}
	}
}

export function parseDataCenterEncryptionContext(
	value: unknown,
	options: {
		accountId: string;
		nowMs: number;
		minimumRemainingValidityMs?: number;
	},
): DataCenterEncryptionContext {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"contextId",
			"purpose",
			"keyRef",
			"publicKey",
			"transportAlgorithm",
			"contentAlgorithm",
			"aadVersion",
			"issuedAt",
			"expiresAt",
		]) ||
		value.schemaVersion !== DATA_CENTER_CONTEXT_SCHEMA_VERSION ||
		!isUuid(value.contextId) ||
		value.purpose !== DATA_CENTER_ENCRYPTION_PURPOSE ||
		value.transportAlgorithm !== DATA_CENTER_TRANSPORT_ALGORITHM ||
		value.contentAlgorithm !== DATA_CENTER_CONTENT_ALGORITHM ||
		value.aadVersion !== DATA_CENTER_AAD_VERSION ||
		typeof value.keyRef !== "string" ||
		typeof value.publicKey !== "string" ||
		typeof value.issuedAt !== "string" ||
		typeof value.expiresAt !== "string"
	) {
		throw new Error("DataCenter encryption context is invalid.");
	}
	const keyIdentity = parseDataCenterKeyRef(value.keyRef);
	if (
		!isUuid(options.accountId) ||
		keyIdentity.userId !== options.accountId.toLowerCase()
	) {
		throw new Error("DataCenter encryption context identity is invalid.");
	}
	decodeBase64UrlStrict(value.publicKey, DATA_CENTER_KEY_BYTES).fill(0);
	const issuedAtMs = parseDataCenterTimestamp(value.issuedAt);
	const expiresAtMs = parseDataCenterTimestamp(value.expiresAt);
	const minimumValidity = options.minimumRemainingValidityMs ?? 0;
	if (
		issuedAtMs > options.nowMs + DATA_CENTER_CONTEXT_REFRESH_WINDOW_MS ||
		expiresAtMs <= issuedAtMs ||
		expiresAtMs <= options.nowMs + minimumValidity
	) {
		throw new Error("DataCenter encryption context validity is invalid.");
	}
	return {
		schemaVersion: DATA_CENTER_CONTEXT_SCHEMA_VERSION,
		contextId: value.contextId,
		purpose: DATA_CENTER_ENCRYPTION_PURPOSE,
		keyRef: value.keyRef,
		publicKey: value.publicKey,
		transportAlgorithm: DATA_CENTER_TRANSPORT_ALGORITHM,
		contentAlgorithm: DATA_CENTER_CONTENT_ALGORITHM,
		aadVersion: DATA_CENTER_AAD_VERSION,
		issuedAt: value.issuedAt,
		expiresAt: value.expiresAt,
		environment: keyIdentity.environment,
		userId: keyIdentity.userId,
		issuedAtMs,
		expiresAtMs,
	};
}

export function dataCenterDesktopEventAAD(
	input: DataCenterContentEncryptionInput,
): Buffer {
	return Buffer.from(
		canonicalJson({
			schemaVersion: DATA_CENTER_AAD_VERSION,
			environment: input.context.environment,
			tenantId: input.userId,
			userId: input.userId,
			agentId: input.agentId,
			contextId: input.context.contextId,
			keyRef: input.context.keyRef,
			purpose: DATA_CENTER_ENCRYPTION_PURPOSE,
			event: {
				schemaVersion: "desktop-event.v1",
				eventId: input.event.eventId,
				cursor: input.event.cursor,
				deviceId: input.event.deviceId,
				sessionId: input.event.sessionId,
				kind: input.event.kind,
				source: input.event.source,
				occurredAtMs: input.event.occurredAtMs,
				observedAtMs: input.event.observedAtMs,
				goalVersion: input.event.goalVersion,
				sensitivity: "content",
				publicPayload: input.publicPayload,
			},
		}),
		"utf8",
	);
}

export function dataCenterDEKTransportAAD(
	context: DataCenterEncryptionContext,
	aadHash: string,
): Buffer {
	decodeBase64UrlStrict(aadHash, 32).fill(0);
	return Buffer.from(
		canonicalJson({
			schemaVersion: DATA_CENTER_TRANSPORT_AAD_VERSION,
			contextId: context.contextId,
			keyRef: context.keyRef,
			purpose: DATA_CENTER_ENCRYPTION_PURPOSE,
			aadHash,
		}),
		"utf8",
	);
}

const defaultMaterialSource: DataCenterCryptoMaterialSource = {
	createEphemeralKeyPair() {
		const keyPair = generateKeyPairSync("x25519");
		const publicJWK = keyPair.publicKey.export({ format: "jwk" });
		if (typeof publicJWK.x !== "string") {
			throw new Error("DataCenter ephemeral public key export failed.");
		}
		return {
			privateKey: keyPair.privateKey,
			publicKeyRaw: decodeBase64UrlStrict(publicJWK.x, DATA_CENTER_KEY_BYTES),
		};
	},
	randomBytes(length) {
		return randomBytes(length);
	},
};

function validateEncryptionInput(
	input: DataCenterContentEncryptionInput,
): void {
	const keyIdentity = parseDataCenterKeyRef(input.context.keyRef);
	if (
		input.event.sensitivity !== "content" ||
		!isUuid(input.userId) ||
		!isUuid(input.agentId) ||
		input.context.schemaVersion !== DATA_CENTER_CONTEXT_SCHEMA_VERSION ||
		!isUuid(input.context.contextId) ||
		input.context.purpose !== DATA_CENTER_ENCRYPTION_PURPOSE ||
		input.context.transportAlgorithm !== DATA_CENTER_TRANSPORT_ALGORITHM ||
		input.context.contentAlgorithm !== DATA_CENTER_CONTENT_ALGORITHM ||
		input.context.aadVersion !== DATA_CENTER_AAD_VERSION ||
		input.context.environment !== keyIdentity.environment ||
		input.context.userId !== keyIdentity.userId ||
		keyIdentity.userId !== input.userId.toLowerCase() ||
		input.context.expiresAtMs <= input.nowMs ||
		!isRecord(input.event.payload) ||
		!isRecord(input.publicPayload)
	) {
		throw new Error("DataCenter content encryption input is invalid.");
	}
}

function parseDataCenterKeyRef(value: string): {
	environment: string;
	userId: string;
} {
	const match = value.match(
		/^env\/([a-z][a-z0-9-]{0,31})\/usr\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/telemetry-sensitive\/v1$/u,
	);
	if (!match?.[1] || !match[2]) {
		throw new Error("DataCenter encryption key reference is invalid.");
	}
	return { environment: match[1], userId: match[2] };
}

function parseDataCenterTimestamp(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
		throw new Error("DataCenter encryption context timestamp is invalid.");
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new Error("DataCenter encryption context timestamp is invalid.");
	}
	return parsed;
}

function sealA256GCM(
	key: Buffer,
	nonce: Buffer,
	plaintext: Buffer,
	aad: Buffer,
): Buffer {
	const cipher = createCipheriv("aes-256-gcm", key, nonce, {
		authTagLength: 16,
	});
	cipher.setAAD(aad);
	return Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
}

function base64UrlSha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("base64url");
}

function decodeBase64UrlStrict(value: string, length: number): Buffer {
	if (value.includes("=") || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new Error("DataCenter base64url value is invalid.");
	}
	const decoded = Buffer.from(value, "base64url");
	if (
		decoded.byteLength !== length ||
		decoded.toString("base64url") !== value
	) {
		decoded.fill(0);
		throw new Error("DataCenter base64url value is invalid.");
	}
	return decoded;
}

function assertLength(value: Buffer, length: number, label: string): void {
	if (value.byteLength !== length) {
		throw new Error(`DataCenter ${label} has an invalid length.`);
	}
}

function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
			value,
		)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}
