import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import type {
	LocalEventCommitResult,
	LocalEventQuery,
	LocalEventQueryResult,
	LocalEventTailCursorResult,
} from "../src/agent/local-protocol";
import type { DesktopEventV1 } from "../src/agent/reflection/types";
import type { AuthSessionIdentity } from "../src/bun/auth-session";
import {
	type CloudSyncConfiguration,
	WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
} from "../src/bun/client-config";
import {
	cloudSyncConsentDigest,
	completeDataCenterRegistration,
	createDataCenterAgentCredentials,
	createPendingDataCenterBatch,
	dataCenterCursorSequence,
} from "../src/bun/data-center-contract";
import {
	type DataCenterBearerAuthorization,
	type DataCenterEventJournal,
	type DataCenterSyncRepository,
	DataCenterSyncService,
} from "../src/bun/data-center-sync";
import type {
	DataCenterAgentCredentialsRecord,
	DataCenterConsumerAuditRecord,
	DataCenterConsumerOwnerRecord,
	DataCenterPendingAdvanceRecord,
	DataCenterPendingBatchRecord,
} from "../src/bun/encrypted-agent-repository";

const enabledMetadata: CloudSyncConfiguration = {
	enabled: true,
	contentEncryptionEnabled: false,
	consents: {
		activity: "metadata",
		browser: "metadata",
		presence: "metadata",
	},
};

const enabledContent: CloudSyncConfiguration = {
	...enabledMetadata,
	contentEncryptionEnabled: true,
	consents: {
		activity: "content",
		browser: "content",
		presence: "content",
	},
};

const CONTENT_ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTENT_NOW_MS = Date.parse("2026-08-10T00:00:00Z");

describe("DataCenterSyncService", () => {
	test("does no credential, journal, or network work while sync is disabled", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		const events = new MemoryEvents([], log);
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		const service = createService({
			repository,
			events,
			auth,
			server,
			configuration: { ...enabledMetadata, enabled: false },
		});

		service.start();
		expect(await service.syncOnce()).toBeFalse();
		await service.stop();
		expect(log).toEqual([]);
	});

	test("recovers a lost registration response with the same installation and public key", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		const events = new MemoryEvents([], log);
		const auth = new MemoryAuth(log);
		auth.failRegisterResponses = true;
		const server = new SignedDesktopServer(log);
		const first = createService({ repository, events, auth, server });

		await expect(first.syncOnce()).rejects.toThrow(
			"registration response lost",
		);
		const pending = structuredClone(repository.credentials);
		expect(pending?.registrationStatus).toBe("pending");
		expect(auth.registerBodies).toHaveLength(3);
		expect(new Set(auth.registerBodies).size).toBe(1);

		auth.failRegisterResponses = false;
		const second = createService({ repository, events, auth, server });
		expect(await second.syncOnce()).toBeTrue();
		expect(auth.registerBodies[3]).toBe(auth.registerBodies[0]);
		expect(repository.credentials).toMatchObject({
			registrationStatus: "registered",
			installationId: pending?.installationId,
			publicKey: pending?.publicKey,
			privateKeyPkcs8: pending?.privateKeyPkcs8,
		});
		expect(pending?.installationId).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
		);
	});

	test("persists a distinct cloud installation UUID per account and reuses it after switching back", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		const events = new MemoryEvents([], log);
		const server = new SignedDesktopServer(log);
		const authA = new MemoryAuth(log, "account-a");
		const authB = new MemoryAuth(log, "account-b");
		const installationA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const installationB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

		expect(
			await createService({
				repository,
				events,
				auth: authA,
				server,
				createCloudInstallationId: () => installationA,
			}).syncOnce(),
		).toBeTrue();
		expect(
			await createService({
				repository,
				events,
				auth: authB,
				server,
				createCloudInstallationId: () => installationB,
			}).syncOnce(),
		).toBeTrue();
		expect(
			await createService({
				repository,
				events,
				auth: authA,
				server,
				createCloudInstallationId: () => {
					throw new Error("must reuse account A cloud installation");
				},
			}).syncOnce(),
		).toBeTrue();

		const registrationA = JSON.parse(authA.registerBodies[0] ?? "") as {
			installation_id: string;
		};
		const registrationB = JSON.parse(authB.registerBodies[0] ?? "") as {
			installation_id: string;
		};
		expect(registrationA.installation_id).toBe(installationA);
		expect(registrationB.installation_id).toBe(installationB);
		expect(registrationA.installation_id).not.toBe(
			registrationB.installation_id,
		);
		expect(authA.registerBodies).toHaveLength(1);
		expect(authB.registerBodies).toHaveLength(1);
		await expect(
			repository.getDataCenterAgentCredentials("account-a"),
		).resolves.toMatchObject({ installationId: installationA });
	});

	test("registers idempotently then rebases an unknown account at the tail before reading payloads", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-old", updatedAtMs: 1 };
		const events = new MemoryEvents(
			[
				heartbeatEvent("1", "ec1_0000000000000001"),
				heartbeatEvent("2", "ec1_0000000000000002"),
			],
			log,
		);
		const auth = new MemoryAuth(log, "account-new");
		const server = new SignedDesktopServer(log);
		const service = createService({ repository, events, auth, server });

		expect(await service.syncOnce()).toBeTrue();
		expect(auth.registerBodies).toHaveLength(1);
		expect(auth.consentDomains).toEqual(["activity", "browser", "presence"]);
		expect(server.advances).toEqual([
			{
				schemaVersion: "desktop-event-advance.v1",
				fromCursor: null,
				toCursor: "ec1_0000000000000002",
				reason: "account-boundary",
				eventCount: 2,
			},
		]);
		expect(events.committedCursor).toBe("ec1_0000000000000002");
		expect(repository.owner?.accountId).toBe("account-new");
		expect(repository.advance).toBeNull();
		expect(repository.audits).toEqual([
			expect.objectContaining({
				fromAccountId: "account-old",
				toAccountId: "account-new",
				fromCursor: null,
				toCursor: "ec1_0000000000000002",
				reason: "account-boundary",
			}),
		]);
		expect(log.indexOf("repository:audit")).toBeLessThan(
			log.indexOf("events:commit:ec1_0000000000000002"),
		);
		expect(log.indexOf("events:tail")).toBeLessThan(
			log.indexOf("events:query"),
		);
		expect(log.indexOf("repository:owner:account-new")).toBeLessThan(
			log.indexOf("events:query"),
		);
		expect(log.indexOf("events:commit:ec1_0000000000000002")).toBeLessThan(
			log.indexOf("repository:delete-advance"),
		);
	});

	test("drops a returning account's stale pending payload at the privacy boundary instead of replaying it", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-other", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const stale = heartbeatEvent("c", "ec1_0000000000000001");
		repository.batch = createPendingDataCenterBatch(
			"account-1",
			[
				{
					...stale,
					sensitivity: "metadata",
					payload: {},
				},
			],
			1_500,
		);
		const events = new MemoryEvents(
			[stale, heartbeatEvent("d", "ec1_0000000000000002")],
			log,
		);
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		const service = createService({ repository, events, auth, server });

		expect(await service.syncOnce()).toBeTrue();
		expect(server.batches).toEqual([]);
		expect(server.exactBatchBodies).toEqual([]);
		expect(server.advances).toEqual([
			{
				schemaVersion: "desktop-event-advance.v1",
				fromCursor: null,
				toCursor: "ec1_0000000000000002",
				reason: "account-boundary",
				eventCount: 2,
			},
		]);
		expect(log.indexOf("repository:delete-batch")).toBeLessThan(
			log.indexOf("repository:put-advance"),
		);
		expect(log).not.toContain("signed:batch");
		expect(repository.owner?.accountId).toBe("account-1");
		expect(repository.audits).toHaveLength(1);
	});

	test("clears the previous owner's pending wire operation during an account switch", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-old", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-new");
		const stale = heartbeatEvent("a", "ec1_0000000000000001");
		repository.batch = createPendingDataCenterBatch(
			"account-old",
			[{ ...stale, sensitivity: "metadata", payload: {} }],
			1_500,
		);
		const events = new MemoryEvents(
			[stale, heartbeatEvent("b", "ec1_0000000000000002")],
			log,
		);
		const auth = new MemoryAuth(log, "account-new");
		const server = new SignedDesktopServer(log);
		const service = createService({ repository, events, auth, server });

		expect(await service.syncOnce()).toBeTrue();
		expect(repository.batch).toBeNull();
		expect(server.batches).toEqual([]);
		expect(server.exactBatchBodies).toEqual([]);
		expect(log).not.toContain("signed:batch");
		expect(log.indexOf("repository:audit")).toBeLessThan(
			log.indexOf("repository:delete-batch"),
		);
		expect(server.advances).toEqual([
			{
				schemaVersion: "desktop-event-advance.v1",
				fromCursor: null,
				toCursor: "ec1_0000000000000002",
				reason: "account-boundary",
				eventCount: 2,
			},
		]);
	});

	test("drops stale pending payload when the returning account cursor already equals the local tail", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-other", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const stale = heartbeatEvent("e", "ec1_0000000000000001");
		repository.batch = createPendingDataCenterBatch(
			"account-1",
			[
				{
					...stale,
					sensitivity: "metadata",
					payload: {},
				},
			],
			1_500,
		);
		const events = new MemoryEvents([stale], log);
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		server.ackCursor = stale.cursor;
		const service = createService({ repository, events, auth, server });

		expect(await service.syncOnce()).toBeTrue();
		expect(server.batches).toEqual([]);
		expect(server.advances).toEqual([]);
		expect(log).not.toContain("signed:batch");
		expect(log).not.toContain("signed:advance");
		expect(log.filter((entry) => entry === "repository:delete-batch")).toEqual([
			"repository:delete-batch",
		]);
		expect(repository.batch).toBeNull();
		expect(repository.owner?.accountId).toBe("account-1");
		expect(repository.audits).toHaveLength(1);
	});

	test("projects content to metadata, persists exact wire bytes, and deletes only after strict ACK and local commit", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-1", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const event = editorEvent();
		const events = new MemoryEvents([event], log);
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		const service = createService({ repository, events, auth, server });

		expect(await service.syncOnce()).toBeTrue();
		expect(server.batches).toHaveLength(1);
		const wire = server.batches[0] as {
			events: Array<{ payload: Record<string, unknown> }>;
		};
		expect(wire.events[0]?.payload).toEqual({
			editorId: "vscode",
			documentId: "document-1",
			language: "typescript",
			insertedChars: 3,
			deletedChars: 1,
			burstStartedAtMs: 1_000,
			burstEndedAtMs: 1_100,
		});
		expect(server.exactBatchBodies[0]).not.toContain("private/path");
		expect(server.exactBatchBodies[0]).not.toContain("source secret");
		expect(repository.batch).toBeNull();
		expect(events.committedCursor).toBe(event.cursor);
		expect(log.indexOf(`events:commit:${event.cursor}`)).toBeLessThan(
			log.indexOf("repository:delete-batch"),
		);
		expect(server.signatureVersions).toEqual(["2", "2"]);
	});

	test("keeps the identical pending body across ambiguous failures and recovers before querying new events", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-1", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const event = heartbeatEvent("f", "ec1_0000000000000001");
		repository.batch = createPendingDataCenterBatch(
			"account-1",
			[
				{
					...event,
					sensitivity: "metadata",
					payload: {},
				},
			],
			2_000,
		);
		const exactBody = repository.batch.body;
		const events = new MemoryEvents([event], log);
		const auth = new MemoryAuth(log);
		const unavailable = new SignedDesktopServer(log);
		unavailable.failBatchResponses = true;
		const first = createService({
			repository,
			events,
			auth,
			server: unavailable,
		});

		await expect(first.syncOnce()).rejects.toThrow("response lost");
		expect(repository.batch?.body).toBe(exactBody);
		expect(events.committedCursor).toBeNull();
		expect(unavailable.exactBatchBodies).toEqual([
			exactBody,
			exactBody,
			exactBody,
		]);

		const recovered = new SignedDesktopServer(log);
		const second = createService({
			repository,
			events,
			auth,
			server: recovered,
		});
		expect(await second.syncOnce()).toBeTrue();
		expect(recovered.exactBatchBodies).toEqual([exactBody]);
		expect(log.indexOf("signed:batch")).toBeLessThan(
			log.lastIndexOf("events:query"),
		);
		expect(events.committedCursor).toBe(event.cursor);
		expect(repository.batch).toBeNull();
	});

	test("does not replay a completed batch when the local commit response is lost across the 31-day boundary", async () => {
		const log: string[] = [];
		let nowMs = 2_000;
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-1", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const event = heartbeatEvent("7", "ec1_0000000000000001");
		const events = new MemoryEvents([event], log);
		events.failCommitResponsesAfterPersist = true;
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		const first = createService({
			repository,
			events,
			auth,
			server,
			now: () => nowMs,
		});

		await expect(first.syncOnce()).rejects.toThrow("commit response lost");
		expect(server.exactBatchBodies).toHaveLength(1);
		expect(repository.batch).not.toBeNull();
		expect(events.committedCursor).toBe(event.cursor);

		nowMs += 31 * 24 * 60 * 60 * 1_000 + 1;
		events.failCommitResponsesAfterPersist = false;
		const recovered = createService({
			repository,
			events,
			auth,
			server,
			now: () => nowMs,
		});
		expect(await recovered.syncOnce()).toBeTrue();
		expect(server.exactBatchBodies).toHaveLength(1);
		expect(server.advances).toEqual([]);
		expect(repository.batch).toBeNull();
	});

	test("atomically replaces an unsubmitted expired batch with a retention advance", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-1", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const event = heartbeatEvent("8", "ec1_0000000000000001");
		repository.batch = createPendingDataCenterBatch(
			"account-1",
			[{ ...event, sensitivity: "metadata", payload: {} }],
			2_000,
		);
		const events = new MemoryEvents([event], log);
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		const service = createService({
			repository,
			events,
			auth,
			server,
			now: () => 31 * 24 * 60 * 60 * 1_000 + 1_001,
		});

		expect(await service.syncOnce()).toBeTrue();
		expect(server.exactBatchBodies).toEqual([]);
		expect(server.advances).toEqual([
			{
				schemaVersion: "desktop-event-advance.v1",
				fromCursor: null,
				toCursor: event.cursor,
				reason: "retention-expired",
				eventCount: 1,
			},
		]);
		expect(log.indexOf("repository:replace-batch-with-advance")).toBeLessThan(
			log.indexOf("signed:advance"),
		);
		expect(log.indexOf("signed:cursor")).toBeLessThan(
			log.indexOf("repository:replace-batch-with-advance"),
		);
		expect(repository.batch).toBeNull();
		expect(repository.advance).toBeNull();
		expect(events.committedCursor).toBe(event.cursor);
	});

	test("replaces stale pending wire when current consent is revoked or content is downgraded", async () => {
		const browser = {
			...heartbeatEvent("9", "ec1_0000000000000001"),
			kind: "browser.tabOpened",
			payload: { browserId: "browser", tabId: "tab" },
		} as DesktopEventV1;
		const editor = contentEditorEvent("a", 1_000);
		const contentWire = {
			schemaVersion: editor.schemaVersion,
			eventId: editor.eventId,
			cursor: editor.cursor,
			deviceId: editor.deviceId,
			sessionId: editor.sessionId,
			kind: editor.kind,
			source: editor.source,
			occurredAtMs: editor.occurredAtMs,
			observedAtMs: editor.observedAtMs,
			goalVersion: editor.goalVersion,
			sensitivity: "content" as const,
			publicPayload: {
				editorId: "vscode",
				documentId: "document-1",
				language: "typescript",
				insertedChars: 3,
				deletedChars: 1,
				burstStartedAtMs: 1_000,
				burstEndedAtMs: 1_100,
			},
			encryptionEnvelope: { schemaVersion: "client-envelope.v1" },
		};
		for (const candidate of [
			{
				event: browser,
				wire: { ...browser, sensitivity: "metadata" as const },
				configuration: {
					...enabledMetadata,
					consents: { ...enabledMetadata.consents, browser: "off" as const },
				},
				reason: "consent-revoked",
			},
			{
				event: editor,
				wire: contentWire,
				configuration: enabledMetadata,
				reason: "content-not-consented",
			},
		] as const) {
			const log: string[] = [];
			const repository = new MemoryRepository(log);
			repository.owner = { accountId: "account-1", updatedAtMs: 1 };
			repository.credentials = registeredCredentials("account-1");
			repository.batch = createPendingDataCenterBatch(
				"account-1",
				[candidate.wire],
				1_500,
			);
			const events = new MemoryEvents([candidate.event], log);
			const auth = new MemoryAuth(log);
			const server = new SignedDesktopServer(log);
			const service = createService({
				repository,
				events,
				auth,
				server,
				configuration: candidate.configuration,
			});

			expect(await service.syncOnce()).toBeTrue();
			expect(server.exactBatchBodies, candidate.reason).toEqual([]);
			expect(server.advances, candidate.reason).toEqual([
				expect.objectContaining({ reason: candidate.reason }),
			]);
			expect(repository.batch).toBeNull();
		}
	});

	test("blocks content sync on a 503 encryption-context response without metadata downgrade or ACK", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: CONTENT_ACCOUNT_ID, updatedAtMs: 1 };
		repository.credentials = registeredCredentials(CONTENT_ACCOUNT_ID);
		const event = contentEditorEvent("1", CONTENT_NOW_MS);
		const events = new MemoryEvents([event], log);
		const auth = new MemoryAuth(log, CONTENT_ACCOUNT_ID);
		const server = new SignedDesktopServer(log);
		server.failContextResponses = true;
		const service = createService({
			repository,
			events,
			auth,
			server,
			configuration: enabledContent,
			now: () => CONTENT_NOW_MS,
		});

		await expect(service.syncOnce()).rejects.toThrow("HTTP 503");
		expect(server.contextRequests).toBe(3);
		expect(server.batches).toEqual([]);
		expect(server.advances).toEqual([]);
		expect(repository.batch).toBeNull();
		expect(repository.advance).toBeNull();
		expect(events.committedCursor).toBeNull();
	});

	test("persists a level-2 envelope without plaintext and replays its exact body after a lost response", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: CONTENT_ACCOUNT_ID, updatedAtMs: 1 };
		repository.credentials = registeredCredentials(CONTENT_ACCOUNT_ID);
		const event = contentEditorEvent("2", CONTENT_NOW_MS);
		const events = new MemoryEvents([event], log);
		const auth = new MemoryAuth(log, CONTENT_ACCOUNT_ID);
		const server = new SignedDesktopServer(log);
		server.encryptionContexts = [
			encryptionContext(
				CONTENT_ACCOUNT_ID,
				"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				CONTENT_NOW_MS,
				CONTENT_NOW_MS + 60 * 60 * 1_000,
			),
		];
		server.failBatchResponses = true;
		const service = createService({
			repository,
			events,
			auth,
			server,
			configuration: enabledContent,
			now: () => CONTENT_NOW_MS,
		});

		await expect(service.syncOnce()).rejects.toThrow("response lost");
		const exactBody = repository.batch?.body;
		if (!exactBody) throw new Error("Expected an encrypted pending batch.");
		expect(server.contextRequests).toBe(1);
		expect(server.exactBatchBodies).toEqual([exactBody, exactBody, exactBody]);
		expect(exactBody).not.toContain("private/path");
		expect(exactBody).not.toContain("source secret");
		const persisted = JSON.parse(exactBody ?? "") as {
			events: Array<{
				sensitivity: string;
				publicPayload: Record<string, unknown>;
				encryptionEnvelope: Record<string, unknown>;
			}>;
		};
		expect(persisted.events[0]).toMatchObject({
			sensitivity: "content",
			publicPayload: {
				editorId: "vscode",
				documentId: "document-1",
				language: "typescript",
				insertedChars: 3,
				deletedChars: 1,
				burstStartedAtMs: CONTENT_NOW_MS,
				burstEndedAtMs: CONTENT_NOW_MS + 100,
			},
		});
		expect(persisted.events[0]?.encryptionEnvelope).toMatchObject({
			schemaVersion: "client-envelope.v1",
			contextId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		});
		expect(events.committedCursor).toBeNull();

		server.failBatchResponses = false;
		expect(await service.syncOnce()).toBeTrue();
		expect(server.exactBatchBodies).toEqual([
			exactBody,
			exactBody,
			exactBody,
			exactBody,
		]);
		expect(server.contextRequests).toBe(1);
		expect(events.committedCursor).toBe(event.cursor);
		expect(repository.batch).toBeNull();
	});

	test("refreshes the encryption context inside its five-minute expiry window", async () => {
		const log: string[] = [];
		let nowMs = CONTENT_NOW_MS;
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: CONTENT_ACCOUNT_ID, updatedAtMs: 1 };
		repository.credentials = registeredCredentials(CONTENT_ACCOUNT_ID);
		const events = new MemoryEvents([contentEditorEvent("3", nowMs)], log);
		const auth = new MemoryAuth(log, CONTENT_ACCOUNT_ID);
		const server = new SignedDesktopServer(log);
		server.encryptionContexts = [
			encryptionContext(
				CONTENT_ACCOUNT_ID,
				"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				nowMs,
				nowMs + 10 * 60 * 1_000,
			),
			encryptionContext(
				CONTENT_ACCOUNT_ID,
				"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
				nowMs + 6 * 60 * 1_000,
				nowMs + 60 * 60 * 1_000,
			),
		];
		const service = createService({
			repository,
			events,
			auth,
			server,
			configuration: enabledContent,
			now: () => nowMs,
		});

		expect(await service.syncOnce()).toBeTrue();
		expect(server.contextRequests).toBe(1);
		nowMs += 6 * 60 * 1_000;
		events.append(contentEditorEvent("4", nowMs, 2));
		expect(await service.syncOnce()).toBeTrue();
		expect(server.contextRequests).toBe(2);
		const contextIds = server.exactBatchBodies.map((body) => {
			const parsed = JSON.parse(body) as {
				events: Array<{ encryptionEnvelope: { contextId: string } }>;
			};
			return parsed.events[0]?.encryptionEnvelope.contextId;
		});
		expect(contextIds).toEqual([
			"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		]);
	});

	test("advances an oversized event then drains the following queue item", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-1", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const oversized = {
			...heartbeatEvent("5", "ec1_0000000000000001"),
			kind: "application.processObservedBatch",
			payload: {
				started: Array.from({ length: 600 }, (_, index) => ({
					processId: index + 1,
					appId: `org.example.${index}`,
					appName: "x".repeat(512),
				})),
				exited: [],
			},
		} as DesktopEventV1;
		const following = heartbeatEvent("6", "ec1_0000000000000002");
		const events = new MemoryEvents([oversized, following], log);
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		const service = createService({ repository, events, auth, server });

		expect(await service.syncOnce()).toBeTrue();
		expect(server.advances).toEqual([
			{
				schemaVersion: "desktop-event-advance.v1",
				fromCursor: null,
				toCursor: oversized.cursor,
				reason: "payload-unsupported",
				eventCount: 1,
			},
		]);
		expect(server.batches).toHaveLength(1);
		expect(server.batches[0]).toMatchObject({
			firstCursor: following.cursor,
			lastCursor: following.cursor,
		});
		expect(events.committedCursor).toBe(following.cursor);
	});

	test("turns expired journal entries into an exact audited advance instead of uploading them", async () => {
		const log: string[] = [];
		const repository = new MemoryRepository(log);
		repository.owner = { accountId: "account-1", updatedAtMs: 1 };
		repository.credentials = registeredCredentials("account-1");
		const expired = {
			...heartbeatEvent("e", "ec1_0000000000000001"),
			occurredAtMs: 0,
			observedAtMs: 0,
		};
		const events = new MemoryEvents([expired], log);
		const auth = new MemoryAuth(log);
		const server = new SignedDesktopServer(log);
		const service = createService({
			repository,
			events,
			auth,
			server,
			now: () => 31 * 24 * 60 * 60 * 1_000 + 1,
		});

		expect(await service.syncOnce()).toBeTrue();
		expect(server.batches).toEqual([]);
		expect(server.advances).toEqual([
			{
				schemaVersion: "desktop-event-advance.v1",
				fromCursor: null,
				toCursor: expired.cursor,
				reason: "retention-expired",
				eventCount: 1,
			},
		]);
		expect(events.committedCursor).toBe(expired.cursor);
	});

	test("rejects declared and chunked responses above the one MiB wire limit", async () => {
		for (const cursorResponse of [
			() =>
				new Response("{}", {
					headers: { "content-length": String(1024 * 1024 + 1) },
				}),
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(512 * 1024));
							controller.enqueue(new Uint8Array(512 * 1024));
							controller.enqueue(new Uint8Array([0x20]));
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		] as const) {
			const log: string[] = [];
			const repository = new MemoryRepository(log);
			repository.owner = { accountId: "account-1", updatedAtMs: 1 };
			repository.credentials = registeredCredentials("account-1");
			const events = new MemoryEvents(
				[heartbeatEvent("f", "ec1_0000000000000001")],
				log,
			);
			const auth = new MemoryAuth(log);
			const server = new SignedDesktopServer(log);
			server.cursorResponse = cursorResponse;
			const service = createService({ repository, events, auth, server });

			await expect(service.syncOnce()).rejects.toThrow(
				"JSON response size is invalid",
			);
			expect(repository.batch).toBeNull();
			expect(events.committedCursor).toBeNull();
		}
	});
});

function createService(options: {
	repository: MemoryRepository;
	events: MemoryEvents;
	auth: MemoryAuth;
	server: SignedDesktopServer;
	configuration?: CloudSyncConfiguration;
	now?: () => number;
	createCloudInstallationId?: () => string;
}): DataCenterSyncService {
	return new DataCenterSyncService({
		baseUrl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
		configuration: options.configuration ?? enabledMetadata,
		repository: options.repository,
		events: options.events,
		auth: options.auth,
		fetch: options.server.fetch,
		now: options.now ?? (() => 2_000),
		retryDelayMs: 0,
		createCloudInstallationId: options.createCloudInstallationId,
	});
}

class MemoryRepository implements DataCenterSyncRepository {
	credentials: DataCenterAgentCredentialsRecord | null = null;
	private readonly credentialsByAccount = new Map<
		string,
		DataCenterAgentCredentialsRecord
	>();
	batch: DataCenterPendingBatchRecord | null = null;
	advance: DataCenterPendingAdvanceRecord | null = null;
	owner: DataCenterConsumerOwnerRecord | null = null;
	readonly audits: DataCenterConsumerAuditRecord[] = [];

	constructor(private readonly log: string[]) {}

	async getDataCenterAgentCredentials(
		accountId: string,
	): Promise<DataCenterAgentCredentialsRecord | null> {
		const credentials =
			this.credentialsByAccount.get(accountId) ??
			(this.credentials?.accountId === accountId ? this.credentials : null);
		return credentials ? structuredClone(credentials) : null;
	}

	async putDataCenterAgentCredentials(
		record: DataCenterAgentCredentialsRecord,
	): Promise<void> {
		this.log.push(`repository:credentials:${record.registrationStatus}`);
		this.credentials = structuredClone(record);
		this.credentialsByAccount.set(record.accountId, structuredClone(record));
	}

	async getDataCenterPendingBatch(
		accountId: string,
	): Promise<DataCenterPendingBatchRecord | null> {
		return this.batch?.accountId === accountId
			? structuredClone(this.batch)
			: null;
	}

	async putDataCenterPendingBatch(
		record: DataCenterPendingBatchRecord,
	): Promise<void> {
		if (this.batch && this.batch.batchKey !== record.batchKey) {
			throw new Error("batch already pending");
		}
		this.log.push("repository:put-batch");
		this.batch = structuredClone(record);
	}

	async replaceDataCenterPendingBatchWithAdvance(
		batch: DataCenterPendingBatchRecord,
		advance: DataCenterPendingAdvanceRecord,
	): Promise<boolean> {
		if (
			this.batch?.accountId !== batch.accountId ||
			this.batch.batchKey !== batch.batchKey ||
			this.batch.requestHash !== batch.requestHash
		) {
			return false;
		}
		if (this.advance) throw new Error("advance already pending");
		this.log.push("repository:replace-batch-with-advance");
		this.batch = null;
		this.advance = structuredClone(advance);
		return true;
	}

	deleteDataCenterPendingBatch(accountId: string, batchKey: string): boolean {
		if (
			this.batch?.accountId !== accountId ||
			this.batch.batchKey !== batchKey
		) {
			return false;
		}
		this.log.push("repository:delete-batch");
		this.batch = null;
		return true;
	}

	async getDataCenterPendingAdvance(
		accountId: string,
	): Promise<DataCenterPendingAdvanceRecord | null> {
		return this.advance?.accountId === accountId
			? structuredClone(this.advance)
			: null;
	}

	async putDataCenterPendingAdvance(
		record: DataCenterPendingAdvanceRecord,
	): Promise<void> {
		if (this.advance && this.advance.advanceKey !== record.advanceKey) {
			throw new Error("advance already pending");
		}
		this.log.push("repository:put-advance");
		this.advance = structuredClone(record);
	}

	deleteDataCenterPendingAdvance(
		accountId: string,
		advanceKey: string,
	): boolean {
		if (
			this.advance?.accountId !== accountId ||
			this.advance.advanceKey !== advanceKey
		) {
			return false;
		}
		this.log.push("repository:delete-advance");
		this.advance = null;
		return true;
	}

	getDataCenterConsumerOwner(): DataCenterConsumerOwnerRecord | null {
		return this.owner ? { ...this.owner } : null;
	}

	async setDataCenterConsumerOwner(accountId: string): Promise<void> {
		this.log.push(`repository:owner:${accountId}`);
		this.owner = { accountId, updatedAtMs: 2_000 };
	}

	async appendDataCenterConsumerAudit(
		record: DataCenterConsumerAuditRecord,
	): Promise<void> {
		this.log.push("repository:audit");
		if (!this.audits.some((candidate) => candidate.id === record.id)) {
			this.audits.push(structuredClone(record));
		}
	}
}

class MemoryEvents implements DataCenterEventJournal {
	committedCursor: string | null = null;
	failCommitResponsesAfterPersist = false;

	constructor(
		private readonly events: DesktopEventV1[],
		private readonly log: string[],
	) {}

	append(event: DesktopEventV1): void {
		this.events.push(structuredClone(event));
	}

	async queryDesktopEvents(
		_query: LocalEventQuery,
	): Promise<LocalEventQueryResult> {
		this.log.push("events:query");
		const committed = cursorPosition(this.committedCursor);
		const remaining = this.events.filter(
			(event) => dataCenterCursorSequence(event.cursor) > committed,
		);
		return {
			events: structuredClone(remaining),
			nextCursor: remaining.at(-1)?.cursor ?? this.committedCursor,
			hasMore: false,
		};
	}

	async getDesktopEventTailCursor(): Promise<LocalEventTailCursorResult> {
		this.log.push("events:tail");
		return {
			cursor: this.events.at(-1)?.cursor ?? "ec1_0000000000000000",
		};
	}

	async commitDesktopEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult> {
		this.log.push(`events:commit:${cursor}`);
		const advanced =
			dataCenterCursorSequence(cursor) > cursorPosition(this.committedCursor);
		if (advanced) this.committedCursor = cursor;
		if (this.failCommitResponsesAfterPersist) {
			throw new Error("commit response lost");
		}
		return { consumerId, cursor, advanced };
	}
}

class MemoryAuth implements DataCenterBearerAuthorization {
	readonly identity: AuthSessionIdentity;
	readonly registerBodies: string[] = [];
	readonly consentDomains: string[] = [];
	current = true;
	failRegisterResponses = false;

	constructor(
		private readonly log: string[],
		accountId = "account-1",
	) {
		this.identity = { accountId, sessionId: "session-1", generation: 1 };
	}

	captureCurrentSession(): AuthSessionIdentity | null {
		return this.current ? { ...this.identity } : null;
	}

	isCurrentSession(identity: AuthSessionIdentity): boolean {
		return (
			this.current &&
			identity.accountId === this.identity.accountId &&
			identity.sessionId === this.identity.sessionId &&
			identity.generation === this.identity.generation
		);
	}

	async bearerFetch(path: string, init?: RequestInit): Promise<Response> {
		if (path === "/v1/agent/register") {
			const body = String(init?.body ?? "");
			this.log.push("bearer:register");
			this.registerBodies.push(body);
			if (this.failRegisterResponses) {
				throw new Error("registration response lost");
			}
			return Response.json(
				{
					agent_id: "11111111-1111-4111-8111-111111111111",
					device_id: "22222222-2222-4222-8222-222222222222",
					config_version: 1,
				},
				{ status: 201 },
			);
		}
		const match = path.match(
			/^\/v1\/devices\/([^/]+)\/consents\/(activity|browser|presence)$/u,
		);
		if (!match) return new Response(null, { status: 404 });
		const request = JSON.parse(String(init?.body ?? "")) as {
			granted: boolean;
			data_level: number;
		};
		const domain = match[2] as "activity" | "browser" | "presence";
		this.log.push(`bearer:consent:${domain}`);
		this.consentDomains.push(domain);
		return Response.json({
			device_id: match[1],
			sensor_type: domain,
			granted: request.granted,
			data_level: request.data_level,
		});
	}
}

class SignedDesktopServer {
	ackCursor: string | null = null;
	readonly batches: unknown[] = [];
	readonly advances: unknown[] = [];
	readonly exactBatchBodies: string[] = [];
	readonly signatureVersions: Array<string | null> = [];
	failBatchResponses = false;
	failContextResponses = false;
	contextRequests = 0;
	encryptionContexts: unknown[] = [];
	cursorResponse: (() => Response) | null = null;

	constructor(private readonly log: string[]) {}

	readonly fetch = (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		this.signatureVersions.push(headers.get("X-Agent-Signature-Version"));
		if (url.pathname.endsWith("/crypto/encryption-context")) {
			this.log.push("signed:encryption-context");
			this.contextRequests += 1;
			if (this.failContextResponses) {
				return Response.json(
					{ error: { code: "crypto_unavailable" } },
					{ status: 503 },
				);
			}
			const context =
				this.encryptionContexts[
					Math.min(this.contextRequests - 1, this.encryptionContexts.length - 1)
				];
			return context
				? Response.json(context)
				: Response.json(
						{ error: { code: "missing_test_context" } },
						{ status: 503 },
					);
		}
		if (url.pathname.endsWith("/desktop/cursor")) {
			this.log.push("signed:cursor");
			if (this.cursorResponse) return this.cursorResponse();
			return Response.json({
				schemaVersion: "desktop-event-cursor.v1",
				ackCursor: this.ackCursor,
				sequence:
					this.ackCursor === null
						? null
						: Number(dataCenterCursorSequence(this.ackCursor)),
				updatedAt: this.ackCursor === null ? null : "2026-08-10T00:00:00Z",
			});
		}
		if (url.pathname.endsWith("/desktop/batch")) {
			this.log.push("signed:batch");
			const exactBody = String(init?.body ?? "");
			this.exactBatchBodies.push(exactBody);
			if (this.failBatchResponses) throw new Error("response lost");
			const body = JSON.parse(exactBody) as {
				lastCursor: string;
				events: Array<{ eventId: string; cursor: string }>;
			};
			this.batches.push(body);
			this.ackCursor = body.lastCursor;
			return Response.json(
				{
					batchId: "33333333-3333-4333-8333-333333333333",
					requestHash: createHash("sha256").update(exactBody).digest("hex"),
					ackCursor: body.lastCursor,
					acceptedCount: body.events.length,
					duplicateCount: 0,
					results: body.events.map((event) => ({
						eventId: event.eventId,
						cursor: event.cursor,
						status: "accepted",
					})),
				},
				{ status: 202 },
			);
		}
		if (url.pathname.endsWith("/desktop/advance")) {
			this.log.push("signed:advance");
			const body = JSON.parse(String(init?.body ?? "")) as {
				toCursor: string;
				eventCount: number;
			};
			this.advances.push(body);
			this.ackCursor = body.toCursor;
			return Response.json(
				{
					schemaVersion: "desktop-event-cursor.v1",
					ackCursor: body.toCursor,
					advancedCount: body.eventCount,
				},
				{ status: 202 },
			);
		}
		return new Response(null, { status: 404 });
	}) as typeof fetch;
}

function registeredCredentials(
	accountId: string,
): DataCenterAgentCredentialsRecord {
	const registered = completeDataCenterRegistration(
		createDataCenterAgentCredentials({
			accountId,
			installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			nowMs: 1_000,
		}),
		{
			agentId: "11111111-1111-4111-8111-111111111111",
			deviceId: "22222222-2222-4222-8222-222222222222",
			configVersion: 1,
		},
		1_500,
	);
	return {
		...registered,
		consentDigest: cloudSyncConsentDigest(enabledMetadata),
		updatedAtMs: 1_600,
	};
}

function heartbeatEvent(suffix: string, cursor: string): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `de1_${suffix.repeat(64).slice(0, 64)}`,
		cursor,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "system.heartbeat",
		source: "test",
		occurredAtMs: 1_000,
		observedAtMs: 1_000,
		goalVersion: null,
		sensitivity: "metadata",
		payload: {},
	};
}

function editorEvent(): DesktopEventV1 {
	return {
		...heartbeatEvent("a", "ec1_0000000000000001"),
		kind: "editor.documentChanged",
		sensitivity: "content",
		payload: {
			editorId: "vscode",
			documentId: "document-1",
			relativePath: "private/path/secret.ts",
			language: "typescript",
			insertedChars: 3,
			deletedChars: 1,
			text: "source secret",
			burstStartedAtMs: 1_000,
			burstEndedAtMs: 1_100,
		},
	} as DesktopEventV1;
}

function contentEditorEvent(
	suffix: string,
	nowMs: number,
	sequence = 1,
): DesktopEventV1 {
	return {
		...heartbeatEvent(suffix, `ec1_${sequence.toString(16).padStart(16, "0")}`),
		kind: "editor.documentChanged",
		occurredAtMs: nowMs,
		observedAtMs: nowMs,
		sensitivity: "content",
		payload: {
			editorId: "vscode",
			documentId: "document-1",
			relativePath: "private/path/secret.ts",
			language: "typescript",
			insertedChars: 3,
			deletedChars: 1,
			text: "source secret",
			burstStartedAtMs: nowMs,
			burstEndedAtMs: nowMs + 100,
		},
	} as DesktopEventV1;
}

function encryptionContext(
	accountId: string,
	contextId: string,
	issuedAtMs: number,
	expiresAtMs: number,
): Record<string, unknown> {
	const keyPair = generateKeyPairSync("x25519");
	const publicJwk = keyPair.publicKey.export({ format: "jwk" });
	if (typeof publicJwk.x !== "string") {
		throw new Error("X25519 test key export failed.");
	}
	return {
		schemaVersion: "encryption-context.v1",
		contextId,
		purpose: "telemetry-sensitive",
		keyRef: `env/test/usr/${accountId}/telemetry-sensitive/v1`,
		publicKey: publicJwk.x,
		transportAlgorithm: "X25519-HKDF-SHA256+A256GCM",
		contentAlgorithm: "A256GCM",
		aadVersion: "desktop-event-aad.v1",
		issuedAt: new Date(issuedAtMs).toISOString(),
		expiresAt: new Date(expiresAtMs).toISOString(),
	};
}

function cursorPosition(cursor: string | null): bigint {
	return cursor === null ? 0n : dataCenterCursorSequence(cursor);
}
