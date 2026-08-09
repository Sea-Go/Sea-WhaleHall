import { describe, expect, test } from "bun:test";
import {
	createHash,
	createPublicKey,
	verify,
} from "node:crypto";
import type { DesktopEventV1 } from "../src/agent/reflection/types";
import {
	canonicalRfc3986Query,
	createDataCenterAgentCredentials,
	createPendingDataCenterAdvance,
	createPendingDataCenterBatch,
	createPendingDataCenterBatchPrefix,
	dataCenterCanonicalRequestV2,
	parseDataCenterCursor,
	projectDataCenterEvent,
	signDataCenterRequestV2,
	validateDataCenterAdvanceResponse,
	validateDataCenterBatchResponse,
} from "../src/bun/data-center-contract";
import type { CloudSyncConfiguration } from "../src/bun/client-config";

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

describe("DataCenter desktop contract", () => {
	test("creates an independent Ed25519 registration identity and signs the exact v2 canonical body", () => {
		const credentials = createDataCenterAgentCredentials({
			accountId: "account-1",
			installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			nowMs: 1_000,
			platform: "darwin",
			agentVersion: "1.2.3",
		});
		const registration = JSON.parse(credentials.registrationRequestBody);
		expect(registration).toEqual({
			device_name: "WhaleHall Desktop",
			device_type: "desktop",
			os_type: "macos",
			fingerprint: credentials.fingerprint,
			agent_version: "1.2.3",
			installation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			public_key: credentials.publicKey,
		});
		expect(credentials.privateKeyPkcs8).not.toBe(credentials.publicKey);

		const url = new URL(
			"https://data.example.test/api/v1/agent/events/desktop/batch?z=2&a=hello%20world",
		);
		const body = '{"schemaVersion":"desktop-event-batch.v1"}';
		const headers = signDataCenterRequestV2({
			agentId: "11111111-1111-4111-8111-111111111111",
			privateKeyPkcs8: credentials.privateKeyPkcs8,
			method: "POST",
			url,
			body,
			nowMs: Date.parse("2026-08-01T00:00:00.000Z"),
			nonce: "nonce-v2-fixture-0001",
		});
		expect(headers["X-Agent-Signature-Version"]).toBe("2");
		const canonical = dataCenterCanonicalRequestV2({
			agentId: "11111111-1111-4111-8111-111111111111",
			method: "POST",
			url,
			timestamp: headers["X-Agent-Timestamp"],
			nonce: headers["X-Agent-Nonce"],
			body,
		});
		expect(canonical.toString("utf8").split("\n")).toEqual([
			"11111111-1111-4111-8111-111111111111",
			"POST",
			"/api/v1/agent/events/desktop/batch",
			"a=hello%20world&z=2",
			"2026-08-01T00:00:00.000Z",
			"nonce-v2-fixture-0001",
			createHash("sha256").update(body).digest("base64").replace(/=+$/u, ""),
		]);
		const publicKey = createPublicKey({
			key: {
				kty: "OKP",
				crv: "Ed25519",
				x: Buffer.from(credentials.publicKey, "base64").toString("base64url"),
			},
			format: "jwk",
		});
		expect(
			verify(
				null,
				canonical,
				publicKey,
				Buffer.from(headers["X-Agent-Signature"], "base64"),
			),
		).toBeTrue();
		const rebound = dataCenterCanonicalRequestV2({
			agentId: "22222222-2222-4222-8222-222222222222",
			method: "POST",
			url,
			timestamp: headers["X-Agent-Timestamp"],
			nonce: headers["X-Agent-Nonce"],
			body,
		});
		expect(
			verify(
				null,
				rebound,
				publicKey,
				Buffer.from(headers["X-Agent-Signature"], "base64"),
			),
		).toBeFalse();
		expect(() =>
			signDataCenterRequestV2({
				agentId: "11111111-1111-4111-8111-111111111111",
				privateKeyPkcs8: credentials.privateKeyPkcs8,
				method: "POST",
				url,
				body,
				nowMs: Date.parse("2026-08-01T00:00:00.000Z"),
				nonce: " nonce-v2-fixture-0001",
			}),
		).toThrow("nonce");
	});

	test("canonicalizes raw RFC3986 query pairs without treating plus as a space", () => {
		expect(
			canonicalRfc3986Query(
				"z=last&a=hello%20world&a=%2B&a=~&empty&plus=a+b&unicode=%E9%B2%B8",
			),
		).toBe(
			"a=%2B&a=hello%20world&a=~&empty=&plus=a%2Bb&unicode=%E9%B2%B8&z=last",
		);
		expect(() => canonicalRfc3986Query("invalid=%ZZ")).toThrow();
	});

	test("allow-lists editor metadata and strips relative path and text during content downgrade", async () => {
		const event = desktopEvent({
			kind: "editor.documentChanged",
			sensitivity: "content",
			payload: {
				editorId: "vscode",
				documentId: "document-1",
				relativePath: "private/customer/secret.ts",
				language: "typescript",
				insertedChars: 4,
				deletedChars: 1,
				text: "secret source text",
				burstStartedAtMs: 900,
				burstEndedAtMs: 1_000,
			},
		});
		const result = await projectDataCenterEvent({
			event,
			configuration: metadataConfiguration,
			nowMs: 2_000,
		});
		expect(result.kind).toBe("upload");
		if (result.kind !== "upload" || result.event.sensitivity !== "metadata") {
			throw new Error("Expected metadata downgrade.");
		}
		expect(result.event.payload).toEqual({
			editorId: "vscode",
			documentId: "document-1",
			language: "typescript",
			insertedChars: 4,
			deletedChars: 1,
			burstStartedAtMs: 900,
			burstEndedAtMs: 1_000,
		});
		expect(JSON.stringify(result.event)).not.toContain("relativePath");
		expect(JSON.stringify(result.event)).not.toContain("secret");
	});

	test("classifies non-downgradable content, revoked consent, and 31-day expiry as audited advances", async () => {
		const goal = desktopEvent({
			kind: "goal.contextChanged",
			sensitivity: "content",
			payload: {
				previous: null,
				next: {
					goalId: "goal-1",
					planId: null,
					version: 1,
					text: "private goal",
					activatedAtMs: 1_000,
				},
			},
		});
		expect(
			await projectDataCenterEvent({
				event: goal,
				configuration: metadataConfiguration,
				nowMs: 2_000,
			}),
		).toMatchObject({ kind: "advance", reason: "content-not-consented" });

		const browser = desktopEvent({
			kind: "browser.tabOpened",
			payload: { browserId: "browser", tabId: "tab", url: "https://secret" },
		});
		expect(
			await projectDataCenterEvent({
				event: browser,
				configuration: {
					...metadataConfiguration,
					consents: { ...metadataConfiguration.consents, browser: "off" },
				},
				nowMs: 2_000,
			}),
		).toMatchObject({ kind: "advance", reason: "consent-revoked" });

		expect(
			await projectDataCenterEvent({
				event: { ...browser, occurredAtMs: 0, observedAtMs: 0 },
				configuration: metadataConfiguration,
				nowMs: 31 * 24 * 60 * 60 * 1_000 + 1,
			}),
		).toMatchObject({ kind: "advance", reason: "retention-expired" });
	});

	test("encrypts only the server content allowlist and fails closed when encryption is unavailable", async () => {
		const goal = desktopEvent({
			kind: "goal.contextChanged",
			sensitivity: "content",
			payload: { previous: null, next: null },
		});
		await expect(
			projectDataCenterEvent({
				event: goal,
				configuration: contentConfiguration,
				nowMs: 2_000,
			}),
		).rejects.toThrow("unavailable");

		const encrypted = await projectDataCenterEvent({
			event: goal,
			configuration: contentConfiguration,
			nowMs: 2_000,
			contentEncryptor: {
				async encrypt(_event, publicPayload) {
					expect(publicPayload).toEqual({});
					return testEncryptionEnvelope();
				},
			},
		});
		expect(encrypted).toMatchObject({
			kind: "upload",
			event: { sensitivity: "content", publicPayload: {} },
		});

		let encryptionCalls = 0;
		const tabClosed = desktopEvent({
			kind: "browser.tabClosed",
			sensitivity: "content",
			payload: { browserId: "browser", tabId: "tab" },
		});
		const downgraded = await projectDataCenterEvent({
			event: tabClosed,
			configuration: contentConfiguration,
			nowMs: 2_000,
			contentEncryptor: {
				async encrypt() {
					encryptionCalls += 1;
					return testEncryptionEnvelope();
				},
			},
		});
		expect(encryptionCalls).toBe(0);
		expect(downgraded).toMatchObject({
			kind: "upload",
			event: {
				sensitivity: "metadata",
				payload: { browserId: "browser", tabId: "tab" },
			},
		});
	});

	test("caps exact batches at 500 events and the conservative UTF-8 wire limit", () => {
		const events = Array.from({ length: 500 }, (_, index) => ({
			schemaVersion: "desktop-event.v1" as const,
			eventId: `de1_${index.toString(16).padStart(64, "0")}`,
			cursor: `ec1_${(index + 1).toString(16).padStart(16, "0")}`,
			deviceId: "device",
			sessionId: "session",
			kind: "system.heartbeat" as const,
			source: "test",
			occurredAtMs: 1_000,
			observedAtMs: 1_000,
			goalVersion: null,
			sensitivity: "metadata" as const,
			payload: {},
		}));
		const maximum = createPendingDataCenterBatchPrefix(
			"account-1",
			events,
			2_000,
		);
		expect(maximum?.eventCount).toBe(500);

		const oversized = {
			...events[0]!,
			payload: { value: "x".repeat(15 * 1024 * 1024) },
		};
		expect(
			createPendingDataCenterBatchPrefix("account-1", [oversized], 2_000),
		).toBeNull();
	});

	test("freezes exact batch and advance bodies and rejects incomplete ACK envelopes", () => {
		const projected = {
			schemaVersion: "desktop-event.v1" as const,
			eventId: `de1_${"b".repeat(64)}`,
			cursor: "ec1_0000000000000001",
			deviceId: "device",
			sessionId: "session",
			kind: "system.heartbeat" as const,
			source: "test",
			occurredAtMs: 1_000,
			observedAtMs: 1_000,
			goalVersion: null,
			sensitivity: "metadata" as const,
			payload: {},
		};
		const batch = createPendingDataCenterBatch("account-1", [projected], 2_000);
		expect(createHash("sha256").update(batch.body).digest("hex")).toBe(
			batch.requestHash,
		);
		validateDataCenterBatchResponse(
			{
				batchId: "11111111-1111-4111-8111-111111111111",
				requestHash: batch.requestHash,
				ackCursor: batch.lastCursor,
				acceptedCount: 1,
				duplicateCount: 0,
				results: [
					{
						eventId: projected.eventId,
						cursor: projected.cursor,
						status: "accepted",
					},
				],
			},
			batch,
		);
		expect(() =>
			validateDataCenterBatchResponse(
				{
					batchId: "11111111-1111-4111-8111-111111111111",
					ackCursor: batch.lastCursor,
					acceptedCount: 1,
					duplicateCount: 0,
					results: [],
				},
				batch,
			),
		).toThrow("ACK");

		const advance = createPendingDataCenterAdvance({
			accountId: "account-1",
			fromCursor: null,
			toCursor: "ec1_0000000000000003",
			reason: "account-boundary",
			createdAtMs: 3_000,
		});
		expect(JSON.parse(advance.body)).toEqual({
			schemaVersion: "desktop-event-advance.v1",
			fromCursor: null,
			toCursor: "ec1_0000000000000003",
			reason: "account-boundary",
			eventCount: 3,
		});
		validateDataCenterAdvanceResponse(
			{
				schemaVersion: "desktop-event-cursor.v1",
				ackCursor: advance.toCursor,
				advancedCount: 3,
			},
			advance,
		);
		expect(
			parseDataCenterCursor({
				schemaVersion: "desktop-event-cursor.v1",
				ackCursor: "ec1_0000000000000003",
				sequence: 3,
				updatedAt: "2026-08-10T00:00:00Z",
			}),
		).toMatchObject({ ackCursor: "ec1_0000000000000003", sequence: 3 });
		expect(() =>
			parseDataCenterCursor({
				schemaVersion: "desktop-event-cursor.v1",
				ackCursor: null,
				sequence: 0,
				updatedAt: null,
			}),
		).toThrow("cursor");
	});
});

function testEncryptionEnvelope() {
	return {
		schemaVersion: "client-envelope.v1" as const,
		contextId: "11111111-1111-4111-8111-111111111111",
		purpose: "telemetry-sensitive" as const,
		transportAlgorithm: "X25519-HKDF-SHA256+A256GCM" as const,
		contentAlgorithm: "A256GCM" as const,
		ephemeralPublicKey: "a",
		wrappedDekNonce: "b",
		wrappedDek: "c",
		contentNonce: "d",
		ciphertext: "e",
		aadHash: "f",
	};
}

function desktopEvent(override: {
	kind: DesktopEventV1["kind"];
	payload: DesktopEventV1["payload"];
	sensitivity?: DesktopEventV1["sensitivity"];
}): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `de1_${"a".repeat(64)}`,
		cursor: "ec1_0000000000000001",
		deviceId: "device-1",
		sessionId: "session-1",
		source: "test",
		occurredAtMs: 1_000,
		observedAtMs: 1_000,
		goalVersion: null,
		sensitivity: "metadata",
		...override,
	} as DesktopEventV1;
}
