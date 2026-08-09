import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	hkdfSync,
	type KeyObject,
	verify,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DesktopEventV1 } from "../src/agent/reflection/types";
import type { CloudSyncConfiguration } from "../src/bun/client-config";
import {
	canonicalRfc3986Query,
	createPendingDataCenterAdvance,
	createPendingDataCenterBatch,
	DATA_CENTER_REGISTER_PATH,
	dataCenterCanonicalRequestV2,
	dataCenterConsentRequest,
	parseDataCenterCursor,
	parseDataCenterErrorEnvelope,
	parseDataCenterRegistration,
	projectDataCenterEvent,
	validateDataCenterAdvanceResponse,
	validateDataCenterBatchResponse,
} from "../src/bun/data-center-contract";
import {
	type DataCenterClientEncryptionEnvelope,
	DataCenterContentCrypto,
	type DataCenterCryptoMaterialSource,
	type DataCenterEncryptionContext,
	dataCenterDEKTransportAAD,
	dataCenterDesktopEventAAD,
	parseDataCenterEncryptionContext,
} from "../src/bun/data-center-crypto";

const DATA_CENTER_CI_REPOSITORY = "/workspace/datacenter";
const DATA_CENTER_REPOSITORY = locateDataCenterRepository();
const CONTRACT_DIRECTORY = DATA_CENTER_REPOSITORY
	? resolve(DATA_CENTER_REPOSITORY, "contracts/v1")
	: "";
const describeDataCenterContract = DATA_CENTER_REPOSITORY
	? describe
	: describe.skip;

type JsonRecord = Record<string, unknown>;

type SignatureCorpus = {
	schemaVersion: string;
	agentId: string;
	publicKey: string;
	cases: Array<{
		name: string;
		signatureVersion: "1" | "2";
		method: string;
		path: string;
		rawQuery: string;
		canonicalQuery: string;
		timestamp: string;
		nonce: string;
		body: string;
		bodyHash: string;
		canonical: string;
		signature: string;
	}>;
};

type DesktopCorpus = {
	schemaVersion: string;
	metadataBatch: {
		exactBody: string;
		requestHash: string;
		ack: unknown;
	};
	cursors: { empty: unknown; afterBatch: unknown };
	advance: {
		allowedReasons: string[];
		exactBody: string;
		requestHash: string;
		ack: unknown;
	};
	errors: Array<{ name: string; status: number; envelope: unknown }>;
};

type AgentCorpus = {
	schemaVersion: string;
	registration: {
		method: string;
		path: string;
		request: JsonRecord;
		responses: Array<{ name: string; status: number; body: unknown }>;
	};
	consents: Array<{
		name: string;
		method: string;
		path: string;
		request: {
			granted: boolean;
			data_level: number;
			policy_version: string;
		};
		status: number;
		ack: JsonRecord;
	}>;
};

type EventCorpus = {
	schemaVersion: string;
	cases: Array<{
		kind: DesktopEventV1["kind"];
		domain: string;
		contentCapable: boolean;
		rawSyntheticPayload: JsonRecord;
		metadataProjection: JsonRecord;
		removedSensitiveFields: string[];
	}>;
};

type EncryptionCorpus = {
	schemaVersion: string;
	testVector: {
		testOnly: boolean;
		environment: string;
		agentId: string;
		userId: string;
		serverPrivateKeyRaw: string;
		ephemeralPrivateKeyRaw: string;
		dekRaw: string;
		contentBase64URL: string;
		aadCanonical: string;
		transportAADCanonical: string;
	};
	context: JsonRecord;
	event: JsonRecord;
	clientEnvelope: DataCenterClientEncryptionEnvelope;
};

const metadataConfiguration: CloudSyncConfiguration = {
	enabled: true,
	contentEncryptionEnabled: false,
	consents: {
		activity: "metadata",
		browser: "metadata",
		presence: "metadata",
	},
};

const contentConfiguration: CloudSyncConfiguration = {
	...metadataConfiguration,
	contentEncryptionEnabled: true,
	consents: {
		activity: "content",
		browser: "content",
		presence: "content",
	},
};

describeDataCenterContract("DataCenter cross-repository cloud contract", () => {
	test("runs against a pinned DataCenter checkout in CI", () => {
		expect(
			existsSync(resolve(CONTRACT_DIRECTORY, "signatures.json")),
		).toBeTrue();
		if (!process.env.CI) return;
		const expected = process.env.DATACENTER_COMMIT_SHA;
		if (!expected || !/^[a-f0-9]{40}$/u.test(expected)) {
			throw new Error(
				"CI must provide a full DATACENTER_COMMIT_SHA for cross-contract tests.",
			);
		}
		const marker = resolve(DATA_CENTER_REPOSITORY, ".datacenter-commit-sha");
		const actual = existsSync(marker)
			? readFileSync(marker, "utf8").trim()
			: execFileSync(
					"git",
					["-C", DATA_CENTER_REPOSITORY, "rev-parse", "HEAD"],
					{ encoding: "utf8" },
				).trim();
		expect(actual).toBe(expected);
	});

	test("accepts every v1/v2 signature golden including exact RFC3986 query bytes", () => {
		const corpus = fixture<SignatureCorpus>("signatures.json");
		expect(corpus.schemaVersion).toBe("datacenter-signature-corpus.v1");
		const publicKey = createPublicKey({
			key: {
				kty: "OKP",
				crv: "Ed25519",
				x: Buffer.from(corpus.publicKey, "base64").toString("base64url"),
			},
			format: "jwk",
		});
		for (const candidate of corpus.cases) {
			const bodyHash = createHash("sha256")
				.update(candidate.body, "utf8")
				.digest("base64")
				.replace(/=+$/u, "");
			expect(bodyHash, candidate.name).toBe(candidate.bodyHash);
			expect(canonicalRfc3986Query(candidate.rawQuery), candidate.name).toBe(
				candidate.canonicalQuery,
			);
			const canonical =
				candidate.signatureVersion === "2"
					? dataCenterCanonicalRequestV2({
							agentId: corpus.agentId,
							method: candidate.method,
							url: new URL(
								`https://data.contract.invalid${candidate.path}${candidate.rawQuery ? `?${candidate.rawQuery}` : ""}`,
							),
							timestamp: candidate.timestamp,
							nonce: candidate.nonce,
							body: candidate.body,
						})
					: Buffer.from(
							[
								candidate.method,
								candidate.path,
								candidate.timestamp,
								candidate.nonce,
								candidate.bodyHash,
							].join("\n"),
							"utf8",
						);
			expect(canonical.toString("utf8"), candidate.name).toBe(
				candidate.canonical,
			);
			expect(
				verify(
					null,
					canonical,
					publicKey,
					Buffer.from(candidate.signature, "base64"),
				),
				candidate.name,
			).toBeTrue();
		}
	});

	test("recreates exact batch, cursor, advance, ACK, and error fixtures", () => {
		const corpus = fixture<DesktopCorpus>("desktop.json");
		expect(corpus.schemaVersion).toBe("datacenter-desktop-corpus.v1");
		const batchBody = JSON.parse(corpus.metadataBatch.exactBody) as {
			events: Parameters<typeof createPendingDataCenterBatch>[1];
		};
		const batch = createPendingDataCenterBatch(
			"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			batchBody.events,
			0,
		);
		expect(batch.body).toBe(corpus.metadataBatch.exactBody);
		expect(batch.requestHash).toBe(corpus.metadataBatch.requestHash);
		expect(() =>
			validateDataCenterBatchResponse(corpus.metadataBatch.ack, batch),
		).not.toThrow();
		expect(parseDataCenterCursor(corpus.cursors.empty) as unknown).toEqual(
			corpus.cursors.empty,
		);
		expect(parseDataCenterCursor(corpus.cursors.afterBatch) as unknown).toEqual(
			corpus.cursors.afterBatch,
		);

		const advanceBody = JSON.parse(corpus.advance.exactBody) as {
			fromCursor: string | null;
			toCursor: string;
			reason: Parameters<typeof createPendingDataCenterAdvance>[0]["reason"];
		};
		const advance = createPendingDataCenterAdvance({
			accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			fromCursor: advanceBody.fromCursor,
			toCursor: advanceBody.toCursor,
			reason: advanceBody.reason,
			createdAtMs: 0,
		});
		expect(advance.body).toBe(corpus.advance.exactBody);
		expect(advance.requestHash).toBe(corpus.advance.requestHash);
		expect(() =>
			validateDataCenterAdvanceResponse(corpus.advance.ack, advance),
		).not.toThrow();
		expect(corpus.advance.allowedReasons.sort()).toEqual(
			[
				"account-boundary",
				"consent-revoked",
				"content-not-consented",
				"payload-unsupported",
				"retention-expired",
			].sort(),
		);
		for (const error of corpus.errors) {
			expect(
				parseDataCenterErrorEnvelope(error.envelope) as unknown,
				error.name,
			).toEqual(error.envelope);
			expect([400, 403, 409, 413, 422, 429, 500, 503]).toContain(error.status);
		}
	});

	test("matches native registration and all three consent levels", () => {
		const corpus = fixture<AgentCorpus>("agent.json");
		expect(corpus.schemaVersion).toBe("datacenter-agent-corpus.v1");
		expect(corpus.registration).toMatchObject({
			method: "POST",
			path: DATA_CENTER_REGISTER_PATH,
		});
		for (const response of corpus.registration.responses) {
			if (response.status === 200 || response.status === 201) {
				const body = response.body as JsonRecord;
				expect(
					parseDataCenterRegistration(response.body),
					response.name,
				).toEqual({
					agentId: String(body.agent_id),
					deviceId: String(body.device_id),
					configVersion: Number(body.config_version),
				});
			} else {
				expect(response.status).toBe(409);
				expect(() => parseDataCenterRegistration(response.body)).toThrow();
			}
		}
		for (const consent of corpus.consents) {
			expect(consent.method, consent.name).toBe("PUT");
			expect(consent.path, consent.name).toBe(
				`/v1/devices/${String(consent.ack.device_id)}/consents/${String(consent.ack.sensor_type)}`,
			);
			const level =
				consent.request.data_level === 0
					? "off"
					: consent.request.data_level === 1
						? "metadata"
						: "content";
			expect(dataCenterConsentRequest(level), consent.name).toEqual({
				...consent.request,
				policy_version: "desktop-metadata.v1",
			});
			expect(consent.status).toBe(200);
			expect(consent.ack).toMatchObject({
				granted: consent.request.granted,
				data_level: consent.request.data_level,
			});
		}
	});

	test("projects every shared event kind and encrypts only the content allowlist", async () => {
		const corpus = fixture<EventCorpus>("events.json");
		expect(corpus.schemaVersion).toBe("datacenter-desktop-event-kinds.v1");
		expect(corpus.cases).toHaveLength(27);
		for (const [index, candidate] of corpus.cases.entries()) {
			const event = corpusEvent(candidate, index);
			const metadata = await projectDataCenterEvent({
				event,
				configuration: metadataConfiguration,
				nowMs: event.observedAtMs,
			});
			if (candidate.kind === "goal.contextChanged") {
				expect(metadata, candidate.kind).toMatchObject({
					kind: "advance",
					reason: "content-not-consented",
				});
			} else {
				expect(metadata, candidate.kind).toMatchObject({
					kind: "upload",
					domain: candidate.domain,
					event: {
						sensitivity: "metadata",
						payload: candidate.metadataProjection,
					},
				});
			}

			let encryptCalls = 0;
			const content = await projectDataCenterEvent({
				event: { ...event, sensitivity: "content" } as DesktopEventV1,
				configuration: contentConfiguration,
				nowMs: event.observedAtMs,
				contentEncryptor: {
					async encrypt(_event, publicPayload) {
						encryptCalls += 1;
						expect(publicPayload).toEqual(candidate.metadataProjection);
						return syntheticEnvelope();
					},
				},
			});
			expect(encryptCalls, candidate.kind).toBe(
				candidate.contentCapable ? 1 : 0,
			);
			expect(content, candidate.kind).toMatchObject({
				kind: "upload",
				domain: candidate.domain,
				event: {
					sensitivity: candidate.contentCapable ? "content" : "metadata",
					...(candidate.contentCapable
						? { publicPayload: candidate.metadataProjection }
						: { payload: candidate.metadataProjection }),
				},
			});
			for (const field of candidate.removedSensitiveFields) {
				const sensitiveValue = field
					.split(".")
					.reduce<unknown>(
						(value, segment) =>
							typeof value === "object" && value !== null
								? (value as JsonRecord)[segment]
								: undefined,
						candidate.rawSyntheticPayload,
					);
				expect(
					JSON.stringify(metadata),
					`${candidate.kind}:${field}`,
				).not.toContain(String(sensitiveValue));
			}
		}
	});

	test("reproduces the real X25519/HKDF/A256GCM golden and rejects identity/AAD tampering", () => {
		const corpus = fixture<EncryptionCorpus>("encryption.json");
		expect(corpus.schemaVersion).toBe("datacenter-encryption-corpus.v1");
		expect(corpus.testVector.testOnly).toBeTrue();
		const nowMs = Date.parse("2026-08-10T00:00:00Z");
		const context = parseDataCenterEncryptionContext(corpus.context, {
			accountId: corpus.testVector.userId,
			nowMs,
		});
		const rawPayload = JSON.parse(
			Buffer.from(corpus.testVector.contentBase64URL, "base64url").toString(
				"utf8",
			),
		) as JsonRecord;
		const event = {
			...corpus.event,
			sensitivity: "content",
			payload: rawPayload,
		} as unknown as DesktopEventV1;
		const material = deterministicMaterialSource(corpus);
		const crypto = new DataCenterContentCrypto(material);
		const envelope = crypto.encrypt({
			context,
			userId: corpus.testVector.userId,
			agentId: corpus.testVector.agentId,
			event,
			publicPayload: corpus.event.publicPayload as JsonRecord,
			nowMs,
		});
		expect(envelope).toEqual(corpus.clientEnvelope);
		expect(
			dataCenterDesktopEventAAD({
				context,
				userId: corpus.testVector.userId,
				agentId: corpus.testVector.agentId,
				event,
				publicPayload: corpus.event.publicPayload as JsonRecord,
				nowMs,
			}).toString("utf8"),
		).toBe(corpus.testVector.aadCanonical);
		expect(
			dataCenterDEKTransportAAD(context, envelope.aadHash).toString("utf8"),
		).toBe(corpus.testVector.transportAADCanonical);

		expect(() =>
			parseDataCenterEncryptionContext(corpus.context, {
				accountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
				nowMs,
			}),
		).toThrow("identity");
		expect(() =>
			parseDataCenterEncryptionContext(
				{
					...corpus.context,
					keyRef: String(corpus.context.keyRef).replace(/\/v1$/u, "/v2"),
				},
				{ accountId: corpus.testVector.userId, nowMs },
			),
		).toThrow("key reference");

		const plaintext = decryptGoldenContent(corpus, context, event, envelope);
		expect(plaintext.toString("utf8")).toBe("{}");
		plaintext.fill(0);
		const tampered = {
			...envelope,
			ciphertext: flipBase64UrlByte(envelope.ciphertext),
		};
		expect(() =>
			decryptGoldenContent(corpus, context, event, tampered),
		).toThrow();
		const changedCursor = {
			...event,
			cursor: "ec1_0000000000000002",
		} as DesktopEventV1;
		expect(() =>
			decryptGoldenContent(corpus, context, changedCursor, envelope),
		).toThrow();
	});
});

function fixture<T>(name: string): T {
	const path = resolve(CONTRACT_DIRECTORY, name);
	if (!existsSync(path)) {
		throw new Error(`Required DataCenter contract fixture is missing: ${path}`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function locateDataCenterRepository(): string {
	if (process.env.CI) {
		if (!process.env.DATACENTER_REPOSITORY) return "";
		if (process.env.DATACENTER_REPOSITORY !== DATA_CENTER_CI_REPOSITORY) {
			throw new Error(
				`CI DATACENTER_REPOSITORY must be ${DATA_CENTER_CI_REPOSITORY}.`,
			);
		}
		if (!existsSync(resolve(DATA_CENTER_CI_REPOSITORY, "contracts/v1"))) {
			throw new Error("CI DataCenter checkout has no contracts/v1 directory.");
		}
		return DATA_CENTER_CI_REPOSITORY;
	}
	for (const candidate of [
		resolve(process.cwd(), "../Sea-DataCenter-integration"),
		resolve(process.cwd(), "../Sea-DataCenter"),
		resolve(process.cwd(), "../../Sea-DataCenter"),
	]) {
		if (existsSync(resolve(candidate, "contracts/v1"))) return candidate;
	}
	throw new Error(
		"Set DATACENTER_REPOSITORY to a DataCenter checkout containing contracts/v1.",
	);
}

function corpusEvent(
	candidate: EventCorpus["cases"][number],
	index: number,
): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `de1_${(index + 1).toString(16).padStart(64, "0")}`,
		cursor: `ec1_${(index + 1).toString().padStart(16, "0")}`,
		deviceId: "golden-device",
		sessionId: "golden-session",
		kind: candidate.kind,
		source: "golden.contract",
		occurredAtMs: 1_786_320_000_000,
		observedAtMs: 1_786_320_000_000,
		goalVersion: null,
		sensitivity: candidate.contentCapable ? "content" : "metadata",
		payload: structuredClone(candidate.rawSyntheticPayload),
	} as DesktopEventV1;
}

function syntheticEnvelope(): DataCenterClientEncryptionEnvelope {
	return {
		schemaVersion: "client-envelope.v1",
		contextId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		purpose: "telemetry-sensitive",
		transportAlgorithm: "X25519-HKDF-SHA256+A256GCM",
		contentAlgorithm: "A256GCM",
		ephemeralPublicKey: "AA",
		wrappedDekNonce: "AA",
		wrappedDek: "AA",
		contentNonce: "AA",
		ciphertext: "AA",
		aadHash: "AA",
	};
}

function deterministicMaterialSource(
	corpus: EncryptionCorpus,
): DataCenterCryptoMaterialSource {
	const privateKey = x25519PrivateKey(corpus.testVector.ephemeralPrivateKeyRaw);
	const publicJwk = createPublicKey(privateKey as never).export({
		format: "jwk",
	});
	if (typeof publicJwk.x !== "string") {
		throw new Error("X25519 test public key export failed.");
	}
	const random = [
		Buffer.from(corpus.testVector.dekRaw, "base64url"),
		Buffer.alloc(12, 0x11),
		Buffer.alloc(12, 0x22),
	];
	return {
		createEphemeralKeyPair() {
			return {
				privateKey,
				publicKeyRaw: Buffer.from(publicJwk.x as string, "base64url"),
			};
		},
		randomBytes(length) {
			const value = random.shift();
			if (!value || value.byteLength !== length) {
				throw new Error("Unexpected deterministic crypto material request.");
			}
			return Buffer.from(value);
		},
	};
}

function x25519PrivateKey(raw: string): KeyObject {
	return createPrivateKey({
		key: Buffer.concat([
			Buffer.from("302e020100300506032b656e04220420", "hex"),
			Buffer.from(raw, "base64url"),
		]),
		format: "der",
		type: "pkcs8",
	});
}

function decryptGoldenContent(
	corpus: EncryptionCorpus,
	context: DataCenterEncryptionContext,
	event: DesktopEventV1,
	envelope: DataCenterClientEncryptionEnvelope,
): Buffer {
	// The golden's wrapped DEK is already independently verified by DataCenter.
	// Derive it here through Node primitives so event-AAD tampering is exercised.
	const transportKey = deriveGoldenTransportKey(
		corpus.testVector.serverPrivateKeyRaw,
		envelope.ephemeralPublicKey,
		context.contextId,
	);
	const transportAAD = dataCenterDEKTransportAAD(context, envelope.aadHash);
	const dek = openA256GCM(
		transportKey,
		Buffer.from(envelope.wrappedDekNonce, "base64url"),
		Buffer.from(envelope.wrappedDek, "base64url"),
		transportAAD,
	);
	const eventAAD = dataCenterDesktopEventAAD({
		context,
		userId: corpus.testVector.userId,
		agentId: corpus.testVector.agentId,
		event,
		publicPayload: corpus.event.publicPayload as JsonRecord,
		nowMs: Date.parse("2026-08-10T00:00:00Z"),
	});
	try {
		return openA256GCM(
			dek,
			Buffer.from(envelope.contentNonce, "base64url"),
			Buffer.from(envelope.ciphertext, "base64url"),
			eventAAD,
		);
	} finally {
		transportKey.fill(0);
		transportAAD.fill(0);
		dek.fill(0);
		eventAAD.fill(0);
	}
}

function deriveGoldenTransportKey(
	serverPrivateRaw: string,
	ephemeralPublicRaw: string,
	contextId: string,
): Buffer {
	const shared = diffieHellman({
		privateKey: x25519PrivateKey(serverPrivateRaw),
		publicKey: createPublicKey({
			key: Buffer.concat([
				Buffer.from("302a300506032b656e032100", "hex"),
				Buffer.from(ephemeralPublicRaw, "base64url"),
			]),
			format: "der",
			type: "spki",
		}),
	});
	const salt = createHash("sha256")
		.update("whalehall/encryption-context/v1\0", "utf8")
		.update(contextId, "utf8")
		.digest();
	try {
		return Buffer.from(
			hkdfSync(
				"sha256",
				shared,
				salt,
				Buffer.from("whalehall/dek-transport/v1", "utf8"),
				32,
			),
		);
	} finally {
		shared.fill(0);
		salt.fill(0);
	}
}

function openA256GCM(
	key: Buffer,
	nonce: Buffer,
	sealed: Buffer,
	aad: Buffer,
): Buffer {
	const tag = sealed.subarray(sealed.byteLength - 16);
	const ciphertext = sealed.subarray(0, sealed.byteLength - 16);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
		authTagLength: 16,
	});
	decipher.setAAD(aad);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function flipBase64UrlByte(value: string): string {
	const bytes = Buffer.from(value, "base64url");
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	return bytes.toString("base64url");
}
