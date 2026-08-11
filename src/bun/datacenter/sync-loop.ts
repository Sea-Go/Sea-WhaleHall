import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	DataCenterSyncErrorCode,
	DataCenterSyncState,
	DataCenterSyncStatus,
} from "../../shared/datacenter";
import {
	generateNonce,
	signAgentRequest,
	type AgentSigningRequest,
	type Ed25519AgentIdentity,
} from "./agent-identity";
import { DataCenterHttpError, DataCenterHttpClient } from "./http";
import {
	formatDesktopCursor,
	isContiguousCursors,
	parseDesktopCursor,
	projectMetadataPayload,
} from "./payload-projection";
import type {
	DataCenterAgentRegistration,
	DataCenterDesktopBatch,
	DataCenterDesktopBatchResult,
	DataCenterDesktopEvent,
} from "./types";

export const DATACENTER_SYNC_CONSUMER_ID = "datacenter-sync";
export const DATACENTER_SYNC_STATE_SCHEMA_VERSION =
	"datacenter-sync-state.v1";
export const DATACENTER_BATCH_LIMIT = 500;
export const DATACENTER_MAX_BACKOFF_MS = 5 * 60 * 1000;
export const DATACENTER_MAX_BATCHES_PER_TICK = 10;

export type UploadCandidateEvent = {
	schemaVersion: string;
	eventId: string;
	cursor: string;
	deviceId: string;
	sessionId: string;
	kind: string;
	source: string;
	occurredAtMs: number;
	observedAtMs: number;
	goalVersion: number | null;
	sensitivity: "metadata" | "content";
	payload: Record<string, unknown>;
};

export type DataCenterEventSource = {
	queryEvents(
		consumerId: string,
		limit: number,
	): Promise<{ events: UploadCandidateEvent[]; hasMore: boolean }>;
	commitCursor(
		consumerId: string,
		cursor: string,
	): Promise<{ advanced: boolean }>;
};

export type DataCenterSyncContext = {
	baseUrl: string;
	http: DataCenterHttpClient;
	eventSource: DataCenterEventSource;
	identity: Ed25519AgentIdentity | Promise<Ed25519AgentIdentity>;
	readAccessToken(): Promise<string | null>;
	readAgentId(): Promise<string | null>;
	registerAgent(): Promise<DataCenterAgentRegistration | null>;
	now(): number;
};

export type DataCenterSyncPersistedState = {
	schemaVersion: typeof DATACENTER_SYNC_STATE_SCHEMA_VERSION;
	enabled: boolean;
	state: DataCenterSyncState;
	pendingBatchKey: string | null;
	pendingFirstCursor: string | null;
	pendingLastCursor: string | null;
	attempt: number;
	nextRetryAtMs: number | null;
	lastSyncAtMs: number | null;
	lastErrorCode: DataCenterSyncErrorCode | null;
	lastErrorMessage: string | null;
	blockedCursor: string | null;
	blockedReason: string | null;
	updatedAtMs: number;
};

export type DataCenterSyncLoopOptions = {
	context: DataCenterSyncContext;
	stateFile: string;
	intervalMs: number;
	now?: () => number;
};

type BuildBatchResult =
	| { kind: "batch"; events: DataCenterDesktopEvent[] }
	| {
			kind: "blocked";
			cursor: string;
			reason: string;
			state: "blocked_content" | "blocked_reconcile";
			errorCode: DataCenterSyncErrorCode;
	  }
	| { kind: "empty" };

export class DataCenterSyncLoop {
	private readonly context: DataCenterSyncContext;
	private readonly stateFile: string;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private lastPendingEventCount = 0;

	constructor(options: DataCenterSyncLoopOptions) {
		this.context = options.context;
		this.stateFile = options.stateFile;
		this.intervalMs = options.intervalMs;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		const state = this.loadState();
		state.enabled = enabled;
		state.updatedAtMs = this.now();
		if (!enabled) {
			state.state = "disabled";
		}
		this.saveState(state);
		if (enabled) await this.tick();
	}

	async getStatus(): Promise<DataCenterSyncStatus> {
		const state = this.loadState();
		const [accessToken, agentId] = await Promise.all([
			this.context.readAccessToken(),
			this.context.readAgentId(),
		]);
		return {
			state: state.state,
			enabled: state.enabled,
			signedIn: accessToken !== null,
			agentRegistered: agentId !== null,
			baseUrl: this.context.baseUrl,
			lastSyncAtMs: state.lastSyncAtMs,
			lastErrorCode: state.lastErrorCode,
			lastErrorMessage: state.lastErrorMessage,
			pendingEventCount: this.lastPendingEventCount,
			blockedCursor: state.blockedCursor,
			blockedReason: state.blockedReason,
			updatedAtMs: state.updatedAtMs,
		};
	}

	trigger(): void {
		void this.tick();
	}

	async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.runPass();
		} finally {
			this.running = false;
		}
	}

	private async runPass(): Promise<void> {
		const state = this.loadState();
		if (!state.enabled) {
			state.state = "disabled";
			this.saveState(state);
			return;
		}
		if (
			state.state === "retry_wait" &&
			state.nextRetryAtMs !== null &&
			this.now() < state.nextRetryAtMs
		) {
			return;
		}
		const accessToken = await this.context.readAccessToken();
		if (accessToken === null) {
			this.applyFailure(state, {
				state: "needs_session",
				errorCode: "session_expired",
				message: "需要先登录 DataCenter 才能开启云同步。",
			});
			return;
		}
		let agentId = await this.context.readAgentId();
		if (agentId === null) {
			const registration = await this.context.registerAgent();
			if (registration === null) {
				this.applyFailure(state, {
					state: "needs_agent",
					errorCode: "agent_invalid",
					message: "Agent 注册失败，请稍后重试。",
				});
				return;
			}
			agentId = registration.agentId;
		}

		for (
			let index = 0;
			index < DATACENTER_MAX_BATCHES_PER_TICK;
			index += 1
		) {
			const shouldContinue = await this.sendNextBatch(
				state,
				accessToken,
				agentId,
			);
			if (!shouldContinue) break;
		}
	}

	private async sendNextBatch(
		state: DataCenterSyncPersistedState,
		accessToken: string,
		agentId: string,
	): Promise<boolean> {
		const query = await this.context.eventSource.queryEvents(
			DATACENTER_SYNC_CONSUMER_ID,
			DATACENTER_BATCH_LIMIT,
		);
		this.lastPendingEventCount = query.events.length;
		if (query.events.length === 0) {
			state.pendingBatchKey = null;
			state.pendingFirstCursor = null;
			state.pendingLastCursor = null;
			state.attempt = 0;
			state.nextRetryAtMs = null;
			state.lastSyncAtMs = this.now();
			state.lastErrorCode = null;
			state.lastErrorMessage = null;
			state.state = "ready";
			state.updatedAtMs = this.now();
			this.saveState(state);
			return false;
		}

		const build = buildUploadableBatch(query.events);
		if (build.kind === "blocked") {
			state.blockedCursor = build.cursor;
			state.blockedReason = build.reason;
			state.state = build.state;
			state.lastErrorCode = build.errorCode;
			state.lastErrorMessage = build.reason;
			state.updatedAtMs = this.now();
			this.saveState(state);
			return false;
		}
		if (build.kind === "empty") {
			state.state = "ready";
			state.updatedAtMs = this.now();
			this.saveState(state);
			return false;
		}

		const firstCursor = build.events[0]?.cursor ?? "";
		const lastCursor =
			build.events[build.events.length - 1]?.cursor ?? "";
		if (firstCursor === "" || lastCursor === "") {
			this.applyFailure(state, {
				state: "blocked_reconcile",
				errorCode: "contract_violation",
				message: "批次缺少有效的首尾游标。",
			});
			return false;
		}

		const batchKey = `${firstCursor}:${lastCursor}`;
		if (
			state.pendingBatchKey !== batchKey ||
			state.pendingFirstCursor !== firstCursor ||
			state.pendingLastCursor !== lastCursor
		) {
			state.pendingBatchKey = batchKey;
			state.pendingFirstCursor = firstCursor;
			state.pendingLastCursor = lastCursor;
			state.attempt = 0;
		}
		state.attempt += 1;
		state.state = "sending";
		state.updatedAtMs = this.now();
		this.saveState(state);

		const body: DataCenterDesktopBatch = {
			schemaVersion: "desktop-event-batch.v1",
			batchKey,
			firstCursor,
			lastCursor,
			events: build.events,
		};
		const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
		const timestamp = new Date(this.now()).toISOString();
		const nonce = generateNonce();
		const signingRequest: AgentSigningRequest = {
			method: "POST",
			path: "/api/v1/agent/events/desktop/batch",
			timestamp,
			nonce,
			bodyBytes,
		};
		const identity = await this.context.identity;
		const signature = await signAgentRequest(identity, signingRequest);

		let result: DataCenterDesktopBatchResult;
		try {
			result = await this.context.http.post<DataCenterDesktopBatchResult>(
				"/api/v1/agent/events/desktop/batch",
				body,
				{
					headers: {
						"X-Agent-ID": agentId,
						"X-Agent-Timestamp": timestamp,
						"X-Agent-Nonce": nonce,
						"X-Agent-Signature": signature,
					},
				},
			);
		} catch (error) {
			if (error instanceof DataCenterHttpError) {
				this.handleHttpError(error, state);
			} else {
				this.applyFailure(state, {
					state: "retry_wait",
					errorCode: "internal",
					message: "同步请求发生未知错误，等待重试。",
				});
			}
			return false;
		}

		const ackSequence = parseDesktopCursor(result.ackCursor);
		const lastSequence = parseDesktopCursor(lastCursor);
		if (
			ackSequence === null ||
			lastSequence === null ||
			ackSequence < lastSequence
		) {
			this.applyFailure(state, {
				state: "blocked_reconcile",
				errorCode: "contract_violation",
				message: "服务端返回的 ackCursor 不在预期范围内。",
			});
			return false;
		}

		await this.context.eventSource.commitCursor(
			DATACENTER_SYNC_CONSUMER_ID,
			result.ackCursor,
		);
		state.pendingBatchKey = null;
		state.pendingFirstCursor = null;
		state.pendingLastCursor = null;
		state.attempt = 0;
		state.nextRetryAtMs = null;
		state.lastSyncAtMs = this.now();
		state.lastErrorCode = null;
		state.lastErrorMessage = null;
		state.state = "ready";
		state.updatedAtMs = this.now();
		this.saveState(state);
		return true;
	}

	private handleHttpError(
		error: DataCenterHttpError,
		state: DataCenterSyncPersistedState,
	): void {
		if (error.kind === "offline" || error.kind === "timeout") {
			this.enterRetryWait(state, "offline", "无法连接 DataCenter，等待重试。");
			return;
		}
		switch (error.status) {
			case 401:
				this.applyFailure(state, {
					state: "needs_agent",
					errorCode: "agent_invalid",
					message: "Agent 签名或身份失效，需要重新注册。",
				});
				return;
			case 403:
				this.applyFailure(state, {
					state: "blocked_reconcile",
					errorCode: "consent_revoked",
					message: "采集授权已撤销，请重新开启监测授权。",
				});
				return;
			case 400: {
				const timeWindow =
					/timestamp|time window|outside accepted range/iu.test(
						error.serverMessage,
					);
				this.applyFailure(state, {
					state: "blocked_reconcile",
					errorCode: timeWindow
						? "time_window_violation"
						: "contract_violation",
					message:
						error.serverMessage || "事件批次未通过服务端校验。",
				});
				return;
			}
			case 409:
				this.enterRetryWait(
					state,
					"http_error",
					"请求重放冲突，将使用新的时间戳与 nonce 重试。",
				);
				return;
			case 429:
				this.enterRetryWait(state, "http_error", "请求过于频繁，等待重试。");
				return;
			case 503:
				this.applyFailure(state, {
					state: "blocked_reconcile",
					errorCode: "server_unavailable",
					message: "DataCenter 暂不支持该批次，等待后续处理。",
				});
				return;
			default:
				this.enterRetryWait(
					state,
					"http_error",
					`DataCenter 返回 HTTP ${error.status}，等待重试。`,
				);
		}
	}

	private enterRetryWait(
		state: DataCenterSyncPersistedState,
		errorCode: DataCenterSyncErrorCode,
		message: string,
	): void {
		const backoffMs = Math.min(
			this.intervalMs * 2 ** Math.max(0, state.attempt - 1),
			DATACENTER_MAX_BACKOFF_MS,
		);
		state.state = "retry_wait";
		state.nextRetryAtMs = this.now() + backoffMs;
		state.lastErrorCode = errorCode;
		state.lastErrorMessage = message;
		state.updatedAtMs = this.now();
		this.saveState(state);
	}

	private applyFailure(
		state: DataCenterSyncPersistedState,
		failure: {
			state: DataCenterSyncState;
			errorCode: DataCenterSyncErrorCode;
			message: string;
		},
	): void {
		state.state = failure.state;
		state.lastErrorCode = failure.errorCode;
		state.lastErrorMessage = failure.message;
		state.updatedAtMs = this.now();
		this.saveState(state);
	}

	private loadState(): DataCenterSyncPersistedState {
		try {
			const parsed = JSON.parse(
				readFileSync(this.stateFile, "utf8"),
			) as Partial<DataCenterSyncPersistedState>;
			if (parsed.schemaVersion === DATACENTER_SYNC_STATE_SCHEMA_VERSION) {
				return {
					schemaVersion: DATACENTER_SYNC_STATE_SCHEMA_VERSION,
					enabled: parsed.enabled === true,
					state: isSyncState(parsed.state)
						? parsed.state
						: "disabled",
					pendingBatchKey:
						typeof parsed.pendingBatchKey === "string"
							? parsed.pendingBatchKey
							: null,
					pendingFirstCursor:
						typeof parsed.pendingFirstCursor === "string"
							? parsed.pendingFirstCursor
							: null,
					pendingLastCursor:
						typeof parsed.pendingLastCursor === "string"
							? parsed.pendingLastCursor
							: null,
					attempt:
						typeof parsed.attempt === "number" &&
						Number.isSafeInteger(parsed.attempt) &&
						parsed.attempt >= 0
							? parsed.attempt
							: 0,
					nextRetryAtMs:
						typeof parsed.nextRetryAtMs === "number"
							? parsed.nextRetryAtMs
							: null,
					lastSyncAtMs:
						typeof parsed.lastSyncAtMs === "number"
							? parsed.lastSyncAtMs
							: null,
					lastErrorCode:
						typeof parsed.lastErrorCode === "string"
							? (parsed.lastErrorCode as DataCenterSyncErrorCode)
							: null,
					lastErrorMessage:
						typeof parsed.lastErrorMessage === "string"
							? parsed.lastErrorMessage
							: null,
					blockedCursor:
						typeof parsed.blockedCursor === "string"
							? parsed.blockedCursor
							: null,
					blockedReason:
						typeof parsed.blockedReason === "string"
							? parsed.blockedReason
							: null,
					updatedAtMs:
						typeof parsed.updatedAtMs === "number"
							? parsed.updatedAtMs
							: this.now(),
				};
			}
		} catch {
			// Missing or corrupt state starts disabled.
		}
		return defaultSyncState(this.now());
	}

	private saveState(state: DataCenterSyncPersistedState): void {
		mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
		writeFileSync(this.stateFile, JSON.stringify(state, null, 2), {
			mode: 0o600,
		});
	}
}

function defaultSyncState(now: number): DataCenterSyncPersistedState {
	return {
		schemaVersion: DATACENTER_SYNC_STATE_SCHEMA_VERSION,
		enabled: false,
		state: "disabled",
		pendingBatchKey: null,
		pendingFirstCursor: null,
		pendingLastCursor: null,
		attempt: 0,
		nextRetryAtMs: null,
		lastSyncAtMs: null,
		lastErrorCode: null,
		lastErrorMessage: null,
		blockedCursor: null,
		blockedReason: null,
		updatedAtMs: now,
	};
}

function isSyncState(value: unknown): value is DataCenterSyncState {
	return (
		value === "disabled" ||
		value === "needs_session" ||
		value === "needs_agent" ||
		value === "ready" ||
		value === "sending" ||
		value === "committing" ||
		value === "retry_wait" ||
		value === "blocked_content" ||
		value === "blocked_reconcile"
	);
}

export function buildUploadableBatch(
	events: readonly UploadCandidateEvent[],
): BuildBatchResult {
	const wireEvents: DataCenterDesktopEvent[] = [];
	for (const event of events) {
		if (event.sensitivity === "content") {
			return {
				kind: "blocked",
				cursor: event.cursor,
				reason: "检测到 content 事件，云同步在加密链路接入前本地失败关闭。",
				state: "blocked_content",
				errorCode: "content_blocked",
			};
		}
		const projection = projectMetadataPayload(event.kind, event.payload);
		if (!projection.ok) {
			return {
				kind: "blocked",
				cursor: event.cursor,
				reason: projection.reason,
				state: "blocked_reconcile",
				errorCode: "contract_violation",
			};
		}
		wireEvents.push({
			schemaVersion: "desktop-event.v1",
			eventId: event.eventId,
			cursor: event.cursor,
			deviceId: event.deviceId,
			sessionId: event.sessionId,
			kind: event.kind,
			source: event.source,
			occurredAtMs: event.occurredAtMs,
			observedAtMs: event.observedAtMs,
			goalVersion: event.goalVersion,
			sensitivity: "metadata",
			payload: projection.payload,
		});
	}
	if (wireEvents.length === 0) {
		return { kind: "empty" };
	}
	if (!isContiguousCursors(wireEvents.map((event) => event.cursor))) {
		return {
			kind: "blocked",
			cursor: wireEvents[wireEvents.length - 1]?.cursor ?? "",
			reason: "本地事件游标不连续，无法安全上传。",
			state: "blocked_reconcile",
			errorCode: "contract_violation",
		};
	}
	return { kind: "batch", events: wireEvents };
}

/** Formats a sequence as a desktop cursor; used by tests and diagnostics. */
export function cursorForSequence(sequence: number): string {
	return formatDesktopCursor(sequence);
}
