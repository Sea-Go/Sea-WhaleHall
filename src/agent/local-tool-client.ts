import {
	isDesktopEvent,
	isLocalAuditFiveMinutesResult,
	isLocalMonitoringConfigure,
	isLocalMonitoringStatus,
	isLocalPlanningCalendarEvent,
	isLocalPlanningOutboxEntry,
	isLocalPlanningPlanSnapshot,
	isLocalToolDescriptor,
	isLocalVaultDeleteResultRecord,
	isLocalVaultKeyStatus,
	isLocalVaultLegacyMigrationResult,
	isLocalVaultOpenResultRecord,
	isLocalVaultSealResultRecord,
	isRecord,
	LOCAL_CONTROL_TIMEOUT_MS,
	LOCAL_KEY_MIGRATION_TIMEOUT_MS,
	LOCAL_PERMISSION_REFRESH_TIMEOUT_MS,
	LOCAL_TOOL_TIMEOUT_MS,
	type LocalAuditFiveMinutesQuery,
	type LocalAuditFiveMinutesResult,
	type LocalDesktopEventFrame,
	type LocalEventCommitResult,
	type LocalEventGoalChange,
	type LocalEventGoalChangeResult,
	type LocalEventQuery,
	type LocalEventQueryResult,
	type LocalEventTailCursorResult,
	type LocalMessage,
	type LocalMethod,
	type LocalMonitoringConfigure,
	type LocalMonitoringStatus,
	type LocalPlanningCalendarEvent,
	type LocalPlanningCalendarList,
	type LocalPlanningCalendarListResult,
	type LocalPlanningCalendarMutate,
	type LocalPlanningCalendarMutationResult,
	type LocalPlanningList,
	type LocalPlanningListResult,
	type LocalPlanningMutationParams,
	type LocalPlanningMutationResult,
	type LocalPlanningOperationGetResult,
	type LocalPlanningOutboxAck,
	type LocalPlanningOutboxAckResult,
	type LocalPlanningOutboxList,
	type LocalPlanningOutboxListResult,
	type LocalPlanningPlanSnapshot,
	type LocalPlanningVaultReferences,
	type LocalPlanningVaultReferencesResult,
	type LocalRequest,
	type LocalRuntimeHealth,
	type LocalSemanticCommitResult,
	type LocalSemanticEventFrame,
	type LocalSemanticQuery,
	type LocalSemanticQueryResult,
	type LocalToolCall,
	type LocalToolCallResult,
	type LocalToolCancelResult,
	type LocalToolDescriptor,
	type LocalToolEvent,
	type LocalToolListResult,
	type LocalVaultDeleteBatch,
	type LocalVaultDeleteBatchResult,
	type LocalVaultKeyStatus,
	type LocalVaultLegacyMigrationResult,
	type LocalVaultListRecords,
	type LocalVaultListRecordsResult,
	type LocalVaultOpenBatch,
	type LocalVaultOpenBatchResult,
	type LocalVaultSealBatch,
	type LocalVaultSealBatchResult,
	MAX_JSONL_LINE_BYTES,
	parseLocalMessage,
} from "./local-protocol";
import { isSemanticCursorV2, isSemanticEventV2 } from "./timeline-v2/contract";

export type LocalClientFailureCode =
	| "SPAWN_FAILED"
	| "PROCESS_EXITED"
	| "PROTOCOL_ERROR"
	| "REQUEST_TIMEOUT"
	| "STOP_FAILED"
	| "STOPPED"
	| "WRITE_FAILED";

export class LocalClientError extends Error {
	constructor(
		public readonly code: LocalClientFailureCode | string,
		message: string,
		public readonly details: Record<string, unknown> | null = null,
	) {
		super(message);
		this.name = "LocalClientError";
	}
}

export type ChildTransport = {
	pid: number;
	stdin: {
		write(data: string | Uint8Array): number;
		flush(): number | Promise<number>;
		end(error?: Error): number | Promise<number>;
	};
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
};

export type SpawnLocalProcess = (
	binaryPath: string,
	environment?: Readonly<Record<string, string>>,
) => ChildTransport;

export const STARTUP_GOAL_CHANGE_ENV = "WHALEHALL_STARTUP_GOAL_CHANGE_JSON";

const LOCAL_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;
const LOCAL_POST_KILL_EXIT_TIMEOUT_MS = 2_000;
const LOCAL_PROCESS_GROUP_POLL_MS = 10;
const WINDOWS_TASKKILL_PATH = "C:\\Windows\\System32\\taskkill.exe";

type OwnedProcessTree = {
	forceKill(): Promise<void>;
	isExited(): boolean;
	/** Windows taskkill needs the still-owned leader; POSIX can inspect the PGID. */
	leaderExitCompletesTree(exitCode: number): boolean;
};

const ownedProcessTrees = new WeakMap<ChildTransport, OwnedProcessTree>();

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

// whalehall-local intentionally receives a closed environment. Keep this list
// aligned with environment reads in whalehall-local/core and
// whalehall-local/server. New entries require a security review; in
// particular, model/auth credentials belong in the Bun host and must never be
// added here.
const LOCAL_TOOL_ENVIRONMENT_KEYS = [
	// Platform process discovery, user data discovery, temporary files and
	// locale. These are needed by the Rust sensors and their native helpers.
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"TEMP",
	"TMP",
	"TMPDIR",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_SESSION_ID",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_COLLATE",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"TZ",
	// WhaleHall-owned, non-secret runtime and sensor configuration.
	"WHALEHALL_DATA_DIR",
	"WHALEHALL_DEVICE_ID",
	"WHALEHALL_SESSION_ID",
	"WHALEHALL_RUNTIME_CHANNEL",
	"WHALEHALL_ALLOW_LEGACY_DEV_KEYCHAIN",
	"WHALEHALL_CI_DISPLAY_MODE",
	"WHALEHALL_CI_FOREGROUND_MODE",
	"WHALEHALL_CI_PRESENCE_MODE",
	"WHALEHALL_ACTIVITY_POLL_MS",
	"WHALEHALL_APPLICATION_POLL_MS",
	"WHALEHALL_INSTALLED_APPLICATION_REFRESH_MS",
	"WHALEHALL_PRESENCE_POLL_MS",
	"WHALEHALL_AFK_THRESHOLD_MS",
	"WHALEHALL_SUSPEND_GAP_THRESHOLD_MS",
	"WHALEHALL_INPUT_MONITORING_ENABLED",
	"WHALEHALL_BROWSER_PROFILE_ROOT",
	"WHALEHALL_BROWSER_EVENT_MONITORING_ENABLED",
	"WHALEHALL_BROWSER_CONTENT_MONITORING_ENABLED",
	"WHALEHALL_BROWSER_TAB_POLL_MS",
	"WHALEHALL_BROWSER_HISTORY_REFRESH_MS",
	"WHALEHALL_BROWSER_BRIDGE_MAX_AGE_MS",
	"WHALEHALL_ACCESSIBILITY_SNAPSHOT_PATH",
	"WHALEHALL_ACCESSIBILITY_MONITORING_ENABLED",
	"WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED",
	"WHALEHALL_ACCESSIBILITY_POLL_MS",
	"WHALEHALL_ACCESSIBILITY_BRIDGE_MAX_AGE_MS",
	"WHALEHALL_ACCESSIBILITY_MAX_NODES",
	"WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT",
	"WHALEHALL_ACCESSIBILITY_RETENTION_DAYS",
	"WHALEHALL_VSCODE_BRIDGE_DIRECTORY",
	"WHALEHALL_OBSERVER_HELPER_PATH",
	"WHALEHALL_OBSERVER_MONITORING_ENABLED",
	"WHALEHALL_OBSERVER_CAPTURE_CONTENT",
	"WHALEHALL_OBSERVER_EXCLUDED_BUNDLE_IDS",
] as const;

const LOCAL_TOOL_ENVIRONMENT_KEY_BY_NORMALIZED = new Map(
	LOCAL_TOOL_ENVIRONMENT_KEYS.map((key) => [key.toUpperCase(), key]),
);

const SENSITIVE_ENVIRONMENT_KEY =
	/(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL|BEARER)/i;

/**
 * Builds the complete environment for whalehall-local without inheriting the
 * Bun process wholesale. Explicit caller values pass through the same closed
 * allowlist as inherited values. The startup goal is a trusted one-shot value
 * supplied only from LocalToolClient state, never from either environment.
 */
export function createLocalToolProcessEnvironment(
	inheritedEnvironment: EnvironmentSource,
	explicitEnvironment: EnvironmentSource = {},
	startupGoalChangeJson?: string | null,
): Record<string, string> {
	const environment: Record<string, string> = {};
	copyAllowedEnvironment(inheritedEnvironment, environment);
	copyAllowedEnvironment(explicitEnvironment, environment);
	if (startupGoalChangeJson !== undefined && startupGoalChangeJson !== null) {
		environment[STARTUP_GOAL_CHANGE_ENV] = startupGoalChangeJson;
	}
	return environment;
}

function copyAllowedEnvironment(
	source: EnvironmentSource,
	destination: Record<string, string>,
): void {
	for (const [sourceKey, value] of Object.entries(source)) {
		if (
			typeof value !== "string" ||
			SENSITIVE_ENVIRONMENT_KEY.test(sourceKey)
		) {
			continue;
		}
		const allowedKey = LOCAL_TOOL_ENVIRONMENT_KEY_BY_NORMALIZED.get(
			sourceKey.toUpperCase(),
		);
		if (allowedKey) destination[allowedKey] = value;
	}
}

export interface LocalToolProcess {
	readonly pid: number | null;
	readonly isRunning: boolean;
	prepareStartupGoalChange(change: LocalEventGoalChange | null): Promise<void>;
	acknowledgeStartupGoalChange(): Promise<void>;
	start(): Promise<void>;
	health(): Promise<LocalRuntimeHealth>;
	listTools(): Promise<LocalToolDescriptor[]>;
	callTool(call: LocalToolCall): Promise<LocalToolCallResult>;
	cancelTool(callId: string): Promise<LocalToolCancelResult>;
	queryEvents(query: LocalEventQuery): Promise<LocalEventQueryResult>;
	getEventTailCursor(): Promise<LocalEventTailCursorResult>;
	commitEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult>;
	appendGoalChange(
		change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult>;
	getMonitoringStatus(): Promise<LocalMonitoringStatus>;
	configureMonitoring(
		configuration: LocalMonitoringConfigure,
	): Promise<LocalMonitoringStatus>;
	pauseMonitoring(): Promise<LocalMonitoringStatus>;
	resumeMonitoring(): Promise<LocalMonitoringStatus>;
	refreshMonitoringPermissions(): Promise<LocalMonitoringStatus>;
	setupMonitoringPermissions(): Promise<LocalMonitoringStatus>;
	querySemanticEvents(
		query: LocalSemanticQuery,
	): Promise<LocalSemanticQueryResult>;
	commitSemanticCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalSemanticCommitResult>;
	queryAuditFiveMinutes(
		query: LocalAuditFiveMinutesQuery,
	): Promise<LocalAuditFiveMinutesResult>;
	sealVaultBatch(
		batch: LocalVaultSealBatch,
	): Promise<LocalVaultSealBatchResult>;
	openVaultBatch(
		batch: LocalVaultOpenBatch,
	): Promise<LocalVaultOpenBatchResult>;
	deleteVaultBatch(
		batch: LocalVaultDeleteBatch,
	): Promise<LocalVaultDeleteBatchResult>;
	listVaultRecords?(
		query: LocalVaultListRecords,
	): Promise<LocalVaultListRecordsResult>;
	getVaultKeyStatus(): Promise<LocalVaultKeyStatus>;
	migrateLegacyVaultKey(): Promise<LocalVaultLegacyMigrationResult>;
	listPlanningPlans?(
		query?: LocalPlanningList,
	): Promise<LocalPlanningListResult>;
	getPlanningPlan?(planId: string): Promise<LocalPlanningPlanSnapshot | null>;
	getPlanningOperationResult?(
		operationId: string,
	): Promise<LocalPlanningPlanSnapshot | null>;
	upsertPlanningPlan?(
		mutation: LocalPlanningMutationParams,
	): Promise<LocalPlanningMutationResult>;
	mutatePlanningPlan?(
		mutation: LocalPlanningMutationParams & { expectedVersion: number },
	): Promise<LocalPlanningMutationResult>;
	listPlanningVaultReferences?(
		query?: LocalPlanningVaultReferences,
	): Promise<LocalPlanningVaultReferencesResult>;
	listPlanningCalendar?(
		query?: LocalPlanningCalendarList,
	): Promise<LocalPlanningCalendarListResult>;
	getPlanningCalendarEvent?(
		eventId: string,
	): Promise<LocalPlanningCalendarEvent | null>;
	mutatePlanningCalendar?(
		mutation: LocalPlanningCalendarMutate,
	): Promise<LocalPlanningCalendarMutationResult>;
	listPlanningOutbox?(
		query?: LocalPlanningOutboxList,
	): Promise<LocalPlanningOutboxListResult>;
	ackPlanningOutbox?(
		acknowledgement: LocalPlanningOutboxAck,
	): Promise<LocalPlanningOutboxAckResult>;
	stop(): Promise<void>;
	onEvent(listener: (event: LocalToolEvent) => void): () => void;
	onDesktopEvent(
		listener: (event: LocalDesktopEventFrame["data"]) => void,
	): () => void;
	onSemanticEvent(
		listener: (event: LocalSemanticEventFrame["data"]) => void,
	): () => void;
	onFailure(listener: (error: LocalClientError) => void): () => void;
}

type PendingRequest = {
	method: LocalMethod;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

function spawnLocal(
	binaryPath: string,
	environment: Readonly<Record<string, string>> = {},
): ChildTransport {
	const child = Bun.spawn({
		cmd: [binaryPath],
		env: environment,
		detached: true,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}) as unknown as ChildTransport;
	ownedProcessTrees.set(child, createOwnedProcessTree(child.pid));
	return child;
}

export class LocalToolClient implements LocalToolProcess {
	private child: ChildTransport | null = null;
	private childCleanup: {
		child: ChildTransport;
		promise: Promise<void>;
	} | null = null;
	private readonly failedChildren = new WeakSet<ChildTransport>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: LocalToolEvent) => void>();
	private readonly desktopEventListeners = new Set<
		(event: LocalDesktopEventFrame["data"]) => void
	>();
	private readonly semanticEventListeners = new Set<
		(event: LocalSemanticEventFrame["data"]) => void
	>();
	private readonly failureListeners = new Set<
		(error: LocalClientError) => void
	>();
	private stopping = false;
	private stopPromise: Promise<void> | null = null;
	private preparedStartupGoalChange: LocalEventGoalChange | null | undefined;
	private preparedStartupGoalChangeJson: string | null | undefined;

	constructor(
		private readonly binaryPath: string,
		private readonly options: {
			spawn?: SpawnLocalProcess;
			environment?: Readonly<Record<string, string>>;
			controlTimeoutMs?: number;
			toolTimeoutMs?: number;
			maxLineBytes?: number;
			shutdownSleep?: (durationMs: number) => Promise<void>;
		} = {},
	) {}

	get pid(): number | null {
		const child = this.child;
		return child !== null && !this.failedChildren.has(child) ? child.pid : null;
	}

	get isRunning(): boolean {
		const child = this.child;
		return child !== null && !this.failedChildren.has(child);
	}

	async prepareStartupGoalChange(
		change: LocalEventGoalChange | null,
	): Promise<void> {
		await this.settleFailedChildBeforeRestart();
		if (this.child) {
			throw new LocalClientError(
				"INVALID_STATE",
				"Cannot prepare a startup goal boundary after whalehall-local has started.",
			);
		}
		if (change === null) {
			this.preparedStartupGoalChange = null;
			this.preparedStartupGoalChangeJson = null;
			return;
		}
		if (
			this.preparedStartupGoalChange !== null &&
			this.preparedStartupGoalChange !== undefined &&
			this.preparedStartupGoalChange.deduplicationKey ===
				change.deduplicationKey
		) {
			if (
				!sameGoalContext(
					this.preparedStartupGoalChange.previous,
					change.previous,
				) ||
				!sameGoalContext(this.preparedStartupGoalChange.next, change.next)
			) {
				throw new LocalClientError(
					"INVALID_ARGUMENTS",
					"Startup goal deduplication key was reused for different goal contexts.",
				);
			}
			// A prior process may have appended this exact payload and crashed
			// before the reflection consumer materialized it. Preserve its
			// original occurredAtMs so native idempotency remains exact.
			return;
		}
		this.preparedStartupGoalChange = structuredClone(change);
		this.preparedStartupGoalChangeJson = JSON.stringify(change);
	}

	async acknowledgeStartupGoalChange(): Promise<void> {
		this.preparedStartupGoalChange = undefined;
		this.preparedStartupGoalChangeJson = undefined;
	}

	async start(): Promise<void> {
		await this.settleFailedChildBeforeRestart();
		if (this.child) return;
		this.stopping = false;
		const environment = createLocalToolProcessEnvironment(
			process.env,
			this.options.environment,
			this.preparedStartupGoalChangeJson,
		);
		let child: ChildTransport;
		try {
			child = (this.options.spawn ?? spawnLocal)(this.binaryPath, environment);
		} catch (error) {
			const clientError = new LocalClientError(
				"SPAWN_FAILED",
				`Unable to start whalehall-local: ${errorMessage(error)}`,
			);
			this.emitFailure(clientError);
			throw clientError;
		}
		this.child = child;
		void this.readStdout(child);
		void this.readStderr(child);
		void child.exited.then((exitCode) => this.handleExit(child, exitCode));
	}

	async health(): Promise<LocalRuntimeHealth> {
		const result = await this.request<unknown>("runtime.health", {});
		if (
			!isRecord(result) ||
			result.service !== "whalehall-local" ||
			typeof result.version !== "string" ||
			typeof result.pid !== "number" ||
			result.status !== "ok"
		) {
			throw this.protocolFailure("runtime.health returned an invalid payload.");
		}
		return result as LocalRuntimeHealth;
	}

	async listTools(): Promise<LocalToolDescriptor[]> {
		const result = await this.request<LocalToolListResult>("tool.list", {});
		if (
			!isRecord(result) ||
			!Array.isArray(result.tools) ||
			!result.tools.every(isLocalToolDescriptor)
		) {
			throw this.protocolFailure("tool.list returned an invalid tool catalog.");
		}
		return result.tools;
	}

	async callTool(call: LocalToolCall): Promise<LocalToolCallResult> {
		const result = await this.request<unknown>(
			"tool.call",
			{ name: call.name, arguments: call.arguments },
			call.callId,
			this.options.toolTimeoutMs ?? LOCAL_TOOL_TIMEOUT_MS,
		);
		if (
			!isRecord(result) ||
			result.callId !== call.callId ||
			!("output" in result)
		) {
			throw this.protocolFailure("tool.call returned an invalid result.");
		}
		return result as LocalToolCallResult;
	}

	async cancelTool(callId: string): Promise<LocalToolCancelResult> {
		const result = await this.request<unknown>("tool.cancel", { callId });
		if (
			!isRecord(result) ||
			result.callId !== callId ||
			typeof result.cancelled !== "boolean"
		) {
			throw this.protocolFailure("tool.cancel returned an invalid result.");
		}
		return result as LocalToolCancelResult;
	}

	async queryEvents(query: LocalEventQuery): Promise<LocalEventQueryResult> {
		if (query.afterCursor !== undefined && query.consumerId !== undefined) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"event.query accepts afterCursor or consumerId, not both.",
			);
		}
		const result = await this.request<unknown>("event.query", query);
		if (
			!isRecord(result) ||
			!Array.isArray(result.events) ||
			!result.events.every(isDesktopEvent) ||
			(result.nextCursor !== null && typeof result.nextCursor !== "string") ||
			typeof result.hasMore !== "boolean"
		) {
			throw this.protocolFailure("event.query returned an invalid result.");
		}
		return result as LocalEventQueryResult;
	}

	async getEventTailCursor(): Promise<LocalEventTailCursorResult> {
		const result = await this.request<unknown>("event.tailCursor", {});
		if (
			!isRecord(result) ||
			Object.keys(result).length !== 1 ||
			!isDesktopEventCursor(result.cursor)
		) {
			throw this.protocolFailure(
				"event.tailCursor returned an invalid result.",
			);
		}
		return result as LocalEventTailCursorResult;
	}

	async commitEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult> {
		const result = await this.request<unknown>("event.commit", {
			consumerId,
			cursor,
		});
		if (
			!isRecord(result) ||
			result.consumerId !== consumerId ||
			result.cursor !== cursor ||
			typeof result.advanced !== "boolean"
		) {
			throw this.protocolFailure("event.commit returned an invalid result.");
		}
		return result as LocalEventCommitResult;
	}

	async appendGoalChange(
		change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult> {
		const result = await this.request<unknown>("event.goal.change", change);
		if (
			!isRecord(result) ||
			typeof result.inserted !== "boolean" ||
			!isDesktopEvent(result.event) ||
			result.event.kind !== "goal.contextChanged" ||
			result.event.source !== "planning.controller" ||
			result.event.occurredAtMs !== change.occurredAtMs ||
			result.event.observedAtMs !== change.occurredAtMs ||
			result.event.goalVersion !== (change.previous?.version ?? null) ||
			result.event.sensitivity !== "content" ||
			!sameGoalContext(result.event.payload.previous, change.previous) ||
			!sameGoalContext(result.event.payload.next, change.next)
		) {
			throw this.protocolFailure(
				"event.goal.change returned an invalid result.",
			);
		}
		return result as LocalEventGoalChangeResult;
	}

	async getMonitoringStatus(): Promise<LocalMonitoringStatus> {
		return this.requestMonitoringStatus("monitoring.status", {});
	}

	async configureMonitoring(
		configuration: LocalMonitoringConfigure,
	): Promise<LocalMonitoringStatus> {
		if (!isLocalMonitoringConfigure(configuration)) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"monitoring.configure received invalid parameters.",
			);
		}
		return this.requestMonitoringStatus("monitoring.configure", configuration);
	}

	async pauseMonitoring(): Promise<LocalMonitoringStatus> {
		return this.requestMonitoringStatus("monitoring.pause", {});
	}

	async resumeMonitoring(): Promise<LocalMonitoringStatus> {
		return this.requestMonitoringStatus("monitoring.resume", {});
	}

	async refreshMonitoringPermissions(): Promise<LocalMonitoringStatus> {
		return this.requestMonitoringStatus(
			"monitoring.refreshPermissions",
			{},
			LOCAL_PERMISSION_REFRESH_TIMEOUT_MS,
		);
	}

	async setupMonitoringPermissions(): Promise<LocalMonitoringStatus> {
		return this.requestMonitoringStatus(
			"monitoring.setupPermissions",
			{},
			LOCAL_PERMISSION_REFRESH_TIMEOUT_MS,
		);
	}

	async querySemanticEvents(
		query: LocalSemanticQuery,
	): Promise<LocalSemanticQueryResult> {
		if (query.afterCursor !== undefined && query.consumerId !== undefined) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"semantic.query accepts afterCursor or consumerId, not both.",
			);
		}
		if (
			(query.afterCursor !== undefined &&
				!isSemanticCursorV2(query.afterCursor)) ||
			(query.consumerId !== undefined &&
				!isSemanticConsumerId(query.consumerId)) ||
			(query.limit !== undefined &&
				(!Number.isInteger(query.limit) ||
					query.limit < 1 ||
					query.limit > 1_000)) ||
			(query.includeContent !== undefined &&
				typeof query.includeContent !== "boolean")
		) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"semantic.query received invalid parameters.",
			);
		}
		const result = await this.request<unknown>("semantic.query", query);
		if (
			!isRecord(result) ||
			!Array.isArray(result.events) ||
			!result.events.every(isSemanticEventV2) ||
			(result.nextCursor !== null && !isSemanticCursorV2(result.nextCursor)) ||
			typeof result.hasMore !== "boolean" ||
			(result.events.length > 0 &&
				result.nextCursor !== result.events.at(-1)?.cursor)
		) {
			throw this.protocolFailure("semantic.query returned an invalid result.");
		}
		return result as LocalSemanticQueryResult;
	}

	async commitSemanticCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalSemanticCommitResult> {
		if (!isSemanticConsumerId(consumerId) || !isSemanticCursorV2(cursor)) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"semantic.commit received an invalid consumer or cursor.",
			);
		}
		const result = await this.request<unknown>("semantic.commit", {
			consumerId,
			cursor,
		});
		if (
			!isRecord(result) ||
			result.consumerId !== consumerId ||
			result.cursor !== cursor ||
			typeof result.advanced !== "boolean"
		) {
			throw this.protocolFailure("semantic.commit returned an invalid result.");
		}
		return result as LocalSemanticCommitResult;
	}

	async queryAuditFiveMinutes(
		query: LocalAuditFiveMinutesQuery,
	): Promise<LocalAuditFiveMinutesResult> {
		if (
			!Number.isSafeInteger(query.fromMs) ||
			query.fromMs < 0 ||
			!Number.isSafeInteger(query.toMs) ||
			query.toMs - query.fromMs !== 300_000 ||
			(query.includeDecryptedContent !== undefined &&
				typeof query.includeDecryptedContent !== "boolean")
		) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"audit.queryFiveMinutes requires one exact non-negative five-minute range.",
			);
		}
		const result = await this.request<unknown>("audit.queryFiveMinutes", query);
		if (!isLocalAuditFiveMinutesResult(result, query)) {
			throw this.protocolFailure(
				"audit.queryFiveMinutes returned an invalid result.",
			);
		}
		return result;
	}

	async sealVaultBatch(
		batch: LocalVaultSealBatch,
	): Promise<LocalVaultSealBatchResult> {
		if (batch.records.length < 1 || batch.records.length > 64) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"vault.sealBatch requires 1 to 64 records.",
			);
		}
		const result = await this.request<unknown>("vault.sealBatch", batch);
		if (
			!isRecord(result) ||
			!Array.isArray(result.records) ||
			result.records.length !== batch.records.length ||
			!result.records.every(isLocalVaultSealResultRecord) ||
			!result.records.every(
				(record, index) => record.recordId === batch.records[index]?.recordId,
			)
		) {
			throw this.protocolFailure("vault.sealBatch returned an invalid result.");
		}
		return result as LocalVaultSealBatchResult;
	}

	async openVaultBatch(
		batch: LocalVaultOpenBatch,
	): Promise<LocalVaultOpenBatchResult> {
		if (batch.contentRefs.length < 1 || batch.contentRefs.length > 64) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"vault.openBatch requires 1 to 64 content references.",
			);
		}
		const result = await this.request<unknown>("vault.openBatch", batch);
		if (
			!isRecord(result) ||
			!Array.isArray(result.records) ||
			result.records.length !== batch.contentRefs.length ||
			!result.records.every(isLocalVaultOpenResultRecord) ||
			!result.records.every(
				(record, index) => record.contentRef === batch.contentRefs[index],
			)
		) {
			throw this.protocolFailure("vault.openBatch returned an invalid result.");
		}
		return result as LocalVaultOpenBatchResult;
	}

	async deleteVaultBatch(
		batch: LocalVaultDeleteBatch,
	): Promise<LocalVaultDeleteBatchResult> {
		if (batch.recordIds.length < 1 || batch.recordIds.length > 64) {
			throw new LocalClientError(
				"INVALID_ARGUMENTS",
				"vault.deleteBatch requires 1 to 64 record IDs.",
			);
		}
		const result = await this.request<unknown>("vault.deleteBatch", batch);
		if (
			!isRecord(result) ||
			!Array.isArray(result.records) ||
			result.records.length !== batch.recordIds.length ||
			!result.records.every(isLocalVaultDeleteResultRecord) ||
			!result.records.every(
				(record, index) => record.recordId === batch.recordIds[index],
			)
		) {
			throw this.protocolFailure(
				"vault.deleteBatch returned an invalid result.",
			);
		}
		return result as LocalVaultDeleteBatchResult;
	}

	async listVaultRecords(
		query: LocalVaultListRecords,
	): Promise<LocalVaultListRecordsResult> {
		const result = await this.request<unknown>("vault.listRecords", {
			...query,
		});
		if (!isLocalVaultListRecordsResult(result, query.limit ?? 100)) {
			throw this.protocolFailure(
				"vault.listRecords returned an invalid result.",
			);
		}
		return result;
	}

	async getVaultKeyStatus(): Promise<LocalVaultKeyStatus> {
		const result = await this.request<unknown>("vault.status", {});
		if (!isLocalVaultKeyStatus(result)) {
			throw this.protocolFailure("vault.status returned an invalid result.");
		}
		return result;
	}

	async migrateLegacyVaultKey(): Promise<LocalVaultLegacyMigrationResult> {
		const result = await this.request<unknown>(
			"vault.migrateLegacyKey",
			{ confirm: true },
			crypto.randomUUID(),
			LOCAL_KEY_MIGRATION_TIMEOUT_MS,
		);
		if (!isLocalVaultLegacyMigrationResult(result)) {
			throw this.protocolFailure(
				"vault.migrateLegacyKey returned an invalid result.",
			);
		}
		return result as LocalVaultLegacyMigrationResult;
	}

	async listPlanningPlans(
		query: LocalPlanningList = {},
	): Promise<LocalPlanningListResult> {
		const result = await this.request<unknown>("planning.list", { ...query });
		if (
			!isExactLocalRecord(result, ["plans"]) ||
			!Array.isArray(result.plans) ||
			result.plans.length > (query.limit ?? 100) ||
			!result.plans.every(isLocalPlanningPlanSnapshot)
		) {
			throw this.protocolFailure("planning.list returned an invalid result.");
		}
		return result as LocalPlanningListResult;
	}

	async getPlanningPlan(
		planId: string,
	): Promise<LocalPlanningPlanSnapshot | null> {
		const result = await this.request<unknown>("planning.get", { planId });
		if (
			!isExactLocalRecord(result, ["plan"]) ||
			!(result.plan === null || isLocalPlanningPlanSnapshot(result.plan))
		) {
			throw this.protocolFailure("planning.get returned an invalid result.");
		}
		return result.plan as LocalPlanningPlanSnapshot | null;
	}

	async getPlanningOperationResult(
		operationId: string,
	): Promise<LocalPlanningPlanSnapshot | null> {
		const result = await this.request<unknown>("planning.operation.get", {
			operationId,
		});
		if (!isValidLocalPlanningOperationGetResult(result, operationId)) {
			throw this.protocolFailure(
				"planning.operation.get returned an invalid result.",
			);
		}
		return result.plan;
	}

	async upsertPlanningPlan(
		mutation: LocalPlanningMutationParams,
	): Promise<LocalPlanningMutationResult> {
		const result = await this.request<unknown>("planning.upsert", {
			...mutation,
		});
		return this.parsePlanningMutationResult(
			result,
			"planning.upsert",
			mutation.plan,
		);
	}

	async mutatePlanningPlan(
		mutation: LocalPlanningMutationParams & { expectedVersion: number },
	): Promise<LocalPlanningMutationResult> {
		const result = await this.request<unknown>("planning.mutate", {
			...mutation,
		});
		return this.parsePlanningMutationResult(
			result,
			"planning.mutate",
			mutation.plan,
		);
	}

	async listPlanningVaultReferences(
		query: LocalPlanningVaultReferences = {},
	): Promise<LocalPlanningVaultReferencesResult> {
		const result = await this.request<unknown>("planning.vaultReferences", {
			...query,
		});
		if (!isLocalPlanningVaultReferencesResult(result, query.limit ?? 100)) {
			throw this.protocolFailure(
				"planning.vaultReferences returned an invalid result.",
			);
		}
		return result;
	}

	async listPlanningCalendar(
		query: LocalPlanningCalendarList = {},
	): Promise<LocalPlanningCalendarListResult> {
		const result = await this.request<unknown>("calendar.list", { ...query });
		if (
			!isExactLocalRecord(result, ["events"]) ||
			!Array.isArray(result.events) ||
			!result.events.every(isLocalPlanningCalendarEvent)
		) {
			throw this.protocolFailure("calendar.list returned an invalid result.");
		}
		return result as LocalPlanningCalendarListResult;
	}

	async getPlanningCalendarEvent(
		eventId: string,
	): Promise<LocalPlanningCalendarEvent | null> {
		const result = await this.request<unknown>("calendar.get", { eventId });
		if (
			!isExactLocalRecord(result, ["event"]) ||
			!(result.event === null || isLocalPlanningCalendarEvent(result.event))
		) {
			throw this.protocolFailure("calendar.get returned an invalid result.");
		}
		return result.event as LocalPlanningCalendarEvent | null;
	}

	async mutatePlanningCalendar(
		mutation: LocalPlanningCalendarMutate,
	): Promise<LocalPlanningCalendarMutationResult> {
		const result = await this.request<unknown>("calendar.mutate", {
			...mutation,
		});
		if (
			!isExactLocalRecord(result, ["outcomes", "outbox"]) ||
			!Array.isArray(result.outcomes) ||
			result.outcomes.length !== mutation.mutations.length ||
			!result.outcomes.every((outcome, index) => {
				const requested = mutation.mutations[index];
				if (!requested || !isExactLocalRecord(outcome, ["eventId", "event"])) {
					return false;
				}
				const expectedId =
					requested.action === "delete"
						? requested.eventId
						: requested.event.eventId;
				return (
					outcome.eventId === expectedId &&
					(requested.action === "delete"
						? outcome.event === null
						: isLocalPlanningCalendarEvent(outcome.event) &&
							outcome.event.eventId === expectedId)
				);
			}) ||
			!Array.isArray(result.outbox) ||
			!result.outbox.every(isLocalPlanningOutboxEntry)
		) {
			throw this.protocolFailure("calendar.mutate returned an invalid result.");
		}
		return result as LocalPlanningCalendarMutationResult;
	}

	async listPlanningOutbox(
		query: LocalPlanningOutboxList = {},
	): Promise<LocalPlanningOutboxListResult> {
		const result = await this.request<unknown>("planning.outbox.list", {
			...query,
		});
		if (
			!isExactLocalRecord(result, ["entries"]) ||
			!Array.isArray(result.entries) ||
			result.entries.length > (query.limit ?? 100) ||
			!result.entries.every(isLocalPlanningOutboxEntry)
		) {
			throw this.protocolFailure(
				"planning.outbox.list returned an invalid result.",
			);
		}
		return result as LocalPlanningOutboxListResult;
	}

	async ackPlanningOutbox(
		acknowledgement: LocalPlanningOutboxAck,
	): Promise<LocalPlanningOutboxAckResult> {
		const result = await this.request<unknown>("planning.outbox.ack", {
			...acknowledgement,
		});
		if (
			!isExactLocalRecord(result, ["entries"]) ||
			!Array.isArray(result.entries) ||
			result.entries.length !== acknowledgement.entryIds.length ||
			!result.entries.every(
				(entry, index) =>
					isLocalPlanningOutboxEntry(entry) &&
					entry.entryId === acknowledgement.entryIds[index] &&
					entry.status === "delivered" &&
					entry.deliveredAtMs === acknowledgement.deliveredAtMs,
			)
		) {
			throw this.protocolFailure(
				"planning.outbox.ack returned an invalid result.",
			);
		}
		return result as LocalPlanningOutboxAckResult;
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const operation = this.stopOwnedChild();
		this.stopPromise = operation;
		void operation.then(
			() => {
				if (this.stopPromise === operation) this.stopPromise = null;
			},
			() => {
				if (this.stopPromise === operation) this.stopPromise = null;
			},
		);
		return operation;
	}

	private async stopOwnedChild(): Promise<void> {
		this.stopping = true;
		const child = this.child;
		this.rejectPending(
			new LocalClientError("STOPPED", "whalehall-local was stopped."),
		);
		if (!child) return;
		if (this.childCleanup?.child === child) {
			await this.childCleanup.promise;
			if (this.child === child) this.child = null;
			return;
		}
		const outcome = await closeGracefully(
			child,
			this.options.shutdownSleep ?? ((durationMs) => Bun.sleep(durationMs)),
		);
		if (this.child === child) this.child = null;
		if (outcome === "forced") {
			console.warn(
				"[whalehall-local] graceful tree shutdown was incomplete; forced process-tree exit was confirmed.",
			);
		}
	}

	onEvent(listener: (event: LocalToolEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onDesktopEvent(
		listener: (event: LocalDesktopEventFrame["data"]) => void,
	): () => void {
		this.desktopEventListeners.add(listener);
		return () => this.desktopEventListeners.delete(listener);
	}

	onSemanticEvent(
		listener: (event: LocalSemanticEventFrame["data"]) => void,
	): () => void {
		this.semanticEventListeners.add(listener);
		return () => this.semanticEventListeners.delete(listener);
	}

	onFailure(listener: (error: LocalClientError) => void): () => void {
		this.failureListeners.add(listener);
		return () => this.failureListeners.delete(listener);
	}

	private request<T>(
		method: LocalMethod,
		params: Record<string, unknown>,
		id: string = crypto.randomUUID(),
		timeoutMs = this.options.controlTimeoutMs ?? LOCAL_CONTROL_TIMEOUT_MS,
	): Promise<T> {
		const child = this.child;
		if (!child) {
			return Promise.reject(
				new LocalClientError("SPAWN_FAILED", "whalehall-local is not running."),
			);
		}
		if (this.failedChildren.has(child)) {
			return Promise.reject(
				new LocalClientError(
					"PROCESS_EXITED",
					"whalehall-local is still completing failed process-tree cleanup.",
				),
			);
		}
		if (this.pending.has(id)) {
			return Promise.reject(
				new LocalClientError(
					"PROTOCOL_ERROR",
					`Duplicate local request id: ${id}`,
				),
			);
		}

		const request: LocalRequest = { id, method, params };
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				const error = new LocalClientError(
					"REQUEST_TIMEOUT",
					`Local request '${method}' timed out after ${timeoutMs} ms.`,
				);
				if (method === "tool.call") this.writeBestEffortCancel(child, id);
				this.emitFailure(error);
				reject(error);
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout,
			});

			try {
				child.stdin.write(`${JSON.stringify(request)}\n`);
				void child.stdin.flush();
			} catch (error) {
				clearTimeout(timeout);
				this.pending.delete(id);
				const clientError = new LocalClientError(
					"WRITE_FAILED",
					`Failed writing to whalehall-local: ${errorMessage(error)}`,
				);
				reject(clientError);
				this.failChild(child, clientError);
			}
		});
	}

	private parsePlanningMutationResult(
		result: unknown,
		method: "planning.upsert" | "planning.mutate",
		expectedPlan: LocalPlanningPlanSnapshot,
	): LocalPlanningMutationResult {
		if (
			!isExactLocalRecord(result, ["plan", "calendarEvents", "outbox"]) ||
			!isLocalPlanningPlanSnapshot(result.plan) ||
			result.plan.planId !== expectedPlan.planId ||
			result.plan.version !== expectedPlan.version ||
			!Array.isArray(result.calendarEvents) ||
			!result.calendarEvents.every(isLocalPlanningCalendarEvent) ||
			!Array.isArray(result.outbox) ||
			!result.outbox.every(isLocalPlanningOutboxEntry)
		) {
			throw this.protocolFailure(`${method} returned an invalid result.`);
		}
		return result as LocalPlanningMutationResult;
	}

	private async requestMonitoringStatus(
		method:
			| "monitoring.status"
			| "monitoring.configure"
			| "monitoring.pause"
			| "monitoring.resume"
			| "monitoring.refreshPermissions"
			| "monitoring.setupPermissions",
		params: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<LocalMonitoringStatus> {
		const result = await this.request<unknown>(
			method,
			params,
			crypto.randomUUID(),
			timeoutMs,
		);
		if (!isLocalMonitoringStatus(result)) {
			throw this.protocolFailure(
				`${method} returned an invalid monitoring status.`,
			);
		}
		return result;
	}

	private async readStdout(child: ChildTransport): Promise<void> {
		const parser = new JsonlParser(
			(line) => this.handleLine(child, line),
			this.options.maxLineBytes ?? MAX_JSONL_LINE_BYTES,
		);
		const reader = child.stdout.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				parser.feed(value);
			}
			parser.finish();
		} catch (error) {
			this.failChild(
				child,
				new LocalClientError(
					"PROTOCOL_ERROR",
					`whalehall-local stdout protocol failed: ${errorMessage(error)}`,
				),
			);
		} finally {
			reader.releaseLock();
		}
	}

	private async readStderr(child: ChildTransport): Promise<void> {
		const reader = child.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true }).trimEnd();
				if (text) console.error(`[whalehall-local:${child.pid}] ${text}`);
			}
		} catch (error) {
			console.error("Failed reading whalehall-local stderr:", error);
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(child: ChildTransport, line: string): void {
		if (child !== this.child) return;
		const message = parseLocalMessage(line);
		if (isDesktopEventFrame(message)) {
			for (const listener of this.desktopEventListeners) listener(message.data);
			return;
		}
		if (isSemanticEventFrame(message)) {
			for (const listener of this.semanticEventListeners) {
				listener(message.data);
			}
			return;
		}
		if (isToolEvent(message)) {
			for (const listener of this.eventListeners) listener(message);
			return;
		}
		if (message.id === null) {
			if (message.ok)
				throw new Error("Successful local response had no request id.");
			throw new Error(`${message.error.code}: ${message.error.message}`);
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pending.delete(message.id);
		if (message.ok) pending.resolve(message.result);
		else {
			pending.reject(
				new LocalClientError(
					message.error.code,
					message.error.message,
					message.error.details ?? null,
				),
			);
		}
	}

	private handleExit(child: ChildTransport, exitCode: number): void {
		if (child !== this.child) return;
		if (this.stopping) {
			if (this.stopPromise === null) {
				this.beginFailedChildCleanup(child, exitCode);
			}
			return;
		}
		if (!this.failedChildren.has(child)) {
			this.failedChildren.add(child);
			const error = new LocalClientError(
				"PROCESS_EXITED",
				`whalehall-local exited unexpectedly with code ${exitCode}.`,
			);
			this.rejectPending(error);
			this.beginFailedChildCleanup(child, exitCode);
			this.emitFailure(error);
			return;
		}
		this.beginFailedChildCleanup(child, exitCode);
	}

	private protocolFailure(message: string): LocalClientError {
		const error = new LocalClientError("PROTOCOL_ERROR", message);
		const child = this.child;
		if (child) this.failChild(child, error);
		return error;
	}

	private failChild(child: ChildTransport, error: LocalClientError): void {
		if (child !== this.child) return;
		this.failedChildren.add(child);
		this.rejectPending(error);
		this.beginFailedChildCleanup(child);
		this.emitFailure(error);
	}

	private async settleFailedChildBeforeRestart(): Promise<void> {
		const child = this.child;
		if (child === null || !this.failedChildren.has(child)) return;
		if (this.childCleanup?.child !== child) {
			this.beginFailedChildCleanup(child);
		}
		const cleanup = this.childCleanup;
		if (cleanup?.child !== child) {
			throw new LocalClientError(
				"STOP_FAILED",
				"The failed whalehall-local process tree still has an unresolved owner.",
			);
		}
		await cleanup.promise;
		if (this.child === child) this.child = null;
	}

	private beginFailedChildCleanup(
		child: ChildTransport,
		leaderExitCode: number | null = null,
	): void {
		if (this.childCleanup?.child === child) return;
		const operation = forceCloseFailedProcessTree(
			child,
			leaderExitCode,
			this.options.shutdownSleep ?? ((durationMs) => Bun.sleep(durationMs)),
		);
		this.childCleanup = { child, promise: operation };
		void operation.then(
			() => {
				if (this.child === child) this.child = null;
				if (this.childCleanup?.promise === operation) {
					this.childCleanup = null;
				}
			},
			(error) => {
				if (this.childCleanup?.promise === operation) {
					this.childCleanup = null;
				}
				this.emitFailure(
					new LocalClientError(
						"STOP_FAILED",
						`Unable to confirm failed whalehall-local process-tree cleanup: ${
							error instanceof Error ? error.name : "UNKNOWN"
						}`,
					),
				);
			},
		);
	}

	private rejectPending(error: LocalClientError): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private emitFailure(error: LocalClientError): void {
		for (const listener of this.failureListeners) listener(error);
	}

	private writeBestEffortCancel(child: ChildTransport, callId: string): void {
		if (child !== this.child) return;
		const request: LocalRequest = {
			id: crypto.randomUUID(),
			method: "tool.cancel",
			params: { callId },
		};
		try {
			child.stdin.write(`${JSON.stringify(request)}\n`);
			void child.stdin.flush();
		} catch {}
	}
}

function isSemanticConsumerId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/u.test(value);
}

function isDesktopEventCursor(value: unknown): value is string {
	return typeof value === "string" && /^ec1_[0-7][0-9a-f]{15}$/u.test(value);
}

function sameGoalContext(
	left: unknown,
	right: LocalEventGoalChange["previous"],
): boolean {
	if (left === null || right === null) return left === right;
	if (!isRecord(left)) return false;
	return (
		left.goalId === right.goalId &&
		left.planId === right.planId &&
		left.version === right.version &&
		left.text === right.text &&
		left.activatedAtMs === right.activatedAtMs
	);
}

function isValidLocalPlanningOperationGetResult(
	value: unknown,
	operationId: string,
): value is LocalPlanningOperationGetResult {
	if (
		!isExactLocalRecord(value, ["operationId", "method", "plan", "result"]) ||
		value.operationId !== operationId ||
		!(
			value.method === null ||
			value.method === "planning.upsert" ||
			value.method === "planning.mutate" ||
			value.method === "calendar.mutate" ||
			value.method === "planning.outbox.ack"
		) ||
		!(value.plan === null || isLocalPlanningPlanSnapshot(value.plan)) ||
		!(value.result === null || isRecord(value.result))
	) {
		return false;
	}
	if (value.method === null) {
		return value.plan === null && value.result === null;
	}
	if (value.result === null) return false;
	if (
		value.method === "planning.upsert" ||
		value.method === "planning.mutate"
	) {
		return (
			value.plan !== null &&
			isLocalPlanningPlanSnapshot(value.result.plan) &&
			value.result.plan.planId === value.plan.planId &&
			value.result.plan.version === value.plan.version
		);
	}
	return value.plan === null;
}

function isLocalVaultListRecordsResult(
	value: unknown,
	pageLimit: number,
): value is LocalVaultListRecordsResult {
	return (
		isExactLocalRecord(value, ["records", "nextCursor"]) &&
		Array.isArray(value.records) &&
		value.records.length <= pageLimit &&
		value.records.every(
			(record) =>
				isExactLocalRecord(record, [
					"recordId",
					"schemaVersion",
					"contentRef",
					"createdAtMs",
					"expiresAtMs",
				]) &&
				localProtocolIdentifier(record.recordId, 256) &&
				localProtocolIdentifier(record.schemaVersion, 160) &&
				localProtocolIdentifier(record.contentRef, 512) &&
				nonNegativeLocalInteger(record.createdAtMs) &&
				(record.expiresAtMs === null ||
					(nonNegativeLocalInteger(record.expiresAtMs) &&
						record.expiresAtMs >= record.createdAtMs)),
		) &&
		(value.nextCursor === null || boundedLocalString(value.nextCursor, 1_024))
	);
}

function isLocalPlanningVaultReferencesResult(
	value: unknown,
	pageLimit: number,
): value is LocalPlanningVaultReferencesResult {
	return (
		isExactLocalRecord(value, ["references", "nextCursor"]) &&
		Array.isArray(value.references) &&
		value.references.length <= pageLimit &&
		value.references.every(
			(reference) =>
				isExactLocalRecord(reference, [
					"source",
					"planId",
					"version",
					"sealedContentRef",
					"manifestRecordId",
				]) &&
				(reference.source === "current" ||
					reference.source === "history" ||
					reference.source === "operation") &&
				localProtocolIdentifier(reference.planId, 256) &&
				Number.isSafeInteger(reference.version) &&
				Number(reference.version) > 0 &&
				localProtocolIdentifier(reference.sealedContentRef, 512) &&
				(reference.manifestRecordId === null ||
					localProtocolIdentifier(reference.manifestRecordId, 256)),
		) &&
		(value.nextCursor === null || boundedLocalString(value.nextCursor, 1_024))
	);
}

function isExactLocalRecord(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function boundedLocalString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		!value.includes("\u0000")
	);
}

function localProtocolIdentifier(
	value: unknown,
	maximum: number,
): value is string {
	return (
		boundedLocalString(value, maximum) && /^[A-Za-z0-9._:@/-]+$/u.test(value)
	);
}

function nonNegativeLocalInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

async function closeGracefully(
	child: ChildTransport,
	shutdownSleep: (durationMs: number) => Promise<void>,
): Promise<"graceful" | "forced"> {
	const ownedTree = ownedProcessTrees.get(child);
	try {
		void child.stdin.end();
	} catch {}
	const leaderExitCode = await Promise.race([
		child.exited,
		shutdownSleep(LOCAL_GRACEFUL_SHUTDOWN_TIMEOUT_MS).then(() => null),
	]);
	const leaderExited = leaderExitCode !== null;
	if (
		leaderExited &&
		(ownedTree === undefined ||
			ownedTree.leaderExitCompletesTree(leaderExitCode) ||
			ownedTree.isExited())
	) {
		return "graceful";
	}
	try {
		if (ownedTree) await ownedTree.forceKill();
		else child.kill("SIGKILL");
	} catch (error) {
		const exitedAfterKillFailure = await confirmForcedTreeExit(
			child,
			ownedTree,
			leaderExitCode,
			shutdownSleep,
		);
		if (exitedAfterKillFailure) return "forced";
		throw new LocalClientError(
			"STOP_FAILED",
			`Unable to terminate the whalehall-local process tree after graceful shutdown timed out: ${
				error instanceof Error ? error.name : "UNKNOWN"
			}`,
		);
	}
	const exitedAfterKill = await confirmForcedTreeExit(
		child,
		ownedTree,
		leaderExitCode,
		shutdownSleep,
	);
	if (!exitedAfterKill) {
		throw new LocalClientError(
			"STOP_FAILED",
			"The whalehall-local process tree did not exit after forced termination.",
		);
	}
	return "forced";
}

async function forceCloseFailedProcessTree(
	child: ChildTransport,
	leaderExitCode: number | null,
	shutdownSleep: (durationMs: number) => Promise<void>,
): Promise<void> {
	const ownedTree = ownedProcessTrees.get(child);
	if (
		leaderExitCode !== null &&
		(ownedTree === undefined ||
			ownedTree.leaderExitCompletesTree(leaderExitCode) ||
			ownedTree.isExited())
	) {
		return;
	}
	try {
		if (ownedTree) await ownedTree.forceKill();
		else child.kill("SIGKILL");
	} catch (error) {
		if (
			await confirmForcedTreeExit(
				child,
				ownedTree,
				leaderExitCode,
				shutdownSleep,
			)
		) {
			return;
		}
		throw error;
	}
	if (
		!(await confirmForcedTreeExit(
			child,
			ownedTree,
			leaderExitCode,
			shutdownSleep,
		))
	) {
		throw new LocalClientError(
			"STOP_FAILED",
			"The failed whalehall-local process tree did not exit after forced termination.",
		);
	}
}

async function confirmForcedTreeExit(
	child: ChildTransport,
	ownedTree: OwnedProcessTree | undefined,
	knownLeaderExitCode: number | null,
	shutdownSleep: (durationMs: number) => Promise<void>,
): Promise<boolean> {
	const [leaderExitCode, treeExited] = await Promise.all([
		knownLeaderExitCode !== null
			? knownLeaderExitCode
			: Promise.race([
					child.exited,
					shutdownSleep(LOCAL_POST_KILL_EXIT_TIMEOUT_MS).then(() => null),
				]),
		ownedTree
			? waitForOwnedProcessTreeExit(ownedTree, LOCAL_POST_KILL_EXIT_TIMEOUT_MS)
			: true,
	]);
	return (
		leaderExitCode !== null &&
		(treeExited ||
			ownedTree === undefined ||
			ownedTree.leaderExitCompletesTree(leaderExitCode))
	);
}

function createOwnedProcessTree(processId: number): OwnedProcessTree {
	if (!Number.isSafeInteger(processId) || processId <= 0) {
		throw new Error("whalehall-local returned an invalid process identifier.");
	}
	return process.platform === "win32"
		? createWindowsProcessTree(processId)
		: createPosixProcessTree(processId);
}

function createPosixProcessTree(processGroupId: number): OwnedProcessTree {
	return {
		leaderExitCompletesTree: () => false,
		async forceKill() {
			try {
				process.kill(-processGroupId, "SIGKILL");
			} catch (error) {
				if (!isNoSuchProcess(error)) throw error;
			}
		},
		isExited() {
			try {
				process.kill(-processGroupId, 0);
				return false;
			} catch (error) {
				if (isNoSuchProcess(error)) return true;
				// Darwin can transiently report EPERM while killed group members
				// are being reaped. It is not proof of absence, so keep polling.
				if (isPermissionDenied(error)) return false;
				throw error;
			}
		},
	};
}

function createWindowsProcessTree(processId: number): OwnedProcessTree {
	let taskkillConfirmed = false;
	let forceKillPromise: Promise<void> | null = null;
	return {
		// The packaged Windows host installs its own KILL_ON_JOB_CLOSE Job before
		// any business child can spawn. When the leader exits for any reason,
		// Windows closes that process-owned handle and terminates every registered
		// descendant. taskkill remains the live-leader fallback below.
		leaderExitCompletesTree: () => true,
		forceKill() {
			if (forceKillPromise !== null) return forceKillPromise;
			const operation = (async () => {
				const taskkill = Bun.spawn({
					cmd: [WINDOWS_TASKKILL_PATH, "/PID", String(processId), "/T", "/F"],
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					windowsHide: true,
				});
				const exitCode = await Promise.race([
					taskkill.exited,
					Bun.sleep(LOCAL_POST_KILL_EXIT_TIMEOUT_MS).then(() => null),
				]);
				if (exitCode === null) {
					try {
						taskkill.kill("SIGKILL");
					} finally {
						// Never abandon the trusted termination helper itself. Even if
						// its kill call fails, this exact shutdown flight retains ownership.
						await taskkill.exited;
					}
					throw new Error("taskkill timed out.");
				}
				if (exitCode !== 0) {
					throw new Error(`taskkill exited with code ${exitCode}.`);
				}
				taskkillConfirmed = true;
			})();
			forceKillPromise = operation;
			void operation.catch(() => {
				// A confirmed taskkill is an idempotent terminal proof. A failed
				// helper attempt is not: retain the process owner and let a later
				// shutdown/restart attempt launch a fresh exact helper.
				if (forceKillPromise === operation) forceKillPromise = null;
			});
			return operation;
		},
		isExited() {
			return taskkillConfirmed;
		},
	};
}

async function waitForOwnedProcessTreeExit(
	ownedTree: OwnedProcessTree,
	timeoutMs: number,
): Promise<boolean> {
	const deadlineAtMs = Date.now() + timeoutMs;
	for (;;) {
		if (ownedTree.isExited()) return true;
		const remainingMs = deadlineAtMs - Date.now();
		if (remainingMs <= 0) return false;
		await Bun.sleep(Math.min(LOCAL_PROCESS_GROUP_POLL_MS, remainingMs));
	}
}

function isNoSuchProcess(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ESRCH"
	);
}

function isPermissionDenied(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EPERM"
	);
}

export class JsonlProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JsonlProtocolError";
	}
}

export class JsonlParser {
	private buffer = new Uint8Array(0);
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly maxLineBytes: number,
	) {}

	feed(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		merged.set(this.buffer);
		merged.set(chunk, this.buffer.byteLength);
		let lineStart = 0;
		for (let index = 0; index < merged.byteLength; index += 1) {
			if (merged[index] !== 0x0a) continue;
			this.emitBytes(merged.subarray(lineStart, index));
			lineStart = index + 1;
		}
		this.buffer = merged.slice(lineStart);
		if (this.buffer.byteLength > this.maxLineBytes) {
			throw new JsonlProtocolError(
				`JSONL line exceeded ${this.maxLineBytes} bytes before a newline.`,
			);
		}
	}

	finish(): void {
		if (this.buffer.byteLength > 0) this.emitBytes(this.buffer);
		this.buffer = new Uint8Array(0);
	}

	private emitBytes(bytes: Uint8Array): void {
		const lineBytes = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
		if (lineBytes.byteLength > this.maxLineBytes) {
			throw new JsonlProtocolError(
				`JSONL line exceeded ${this.maxLineBytes} bytes.`,
			);
		}
		try {
			this.onLine(this.decoder.decode(lineBytes));
		} catch (error) {
			if (error instanceof JsonlProtocolError) throw error;
			throw new JsonlProtocolError(errorMessage(error));
		}
	}
}

function isToolEvent(message: LocalMessage): message is LocalToolEvent {
	return (
		"event" in message &&
		message.event !== "desktop.event" &&
		message.event !== "semantic.event"
	);
}

function isDesktopEventFrame(
	message: LocalMessage,
): message is LocalDesktopEventFrame {
	return "event" in message && message.event === "desktop.event";
}

function isSemanticEventFrame(
	message: LocalMessage,
): message is LocalSemanticEventFrame {
	return "event" in message && message.event === "semantic.event";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
