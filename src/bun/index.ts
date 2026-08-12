import { join } from "node:path";
import Electrobun, {
	app,
	BrowserView,
	BrowserWindow,
	PATHS,
	Screen,
	Updater,
	Utils,
} from "electrobun/bun";
import {
	ActivityWindowDeliveryService,
	ActivityWindowDeliveryStore,
	activityWindowWorkerDiagnostic,
} from "../agent/activity-window-worker";
import { AgentRuntime } from "../agent/agent-runtime";
import type {
	LocalToolEvent,
	LocalVaultLegacyMigrationResult,
} from "../agent/local-protocol";
import { LocalClientError, LocalToolClient } from "../agent/local-tool-client";
import { AGENT_HOST_PROTOCOL_VERSION } from "../agent/mastra-host/protocol";
import { loadOrCreateReflectionIdentity } from "../agent/reflection";
import {
	type RawFiveMinuteAuditSource,
	TimelineFiveMinuteAuditExporter,
} from "../agent/timeline-v2/audit";
import {
	createTimelineV2Runtime,
	type TimelineV2Runtime,
} from "../agent/timeline-v2/runtime";
import type {
	AgentRunEventEnvelope,
	InternalAgentRunEventEnvelope,
} from "../shared/agent-runs";
import type {
	AgentReadPermissionsRpcResult,
	AgentReadPermissionsSnapshot,
	AuthRpcResult,
	ClientRPC,
	PetRPC,
} from "../shared/contracts";
import { AccountScopedActiveGoalStore } from "./account-scoped-active-goal";
import { runAccountSessionCleanup } from "./account-session-cleanup";
import { ActivityAnalysisDispatcher } from "./activity-analysis-dispatcher";
import { stopActivityWindowDeliveryResources } from "./activity-window-delivery-lifecycle";
import { AgentRunCoordinator } from "./agent-run-coordinator";
import { AgentToolPolicy } from "./agent-tool-policy";
import {
	BackgroundAppLifecycle,
	type BeforeQuitEvent,
	runBestEffortShutdown,
} from "./app-lifecycle";
import { CalendarRepository } from "./calendar-repository";
import {
	activityReflectionConfigurationFromConfiguration,
	agentModelConfigurationFromConfiguration,
	loadOrCreateClientConfiguration,
	REFLECTION_RELAY_COMPLETIONS_PATH,
	WHALEHALL_RELAY_MODEL,
} from "./client-config";
import { CredentialHelperClient } from "./credential-helper-client";
import { DataCenterContentCrypto } from "./data-center-crypto";
import {
	DataCenterSyncService,
	dataCenterSyncDiagnosticCode,
} from "./data-center-sync";
import {
	AgentPermissionRevisionConflictError,
	EncryptedAgentRepository,
} from "./encrypted-agent-repository";
import {
	FileAuditCaptureStore,
	FiveMinuteAuditCaptureCoordinator,
	settleEffectiveAuditAuthorities,
} from "./five-minute-audit-capture";
import { exportFiveMinuteAuditToFile } from "./five-minute-audit-file-export";
import { loadOrCreateInstallationId } from "./installation-id";
import { WhaleHallAgentToolExecutor } from "./local-agent-tool-executor";
import { MastraActivityReflectionAnalyzer } from "./mastra-activity-reflection";
import { LocalAgentHostServices } from "./mastra-host-services";
import { MastraSidecarClient } from "./mastra-sidecar-client";
import { ModelRelayTransport } from "./model-relay-transport";
import { monitoringPermissionSettingsUrl } from "./monitoring-permission-settings";
import {
	isObservationEncryptionUnavailable,
	nativeRuntimeSecurityEnvironment,
	parseNativeRuntimeChannel,
} from "./native-runtime-security";
import { PetStateArbiter } from "./pet-state";
import { PetWindowController } from "./pet-window-controller";
import { PlanningAuthorityService } from "./planning-authority-service";
import { PrivateTrainingWindowExportCoordinator } from "./private-training-window-export";
import { ReflectionModelRelayAuthorization } from "./reflection-model-relay-authorization";
import {
	createWhaleHallReflectionRuntime,
	setRuntimeGoal,
	type WhaleHallReflectionRuntime,
} from "./reflection-runtime";
import {
	RemoteAuthError,
	RemoteAuthSessionManager,
} from "./remote-auth-session";
import { SidecarModelRelayBridge } from "./sidecar-model-relay-bridge";
import { loadTimelineModernBertConfiguration } from "./timeline-modernbert-config";
import {
	resumeTimelineRuntimeForAvailableVault,
	TimelineRuntimeLifecycle,
} from "./timeline-runtime-lifecycle";

const HMR_ORIGIN = "http://127.0.0.1:5173";
const runtimeChannel = parseNativeRuntimeChannel(
	await Updater.localInfo.channel(),
);
const nativeBinary =
	process.platform === "win32" ? "whalehall-local.exe" : "whalehall-local";
const nativePath = join(PATHS.RESOURCES_FOLDER, "app", "native", nativeBinary);
const credentialHelperBinary =
	process.platform === "win32"
		? "whalehall-credential-helper.exe"
		: "whalehall-credential-helper";
const credentialHelperPath = join(
	PATHS.RESOURCES_FOLDER,
	"app",
	"native",
	credentialHelperBinary,
);
const nodeBinary = process.platform === "win32" ? "node.exe" : "node";
const nodePath = join(PATHS.RESOURCES_FOLDER, "app", "node", nodeBinary);
const sidecarEntryPath = join(
	PATHS.RESOURCES_FOLDER,
	"app",
	"agent",
	"whalehall-agent-host.mjs",
);
const localDataPath = join(Utils.paths.userData, "local");
const clientConfiguration = loadOrCreateClientConfiguration({
	userDataDirectory: Utils.paths.userData,
	bundledTemplatePath: join(PATHS.RESOURCES_FOLDER, "app", "config.yaml"),
});
if (clientConfiguration.status === "invalid") {
	console.warn(
		"WhaleHall client config.yaml is invalid; safe defaults remain active.",
	);
}
const runtimeIdentity = loadOrCreateReflectionIdentity(
	join(localDataPath, "reflection-identity.v1.json"),
);
const localRuntimeEnvironment: Record<string, string> = {
	WHALEHALL_DATA_DIR: localDataPath,
	WHALEHALL_DEVICE_ID: runtimeIdentity.deviceId,
	WHALEHALL_SESSION_ID: runtimeIdentity.sessionId,
	...nativeRuntimeSecurityEnvironment(runtimeChannel),
};
const timelineModernBertConfiguration = loadTimelineModernBertConfiguration(
	process.env,
	{
		manifestDirectory: join(
			PATHS.RESOURCES_FOLDER,
			"app",
			"models",
			"timeline-modernbert",
		),
	},
);
if (timelineModernBertConfiguration.code === "invalid_config") {
	console.warn(
		"WhaleHall Timeline v2 ModernBERT configuration is incomplete or invalid; deterministic cold-start remains active.",
	);
}
const agentDataPath = join(Utils.paths.userData, "agent");
const installationId = await loadOrCreateInstallationId(agentDataPath);
const credentialStore = new CredentialHelperClient(credentialHelperPath, {
	installationId,
});
const agentRepository = new EncryptedAgentRepository({
	databasePath: join(agentDataPath, "whalehall-agent.sqlite3"),
	installationId,
	keyStore: credentialStore,
});
const calendarRepository = new CalendarRepository(agentRepository, {
	timeZone: () =>
		Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
});
const activityReflectionConfiguration =
	activityReflectionConfigurationFromConfiguration(
		clientConfiguration.configuration,
	);
const agentModelConfiguration = agentModelConfigurationFromConfiguration(
	clientConfiguration.configuration,
);
if (activityReflectionConfiguration === null) {
	console.warn(
		"WhaleHall cloud reflection is inactive until the literal reflection relay key is provisioned.",
	);
}
if (agentModelConfiguration === null) {
	console.warn(
		"WhaleHall Agent relay is inactive until the literal personal relay key is provisioned.",
	);
}
const configuredModelId =
	agentModelConfiguration?.name ??
	activityReflectionConfiguration?.modelName ??
	WHALEHALL_RELAY_MODEL;
const reflectionModelId =
	activityReflectionConfiguration?.modelName ?? WHALEHALL_RELAY_MODEL;
const agentModelRelayProvider = "whalehall-relay";
const reflectionModelRelayProvider = "whalehall-activity-reflection";
let activeGoalStore!: AccountScopedActiveGoalStore;
let coordinator!: AgentRunCoordinator;
let hostServices!: LocalAgentHostServices;
let relayBridge!: SidecarModelRelayBridge;
let activityReflectionRelayBridge: SidecarModelRelayBridge | null = null;
let activityAnalysisDispatcher: ActivityAnalysisDispatcher | null = null;
let activityReflectionAnalyzer: MastraActivityReflectionAnalyzer | null = null;
let dataCenterSync: DataCenterSyncService | null = null;

const authSession = new RemoteAuthSessionManager(credentialStore, {
	baseUrl: clientConfiguration.configuration.agent.baseurl,
	agentKey: agentModelConfiguration?.apikey,
	onSessionExpired: () => {
		try {
			relayBridge?.abortAll();
		} catch {
			// Logout remains fail-closed even if an already-failing relay cannot abort.
		}
		activeGoalStore?.invalidateSynchronously();
		clientRPC.send.authSessionExpired({});
	},
	onBeforeSessionClear: async (accountId) => {
		try {
			relayBridge?.abortAll();
		} catch {
			// Session transitions stay fail-closed if an in-flight relay is broken.
		}
		activeGoalStore?.invalidateSynchronously();
		const cleanupTasks: Array<() => unknown | Promise<unknown>> = [
			() => dataCenterSync?.stop(),
			() => activeGoalStore.clearForAccountTransition(),
		];
		if (accountId && coordinator) {
			cleanupTasks.push(() => coordinator.cancelAllForAccount(accountId));
		}
		await runAccountSessionCleanup(cleanupTasks);
	},
});
activeGoalStore = new AccountScopedActiveGoalStore({
	currentSession: () => authSession.captureCurrentSession(),
	writeRuntimeGoal: async (goal) => {
		const runtime = reflectionRuntime;
		if (!runtime) {
			if (goal === null) return null;
			throw new Error("Reflection runtime is not ready.");
		}
		const normalized = await setRuntimeGoal(runtime, goal);
		return normalized
			? { schemaVersion: "active-goal.v1", ...normalized }
			: null;
	},
});
const planningAuthority = new PlanningAuthorityService({
	currentSession: () => authSession.captureCurrentSession(),
	isCurrentSession: (identity) => authSession.isCurrentSession(identity),
	repository: agentRepository,
	calendar: calendarRepository,
	currentActiveGoal: (accountId) => activeGoalStore.getForAccount(accountId),
	applyActiveGoal: async (goal) => {
		const normalized = await activeGoalStore.setForCurrentSession(goal);
		if (!normalized)
			throw new Error("Active goal synchronization returned no goal.");
		return normalized;
	},
});
const modelRelay = new ModelRelayTransport(authSession);
const activityReflectionModelRelay = activityReflectionConfiguration
	? new ModelRelayTransport(
			new ReflectionModelRelayAuthorization({
				baseUrl: activityReflectionConfiguration.relayBaseUrl,
				reflectionKey: activityReflectionConfiguration.reflectionKey,
			}),
			{ endpointPath: REFLECTION_RELAY_COMPLETIONS_PATH },
		)
	: null;
const sidecar = new MastraSidecarClient({
	nodePath,
	entryPath: sidecarEntryPath,
	initialize: {
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		client: { name: "whalehall-desktop", version: "0.1.0" },
		model: {
			provider: agentModelRelayProvider,
			modelId: configuredModelId,
			supportsStructuredOutputs: true,
		},
		reflectionModel: {
			provider: reflectionModelRelayProvider,
			modelId: reflectionModelId,
			baseUrl: "https://model.sea-ridethewindbreakthewaves.xyz/v1",
			supportsStructuredOutputs: true,
		},
	},
	onHostCall: async (call) => {
		if (call.method === "model/relay.open") {
			const ownerRunId = call.params.ownerRunId;
			if (typeof ownerRunId !== "string" || call.params.runId !== ownerRunId) {
				throw new Error(
					"Model relay call is not bound to its owning Agent run.",
				);
			}
			const params = { ...call.params };
			delete params.ownerRunId;
			if (params.provider === reflectionModelRelayProvider) {
				const analyzer = activityReflectionAnalyzer;
				const bridge = activityReflectionRelayBridge;
				if (!analyzer?.hasPendingInvocation(ownerRunId) || !bridge) {
					throw new Error(
						"Reflection model relay call is not locally authorized.",
					);
				}
				return bridge.open(call.requestId, params);
			}
			if (params.provider !== agentModelRelayProvider) {
				throw new Error("Model relay provider is not approved.");
			}
			return coordinator.runBoundHostCall(ownerRunId, () =>
				relayBridge.open(call.requestId, params),
			);
		}
		if (call.method === "model/relay.abort") {
			const ownerRunId = call.params.ownerRunId;
			if (typeof ownerRunId !== "string" || call.params.runId !== ownerRunId) {
				throw new Error(
					"Model relay abort is not bound to its owning Agent run.",
				);
			}
			const params = { ...call.params };
			delete params.ownerRunId;
			// Abort frames intentionally contain only the relay/run IDs. Pending
			// reflection invocation ownership is therefore the capability check.
			if (activityReflectionAnalyzer?.hasPendingInvocation(ownerRunId)) {
				return (
					activityReflectionRelayBridge?.abort(params) ?? { aborted: false }
				);
			}
			return coordinator.runBoundHostCall(ownerRunId, async () =>
				relayBridge.abort(params),
			);
		}
		return hostServices.handle(call.method, call.params);
	},
	onRunEvent: (event) => coordinator.acceptSidecarEvent(event),
	onInterrupted: (runIds, reason) => {
		relayBridge.abortAll();
		activityReflectionRelayBridge?.abortAll();
		void coordinator.interruptRuns(runIds, reason);
	},
});
relayBridge = new SidecarModelRelayBridge({
	transport: modelRelay,
	modelId: configuredModelId,
	send: (event) => sidecar.sendRelayEvent(event),
});
if (activityReflectionModelRelay !== null) {
	activityReflectionRelayBridge = new SidecarModelRelayBridge({
		transport: activityReflectionModelRelay,
		modelId: reflectionModelId,
		send: (event) => sidecar.sendRelayEvent(event),
	});
}
const agentToolPolicy = new AgentToolPolicy(agentRepository);
const agentToolExecutor = new WhaleHallAgentToolExecutor({
	calendar: calendarRepository,
	repository: agentRepository,
	activeGoal: (accountId) => activeGoalStore.getForAccount(accountId),
});
coordinator = new AgentRunCoordinator({
	sessionIdentity: () => authSession.captureCurrentSession(),
	repository: agentRepository,
	sidecar,
	abortModelRelay: (runId) => relayBridge.abortRun(runId),
	toolPolicy: agentToolPolicy,
	toolExecutor: agentToolExecutor,
	onEvent: (event) => {
		// Background activity analysis is an encrypted local-only workflow. Its
		// lifecycle and model output must never be broadcast to the renderer.
		if (isRendererAgentRunEvent(event)) clientRPC.send.agentRunEvent(event);
	},
	onActivityRunTerminal: (input) =>
		activityAnalysisDispatcher?.onActivityRunTerminal(input),
});
hostServices = new LocalAgentHostServices({
	runBound: (ownerRunId, operation) =>
		coordinator.runBoundHostCall(ownerRunId, operation),
	repository: agentRepository,
	calendar: calendarRepository,
	toolPolicy: agentToolPolicy,
	memory: coordinator,
	tools: coordinator,
});

const agent = new AgentRuntime(
	new LocalToolClient(nativePath, {
		environment: localRuntimeEnvironment,
	}),
	{ requireStartupGoalPreparation: true },
);
dataCenterSync = new DataCenterSyncService({
	baseUrl: clientConfiguration.configuration.agent.baseurl,
	configuration: clientConfiguration.configuration.cloudSync,
	repository: agentRepository,
	events: agent,
	auth: authSession,
	contentCrypto: new DataCenterContentCrypto(),
	onError(error) {
		console.warn(
			"WhaleHall DataCenter cloud synchronization retry:",
			dataCenterSyncDiagnosticCode(error),
		);
	},
});
const rawAuditSource = createRawFiveMinuteAuditSource(agent);
const rawOnlyAuditExporter = new TimelineFiveMinuteAuditExporter(
	rawAuditSource,
	{
		async readAuditRange() {
			throw new Error("Production-derived Timeline data is unavailable.");
		},
	},
);
let petVisible = true;
let shutdownRequested = false;
let shutdownPromise: Promise<void> | null = null;
const completedShutdownSteps = new Set<string>();
const FAST_SHUTDOWN_STEP_TIMEOUT_MS = 1_000;
const SIDECAR_SHUTDOWN_STEP_TIMEOUT_MS = 5_000;
const LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS = 13_000;
const OVERALL_SHUTDOWN_TIMEOUT_MS = 25_000;
let startupPromise: Promise<void> | null = null;
let cancelStartupRetryWait: (() => void) | null = null;
let reflectionRuntime: WhaleHallReflectionRuntime | null = null;
let activityWindowDelivery: ActivityWindowDeliveryService | null = null;
let activityWindowDeliveryStore: ActivityWindowDeliveryStore | null = null;
let activityWindowDeliveryStopPromise: Promise<void> | null = null;
const STARTUP_RETRY_DELAYS_MS = [
	1_000, 5_000, 15_000, 45_000, 120_000, 300_000,
];
const timelineLifecycle = new TimelineRuntimeLifecycle<TimelineV2Runtime>({
	async createRuntime() {
		const reflection = reflectionRuntime;
		if (reflection === null || shutdownRequested) {
			throw new Error(
				"Timeline runtime cannot start without an active reflection runtime.",
			);
		}
		return createTimelineV2Runtime({
			agent,
			dataDirectory: localDataPath,
			initialGoal: reflection.service.getActiveGoalContext(),
			rawAuditSource,
			modernBert: timelineModernBertConfiguration.modernBert,
		});
	},
	retryDelaysMs: STARTUP_RETRY_DELAYS_MS,
	onError(error) {
		console.error(
			"WhaleHall Timeline v2 start attempt failed:",
			error instanceof Error ? error.name : "UNKNOWN",
		);
	},
});
const auditCaptureCoordinator = new FiveMinuteAuditCaptureCoordinator({
	store: new FileAuditCaptureStore(
		join(localDataPath, "audit-capture-session.v1.json"),
	),
	async settleRange(fromMs, toMs) {
		if (
			!Number.isSafeInteger(fromMs) ||
			!Number.isSafeInteger(toMs) ||
			toMs <= fromMs
		) {
			throw new Error("The audit capture range is invalid.");
		}
		const runtime = timelineLifecycle.current;
		const raw = await rawAuditSource.queryAuditRange({
			fromMs,
			toMs,
			includeDecryptedContent: false,
		});
		const hasEffectiveEvents = raw.semanticEvents.some(
			(event) =>
				event.countClass === "effective" &&
				event.occurredAtMs >= fromMs &&
				event.occurredAtMs < toMs,
		);
		if (!hasEffectiveEvents) return { state: "ready" };
		if (runtime === null) {
			return { state: "pending" };
		}
		// Pull and process only naturally sealed production windows. An audit
		// capture must never force-seal or otherwise perturb collector state.
		await runtime.service.pullNow();
		await runtime.service.runJobsNow();
		return settleEffectiveAuditAuthorities(
			raw.semanticEvents,
			fromMs,
			toMs,
			(cursor) => runtime.repository.readCursorAuthority(cursor),
		);
	},
	onError(error) {
		console.error(
			"[audit-capture] local session failed:",
			error instanceof Error ? error.name : "UNKNOWN",
		);
	},
});
await auditCaptureCoordinator.initialize();

const privateTrainingExportCoordinator =
	new PrivateTrainingWindowExportCoordinator({
		getExporter: () => timelineLifecycle.current?.privateTrainingExport ?? null,
		async listCommittedWindowIds(options) {
			const repository = timelineLifecycle.current?.repository;
			if (repository === undefined) {
				throw new Error("Timeline repository is not ready.");
			}
			return repository.listCommittedWindowIds(options);
		},
		dialogs: {
			async confirmDecryptedTrainingExport(windowCount) {
				const { response } = await Utils.showMessageBox({
					type: "warning",
					title: "导出本地训练数据？",
					message: `将导出 ${windowCount} 个已完成分析窗口，其中包含可解密的可见文本和网址。`,
					detail:
						"导出只写入你下一步选择的本机文件夹，不会上传。生成目录和文件仅当前用户可访问。",
					buttons: ["继续选择文件夹", "取消"],
					defaultId: 1,
					cancelId: 1,
				});
				return response === 0;
			},
			async chooseDirectory() {
				const selected = await Utils.openFileDialog({
					startingFolder: Utils.paths.downloads,
					allowedFileTypes: "*",
					canChooseFiles: false,
					canChooseDirectory: true,
					allowsMultipleSelection: false,
				});
				const directory = selected[0]?.trim();
				return directory ? directory : null;
			},
		},
		participantId: runtimeIdentity.deviceId.startsWith("device_")
			? runtimeIdentity.deviceId.replace(/^device_/u, "participant_")
			: `participant_${runtimeIdentity.deviceId}`,
		sessionTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	});

let clientWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow;
let petWindowController: PetWindowController;
let petStateArbiter: PetStateArbiter;

function sendLocalStatus(status = agent.getLocalStatus()): void {
	if (clientWindow !== null) clientRPC.send.localStatusChanged(status);
	petStateArbiter.updateRuntime(status);
}

function sendToolEvent(event: LocalToolEvent): void {
	petStateArbiter.showToolEvent(event);
}

function requireAuthenticatedAccount(): string {
	const accountId = authSession.accountId;
	if (!accountId) throw new RemoteAuthError("expired", "登录会话已失效。", 401);
	return accountId;
}

async function authRpc<T>(
	operation: () => Promise<T>,
): Promise<AuthRpcResult<T>> {
	try {
		return { kind: "success", data: await operation() };
	} catch (error) {
		if (error instanceof RemoteAuthError) {
			return {
				kind: "error",
				failure:
					error.kind === "secure-storage-unavailable"
						? "service-unavailable"
						: error.kind,
				message: error.message,
			};
		}
		const secureStorageFailure =
			error instanceof Error &&
			(error.name === "CredentialHelperError" ||
				error.name === "EncryptedAgentRepositoryError");
		return {
			kind: "error",
			failure: secureStorageFailure ? "service-unavailable" : "unexpected",
			message: secureStorageFailure
				? "系统安全凭据存储不可用，WhaleHall 已阻止登录以保护本地数据。"
				: "登录服务暂时不可用，请稍后重试。",
		};
	}
}

async function agentPermissionsRpc(
	operation: () => Promise<AgentReadPermissionsSnapshot>,
): Promise<AgentReadPermissionsRpcResult<AgentReadPermissionsSnapshot>> {
	try {
		return { kind: "success", data: await operation() };
	} catch (error) {
		if (error instanceof AgentPermissionRevisionConflictError) {
			return {
				kind: "error",
				failure: "version-conflict",
				message: "Agent 授权已发生变化，请刷新后重试。",
				currentRevision: error.actualRevision,
			};
		}
		const unavailable =
			error instanceof RemoteAuthError ||
			(error instanceof Error &&
				(error.name === "CredentialHelperError" ||
					error.name === "EncryptedAgentRepositoryError"));
		return {
			kind: "error",
			failure: unavailable ? "service-unavailable" : "unexpected",
			message: unavailable
				? "本机 Agent 授权服务暂不可用。"
				: "Agent 授权没有更改，请稍后重试。",
		};
	}
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return (
		keys.length === expected.length &&
		keys.every((key, index) => key === expected[index])
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRendererAgentRunEvent(
	event: InternalAgentRunEventEnvelope,
): event is AgentRunEventEnvelope {
	return event.kind !== "activity-analysis";
}

const clientRPC = BrowserView.defineRPC<ClientRPC>({
	// A user-initiated legacy Keychain migration may wait on one native
	// authorization sheet. Normal monitoring/status requests keep their much
	// shorter LocalToolClient deadlines.
	maxRequestTime: 130_000,
	handlers: {
		requests: {
			getAgentReadPermissions: (input) =>
				agentPermissionsRpc(async () => {
					if (!hasExactKeys(input, []))
						throw new Error("Invalid Agent permission request.");
					return agentRepository.getAgentReadPermissions(
						requireAuthenticatedAccount(),
					);
				}),
			setAgentReadPermissions: (input) =>
				agentPermissionsRpc(async () => {
					if (
						!hasExactKeys(input, ["enabled", "expectedRevision"]) ||
						typeof input.enabled !== "boolean" ||
						!isNonNegativeSafeInteger(input.expectedRevision)
					) {
						throw new Error("Invalid Agent permission request.");
					}
					return agentRepository.setAgentReadPermissions(
						requireAuthenticatedAccount(),
						input.enabled,
						input.expectedRevision,
					);
				}),
			restoreAuthSession: () =>
				authRpc(async () => {
					const session = await authSession.restoreSession();
					if (!session) return null;
					const identity = authSession.captureCurrentSession();
					if (!identity || identity.sessionId !== session.id) {
						throw new RemoteAuthError(
							"expired",
							"登录会话已被新的会话操作取代。",
							401,
						);
					}
					try {
						await agentRepository.ensureAccount(session.user.id);
					} catch (error) {
						await authSession
							.clearSessionIfCurrent(identity)
							.catch(() => undefined);
						throw error;
					}
					if (!authSession.isCurrentSession(identity)) {
						throw new RemoteAuthError(
							"expired",
							"登录会话已在恢复期间失效。",
							401,
						);
					}
					activityAnalysisDispatcher?.wake();
					dataCenterSync?.start();
					return session;
				}),
			signIn: (input) =>
				authRpc(async () => {
					if (
						!hasExactKeys(input, ["email", "password"]) ||
						typeof input.email !== "string" ||
						typeof input.password !== "string" ||
						input.email.length > 320 ||
						input.password.length > 1_024
					) {
						throw new RemoteAuthError(
							"invalid-credentials",
							"邮箱或密码格式无效。",
							400,
						);
					}
					const session = await authSession.signIn(input);
					const identity = authSession.captureCurrentSession();
					if (!identity || identity.sessionId !== session.id) {
						throw new RemoteAuthError(
							"expired",
							"登录会话已被新的会话操作取代。",
							401,
						);
					}
					try {
						await agentRepository.ensureAccount(session.user.id);
					} catch (error) {
						await authSession
							.clearSessionIfCurrent(identity)
							.catch(() => undefined);
						throw error;
					}
					if (!authSession.isCurrentSession(identity)) {
						throw new RemoteAuthError(
							"expired",
							"登录会话已在登录期间失效。",
							401,
						);
					}
					activityAnalysisDispatcher?.wake();
					dataCenterSync?.start();
					return session;
				}),
			signOut: () =>
				authRpc(async () => {
					await authSession.signOut();
				}),
			loadCalendar: () =>
				calendarRepository.load(requireAuthenticatedAccount()),
			mutateCalendar: (mutation) =>
				calendarRepository.mutate(requireAuthenticatedAccount(), mutation),
			mutateCalendarBatch: ({ batchId, mutations, expectedRevision }) =>
				calendarRepository.mutateBatch(
					requireAuthenticatedAccount(),
					batchId,
					mutations,
					expectedRevision,
				),
			getLocalStatus: () => agent.getLocalStatus(),
			getMonitoringStatus: async () => {
				try {
					return await agent.getMonitoringStatus();
				} catch (error) {
					console.error(
						"[monitoring] status request failed:",
						error instanceof LocalClientError ? error.code : "UNKNOWN",
					);
					throw error;
				}
			},
			configureMonitoring: (configuration) =>
				agent.configureMonitoring(configuration),
			pauseMonitoring: () => agent.pauseMonitoring(),
			resumeMonitoring: () => agent.resumeMonitoring(),
			refreshMonitoringPermissions: () => agent.refreshMonitoringPermissions(),
			setupMonitoringPermissions: () => agent.setupMonitoringPermissions(),
			openMonitoringPermissionSettings: ({ permission }) => {
				const url = monitoringPermissionSettingsUrl(permission);
				return {
					opened:
						process.platform === "darwin" &&
						url !== null &&
						Utils.openExternal(url),
				};
			},
			getContentVaultStatus: async () => {
				const vault = await agent.getVaultKeyStatus();
				if (
					vault.availability === "available" &&
					reflectionRuntime !== null &&
					!shutdownRequested &&
					timelineLifecycle.current === null &&
					!timelineLifecycle.recoveryPending
				) {
					void resumeTimelineRuntimeForAvailableVault(vault, timelineLifecycle);
				}
				return vault;
			},
			migrateLegacyContentVault: async () => {
				const vault = await agent.getVaultKeyStatus();
				if (vault.availability === "available") {
					if (
						timelineLifecycle.current === null &&
						!timelineLifecycle.recoveryPending
					) {
						void resumeTimelineRuntimeForAvailableVault(
							vault,
							timelineLifecycle,
						);
					}
					return { status: "cancelled", vault };
				}
				if (
					vault.availability !== "migration_required" ||
					!vault.interactiveMigrationAvailable
				) {
					return { status: "cancelled", vault };
				}
				const { response } = await Utils.showMessageBox({
					type: "warning",
					title: "迁移本地加密密钥？",
					message:
						"WhaleHall 将请求一次访问旧的本地密钥，并将同一密钥迁移到稳定签名的安全存储。",
					detail:
						"只有这次明确操作可能出现 macOS 密钥链确认。不会读取或展示密钥，也不会删除旧密钥；普通启动和后台观察不会弹出此提示。",
					buttons: ["继续一次性迁移", "取消"],
					defaultId: 1,
					cancelId: 1,
				});
				if (response !== 0) {
					return { status: "cancelled", vault };
				}
				let result: LocalVaultLegacyMigrationResult;
				try {
					result = await agent.migrateLegacyVaultKey();
				} catch (error) {
					// The native migration may have committed just before its response
					// was interrupted. A content-free status recheck restores Timeline
					// without asking the user to repeat the Keychain operation.
					const recoveredVault = await agent
						.getVaultKeyStatus()
						.catch(() => null);
					if (recoveredVault?.availability === "available") {
						void resumeTimelineRuntimeForAvailableVault(
							recoveredVault,
							timelineLifecycle,
						);
						return {
							status: "completed",
							result: {
								// The durable target is usable, but the interrupted
								// response cannot prove which process performed the copy.
								migrated: false,
								status: recoveredVault,
							},
						};
					}
					throw error;
				}
				void resumeTimelineRuntimeForAvailableVault(
					result.status,
					timelineLifecycle,
				);
				return {
					status: "completed",
					result,
				};
			},
			exportFiveMinuteAuditToFile: (request) =>
				exportFiveMinuteAuditToFile(request, {
					getExporter: () =>
						timelineLifecycle.current?.audit ?? rawOnlyAuditExporter,
					dialogs: {
						async confirmDecryptedContent() {
							const { response } = await Utils.showMessageBox({
								type: "warning",
								title: "导出含明文的审计包？",
								message: "此文件会包含最近五分钟内可解密的可见文本和网址。",
								detail:
									"文件只会写入你下一步选择的本机文件夹，权限为仅当前用户可读写。请仅在可信位置保存。",
								buttons: ["继续选择文件夹", "取消"],
								defaultId: 1,
								cancelId: 1,
							});
							return response === 0;
						},
						async chooseDirectory() {
							const selected = await Utils.openFileDialog({
								startingFolder: Utils.paths.downloads,
								allowedFileTypes: "*",
								canChooseFiles: false,
								canChooseDirectory: true,
								allowsMultipleSelection: false,
							});
							const directory = selected[0]?.trim();
							return directory ? directory : null;
						},
					},
				}),
			exportPrivateTrainingWindows: (request) =>
				privateTrainingExportCoordinator.start(request),
			getPrivateTrainingWindowExportStatus: () =>
				privateTrainingExportCoordinator.getStatus(),
			startFiveMinuteAuditCapture: () => auditCaptureCoordinator.start(),
			getFiveMinuteAuditCaptureStatus: async () => ({
				capture: await auditCaptureCoordinator.status(),
			}),
			cancelFiveMinuteAuditCapture: async ({ captureId }) => ({
				capture: await auditCaptureCoordinator.cancel(captureId),
			}),
			setPetVisible: ({ visible }): { visible: boolean } => {
				petVisible = visible;
				if (!visible) petStateArbiter.resetToRuntime(agent.getLocalStatus());
				petWindowController.setVisible(visible);
				if (clientWindow !== null) {
					clientRPC.send.petVisibilityChanged({ visible });
				}
				return { visible };
			},
			presentPetEvent: (event): { accepted: boolean } => {
				petStateArbiter.showPresentationEvent(event);
				return { accepted: true };
			},
			setActiveGoalContext: async ({ goal }) => {
				requireAuthenticatedAccount();
				const normalized = await activeGoalStore.setForCurrentSession(
					goal
						? {
								goalId: goal.goalId,
								planId: goal.planId,
								text: goal.text,
								activatedAtMs: goal.activatedAtMs,
							}
						: null,
				);
				await timelineLifecycle.current?.service.pullNow();
				return {
					goal: normalized,
				};
			},
			startConversationTurn: (input) =>
				coordinator.startConversationTurn(input),
			startTaskPlanningRun: (input) => coordinator.startTaskPlanningRun(input),
			submitPlanningClarification: (input) =>
				coordinator.submitPlanningClarification(input),
			decideAgentToolApproval: (input) =>
				coordinator.decideAgentToolApproval(input),
			cancelAgentRun: (input) => coordinator.cancelAgentRun(input),
			getAgentRunSnapshot: ({ runId }) =>
				coordinator.getAgentRunSnapshot(runId),
			listRestorableAgentRuns: (input) =>
				coordinator.listRestorableAgentRuns(input),
			getActiveConversation: () => coordinator.getActiveConversation(),
			loadPlanningAuthority: (input) => {
				if (!hasExactKeys(input, []))
					throw new Error("Invalid planning authority request.");
				return planningAuthority.load();
			},
			savePlanningDraft: (input) => planningAuthority.saveDraft(input),
			commitPlanningDraft: (input) => planningAuthority.commitDraft(input),
		},
		messages: {},
	},
});

const petRPC = BrowserView.defineRPC<PetRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			ready: () => {
				console.log("[pet] React renderer ready");
				// A remounted/reloaded WebView cannot still own an old pointer capture.
				petStateArbiter.resetToRuntime(agent.getLocalStatus());
			},
			interacted: (event) => {
				if (event.kind === "dragStart") {
					petWindowController.beginDrag(event.dragDelta);
				}
				if (event.kind === "dragEnd") {
					petWindowController.endDrag("webview");
				}
				petStateArbiter.showInteraction(event);
			},
		},
	},
});

petStateArbiter = new PetStateArbiter((state) =>
	petRPC.send.setPetState(state),
);

const hmrAvailable = (async (): Promise<boolean> => {
	if (runtimeChannel !== "dev") return false;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			const response = await fetch(`${HMR_ORIGIN}/client/index.html`, {
				method: "HEAD",
				signal: AbortSignal.timeout(150),
			});
			if (response.ok) return true;
		} catch {}
		await Bun.sleep(100);
	}
	return false;
})();

async function viewUrl(view: "client" | "pet"): Promise<string> {
	const bundled = `views://${view}/index.html`;
	const hmrUrl = `${HMR_ORIGIN}/${view}/index.html`;
	if (await hmrAvailable) return hmrUrl;
	console.log(`[views] Vite is unavailable; using ${bundled}`);
	return bundled;
}

const petWidth = 360;
const petHeight = 300;
const display = Screen.getPrimaryDisplay();
const clientWidth = Math.min(1280, Math.max(1000, display.workArea.width - 80));
const clientHeight = Math.min(800, Math.max(720, display.workArea.height - 80));

async function createClientWindow(): Promise<BrowserWindow> {
	const window = new BrowserWindow({
		title: "WhaleHall",
		url: await viewUrl("client"),
		rpc: clientRPC,
		frame: {
			x: 120,
			y: 100,
			width: clientWidth,
			height: clientHeight,
		},
	});
	window.setPosition(
		display.workArea.x +
			Math.max(0, Math.floor((display.workArea.width - clientWidth) / 2)),
		display.workArea.y +
			Math.max(0, Math.floor((display.workArea.height - clientHeight) / 2)),
	);
	window.webview.on("dom-ready", () => {
		sendLocalStatus();
		clientRPC.send.petVisibilityChanged({ visible: petVisible });
	});
	window.on("close", () => {
		clientLifecycle.didClose(window);
		if (clientWindow === window) clientWindow = null;
	});
	clientWindow = window;
	return window;
}

const clientLifecycle = new BackgroundAppLifecycle<BrowserWindow>({
	createWindow: createClientWindow,
	onQuitRequested() {
		shutdownRequested = true;
		agent.beginShutdown();
		sidecar.beginShutdown();
	},
	shutdown,
	exit: () => Utils.quit(),
	onError(operation, error) {
		console.error(
			`[lifecycle] ${operation} failed:`,
			error instanceof Error ? error.name : "UNKNOWN",
		);
	},
});
await clientLifecycle.open();

petWindow = new BrowserWindow({
	title: "WhaleHall Pet",
	url: await viewUrl("pet"),
	rpc: petRPC,
	titleBarStyle: "hidden",
	transparent: true,
	// Electrobun 1.18 applies passthrough to the whole WebView, so interactive pets
	// must keep it disabled in order to receive hover and click pointer events.
	passthrough: false,
	renderer: process.platform === "linux" ? "cef" : "native",
	activate: false,
	frame: {
		x: display.workArea.x + display.workArea.width - petWidth - 32,
		y: display.workArea.y + display.workArea.height - petHeight - 24,
		width: petWidth,
		height: petHeight,
	},
});

petWindow.setAlwaysOnTop(true);
petWindow.setVisibleOnAllWorkspaces(true);
petWindowController = new PetWindowController(petWindow, Screen, {
	onDragStateChange: ({ dragging, reason }) => {
		console.log(
			`[pet] native drag ${dragging ? "started" : `ended (${reason ?? "unknown"})`}`,
		);
		petRPC.send.nativeDragChanged({ dragging, reason });
		if (!dragging && reason !== "disposed") petStateArbiter.finishNativeDrag();
	},
});

agent.onStatusChange(sendLocalStatus);
agent.onToolEvent(sendToolEvent);
petWindow.webview.on("dom-ready", () => {
	console.log("[pet] DOM ready");
	sendLocalStatus();
});

function shutdown(): Promise<void> {
	shutdownRequested = true;
	agent.beginShutdown();
	sidecar.beginShutdown();
	if (shutdownPromise) return shutdownPromise;
	const steps = [
		{
			name: "startup-retry",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => cancelStartupRetryWait?.(),
		},
		{
			name: "model-relays",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => abortModelRelays(),
		},
		{
			name: "activity-window-delivery",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => stopActivityWindowDelivery(),
		},
		{
			name: "sensor-sidecar",
			critical: true,
			timeoutMs: SIDECAR_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => sidecar.stop(),
		},
		{
			name: "local-tool-host",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => agent.stop(),
		},
		{
			name: "audit-capture",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => auditCaptureCoordinator.dispose(),
		},
		{
			name: "data-center-sync",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => dataCenterSync?.stop(),
		},
		{
			name: "startup",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			// Startup owns both the initial native start and any reflection-service
			// start. Waiting here prevents a late candidate from restarting the
			// native sensor process after shutdown has already stopped it.
			run: async () => {
				await startupPromise;
			},
		},
		{
			name: "timeline",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => timelineLifecycle.close(),
		},
		{
			name: "reflection",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: async () => {
				const runtime = reflectionRuntime;
				reflectionRuntime = null;
				await runtime?.close();
			},
		},
		{
			name: "agent-repository",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => agentRepository.close(),
		},
		{
			name: "pet-state",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => petStateArbiter.dispose(),
		},
		{
			name: "pet-window-controller",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => petWindowController.dispose(),
		},
		{
			name: "pet-window",
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => petWindow.close(),
		},
	] as const;
	const operation = runBestEffortShutdown(
		steps
			.filter((step) => !completedShutdownSteps.has(step.name))
			.map((step) => ({
				...step,
				async run() {
					await step.run();
					completedShutdownSteps.add(step.name);
				},
			})),
		(operation, error) => {
			console.error(
				`[shutdown] ${operation} failed:`,
				error instanceof LocalClientError
					? error.code
					: error instanceof Error
						? error.name
						: "UNKNOWN",
			);
		},
		{
			overallTimeoutMs: OVERALL_SHUTDOWN_TIMEOUT_MS,
			onStepSettled(result) {
				console.log(
					"[shutdown]",
					`step=${result.name}`,
					`outcome=${result.outcome}`,
					`critical=${result.critical}`,
					`duration_ms=${Math.round(result.durationMs)}`,
				);
			},
		},
	);
	shutdownPromise = operation;
	void operation.then(
		() => {
			if (shutdownPromise === operation) shutdownPromise = null;
		},
		() => {
			if (shutdownPromise === operation) shutdownPromise = null;
		},
	);
	return operation;
}

function abortModelRelays(): void {
	const failures: unknown[] = [];
	try {
		relayBridge.abortAll();
	} catch (error) {
		failures.push(error);
	}
	try {
		activityReflectionRelayBridge?.abortAll();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, "Model relay shutdown failed.");
	}
}

app.on("reopen", () => {
	// A shutdown veto intentionally rejects reopen while critical process owners
	// are waiting for a later quit retry. Normal create failures are already
	// projected through the lifecycle error handler.
	void clientLifecycle.open().catch(() => undefined);
});
Electrobun.events.on("before-quit", (event: BeforeQuitEvent) => {
	// The high-level app event strips the response setter Electrobun requires
	// to veto its synchronous quit path, so lifecycle owns the raw event.
	clientLifecycle.handleBeforeQuit(event);
});
process.once("SIGINT", () => {
	void clientLifecycle.quit();
});
process.once("SIGTERM", () => {
	void clientLifecycle.quit();
});

startupPromise = (async () => {
	let attempt = 0;
	while (!shutdownRequested) {
		let candidate: WhaleHallReflectionRuntime | null = null;
		try {
			candidate = await createWhaleHallReflectionRuntime({
				agent,
				dataDirectory: localDataPath,
				onWindowSealed: (window) => {
					const delivery = activityWindowDelivery;
					if (delivery === null || shutdownRequested) return;
					return delivery.enqueueWindow(window);
				},
				environment: {
					...process.env,
					WHALEHALL_MODERNBERT_ALLOWED_ORIGINS: undefined,
				},
			});
			if (shutdownRequested) {
				await candidate.close();
				return;
			}
			await startActivityWindowDelivery(candidate.repository);
			await candidate.service.start();
			if (shutdownRequested) {
				await candidate.close();
				return;
			}
			reflectionRuntime = candidate;
			candidate = null;
			if (authSession.accountId) {
				await planningAuthority.load();
			}
			let timeline: TimelineV2Runtime;
			try {
				timeline = await timelineLifecycle.ensureStarted();
			} catch (error) {
				if (!isObservationEncryptionUnavailable(error)) throw error;
				// Keychain can be unavailable before first unlock or after an
				// ad-hoc development re-sign. Keep the healthy native process
				// available for monitoring/configuration, while Timeline v2
				// and decrypted export remain fail closed.
				console.warn(
					"WhaleHall Timeline v2 is unavailable because the local encryption key cannot be opened; monitoring remains available.",
				);
				return;
			}
			if (shutdownRequested) {
				await timelineLifecycle.close();
				await reflectionRuntime?.close();
				reflectionRuntime = null;
				return;
			}
			console.log(
				`WhaleHall Timeline v2 ready; Qwen hypothesis lock: ${
					timeline.teacherVerified ? "verified" : "deterministic fallback"
				}`,
			);
			return;
		} catch (error) {
			await stopActivityWindowDelivery();
			if (candidate) {
				await candidate.close().catch((closeError) => {
					console.error(
						"WhaleHall reflection candidate cleanup failed:",
						closeError,
					);
				});
			}
			if (reflectionRuntime) {
				await reflectionRuntime.close().catch((closeError) => {
					console.error(
						"WhaleHall reflection runtime cleanup failed:",
						closeError,
					);
				});
				reflectionRuntime = null;
			}
			if (shutdownRequested) return;
			// A failed health/query can leave a child allocated but unusable.
			// Stop it before retrying so AgentRuntime cannot mistake that child
			// for a healthy already-started transport.
			await agent.stop().catch((stopError) => {
				console.error(
					"WhaleHall local runtime cleanup before retry failed:",
					stopError,
				);
			});
			const delayMs =
				STARTUP_RETRY_DELAYS_MS[
					Math.min(attempt, STARTUP_RETRY_DELAYS_MS.length - 1)
				] ?? 300_000;
			attempt += 1;
			console.error(
				`WhaleHall reflection runtime start failed; retrying in ${delayMs}ms:`,
				error,
			);
			await waitForStartupRetry(delayMs);
		}
	}
})();
console.log(`WhaleHall started; local tool host: ${nativePath}`);

function waitForStartupRetry(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			cancelStartupRetryWait = null;
			resolve();
		};
		const timer = globalThis.setTimeout(finish, delayMs);
		cancelStartupRetryWait = () => {
			globalThis.clearTimeout(timer);
			finish();
		};
	});
}

async function startActivityWindowDelivery(
	source: WhaleHallReflectionRuntime["repository"],
): Promise<void> {
	if (
		activityReflectionConfiguration === null ||
		activityReflectionRelayBridge === null ||
		activityWindowDelivery !== null ||
		shutdownRequested
	) {
		return;
	}
	const store = new ActivityWindowDeliveryStore(
		join(localDataPath, "activity-window-worker.sqlite3"),
	);
	const dispatcher = new ActivityAnalysisDispatcher({
		store,
		scoreThreshold: activityReflectionConfiguration.scoreThreshold,
		auth: authSession,
		coordinator,
		onError: (error) => {
			console.warn(
				"WhaleHall local activity Agent job retry:",
				error instanceof Error ? error.name : "UNKNOWN",
			);
		},
	});
	// Policy: Bun constructs the complete raw-window prompt and normalizes the
	// response. The no-persistence Mastra workflow calls the host-only generic
	// relay, which only authenticates and forwards to the CPU model.
	const analyzer = new MastraActivityReflectionAnalyzer({
		sidecar,
		onInvocationAbort: (invocationId) =>
			activityReflectionRelayBridge?.abortRun(invocationId),
	});
	const delivery = new ActivityWindowDeliveryService({
		source,
		analyzer,
		store,
		scoreThreshold: activityReflectionConfiguration.scoreThreshold,
		onAgentTriggerRequired: () => dispatcher.wake(),
		onError: (error) => {
			const diagnostic = activityWindowWorkerDiagnostic(error);
			console.warn(
				"WhaleHall activity window delivery retry:",
				diagnostic.code,
				diagnostic.httpStatus ?? "",
				diagnostic.requestBytes === null
					? ""
					: `request_bytes=${diagnostic.requestBytes}`,
				diagnostic.responseServer === null
					? ""
					: `server=${diagnostic.responseServer}`,
				diagnostic.triggerReason === null
					? ""
					: `trigger_reason=${diagnostic.triggerReason}`,
				diagnostic.eventCount === null
					? ""
					: `event_count=${diagnostic.eventCount}`,
				diagnostic.validationStage === null
					? ""
					: `validation_stage=${diagnostic.validationStage}`,
			);
		},
	});
	activityWindowDeliveryStore = store;
	activityAnalysisDispatcher = dispatcher;
	activityWindowDelivery = delivery;
	activityReflectionAnalyzer = analyzer;
	try {
		dispatcher.start();
		await delivery.start();
	} catch (error) {
		await stopActivityWindowDelivery();
		throw error;
	}
}

function stopActivityWindowDelivery(): Promise<void> {
	if (activityWindowDeliveryStopPromise !== null) {
		return activityWindowDeliveryStopPromise;
	}
	const delivery = activityWindowDelivery;
	const dispatcher = activityAnalysisDispatcher;
	const store = activityWindowDeliveryStore;
	const analyzer = activityReflectionAnalyzer;
	let operation!: Promise<void>;
	operation = stopActivityWindowDeliveryResources(
		{ analyzer, delivery, dispatcher, store },
		reportActivityWindowDeliveryCleanupFailure,
	).then(
		() => {
			if (activityWindowDelivery === delivery) activityWindowDelivery = null;
			if (activityAnalysisDispatcher === dispatcher) {
				activityAnalysisDispatcher = null;
			}
			if (activityWindowDeliveryStore === store) {
				activityWindowDeliveryStore = null;
			}
			if (activityReflectionAnalyzer === analyzer) {
				activityReflectionAnalyzer = null;
			}
			if (activityWindowDeliveryStopPromise === operation) {
				activityWindowDeliveryStopPromise = null;
			}
		},
		(error: unknown) => {
			if (activityWindowDeliveryStopPromise === operation) {
				activityWindowDeliveryStopPromise = null;
			}
			throw error;
		},
	);
	activityWindowDeliveryStopPromise = operation;
	return operation;
}

function reportActivityWindowDeliveryCleanupFailure(
	resource: string,
	error: unknown,
): void {
	console.warn(
		"WhaleHall activity delivery cleanup failed:",
		resource,
		error instanceof Error ? error.name : "UNKNOWN",
	);
}

function createRawFiveMinuteAuditSource(
	runtime: AgentRuntime,
): RawFiveMinuteAuditSource {
	return {
		async queryAuditRange({ fromMs, toMs, includeDecryptedContent }) {
			const result = await runtime.queryAuditFiveMinutes({
				fromMs,
				toMs,
				includeDecryptedContent,
			});
			return {
				permissions: {
					accessibility: result.permissions.accessibility,
					screenRecording: result.permissions.screenRecording,
					inputMonitoring: result.permissions.inputMonitoring,
					automation: result.permissions.automation,
				},
				coverage: result.coverage,
				rawObservations: result.rawObservations,
				semanticEvents: result.semanticEvents,
			};
		},
	};
}
