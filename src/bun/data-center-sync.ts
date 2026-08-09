import { randomUUID } from "node:crypto";
import type {
	LocalEventCommitResult,
	LocalEventQuery,
	LocalEventQueryResult,
	LocalEventTailCursorResult,
} from "../agent/local-protocol";
import type { DesktopEventV1 } from "../agent/reflection/types";
import type { AuthSessionIdentity } from "./auth-session";
import {
	type CloudSyncConfiguration,
	WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
	WHALEHALL_DATA_CENTER_STAGING_BASE_URL,
} from "./client-config";
import {
	cloudSyncConsentDigest,
	completeDataCenterRegistration,
	createDataCenterConsumerAudit,
	createDataCenterAgentCredentials,
	createPendingDataCenterAdvance,
	createPendingDataCenterBatchPrefix,
	DATA_CENTER_ADVANCE_PATH,
	DATA_CENTER_BATCH_PATH,
	DATA_CENTER_CONSUMER_ID,
	DATA_CENTER_CURSOR_PATH,
	DATA_CENTER_EMPTY_BATCH_BODY_BYTES,
	DATA_CENTER_MAX_BATCH_BODY_BYTES,
	dataCenterConsentRequest,
	dataCenterCursorSequence,
	dataCenterPendingBatchReplacementReason,
	dataCenterWireEventByteLength,
	type DataCenterContentEncryptor,
	type DataCenterProjectionResult,
	type DataCenterWireEvent,
	parseDataCenterCursor,
	parseDataCenterRegistration,
	projectDataCenterEvent,
	DATA_CENTER_REGISTER_PATH,
	signDataCenterRequestV2,
	validateDataCenterAdvanceResponse,
	validateDataCenterBatchResponse,
} from "./data-center-contract";
import {
	DATA_CENTER_CONTEXT_REFRESH_WINDOW_MS,
	DATA_CENTER_ENCRYPTION_CONTEXT_PATH,
	DataCenterContentCrypto,
	type DataCenterEncryptionContext,
	parseDataCenterEncryptionContext,
} from "./data-center-crypto";
import type {
	DataCenterAgentCredentialsRecord,
	DataCenterConsumerAuditRecord,
	DataCenterConsumerOwnerRecord,
	DataCenterPendingAdvanceRecord,
	DataCenterPendingBatchRecord,
} from "./encrypted-agent-repository";

const DATA_CENTER_SYNC_INTERVAL_MS = 15_000;
const DATA_CENTER_MAX_DRAIN_OPERATIONS = 100;
const DATA_CENTER_MAX_RESPONSE_BYTES = 1024 * 1024;
const DATA_CENTER_REQUEST_ATTEMPTS = 3;

export interface DataCenterSyncRepository {
	getDataCenterAgentCredentials(
		accountId: string,
	): Promise<DataCenterAgentCredentialsRecord | null>;
	putDataCenterAgentCredentials(
		record: DataCenterAgentCredentialsRecord,
	): Promise<void>;
	getDataCenterPendingBatch(
		accountId: string,
	): Promise<DataCenterPendingBatchRecord | null>;
	putDataCenterPendingBatch(
		record: DataCenterPendingBatchRecord,
	): Promise<void>;
	replaceDataCenterPendingBatchWithAdvance(
		batch: DataCenterPendingBatchRecord,
		advance: DataCenterPendingAdvanceRecord,
	): Promise<boolean>;
	deleteDataCenterPendingBatch(accountId: string, batchKey: string): boolean;
	getDataCenterPendingAdvance(
		accountId: string,
	): Promise<DataCenterPendingAdvanceRecord | null>;
	putDataCenterPendingAdvance(
		record: DataCenterPendingAdvanceRecord,
	): Promise<void>;
	deleteDataCenterPendingAdvance(
		accountId: string,
		advanceKey: string,
	): boolean;
	getDataCenterConsumerOwner(): DataCenterConsumerOwnerRecord | null;
	setDataCenterConsumerOwner(accountId: string): Promise<void>;
	appendDataCenterConsumerAudit(
		record: DataCenterConsumerAuditRecord,
	): Promise<void>;
}

export interface DataCenterEventJournal {
	queryDesktopEvents(query: LocalEventQuery): Promise<LocalEventQueryResult>;
	getDesktopEventTailCursor(): Promise<LocalEventTailCursorResult>;
	commitDesktopEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult>;
}

export interface DataCenterBearerAuthorization {
	captureCurrentSession(): AuthSessionIdentity | null;
	isCurrentSession(identity: AuthSessionIdentity): boolean;
	bearerFetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface DataCenterSyncServiceOptions {
	baseUrl: string;
	configuration: CloudSyncConfiguration;
	repository: DataCenterSyncRepository;
	events: DataCenterEventJournal;
	auth: DataCenterBearerAuthorization;
	fetch?: typeof fetch;
	contentCrypto?: DataCenterContentCrypto;
	now?: () => number;
	retryDelayMs?: number;
	syncIntervalMs?: number;
	onError?: (error: unknown) => void;
	agentVersion?: string;
	createCloudInstallationId?: () => string;
}

/**
 * Account-bound encrypted cloud synchronization for the durable DesktopEvent journal.
 *
 * No payload is queried while ownership of the fixed consumer belongs to a
 * different account. Every network-mutating operation is recoverable from an
 * encrypted exact-wire record and local cursor deletion always follows commit.
 */
export class DataCenterSyncService {
	private readonly baseUrl: URL;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly retryDelayMs: number;
	private readonly syncIntervalMs: number;
	private readonly onError: (error: unknown) => void;
	private readonly contentCrypto: DataCenterContentCrypto;
	private readonly createCloudInstallationId: () => string;
	private encryptionContextCache: {
		accountId: string;
		agentId: string;
		context: DataCenterEncryptionContext;
	} | null = null;
	private desiredRunning = false;
	private loopController: AbortController | null = null;
	private loopPromise: Promise<void> | null = null;
	private wakeWaiter: (() => void) | null = null;
	private serialTail: Promise<unknown> = Promise.resolve();
	private bearerRequests = 0;

	constructor(private readonly options: DataCenterSyncServiceOptions) {
		this.baseUrl = validateDataCenterBaseUrl(options.baseUrl);
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.retryDelayMs = options.retryDelayMs ?? 250;
		this.syncIntervalMs =
			options.syncIntervalMs ?? DATA_CENTER_SYNC_INTERVAL_MS;
		this.onError = options.onError ?? (() => {});
		this.contentCrypto = options.contentCrypto ?? new DataCenterContentCrypto();
		this.createCloudInstallationId =
			options.createCloudInstallationId ?? randomUUID;
	}

	start(): void {
		if (!this.options.configuration.enabled) return;
		this.desiredRunning = true;
		if (this.loopPromise) {
			this.wake();
			return;
		}
		const controller = new AbortController();
		this.loopController = controller;
		const loop = this.runLoop(controller.signal);
		this.loopPromise = loop;
		void loop.finally(() => {
			if (this.loopPromise === loop) this.loopPromise = null;
			if (this.loopController === controller) this.loopController = null;
			if (this.desiredRunning) this.start();
		});
	}

	wake(): void {
		this.wakeWaiter?.();
	}

	async stop(): Promise<void> {
		this.desiredRunning = false;
		this.encryptionContextCache = null;
		this.loopController?.abort();
		this.wake();
		// A bearer request can expire its own auth session and enter the session
		// transition barrier. In that re-entrant case, identity guards plus abort
		// are the barrier; awaiting this same loop would deadlock the transition.
		if (this.bearerRequests > 0) return;
		await this.loopPromise;
		await this.serialTail;
	}

	/** Drains a bounded number of durable operations for the current session. */
	async syncOnce(signal?: AbortSignal): Promise<boolean> {
		if (!this.options.configuration.enabled) return false;
		const identity = this.options.auth.captureCurrentSession();
		if (!identity) return false;
		return this.serialize(async () => {
			let didAnyWork = false;
			for (
				let operation = 0;
				operation < DATA_CENTER_MAX_DRAIN_OPERATIONS;
				operation += 1
			) {
				throwIfAborted(signal);
				this.assertCurrent(identity);
				const didWork = await this.syncAccount(identity, signal);
				if (!didWork) return didAnyWork;
				didAnyWork = true;
			}
			return didAnyWork;
		});
	}

	private async runLoop(signal: AbortSignal): Promise<void> {
		while (!signal.aborted && this.desiredRunning) {
			try {
				await this.syncOnce(signal);
			} catch (error) {
				if (!signal.aborted) this.onError(error);
			}
			if (!signal.aborted && this.desiredRunning) {
				await this.waitForWake(signal);
			}
		}
	}

	private async syncAccount(
		identity: AuthSessionIdentity,
		signal?: AbortSignal,
	): Promise<boolean> {
		let credentials = await this.registeredCredentials(identity, signal);
		credentials = await this.ensureConsents(identity, credentials, signal);
		const owner = this.options.repository.getDataCenterConsumerOwner();
		if (owner?.accountId !== identity.accountId) {
			await this.rebaseConsumerForAccount(identity, credentials, signal);
			return true;
		}

		const pending = await this.pendingOperation(identity.accountId);
		if (pending.batch) {
			await this.recoverPendingBatch(
				identity,
				credentials,
				pending.batch,
				signal,
			);
			return true;
		}
		if (pending.advance) {
			await this.sendPendingAdvance(
				identity,
				credentials,
				pending.advance,
				signal,
			);
			await this.commit(identity, pending.advance.toCursor);
			this.deletePendingAdvance(pending.advance);
			return true;
		}

		const page = await this.options.events.queryDesktopEvents({
			consumerId: DATA_CENTER_CONSUMER_ID,
			limit: 500,
		});
		this.assertCurrent(identity);
		if (page.events.length === 0) return false;
		assertContiguousEvents(page.events);

		const projections: DataCenterProjectionResult[] = [];
		const contentEncryptor = this.contentEncryptor(
			identity,
			credentials,
			signal,
		);
		let uploadBodyBytes = DATA_CENTER_EMPTY_BATCH_BODY_BYTES;
		for (const event of page.events) {
			let projection = await projectDataCenterEvent({
				event,
				configuration: this.options.configuration,
				nowMs: this.now(),
				contentEncryptor,
			});
			const first = projections[0];
			if (!first) {
				if (projection.kind === "upload") {
					const nextBytes =
						uploadBodyBytes + dataCenterWireEventByteLength(projection.event);
					if (nextBytes > DATA_CENTER_MAX_BATCH_BODY_BYTES) {
						projection = {
							kind: "advance",
							domain: projection.domain,
							reason: "payload-unsupported",
						};
					} else {
						uploadBodyBytes = nextBytes;
					}
				}
				projections.push(projection);
				continue;
			}
			if (first.kind === "advance") {
				if (
					projection.kind !== "advance" ||
					projection.reason !== first.reason
				) {
					break;
				}
				projections.push(projection);
				continue;
			}
			if (projection.kind !== "upload") break;
			const nextBytes =
				uploadBodyBytes +
				1 +
				dataCenterWireEventByteLength(projection.event);
			if (nextBytes > DATA_CENTER_MAX_BATCH_BODY_BYTES) break;
			uploadBodyBytes = nextBytes;
			projections.push(projection);
		}
		this.assertCurrent(identity);
		const remoteCursor = await this.getRemoteCursor(
			identity,
			credentials,
			signal,
		);
		const expectedFrom = previousCursor(page.events[0]?.cursor ?? "");
		if (remoteCursor !== expectedFrom) {
			throw new Error(
				"DataCenter and local desktop cursors diverged without a durable pending operation.",
			);
		}

		if (projections[0]?.kind === "upload") {
			const events: DataCenterWireEvent[] = [];
			for (const projection of projections) {
				if (projection.kind !== "upload") break;
				events.push(projection.event);
			}
			const candidate = createPendingDataCenterBatchPrefix(
				identity.accountId,
				events,
				this.now(),
			);
			if (!candidate) {
				const firstCursor = page.events[0]?.cursor;
				if (!firstCursor) throw new Error("DataCenter upload range is empty.");
				const unsupported = createPendingDataCenterAdvance({
					accountId: identity.accountId,
					fromCursor: remoteCursor,
					toCursor: firstCursor,
					reason: "payload-unsupported",
					createdAtMs: this.now(),
				});
				await this.options.repository.putDataCenterPendingAdvance(unsupported);
				this.assertCurrent(identity);
				await this.sendPendingAdvance(
					identity,
					credentials,
					unsupported,
					signal,
				);
				await this.commit(identity, unsupported.toCursor);
				this.deletePendingAdvance(unsupported);
				return true;
			}
			const durable = candidate.pending;
			await this.options.repository.putDataCenterPendingBatch(durable);
			this.assertCurrent(identity);
			await this.sendPendingBatch(identity, credentials, durable, signal);
			await this.commit(identity, durable.lastCursor);
			this.deletePendingBatch(durable);
			return true;
		}

		const first = projections[0];
		if (!first || first.kind !== "advance") {
			throw new Error("DataCenter event projection is empty.");
		}
		let lastCursor = page.events[0]?.cursor;
		for (let index = 1; index < projections.length; index += 1) {
			const projection = projections[index];
			if (
				projection?.kind !== "advance" ||
				projection.reason !== first.reason
			) {
				break;
			}
			lastCursor = page.events[index]?.cursor;
		}
		if (!lastCursor) throw new Error("DataCenter advance range is empty.");
		const durable = createPendingDataCenterAdvance({
			accountId: identity.accountId,
			fromCursor: remoteCursor,
			toCursor: lastCursor,
			reason: first.reason,
			createdAtMs: this.now(),
		});
		await this.options.repository.putDataCenterPendingAdvance(durable);
		this.assertCurrent(identity);
		await this.sendPendingAdvance(identity, credentials, durable, signal);
		await this.commit(identity, durable.toCursor);
		this.deletePendingAdvance(durable);
		return true;
	}

	private async registeredCredentials(
		identity: AuthSessionIdentity,
		signal?: AbortSignal,
	): Promise<DataCenterAgentCredentialsRecord> {
		let credentials =
			await this.options.repository.getDataCenterAgentCredentials(
				identity.accountId,
			);
		if (!credentials) {
			credentials = createDataCenterAgentCredentials({
				accountId: identity.accountId,
				installationId: this.createCloudInstallationId(),
				nowMs: this.now(),
				agentVersion: this.options.agentVersion,
			});
			await this.options.repository.putDataCenterAgentCredentials(credentials);
		}
		if (credentials.registrationStatus === "registered") return credentials;

		const response = await this.bearerJsonWithRetry(
			identity,
			DATA_CENTER_REGISTER_PATH,
			credentials.registrationRequestBody,
			[200, 201],
			signal,
		);
		const registration = parseDataCenterRegistration(response);
		this.assertCurrent(identity);
		credentials = completeDataCenterRegistration(
			credentials,
			registration,
			this.now(),
		);
		await this.options.repository.putDataCenterAgentCredentials(credentials);
		return credentials;
	}

	private async ensureConsents(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		signal?: AbortSignal,
	): Promise<DataCenterAgentCredentialsRecord> {
		if (!credentials.deviceId) {
			throw new Error("Registered DataCenter Agent has no device ID.");
		}
		const digest = cloudSyncConsentDigest(this.options.configuration);
		if (credentials.consentDigest === digest) return credentials;
		for (const domain of ["activity", "browser", "presence"] as const) {
			const consent = dataCenterConsentRequest(
				this.options.configuration.consents[domain],
			);
			const response = await this.bearerJsonWithRetry(
				identity,
				`/v1/devices/${credentials.deviceId}/consents/${domain}`,
				JSON.stringify(consent),
				[200],
				signal,
				"PUT",
			);
			validateConsentResponse(
				response,
				credentials.deviceId,
				domain,
				consent,
			);
		}
		this.assertCurrent(identity);
		const updated = {
			...credentials,
			consentDigest: digest,
			updatedAtMs: this.now(),
		};
		await this.options.repository.putDataCenterAgentCredentials(updated);
		return updated;
	}

	private async rebaseConsumerForAccount(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		signal?: AbortSignal,
	): Promise<void> {
		const tail = (await this.options.events.getDesktopEventTailCursor()).cursor;
		this.assertCurrent(identity);
		const owner = this.options.repository.getDataCenterConsumerOwner();
		const [stale, previousOwnerStale] = await Promise.all([
			this.pendingOperation(identity.accountId),
			owner && owner.accountId !== identity.accountId
				? this.pendingOperation(owner.accountId)
				: Promise.resolve({ batch: null, advance: null }),
		]);
		let remoteCursor = await this.getRemoteCursor(identity, credentials, signal);
		if (cursorPosition(remoteCursor) > dataCenterCursorSequence(tail)) {
			throw new Error("DataCenter cursor is ahead of this local event journal.");
		}
		const audit = createDataCenterConsumerAudit({
			fromAccountId: owner?.accountId ?? null,
			toAccountId: identity.accountId,
			fromCursor: remoteCursor,
			toCursor: tail,
			boundaryEpochMs: owner?.updatedAtMs ?? credentials.createdAtMs,
			createdAtMs: this.now(),
		});
		await this.options.repository.appendDataCenterConsumerAudit(audit);
		this.assertCurrent(identity);

		// Ownership mismatch is a hard privacy boundary. An encrypted pending body
		// may predate the intervening account session, so it is never replayed here.
		// First make its removal crash-safe by advancing the fixed local consumer;
		// ownership intentionally remains unchanged until the cloud gap is audited.
		await this.commit(identity, tail);
		if (previousOwnerStale.batch) {
			this.deletePendingBatch(previousOwnerStale.batch);
		}
		if (previousOwnerStale.advance) {
			this.deletePendingAdvance(previousOwnerStale.advance);
		}
		if (stale.batch) this.deletePendingBatch(stale.batch);
		if (stale.advance) this.deletePendingAdvance(stale.advance);

		if (cursorPosition(remoteCursor) !== dataCenterCursorSequence(tail)) {
			const boundary = createPendingDataCenterAdvance({
				accountId: identity.accountId,
				fromCursor: remoteCursor,
				toCursor: tail,
				reason: "account-boundary",
				createdAtMs: this.now(),
			});
			await this.options.repository.putDataCenterPendingAdvance(boundary);
			this.assertCurrent(identity);
			await this.sendPendingAdvance(identity, credentials, boundary, signal);
			remoteCursor = boundary.toCursor;
			await this.commit(identity, remoteCursor);
			await this.options.repository.setDataCenterConsumerOwner(
				identity.accountId,
			);
			this.assertCurrent(identity);
			this.deletePendingAdvance(boundary);
			return;
		}

		await this.commit(identity, tail);
		await this.options.repository.setDataCenterConsumerOwner(identity.accountId);
		this.assertCurrent(identity);
	}

	private async pendingOperation(accountId: string): Promise<{
		batch: DataCenterPendingBatchRecord | null;
		advance: DataCenterPendingAdvanceRecord | null;
	}> {
		const [batch, advance] = await Promise.all([
			this.options.repository.getDataCenterPendingBatch(accountId),
			this.options.repository.getDataCenterPendingAdvance(accountId),
		]);
		if (batch && advance) {
			throw new Error("Multiple DataCenter wire operations are pending.");
		}
		return { batch, advance };
	}

	private async recoverPendingBatch(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		pending: DataCenterPendingBatchRecord,
		signal?: AbortSignal,
	): Promise<void> {
		const remoteCursor = await this.getRemoteCursor(
			identity,
			credentials,
			signal,
		);
		if (remoteCursor === pending.lastCursor) {
			await this.commit(identity, pending.lastCursor);
			this.deletePendingBatch(pending);
			return;
		}
		const expectedFrom = previousCursor(pending.firstCursor);
		if (remoteCursor !== expectedFrom) {
			throw new Error(
				"DataCenter and durable pending batch cursors diverged.",
			);
		}
		const replacementReason = dataCenterPendingBatchReplacementReason({
			pending,
			configuration: this.options.configuration,
			nowMs: this.now(),
		});
		if (replacementReason) {
			const advance = createPendingDataCenterAdvance({
				accountId: pending.accountId,
				fromCursor: remoteCursor,
				toCursor: pending.lastCursor,
				reason: replacementReason,
				createdAtMs: this.now(),
			});
			const replaced =
				await this.options.repository.replaceDataCenterPendingBatchWithAdvance(
					pending,
					advance,
				);
			this.assertCurrent(identity);
			if (!replaced) {
				throw new Error(
					"Durable DataCenter batch changed during cursor advance replacement.",
				);
			}
			await this.sendPendingAdvance(identity, credentials, advance, signal);
			await this.commit(identity, advance.toCursor);
			this.deletePendingAdvance(advance);
			return;
		}
		await this.sendPendingBatch(identity, credentials, pending, signal);
		await this.commit(identity, pending.lastCursor);
		this.deletePendingBatch(pending);
	}

	private async sendPendingBatch(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		pending: DataCenterPendingBatchRecord,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.signedJsonWithRetry(
			identity,
			credentials,
			"POST",
			DATA_CENTER_BATCH_PATH,
			pending.body,
			202,
			signal,
		);
		validateDataCenterBatchResponse(response, pending);
	}

	private async sendPendingAdvance(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		pending: DataCenterPendingAdvanceRecord,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.signedJsonWithRetry(
			identity,
			credentials,
			"POST",
			DATA_CENTER_ADVANCE_PATH,
			pending.body,
			202,
			signal,
		);
		validateDataCenterAdvanceResponse(response, pending);
	}

	private async getRemoteCursor(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		signal?: AbortSignal,
	): Promise<string | null> {
		const response = await this.signedJsonWithRetry(
			identity,
			credentials,
			"GET",
			DATA_CENTER_CURSOR_PATH,
			"",
			200,
			signal,
		);
		return parseDataCenterCursor(response).ackCursor;
	}

	private contentEncryptor(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		signal?: AbortSignal,
	): DataCenterContentEncryptor {
		return {
			encrypt: async (event, publicPayload) => {
				if (!credentials.agentId) {
					throw new Error("DataCenter Agent is not registered.");
				}
				const context = await this.getEncryptionContext(
					identity,
					credentials,
					signal,
				);
				this.assertCurrent(identity);
				return this.contentCrypto.encrypt({
					context,
					userId: identity.accountId,
					agentId: credentials.agentId,
					event,
					publicPayload,
					nowMs: this.now(),
				});
			},
		};
	}

	private async getEncryptionContext(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		signal?: AbortSignal,
	): Promise<DataCenterEncryptionContext> {
		if (!credentials.agentId) {
			throw new Error("DataCenter Agent is not registered.");
		}
		const nowMs = this.now();
		const cached = this.encryptionContextCache;
		if (
			cached?.accountId === identity.accountId &&
			cached.agentId === credentials.agentId &&
			nowMs <
				cached.context.expiresAtMs - DATA_CENTER_CONTEXT_REFRESH_WINDOW_MS
		) {
			return cached.context;
		}
		const response = await this.signedJsonWithRetry(
			identity,
			credentials,
			"GET",
			DATA_CENTER_ENCRYPTION_CONTEXT_PATH,
			"",
			200,
			signal,
		);
		const context = parseDataCenterEncryptionContext(response, {
			accountId: identity.accountId,
			nowMs: this.now(),
			minimumRemainingValidityMs: DATA_CENTER_CONTEXT_REFRESH_WINDOW_MS,
		});
		this.assertCurrent(identity);
		this.encryptionContextCache = {
			accountId: identity.accountId,
			agentId: credentials.agentId,
			context,
		};
		return context;
	}

	private async signedJsonWithRetry(
		identity: AuthSessionIdentity,
		credentials: DataCenterAgentCredentialsRecord,
		method: "GET" | "POST",
		path: string,
		body: string,
		expectedStatus: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (!credentials.agentId) {
			throw new Error("DataCenter Agent is not registered.");
		}
		const url = new URL(path, this.baseUrl);
		if (
			url.origin !== this.baseUrl.origin ||
			`${url.pathname}${url.search}` !== path ||
			url.hash !== ""
		) {
			throw new Error("Refusing a cross-origin DataCenter Agent request.");
		}
		let lastError: unknown;
		for (let attempt = 0; attempt < DATA_CENTER_REQUEST_ATTEMPTS; attempt += 1) {
			throwIfAborted(signal);
			this.assertCurrent(identity);
			try {
				const signed = signDataCenterRequestV2({
					agentId: credentials.agentId,
					privateKeyPkcs8: credentials.privateKeyPkcs8,
					method,
					url,
					body,
					nowMs: this.now(),
				});
				const headers = new Headers(signed);
				headers.set("accept", "application/json");
				if (method === "POST") {
					headers.set("content-type", "application/json");
				}
				const response = await this.fetchImpl(url, {
					method,
					headers,
					...(method === "POST" ? { body } : {}),
					redirect: "error",
					cache: "no-store",
					signal,
				});
				this.assertCurrent(identity);
				if (response.status !== expectedStatus) {
					if (
						(response.status === 429 || response.status >= 500) &&
						attempt + 1 < DATA_CENTER_REQUEST_ATTEMPTS
					) {
						await this.retryWait(attempt, signal);
						continue;
					}
					throw new DataCenterHttpStatusError(path, response.status);
				}
				return await readBoundedJson(response);
			} catch (error) {
				lastError = error;
				if (error instanceof DataCenterHttpStatusError) throw error;
				if (signal?.aborted || !this.options.auth.isCurrentSession(identity)) {
					throw error;
				}
				if (attempt + 1 >= DATA_CENTER_REQUEST_ATTEMPTS) throw error;
				await this.retryWait(attempt, signal);
			}
		}
		throw lastError ?? new Error("DataCenter signed request failed.");
	}

	private async bearerJsonWithRetry(
		identity: AuthSessionIdentity,
		path: string,
		body: string,
		expectedStatuses: readonly number[],
		signal?: AbortSignal,
		method: "POST" | "PUT" = "POST",
	): Promise<unknown> {
		let lastError: unknown;
		for (let attempt = 0; attempt < DATA_CENTER_REQUEST_ATTEMPTS; attempt += 1) {
			throwIfAborted(signal);
			this.assertCurrent(identity);
			try {
				this.bearerRequests += 1;
				let response: Response;
				try {
					response = await this.options.auth.bearerFetch(path, {
						method,
						headers: {
							accept: "application/json",
							"content-type": "application/json",
						},
						body,
						signal,
					});
				} finally {
					this.bearerRequests -= 1;
				}
				this.assertCurrent(identity);
				if (!expectedStatuses.includes(response.status)) {
					if (
						(response.status === 429 || response.status >= 500) &&
						attempt + 1 < DATA_CENTER_REQUEST_ATTEMPTS
					) {
						await this.retryWait(attempt, signal);
						continue;
					}
					throw new DataCenterHttpStatusError(path, response.status);
				}
				return await readBoundedJson(response);
			} catch (error) {
				lastError = error;
				if (error instanceof DataCenterHttpStatusError) throw error;
				if (signal?.aborted || !this.options.auth.isCurrentSession(identity)) {
					throw error;
				}
				if (attempt + 1 >= DATA_CENTER_REQUEST_ATTEMPTS) throw error;
				await this.retryWait(attempt, signal);
			}
		}
		throw lastError ?? new Error("DataCenter bearer request failed.");
	}

	private async commit(
		identity: AuthSessionIdentity,
		cursor: string,
	): Promise<void> {
		this.assertCurrent(identity);
		const result = await this.options.events.commitDesktopEventCursor(
			DATA_CENTER_CONSUMER_ID,
			cursor,
		);
		this.assertCurrent(identity);
		if (
			result.consumerId !== DATA_CENTER_CONSUMER_ID ||
			result.cursor !== cursor ||
			typeof result.advanced !== "boolean"
		) {
			throw new Error("Local DataCenter consumer commit ACK is invalid.");
		}
	}

	private deletePendingBatch(pending: DataCenterPendingBatchRecord): void {
		if (
			!this.options.repository.deleteDataCenterPendingBatch(
				pending.accountId,
				pending.batchKey,
			)
		) {
			throw new Error("Durable DataCenter batch disappeared before deletion.");
		}
	}

	private deletePendingAdvance(
		pending: DataCenterPendingAdvanceRecord,
	): void {
		if (
			!this.options.repository.deleteDataCenterPendingAdvance(
				pending.accountId,
				pending.advanceKey,
			)
		) {
			throw new Error("Durable DataCenter advance disappeared before deletion.");
		}
	}

	private assertCurrent(identity: AuthSessionIdentity): void {
		if (!this.options.auth.isCurrentSession(identity)) {
			throw new Error("DataCenter sync session changed during an operation.");
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.serialTail.then(operation, operation);
		this.serialTail = result.catch(() => undefined);
		return result;
	}

	private async retryWait(attempt: number, signal?: AbortSignal): Promise<void> {
		const delay = this.retryDelayMs * 2 ** attempt;
		if (delay <= 0) return;
		await abortableDelay(delay, signal);
	}

	private waitForWake(signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				if (this.wakeWaiter === finish) this.wakeWaiter = null;
				resolve();
			};
			const timer = setTimeout(finish, this.syncIntervalMs);
			this.wakeWaiter = finish;
			signal.addEventListener("abort", finish, { once: true });
		});
	}
}

class DataCenterHttpStatusError extends Error {
	constructor(path: string, status: number) {
		super(`DataCenter ${path} returned HTTP ${status}.`);
		this.name = "DataCenterHttpStatusError";
	}
}

function validateDataCenterBaseUrl(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "")
	) {
		throw new Error("DataCenter base URL must be an HTTPS origin.");
	}
	if (
		url.origin !== WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL &&
		url.origin !== WHALEHALL_DATA_CENTER_STAGING_BASE_URL
	) {
		throw new Error("DataCenter base URL is not a code-owned origin.");
	}
	return new URL(url.origin);
}

function validateConsentResponse(
	value: unknown,
	deviceId: string,
	domain: "activity" | "browser" | "presence",
	request: ReturnType<typeof dataCenterConsentRequest>,
): void {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"device_id",
			"sensor_type",
			"granted",
			"data_level",
		]) ||
		value.device_id !== deviceId ||
		value.sensor_type !== domain ||
		value.granted !== request.granted ||
		value.data_level !== request.data_level
	) {
		throw new Error("DataCenter consent ACK is invalid.");
	}
}

function previousCursor(cursor: string): string | null {
	const sequence = dataCenterCursorSequence(cursor);
	if (sequence === 1n) return null;
	if (sequence < 1n) throw new Error("Desktop event cursor cannot precede one.");
	return `ec1_${(sequence - 1n).toString(16).padStart(16, "0")}`;
}

function cursorPosition(cursor: string | null): bigint {
	return cursor === null ? 0n : dataCenterCursorSequence(cursor);
}

function assertContiguousEvents(events: DesktopEventV1[]): void {
	for (let index = 1; index < events.length; index += 1) {
		const previous = events[index - 1];
		const current = events[index];
		if (
			!previous ||
			!current ||
			dataCenterCursorSequence(current.cursor) !==
				dataCenterCursorSequence(previous.cursor) + 1n
		) {
			throw new Error("Local desktop event page is not contiguous.");
		}
	}
}

async function readBoundedJson(response: Response): Promise<unknown> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		if (!/^\d+$/u.test(declaredLength)) {
			throw new Error("DataCenter JSON response size is invalid.");
		}
		const parsedLength = Number(declaredLength);
		if (
			!Number.isSafeInteger(parsedLength) ||
			parsedLength < 1 ||
			parsedLength > DATA_CENTER_MAX_RESPONSE_BYTES
		) {
			throw new Error("DataCenter JSON response size is invalid.");
		}
	}
	if (!response.body) {
		throw new Error("DataCenter JSON response size is invalid.");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			byteLength += result.value.byteLength;
			if (byteLength > DATA_CENTER_MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error("DataCenter JSON response size is invalid.");
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (byteLength < 1) {
		throw new Error("DataCenter JSON response size is invalid.");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks, byteLength),
		);
	} catch {
		throw new Error("DataCenter JSON response encoding is invalid.");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("DataCenter JSON response is invalid.");
	}
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Operation aborted."));
			return;
		}
		const timer = setTimeout(resolve, delayMs);
		if (!signal) return;
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Operation aborted."));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new Error("Operation aborted.");
	}
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
