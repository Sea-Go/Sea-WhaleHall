import { existsSync } from "node:fs";
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
import { createActivitySupportPersonalization } from "../shared/activity-support";
import type {
	AgentRunEventEnvelope,
	InternalAgentRunEventEnvelope,
} from "../shared/agent-runs";
import { isWhaleHallLifecycleSignalMessage } from "../shared/app-lifecycle-signal";
import type {
	AgentReadPermissionsRpcResult,
	AgentReadPermissionsSnapshot,
	AuthRpcResult,
	ClientRPC,
} from "../shared/contracts";
import type {
	PetActivityFeedbackRendererChallenge,
	PetActivityFeedbackRPC,
} from "../shared/pet-activity-feedback";
import type {
	PlanningCalendarEventProjection,
	PlanningCalendarMutationProjection,
} from "../shared/planning";
import {
	isListProactiveFeedbackRequest,
	isSetProactiveFeedbackPolicyRequest,
	type ProactiveFeedbackRpcResult,
} from "../shared/proactive-feedback";
import { AccountScopedActiveGoalStore } from "./account-scoped-active-goal";
import { runAccountSessionCleanup } from "./account-session-cleanup";
import { ActivityAnalysisDispatcher } from "./activity-analysis-dispatcher";
import {
	ActivityWindowDeliveryLifecycle,
	stopActivityWindowDeliveryResources,
} from "./activity-window-delivery-lifecycle";
import { completeLegacyActivityPolicyCutover } from "./activity-window-policy-cutover";
import { AgentRunCoordinator } from "./agent-run-coordinator";
import { AgentToolPolicy } from "./agent-tool-policy";
import {
	BackgroundAppLifecycle,
	type BeforeQuitEvent,
	closeOwnerAfterDraining,
	runBestEffortShutdown,
	ShutdownWorkBarrier,
} from "./app-lifecycle";
import {
	AppUpdateController,
	createElectrobunAppUpdaterAdapter,
} from "./app-update-controller";
import { shouldForceRendererPlanLock } from "./calendar-mutation-policy";
import { CalendarRepository } from "./calendar-repository";
import {
	activityReflectionConfigurationFromConfiguration,
	agentModelConfigurationFromConfiguration,
	loadOrCreateClientConfiguration,
	planningModelConfigurationFromConfiguration,
	WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
} from "./client-config";
import { CredentialHelperClient } from "./credential-helper-client";
import { DataCenterContentCrypto } from "./data-center-crypto";
import {
	DataCenterProductionOriginCutoverCredentialError,
	runDataCenterProductionOriginCutover,
} from "./data-center-origin-cutover";
import {
	DataCenterSyncService,
	dataCenterSyncDiagnosticCode,
} from "./data-center-sync";
import { DeferredReflectionOperations } from "./deferred-reflection-operations";
import {
	calendarEventsAfterDurableCommit,
	type DurableCalendarPostCommitStage,
	runDurableCalendarMutation,
} from "./durable-calendar-mutation";
import {
	AgentPermissionRevisionConflictError,
	EncryptedAgentRepository,
	EncryptedAgentRepositoryError,
	ProactiveFeedbackPolicyRevisionConflictError,
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
import { MastraPlanningModel } from "./mastra-planning-model";
import { MastraSidecarClient } from "./mastra-sidecar-client";
import { authorizeRunBoundModelRelay } from "./model-relay-authorization";
import { ModelRelayTransport } from "./model-relay-transport";
import { monitoringPermissionSettingsUrl } from "./monitoring-permission-settings";
import {
	isObservationEncryptionUnavailable,
	nativeRuntimeSecurityEnvironment,
	parseNativeRuntimeChannel,
} from "./native-runtime-security";
import { PetActivityFeedbackDelivery } from "./pet-activity-feedback-delivery";
import { PetStateArbiter } from "./pet-state";
import { PetWindowController } from "./pet-window-controller";
import { PlanningAuthorityService } from "./planning-authority-service";
import { WhaleHallPlanningRuntime } from "./planning-runtime";
import { PrivateTrainingWindowExportCoordinator } from "./private-training-window-export";
import { ProactiveFeedbackRuntime } from "./proactive-feedback-runtime";
import {
	createWhaleHallReflectionRuntime,
	setRuntimeGoal,
	stopNativeAgentWithReflection,
	type WhaleHallReflectionRuntime,
} from "./reflection-runtime";
import {
	RemoteAuthError,
	RemoteAuthSessionManager,
} from "./remote-auth-session";
import { SidecarModelRelayBridge } from "./sidecar-model-relay-bridge";
import {
	resumeTimelineRuntimeForAvailableVault,
	TimelineRuntimeLifecycle,
} from "./timeline-runtime-lifecycle";

const HMR_ORIGIN = "http://127.0.0.1:5173";
const runtimeChannel = parseNativeRuntimeChannel(
	await Updater.localInfo.channel(),
);
const runtimeVersion = await Updater.localInfo.version();
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
if (clientConfiguration.cloudSyncConsentBlockedByRetiredOrigin) {
	console.warn(
		"WhaleHall cloud sync consent was disabled because its production origin could not be verified; grant production consent explicitly.",
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
const productionOriginCutover = await runDataCenterProductionOriginCutover({
	repository: agentRepository,
	credentials: credentialStore,
}).catch((error: unknown) => {
	if (error instanceof DataCenterProductionOriginCutoverCredentialError) {
		console.error(error.message);
	}
	throw error;
});
if (productionOriginCutover === "completed") {
	console.warn(
		"WhaleHall initialized the fixed production credential boundary; sign-in is required.",
	);
}
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
const planningModelConfiguration = planningModelConfigurationFromConfiguration(
	clientConfiguration.configuration,
);
const configuredModelId = agentModelConfiguration.name;
const planningModelId = planningModelConfiguration.name;
const reflectionModelId = activityReflectionConfiguration.modelName;
const dataCenterModelApiBaseUrl = `${WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL}/v1`;
const agentModelRelayProvider = "whalehall-relay";
const planningModelRelayProvider = "whalehall-planning";
const reflectionModelRelayProvider = "whalehall-activity-reflection";
let activeGoalStore!: AccountScopedActiveGoalStore;
let coordinator!: AgentRunCoordinator;
let hostServices!: LocalAgentHostServices;
let relayBridge!: SidecarModelRelayBridge;
let activityAgentRelayBridge!: SidecarModelRelayBridge;
let planningRelayBridge!: SidecarModelRelayBridge;
let activityReflectionRelayBridge: SidecarModelRelayBridge | null = null;
let dynamicPlanningModel: MastraPlanningModel | null = null;
let activityAnalysisDispatcher: ActivityAnalysisDispatcher | null = null;
let activityReflectionAnalyzer: MastraActivityReflectionAnalyzer | null = null;
let petActivityFeedbackDelivery: PetActivityFeedbackDelivery | null = null;
let petActivityFeedbackRendererQuarantined = false;
let petRendererProofTimer: ReturnType<typeof setTimeout> | null = null;
let petRendererProofInFlight: string | null = null;
let proactiveFeedbackRuntime!: ProactiveFeedbackRuntime;
let appUpdateController: AppUpdateController | null = null;
let dataCenterSync: DataCenterSyncService | null = null;
let reflectionRuntime: WhaleHallReflectionRuntime | null = null;
const deferredReflectionOperations = new DeferredReflectionOperations();

function cutoverReflectionCloudOwner(accountId: string | null): Promise<void> {
	const runtime = reflectionRuntime;
	if (runtime !== null) return runtime.service.cutoverCloudOwner(accountId);
	deferredReflectionOperations.deferCutover(accountId);
	return Promise.resolve();
}

function clearReflectionCloudHandoffs(
	accountId: string,
	options: { requireCompletion?: boolean } = {},
): Promise<void> {
	const runtime = reflectionRuntime;
	if (runtime !== null) {
		return runtime.repository
			.clearWindowsForAccount(accountId)
			.then(() => undefined);
	}
	try {
		deferredReflectionOperations.deferClearHandoffs(accountId, options);
	} catch (error) {
		return Promise.reject(error);
	}
	return Promise.resolve();
}

function currentReflectionRuntime(): WhaleHallReflectionRuntime | null {
	return reflectionRuntime;
}

async function publishReflectionRuntime(
	runtime: WhaleHallReflectionRuntime,
): Promise<void> {
	await deferredReflectionOperations.replayAndPublish(
		{
			cutoverCloudOwner: (accountId) =>
				runtime.service.cutoverCloudOwner(accountId),
			clearWindowsForAccount: (accountId) =>
				runtime.repository.clearWindowsForAccount(accountId),
		},
		() => {
			reflectionRuntime = runtime;
		},
	);
}

const authSession = new RemoteAuthSessionManager(credentialStore, {
	baseUrl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
	onBeforeSessionActivate: (identity) =>
		proactiveFeedbackRuntime.prepareSessionActivationForAuth(identity),
	onSessionActivated: (identity) =>
		proactiveFeedbackRuntime.sessionReadyForAuth(identity),
	onSessionExpired: () => {
		try {
			relayBridge?.abortAll();
		} catch {
			// Logout remains fail-closed even if an already-failing relay cannot abort.
		}
		try {
			activityReflectionRelayBridge?.abortAll();
		} catch {
			// Account ownership is revoked even if the activity relay is failing.
		}
		try {
			activityAgentRelayBridge?.abortAll();
		} catch {
			// Account ownership is revoked even if the activity Agent relay is failing.
		}
		try {
			dynamicPlanningModel?.cancelPending();
			planningRelayBridge?.abortAll();
		} catch {
			// Account ownership is revoked even if dynamic Planning is failing.
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
		try {
			activityReflectionRelayBridge?.abortAll();
		} catch {
			// Account transitions remain fail-closed for background model calls.
		}
		try {
			activityAgentRelayBridge?.abortAll();
		} catch {
			// Account transitions remain fail-closed for background Agent calls.
		}
		try {
			dynamicPlanningModel?.cancelPending();
			planningRelayBridge?.abortAll();
		} catch {
			// Account transitions remain fail-closed for dynamic Planning calls.
		}
		activeGoalStore?.invalidateSynchronously();
		const cleanupFailures: unknown[] = [];
		try {
			// This is the account handoff barrier: revoke the durable Reflection
			// owner and discard its open evidence before another login can activate.
			await proactiveFeedbackRuntime.clearSessionOwner();
		} catch (error) {
			cleanupFailures.push(error);
		}
		const cleanupTasks: Array<() => unknown | Promise<unknown>> = [
			() => dataCenterSync?.stop(),
			() => stopActivityWindowDelivery(),
			() => activeGoalStore.clearForAccountTransition(),
		];
		if (accountId && coordinator) {
			cleanupTasks.push(() => coordinator.cancelAllForAccount(accountId));
		}
		try {
			await runAccountSessionCleanup(cleanupTasks);
		} catch (error) {
			cleanupFailures.push(error);
		}
		if (cleanupFailures.length > 0) {
			throw new AggregateError(
				cleanupFailures,
				"The local account transition did not complete every fail-closed barrier.",
			);
		}
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

proactiveFeedbackRuntime = new ProactiveFeedbackRuntime({
	repository: agentRepository,
	currentSession: () => authSession.captureCurrentSession(),
	isCurrentSession: (identity) => authSession.isCurrentSession(identity),
	isCapabilityAvailable: () => true,
	cutoverCloudOwner: (accountId) => cutoverReflectionCloudOwner(accountId),
	startDelivery: async () => {
		const runtime = reflectionRuntime;
		if (runtime) await startActivityWindowDelivery(runtime.repository);
	},
	stopDelivery: async ({ accountId, clearPending }) => {
		await stopActivityWindowDelivery();
		if (clearPending) clearActivityWindowDeliveryLedger(accountId);
	},
	abortActivityRequests: () => {
		activityReflectionRelayBridge?.abortAll();
		activityAgentRelayBridge?.abortAll();
	},
	clearPetPresentation: async () => {
		await petActivityFeedbackDelivery?.clearForAccountTransition();
	},
	quiesceActivityRuns: async (accountId) => {
		await coordinator?.quiesceActivityRunsForSessionTransition(accountId);
	},
	discardActivityRuns: async (accountId) => {
		await coordinator?.discardActivityRunsForAccount(accountId);
	},
	clearReflectionHandoffs: async (accountId, options) => {
		await clearReflectionCloudHandoffs(accountId, options);
	},
	protectedActivityRunIds: (accountId) =>
		protectedActivityWindowDeliveryRunIds(accountId),
	onError: (error) => {
		console.warn(
			"WhaleHall proactive feedback retention failed:",
			error instanceof Error ? error.name : "UNKNOWN",
		);
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
const modelRelay = new ModelRelayTransport(authSession, { purpose: "agent" });
const activityAgentModelRelay = new ModelRelayTransport(authSession, {
	purpose: "activity",
});
const planningModelRelay = new ModelRelayTransport(authSession, {
	purpose: "planning",
});
const activityReflectionModelRelay = activityReflectionConfiguration
	? new ModelRelayTransport(authSession, { purpose: "reflection" })
	: null;
const sidecar = new MastraSidecarClient({
	nodePath,
	entryPath: sidecarEntryPath,
	initialize: {
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		client: { name: "whalehall-desktop", version: runtimeVersion },
		model: {
			provider: agentModelRelayProvider,
			modelId: configuredModelId,
			supportsStructuredOutputs: true,
		},
		planningModel: {
			provider: planningModelRelayProvider,
			modelId: planningModelId,
			baseUrl: dataCenterModelApiBaseUrl,
			supportsStructuredOutputs: true,
		},
		reflectionModel: {
			provider: reflectionModelRelayProvider,
			modelId: reflectionModelId,
			baseUrl: dataCenterModelApiBaseUrl,
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
			if (typeof params.provider !== "string") {
				throw new Error("Model relay provider is invalid.");
			}
			const provider = params.provider;
			if (provider === reflectionModelRelayProvider) {
				const analyzer = activityReflectionAnalyzer;
				const bridge = activityReflectionRelayBridge;
				if (!analyzer?.hasPendingInvocation(ownerRunId) || !bridge) {
					throw new Error(
						"Reflection model relay call is not locally authorized.",
					);
				}
				return bridge.open(call.requestId, params);
			}
			const dynamicPlanningPending =
				dynamicPlanningModel?.hasPendingInvocation(ownerRunId) ?? false;
			if (dynamicPlanningPending) {
				authorizeRunBoundModelRelay({
					provider,
					agentProvider: agentModelRelayProvider,
					planningProvider: planningModelRelayProvider,
					runPurpose: null,
					dynamicPlanningPending,
				});
				return planningRelayBridge.open(call.requestId, params);
			}
			return coordinator.runBoundHostCall(ownerRunId, () => {
				const bridge = authorizeRunBoundModelRelay({
					provider,
					agentProvider: agentModelRelayProvider,
					planningProvider: planningModelRelayProvider,
					runPurpose: coordinator.modelPurposeForRun(ownerRunId),
					dynamicPlanningPending,
				});
				if (bridge === "planning") {
					return planningRelayBridge.open(call.requestId, params);
				}
				return (bridge === "activity"
					? activityAgentRelayBridge
					: relayBridge
				).open(call.requestId, params);
			});
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
			if (dynamicPlanningModel?.hasPendingInvocation(ownerRunId)) {
				return planningRelayBridge.abort(params);
			}
			// Abort frames intentionally contain only the relay/run IDs. Pending
			// reflection invocation ownership is therefore the capability check.
			if (activityReflectionAnalyzer?.hasPendingInvocation(ownerRunId)) {
				return (
					activityReflectionRelayBridge?.abort(params) ?? { aborted: false }
				);
			}
			return coordinator.runBoundHostCall(ownerRunId, async () => {
				switch (coordinator.modelPurposeForRun(ownerRunId)) {
					case "planning":
						return planningRelayBridge.abort(params);
					case "activity":
						return activityAgentRelayBridge.abort(params);
					default:
						return relayBridge.abort(params);
				}
			});
		}
		return hostServices.handle(call.method, call.params);
	},
	onRunEvent: (event) => coordinator.acceptSidecarEvent(event),
	onInterrupted: async (runIds, reason) => {
		relayBridge.abortAll();
		activityAgentRelayBridge.abortAll();
		planningRelayBridge.abortAll();
		activityReflectionRelayBridge?.abortAll();
		await coordinator.interruptRuns(runIds, reason);
	},
});
relayBridge = new SidecarModelRelayBridge({
	transport: modelRelay,
	modelId: configuredModelId,
	send: (event) => sidecar.sendRelayEvent(event),
});
activityAgentRelayBridge = new SidecarModelRelayBridge({
	transport: activityAgentModelRelay,
	modelId: configuredModelId,
	send: (event) => sidecar.sendRelayEvent(event),
});
planningRelayBridge = new SidecarModelRelayBridge({
	transport: planningModelRelay,
	modelId: planningModelId,
	send: (event) => sidecar.sendRelayEvent(event),
});
dynamicPlanningModel = new MastraPlanningModel({
	sidecar,
	modelVersion: `relay/${planningModelId}`,
	onInvocationAbort: (invocationId) => {
		planningRelayBridge.abortRun(invocationId);
	},
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
	abortModelRelay: (runId) =>
		relayBridge.abortRun(runId) ||
		activityAgentRelayBridge.abortRun(runId) ||
		planningRelayBridge.abortRun(runId),
	toolPolicy: agentToolPolicy,
	toolExecutor: agentToolExecutor,
	onEvent: (event) => {
		// Background activity analysis is an encrypted local-only workflow. Its
		// lifecycle and model output must never be broadcast to the renderer.
		if (isRendererAgentRunEvent(event)) clientRPC.send.agentRunEvent(event);
	},
	onActivityRunTerminal: (input) =>
		(async () => {
			if (
				input.status === "completed" &&
				input.feedback !== null &&
				proactiveFeedbackRuntime.isPresentationAllowed(
					input.sessionIdentity,
					input.feedback.generatedAtMs,
				)
			) {
				try {
					clientRPC.send.proactiveFeedbackAvailable({
						id: input.feedback.id,
						generatedAtMs: input.feedback.generatedAtMs,
					});
				} catch {
					// History is already durable; a renderer failure cannot roll back or
					// repeat the expensive Agent operation.
				}
				try {
					petActivityFeedbackDelivery?.present({
						presentationId: input.feedback.id,
						generatedAtMs: input.feedback.generatedAtMs,
						text: input.feedback.message,
					});
				} catch {
					// Pet delivery is online best-effort. The history remains authoritative.
				}
			}
			await activityAnalysisDispatcher?.onActivityRunTerminal(input);
		})(),
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
		controlTimeoutMs: 30_000,
	}),
	{ requireStartupGoalPreparation: true },
);
dataCenterSync = new DataCenterSyncService({
	baseUrl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL,
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
// The renderer publishes the persisted preference after it has loaded. Until
// then both the native window and sensitive feedback delivery stay fail closed.
let petVisible = false;
let shutdownRequested = false;
let shutdownPromise: Promise<void> | null = null;
const completedShutdownSteps = new Set<string>();
const shutdownFlights: Record<
	| "clientRequests"
	| "authTransitions"
	| "proactiveFeedback"
	| "agentRuns"
	| "dataCenter"
	| "updateBackground"
	| "privateExport"
	| "auditCapture"
	| "activityDelivery"
	| "modelRelays"
	| "sidecar"
	| "nativeAgent"
	| "timeline"
	| "reflection"
	| "repository",
	Promise<void> | null
> = {
	clientRequests: null,
	authTransitions: null,
	proactiveFeedback: null,
	agentRuns: null,
	dataCenter: null,
	updateBackground: null,
	privateExport: null,
	auditCapture: null,
	activityDelivery: null,
	modelRelays: null,
	sidecar: null,
	nativeAgent: null,
	timeline: null,
	reflection: null,
	repository: null,
};
type ShutdownFlightName = keyof typeof shutdownFlights;
const pendingShutdownFlights = new Set<Promise<void>>();
let shutdownAccountCaptured = false;
let capturedShutdownAccountId: string | null = null;
const FAST_SHUTDOWN_STEP_TIMEOUT_MS = 1_000;
const SIDECAR_SHUTDOWN_STEP_TIMEOUT_MS = 5_000;
const LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS = 13_000;
const OVERALL_SHUTDOWN_TIMEOUT_MS = 25_000;
const REPOSITORY_BARRIER_COVERED_SHUTDOWN_STEPS = new Set([
	"model-relays",
	"client-rpc",
	"app-update-background",
	"auth-transitions",
	"activity-window-delivery",
	"proactive-feedback-runtime",
	"agent-runs",
	"sensor-sidecar",
	"local-tool-host",
	"audit-capture",
	"private-training-export",
	"data-center-sync",
	"startup",
	"timeline",
	"reflection",
]);
let startupPromise: Promise<void> | null = null;
let cancelStartupRetryWait: (() => void) | null = null;
let planningRuntime: WhaleHallPlanningRuntime | null = null;
let planningMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let activityWindowDelivery: ActivityWindowDeliveryService | null = null;
let activityWindowDeliveryStore: ActivityWindowDeliveryStore | null = null;
interface ActivityWindowDeliveryLifecycleKey {
	accountId: string;
	sessionId: string;
	generation: number;
	source: WhaleHallReflectionRuntime["repository"];
}
interface ActivityWindowDeliveryLifecycleBundle {
	analyzer: MastraActivityReflectionAnalyzer | null;
	delivery: ActivityWindowDeliveryService | null;
	dispatcher: ActivityAnalysisDispatcher | null;
	store: ActivityWindowDeliveryStore;
}
const activityWindowDeliveryLifecycle = new ActivityWindowDeliveryLifecycle<
	ActivityWindowDeliveryLifecycleKey,
	ActivityWindowDeliveryLifecycleBundle
>({
	sameKey: (left, right) =>
		left.accountId === right.accountId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation &&
		left.source === right.source,
	release: async (bundle) => {
		await stopActivityWindowDeliveryResources(
			bundle,
			reportActivityWindowDeliveryCleanupFailure,
		);
		if (activityWindowDelivery === bundle.delivery) {
			activityWindowDelivery = null;
		}
		if (activityAnalysisDispatcher === bundle.dispatcher) {
			activityAnalysisDispatcher = null;
		}
		if (activityWindowDeliveryStore === bundle.store) {
			activityWindowDeliveryStore = null;
		}
		if (activityReflectionAnalyzer === bundle.analyzer) {
			activityReflectionAnalyzer = null;
		}
	},
});
const STARTUP_RETRY_DELAYS_MS = [
	1_000, 5_000, 15_000, 45_000, 120_000, 300_000,
];

function runShutdownFlight(
	name: ShutdownFlightName,
	operation: () => Promise<void>,
): Promise<void> {
	const current = shutdownFlights[name];
	if (current !== null) return current;
	const flight = Promise.resolve().then(operation);
	shutdownFlights[name] = flight;
	pendingShutdownFlights.add(flight);
	void flight
		.finally(() => pendingShutdownFlights.delete(flight))
		.catch(() => undefined);
	void flight.catch(() => {
		// A pending/successful exact owner flight is shared by every quit retry.
		// A settled failure is retryable, but the failed attempt's dependents still
		// observe that rejection and therefore cannot close the owner in front of it.
		if (shutdownFlights[name] === flight) shutdownFlights[name] = null;
	});
	return flight;
}

function waitForPendingShutdownFlights(): Promise<void> | null {
	const pending = [...pendingShutdownFlights];
	if (pending.length === 0) return null;
	return Promise.allSettled(pending).then(() => undefined);
}
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

function requireAuthenticatedSession() {
	const identity = authSession.captureCurrentSession();
	if (!identity) throw new RemoteAuthError("expired", "登录会话已失效。", 401);
	return identity;
}

async function proactiveFeedbackRpc<T>(
	operation: () => Promise<T>,
): Promise<ProactiveFeedbackRpcResult<T>> {
	try {
		return { kind: "success", data: await operation() };
	} catch (error) {
		if (error instanceof ProactiveFeedbackPolicyRevisionConflictError) {
			return {
				kind: "error",
				failure: "version-conflict",
				message: "主动反馈设置已发生变化，请刷新后重试。",
				currentRevision: error.actualRevision,
			};
		}
		if (error instanceof RemoteAuthError) {
			return {
				kind: "error",
				failure:
					error.kind === "expired" ? "signed-out" : "service-unavailable",
				message:
					error.kind === "expired"
						? "请先登录后再使用主动反馈。"
						: "主动反馈服务暂时不可用。",
			};
		}
		if (
			error instanceof EncryptedAgentRepositoryError &&
			error.code === "INVALID_ARGUMENT"
		) {
			return {
				kind: "error",
				failure: "invalid-request",
				message: "主动反馈请求格式无效。",
			};
		}
		const unavailable =
			error instanceof EncryptedAgentRepositoryError ||
			(error instanceof Error && error.name === "CredentialHelperError");
		return {
			kind: "error",
			failure: unavailable ? "service-unavailable" : "unexpected",
			message: unavailable
				? "本地主动反馈数据暂时不可用。"
				: "主动反馈操作没有完成，请稍后重试。",
		};
	}
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

function requireAppUpdateController(): AppUpdateController {
	if (appUpdateController === null) {
		throw new Error("The application update service is not ready.");
	}
	return appUpdateController;
}

type ClientRequestSchema = ClientRPC["bun"]["requests"];
type ClientRequestHandlers = {
	[Method in keyof ClientRequestSchema]: (
		input: ClientRequestSchema[Method]["params"],
	) =>
		| ClientRequestSchema[Method]["response"]
		| Promise<ClientRequestSchema[Method]["response"]>;
};

const clientRequestBarrier = new ShutdownWorkBarrier();
const shutdownAllowedClientRequests = new Set<keyof ClientRequestSchema>([
	"getAppUpdateStatus",
	"installAppUpdateAndRestart",
]);

const clientRequestHandlers: ClientRequestHandlers = {
	listPlans: async () => ({
		plans: await (await requirePlanningRuntime()).listPlans(),
	}),
	getPlan: async ({ planId }) => ({
		plan: await (await requirePlanningRuntime()).getPlan(planId),
	}),
	createPlanDraft: async ({ input, operationId }) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.createPlanDraft({ input, operationId });
		return { planId: plan.id };
	},
	sendPlanMessage: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.sendPlanMessage(command);
		throwIfPlanningAnalysisUnavailable(plan);
		return { plan: await runtime.getPlan(plan.id) };
	},
	confirmPlanRevision: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.confirmPlanRevision(command);
		await reconcileExecutingPlanningGoal();
		return { plan: await runtime.getPlan(plan.id) };
	},
	setPlanningTaskStatus: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.setTaskStatus(command);
		throwIfPlanningAnalysisUnavailable(plan);
		await reconcileExecutingPlanningGoal();
		return { plan: await runtime.getPlan(plan.id) };
	},
	confirmPlanningObservation: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.confirmObservationAttribution(command);
		throwIfPlanningAnalysisUnavailable(plan);
		return { plan: await runtime.getPlan(plan.id) };
	},
	pausePlan: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.pausePlan(command);
		await reconcileExecutingPlanningGoal();
		return { plan: await runtime.getPlan(plan.id) };
	},
	resumePlan: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.resumePlan(command);
		throwIfPlanningAnalysisUnavailable(plan);
		await reconcileExecutingPlanningGoal();
		return { plan: await runtime.getPlan(plan.id) };
	},
	completePlan: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.completePlan(command);
		await reconcileExecutingPlanningGoal();
		return { plan: await runtime.getPlan(plan.id) };
	},
	archivePlan: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.archivePlan(command);
		await reconcileExecutingPlanningGoal();
		return { plan: await runtime.getPlan(plan.id) };
	},
	undoPlanAdjustment: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.undoPlanAdjustment(command);
		await reconcileExecutingPlanningGoal();
		return { plan: await runtime.getPlan(plan.id) };
	},
	retryPendingPlanAnalysis: async (command) => {
		const runtime = await requirePlanningRuntime();
		const plan = await runtime.retryPendingAnalysis(command);
		throwIfPlanningAnalysisUnavailable(plan);
		return { plan: await runtime.getPlan(plan.id) };
	},
	loadPlanningCalendar: async () => {
		const events = await agent.listAllPlanningCalendar();
		const redactedTaskTitles = await planningCalendarTaskTitles(events);
		return {
			events: events.map((event) =>
				projectNativeCalendarEvent(
					event,
					redactedTaskTitles.get(event.eventId) ?? event.title,
				),
			),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		};
	},
	mutatePlanningCalendar: async (mutation) => {
		const result = await mutateRendererCalendar(mutation.mutationId, [
			mutation,
		]);
		if (!result.ok) {
			const conflict = result.conflicts[0] ?? {
				reason: "service-unavailable" as const,
				severity: "error" as const,
				affectedEventIds: [mutation.eventId],
				message: "本地日历暂时不可用，原安排保持不变。",
				nextAction: "keep-proposed" as const,
			};
			return {
				ok: false as const,
				mutationId: mutation.mutationId,
				conflict,
			};
		}
		return {
			ok: true as const,
			mutationId: mutation.mutationId,
			event: result.events[0] ?? null,
			warning: result.warnings[0] ?? null,
		};
	},
	mutatePlanningCalendarBatch: ({ batchId, mutations }) =>
		mutateRendererCalendar(batchId, mutations),
	getAppUpdateStatus: (input) => {
		if (!hasExactKeys(input, [])) {
			throw new Error("Invalid application update status request.");
		}
		return requireAppUpdateController().getStatus();
	},
	checkForAppUpdate: (input) => {
		if (!hasExactKeys(input, [])) {
			throw new Error("Invalid application update check request.");
		}
		return requireAppUpdateController().startCheck();
	},
	downloadAppUpdate: (input) => {
		if (!hasExactKeys(input, [])) {
			throw new Error("Invalid application update download request.");
		}
		return requireAppUpdateController().startDownload();
	},
	installAppUpdateAndRestart: (input) => {
		if (!hasExactKeys(input, [])) {
			throw new Error("Invalid application update install request.");
		}
		return requireAppUpdateController().startInstallAndRestart();
	},
	getProactiveFeedbackPolicy: (input) =>
		proactiveFeedbackRpc(async () => {
			if (!hasExactKeys(input, [])) {
				throw new EncryptedAgentRepositoryError(
					"INVALID_ARGUMENT",
					"Invalid proactive feedback policy request.",
				);
			}
			return proactiveFeedbackRuntime.getPolicy(requireAuthenticatedSession());
		}),
	setProactiveFeedbackPolicy: (input) =>
		proactiveFeedbackRpc(async () => {
			if (!isSetProactiveFeedbackPolicyRequest(input)) {
				throw new EncryptedAgentRepositoryError(
					"INVALID_ARGUMENT",
					"Invalid proactive feedback policy update.",
				);
			}
			return proactiveFeedbackRuntime.setPolicy(
				requireAuthenticatedSession(),
				input,
			);
		}),
	listProactiveFeedback: (input) =>
		proactiveFeedbackRpc(async () => {
			if (!isListProactiveFeedbackRequest(input)) {
				throw new EncryptedAgentRepositoryError(
					"INVALID_ARGUMENT",
					"Invalid proactive feedback history request.",
				);
			}
			return proactiveFeedbackRuntime.list(
				requireAuthenticatedSession(),
				input,
			);
		}),
	clearProactiveFeedbackData: (input) =>
		proactiveFeedbackRpc(async () => {
			if (!hasExactKeys(input, [])) {
				throw new EncryptedAgentRepositoryError(
					"INVALID_ARGUMENT",
					"Invalid proactive feedback clear request.",
				);
			}
			return proactiveFeedbackRuntime.clearData(requireAuthenticatedSession());
		}),
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
				throw new RemoteAuthError("expired", "登录会话已在恢复期间失效。", 401);
			}
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
				throw new RemoteAuthError("expired", "登录会话已在登录期间失效。", 401);
			}
			dataCenterSync?.start();
			return session;
		}),
	signOut: () =>
		authRpc(async () => {
			await authSession.signOut();
		}),
	loadCalendar: () => calendarRepository.load(requireAuthenticatedAccount()),
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
				void resumeTimelineRuntimeForAvailableVault(vault, timelineLifecycle);
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
			const recoveredVault = await agent.getVaultKeyStatus().catch(() => null);
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
	setPetVisible: async ({ visible }): Promise<{ visible: boolean }> => {
		petVisible = visible;
		if (!visible) {
			// Hide natively before waiting for the renderer to erase any sensitive
			// text. A failed acknowledgement keeps the replacement renderer hidden.
			petWindowController?.setVisible(false);
			petStateArbiter.resetToRuntime(agent.getLocalStatus());
		}
		await petActivityFeedbackDelivery?.setVisible(visible);
		if (visible) {
			petWindowController?.setVisible(!petActivityFeedbackRendererQuarantined);
		}
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
	startConversationTurn: (input) => coordinator.startConversationTurn(input),
	startTaskPlanningRun: (input) => coordinator.startTaskPlanningRun(input),
	submitPlanningClarification: (input) =>
		coordinator.submitPlanningClarification(input),
	decideAgentToolApproval: (input) =>
		coordinator.decideAgentToolApproval(input),
	cancelAgentRun: (input) => coordinator.cancelAgentRun(input),
	getAgentRunSnapshot: ({ runId }) => coordinator.getAgentRunSnapshot(runId),
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
};

async function dispatchClientRequest<Method extends keyof ClientRequestSchema>(
	method: Method,
	input: ClientRequestSchema[Method]["params"],
): Promise<ClientRequestSchema[Method]["response"]> {
	const allowedDuringShutdown = shutdownAllowedClientRequests.has(method);
	if (shutdownRequested && !allowedDuringShutdown) {
		throw new Error(
			"WhaleHall is shutting down; new client work is unavailable.",
		);
	}
	const handler = clientRequestHandlers[method] as (
		value: ClientRequestSchema[Method]["params"],
	) =>
		| ClientRequestSchema[Method]["response"]
		| Promise<ClientRequestSchema[Method]["response"]>;
	if (shutdownRequested) return await handler(input);
	return await clientRequestBarrier.run(() => handler(input));
}

const guardedClientRequestHandlers = Object.fromEntries(
	(Object.keys(clientRequestHandlers) as (keyof ClientRequestSchema)[]).map(
		(method) => [
			method,
			(input: ClientRequestSchema[typeof method]["params"]) =>
				dispatchClientRequest(method, input),
		],
	),
) as ClientRequestHandlers;

const drainClientRequests = () => clientRequestBarrier.drain();

const clientRPC = BrowserView.defineRPC<ClientRPC>({
	// A planning turn may consume the full verified-model budget and then make
	// one schema-repair attempt. Keep the transport alive for that bounded work;
	// normal monitoring/status requests retain their shorter service deadlines.
	maxRequestTime: 260_000,
	handlers: {
		requests: guardedClientRequestHandlers,
		messages: {},
	},
});

const petRPC = BrowserView.defineRPC<PetActivityFeedbackRPC>({
	maxRequestTime: 1000,
	handlers: {
		requests: {},
		messages: {
			ready: () => {
				const challenge = petActivityFeedbackDelivery?.rendererChallenge();
				if (challenge) schedulePetRendererProof(challenge);
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

function stopPetRendererProof(): void {
	if (petRendererProofTimer !== null) clearTimeout(petRendererProofTimer);
	petRendererProofTimer = null;
	petRendererProofInFlight = null;
}

function schedulePetRendererProof(
	challenge: PetActivityFeedbackRendererChallenge,
	delayMs = 0,
): void {
	if (shutdownRequested) return;
	const current = petActivityFeedbackDelivery?.rendererChallenge();
	if (current?.rendererEpoch !== challenge.rendererEpoch) return;
	if (petRendererProofTimer !== null) clearTimeout(petRendererProofTimer);
	petRendererProofTimer = setTimeout(() => {
		petRendererProofTimer = null;
		void provePetRenderer(challenge);
	}, delayMs);
}

async function provePetRenderer(
	challenge: PetActivityFeedbackRendererChallenge,
): Promise<void> {
	if (
		shutdownRequested ||
		petRendererProofInFlight === challenge.rendererEpoch
	) {
		return;
	}
	const current = petActivityFeedbackDelivery?.rendererChallenge();
	if (current?.rendererEpoch !== challenge.rendererEpoch) return;
	petRendererProofInFlight = challenge.rendererEpoch;
	try {
		const response =
			await petRPC.request.proveActivityFeedbackRenderer(challenge);
		if (shutdownRequested) return;
		if (petActivityFeedbackDelivery?.markRendererReady(response)) {
			console.log("[pet] React renderer ready");
			petActivityFeedbackRendererQuarantined = false;
			petWindowController?.setVisible(petVisible);
			petStateArbiter.resetToRuntime(agent.getLocalStatus());
			return;
		}
	} catch {
		// Retry the exact document challenge; the native window remains hidden.
	} finally {
		if (petRendererProofInFlight === challenge.rendererEpoch) {
			petRendererProofInFlight = null;
		}
	}
	const retry = petActivityFeedbackDelivery?.rendererChallenge();
	if (retry?.rendererEpoch === challenge.rendererEpoch) {
		schedulePetRendererProof(retry, 250);
	}
}

petActivityFeedbackDelivery = new PetActivityFeedbackDelivery({
	initiallyVisible: petVisible,
	present: (presentation) => petRPC.send.presentActivityFeedback(presentation),
	clear: ({ clearId }) => petRPC.request.clearActivityFeedback({ clearId }),
	failClosedAfterClearFailure: async ({ reloadRequired, rendererEpoch }) => {
		petActivityFeedbackRendererQuarantined = true;
		petWindowController?.setVisible(false);
		if (!reloadRequired) return;
		try {
			const url = await viewUrl("pet");
			if (
				shutdownRequested ||
				!petActivityFeedbackDelivery?.isRendererAttemptCurrent(rendererEpoch)
			) {
				return;
			}
			petWindow?.webview.loadURL(url);
		} catch {
			// The native window remains hidden until a fresh renderer reaches ready.
		}
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
		if (appUpdateController !== null) {
			clientRPC.send.appUpdateStatusChanged(appUpdateController.getStatus());
		}
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
		reflectionRuntime?.beginShutdown();
		timelineLifecycle.beginShutdown();
		deferredReflectionOperations.close();
		activityWindowDeliveryLifecycle.close();
		clientRequestBarrier.close();
		dataCenterSync?.beginShutdown();
		appUpdateController?.beginShutdown();
		authSession.beginShutdown();
		relayBridge.beginShutdown();
		activityAgentRelayBridge.beginShutdown();
		planningRelayBridge.beginShutdown();
		activityReflectionRelayBridge?.beginShutdown();
		shutdownRequested = true;
		agent.beginShutdown();
		sidecar.beginShutdown();
	},
	shutdown,
	waitForShutdownRetry: () => waitForPendingShutdownFlights(),
	exit: () => Utils.quit(),
	onError(operation, error) {
		console.error(
			`[lifecycle] ${operation} failed:`,
			error instanceof Error ? error.name : "UNKNOWN",
		);
	},
});

appUpdateController = new AppUpdateController({
	updater: createElectrobunAppUpdaterAdapter(Updater, {
		exitForUpdate: () => Utils.quit(),
	}),
	publicKeySpkiBase64:
		process.env.WHALEHALL_APP_UPDATE_PUBLIC_KEY_SPKI_BASE64?.trim() ?? "",
	downloadDirectory: join(Utils.paths.userData, "updates"),
	prepareForInstall: async () => {
		await clientLifecycle.prepareForExternalExit();
		return { ready: true };
	},
	onPreparedInstallFailure: () => {
		// A successful preparation has already stopped every persistence owner.
		// If replacement unexpectedly returns/fails, exit the quiesced old process;
		// the installed version remains untouched and can be reopened for retry.
		queueMicrotask(() => Utils.quit());
	},
});
appUpdateController.subscribe((snapshot) => {
	if (clientWindow !== null) clientRPC.send.appUpdateStatusChanged(snapshot);
});
appUpdateController.startAutomaticChecks();
await clientLifecycle.open();

petActivityFeedbackDelivery.beginRendererLoad();
petWindow = new BrowserWindow({
	title: "WhaleHall Pet",
	url: null,
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
petActivityFeedbackRendererQuarantined = true;
petWindowController.setVisible(false);

agent.onStatusChange(sendLocalStatus);
agent.onToolEvent(sendToolEvent);
petWindow.webview.on("did-commit-navigation", () => {
	petActivityFeedbackRendererQuarantined = true;
	petWindowController.setVisible(false);
	petActivityFeedbackDelivery?.markRendererNavigationCommitted();
});
petWindow.webview.on("dom-ready", () => {
	console.log("[pet] DOM ready");
	petActivityFeedbackRendererQuarantined = true;
	petWindowController.setVisible(false);
	const challenge = petActivityFeedbackDelivery?.markRendererDocumentReady();
	if (challenge) schedulePetRendererProof(challenge);
	sendLocalStatus();
});
petWindow.webview.loadURL(await viewUrl("pet"));

function shutdown(): Promise<void> {
	reflectionRuntime?.beginShutdown();
	timelineLifecycle.beginShutdown();
	dynamicPlanningModel?.close();
	deferredReflectionOperations.close();
	activityWindowDeliveryLifecycle.close();
	shutdownRequested = true;
	agent.beginShutdown();
	sidecar.beginShutdown();
	if (planningMaintenanceTimer !== null) {
		clearInterval(planningMaintenanceTimer);
		planningMaintenanceTimer = null;
	}
	if (shutdownPromise) return shutdownPromise;
	if (!shutdownAccountCaptured) {
		shutdownAccountCaptured = true;
		capturedShutdownAccountId = authSession.accountId;
	}
	const drainClientRpc = () =>
		runShutdownFlight("clientRequests", drainClientRequests);
	const drainAuthTransitions = () =>
		runShutdownFlight("authTransitions", () => authSession.drain());
	const drainProactiveFeedback = () =>
		runShutdownFlight("proactiveFeedback", () =>
			proactiveFeedbackRuntime.shutdown(),
		);
	const drainAgentRuns = () =>
		runShutdownFlight("agentRuns", async () => {
			// A renderer request accepted before the synchronous ingress latch may
			// still be entering the coordinator, while a Sidecar event may already be
			// parsed behind an accepted host call. Establish the stable consumer set
			// only after both exact ingress sets have drained.
			await drainClientRpc();
			await sidecar.drainAcceptedFrames();
			if (capturedShutdownAccountId) {
				await coordinator.cancelAllForAccount(capturedShutdownAccountId);
			}
		});
	const drainDataCenter = () =>
		runShutdownFlight(
			"dataCenter",
			() => dataCenterSync?.stop() ?? Promise.resolve(),
		);
	const drainUpdateBackground = () =>
		runShutdownFlight(
			"updateBackground",
			() => appUpdateController?.drainBackgroundWork() ?? Promise.resolve(),
		);
	const drainPrivateExport = () =>
		runShutdownFlight("privateExport", () =>
			privateTrainingExportCoordinator.shutdown(),
		);
	const drainAuditCapture = () =>
		runShutdownFlight("auditCapture", () => auditCaptureCoordinator.shutdown());
	const drainActivityDelivery = () =>
		runShutdownFlight("activityDelivery", stopActivityWindowDelivery);
	const drainModelRelays = () =>
		runShutdownFlight("modelRelays", async () => {
			await Promise.all([
				relayBridge.abortAllAndDrain(),
				activityAgentRelayBridge.abortAllAndDrain(),
				planningRelayBridge.abortAllAndDrain(),
				activityReflectionRelayBridge?.abortAllAndDrain() ?? Promise.resolve(),
			]);
		});
	const stopSidecar = () =>
		runShutdownFlight("sidecar", async () => {
			// Both Agent runs and first-stage Reflection invocations own sidecar work.
			// Never terminate their process owner before the exact accepted sets have
			// either completed or reached their durable interruption state.
			await Promise.all([
				drainAgentRuns(),
				drainActivityDelivery(),
				drainModelRelays(),
			]);
			await sidecar.stop();
			await sidecar.drainInterruptions();
		});
	const closeTimeline = () =>
		runShutdownFlight("timeline", async () => {
			// Audit and export operations dereference the Timeline runtime after
			// asynchronous dialogs, reads and encryption. Their earlier observable
			// shutdown step may time out, so the owner itself repeats the exact join.
			await Promise.all([
				drainClientRpc(),
				drainAuditCapture(),
				drainPrivateExport(),
			]);
			// close() synchronously seals Timeline candidate ingress, then joins an
			// in-flight start. Calling it before joining startup avoids waiting forever
			// on a candidate that needs this close latch to observe shutdown.
			await timelineLifecycle.close();
			await startupPromise;
		});
	const closeReflection = () =>
		runShutdownFlight("reflection", async () => {
			// Timeline, proactive policy mutations and activity delivery all retain
			// Reflection repository/service references. Join them again at the owner
			// boundary even if a prior diagnostic step exceeded its deadline.
			await Promise.all([
				drainClientRpc(),
				drainProactiveFeedback(),
				drainActivityDelivery(),
				closeTimeline(),
				startupPromise,
			]);
			const runtime = reflectionRuntime;
			if (runtime === null) return;
			await runtime.close();
			if (reflectionRuntime === runtime) reflectionRuntime = null;
		});
	const stopNativeAgent = () =>
		runShutdownFlight("nativeAgent", async () => {
			await stopNativeAgentWithReflection({
				drainProducers: async () => {
					// These ingress owners are already synchronously latched. Join their
					// accepted work before stopping the shared native process.
					await Promise.all([
						drainClientRpc(),
						drainAgentRuns(),
						drainDataCenter(),
						drainAuditCapture(),
						drainPrivateExport(),
					]);
				},
				// LocalToolClient rejects every pending RPC synchronously when stop
				// begins. Start that release before Reflection joins its operation tail.
				stopNativeAgent: () => agent.stop(),
				closeReflection,
			});
		});
	const closeAgentRepository = () =>
		runShutdownFlight("repository", () =>
			closeOwnerAfterDraining(
				async () => {
					// Never close the encrypted database in front of work accepted before
					// the synchronous latch. Earlier step deadlines do not cancel these
					// exact flights, so the owner boundary joins them again.
					await Promise.all([
						drainClientRpc(),
						drainProactiveFeedback(),
						drainActivityDelivery(),
						drainModelRelays(),
						drainAgentRuns(),
						drainDataCenter(),
						drainUpdateBackground(),
						drainPrivateExport(),
						drainAuditCapture(),
						stopSidecar(),
						stopNativeAgent(),
						closeTimeline(),
						closeReflection(),
						startupPromise,
					]);
				},
				// A sign-out accepted before the latch can register its best-effort
				// remote revoke at the end of its transition, so drain auth only after
				// every producer above has settled.
				() => authSession.drain(),
				() => agentRepository.close(),
			),
		);
	const steps = [
		{
			name: "startup-retry",
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => cancelStartupRetryWait?.(),
		},
		{
			name: "model-relays",
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainModelRelays,
		},
		{
			name: "client-rpc",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainClientRpc,
		},
		{
			name: "app-update-background",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainUpdateBackground,
		},
		{
			name: "auth-transitions",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainAuthTransitions,
		},
		{
			name: "activity-window-delivery",
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainActivityDelivery,
		},
		{
			name: "proactive-feedback-runtime",
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainProactiveFeedback,
		},
		{
			name: "agent-runs",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainAgentRuns,
		},
		{
			name: "pet-activity-feedback",
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: () => {
				stopPetRendererProof();
				petActivityFeedbackDelivery?.dispose();
			},
		},
		{
			name: "sensor-sidecar",
			critical: true,
			timeoutMs: SIDECAR_SHUTDOWN_STEP_TIMEOUT_MS,
			run: stopSidecar,
		},
		{
			name: "local-tool-host",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: stopNativeAgent,
		},
		{
			name: "audit-capture",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainAuditCapture,
		},
		{
			name: "private-training-export",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainPrivateExport,
		},
		{
			name: "data-center-sync",
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: drainDataCenter,
		},
		{
			name: "startup",
			critical: true,
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
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: closeTimeline,
		},
		{
			name: "reflection",
			critical: true,
			timeoutMs: FAST_SHUTDOWN_STEP_TIMEOUT_MS,
			run: closeReflection,
		},
		{
			name: "agent-repository",
			critical: true,
			timeoutMs: LOCAL_TOOL_SHUTDOWN_STEP_TIMEOUT_MS,
			run: closeAgentRepository,
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
			isCriticalFailureRecovered(step) {
				if (completedShutdownSteps.has(step)) return true;
				return (
					completedShutdownSteps.has("agent-repository") &&
					REPOSITORY_BARRIER_COVERED_SHUTDOWN_STEPS.has(step)
				);
			},
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
			planningRuntime = null;
			if (shutdownPromise === operation) shutdownPromise = null;
		},
		() => {
			if (shutdownPromise === operation) shutdownPromise = null;
		},
	);
	return operation;
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
self.addEventListener("message", (event: MessageEvent<unknown>) => {
	if (!isWhaleHallLifecycleSignalMessage(event.data)) return;
	void clientLifecycle.quit();
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
				cloudOwnerAccountId: () =>
					proactiveFeedbackRuntime.cloudOwnerAccountId(),
				onWindowSealed: (window) => {
					const delivery = activityWindowDelivery;
					if (delivery === null || shutdownRequested) return;
					return delivery.enqueueWindow(window);
				},
			});
			if (shutdownRequested) {
				await candidate.close();
				return;
			}
			await candidate.service.start();
			if (shutdownRequested) {
				await candidate.close();
				return;
			}
			await publishReflectionRuntime(candidate);
			candidate = null;
			if (shutdownRequested) return;
			const startupOwner = authSession.captureCurrentSession();
			if (startupOwner !== null && authSession.isCurrentSession(startupOwner)) {
				await proactiveFeedbackRuntime.sessionReadyForAuth(startupOwner);
			}
			if (authSession.accountId) {
				await planningAuthority.load();
			}
			planningRuntime = new WhaleHallPlanningRuntime(
				agent,
				{
					planChanged(change) {
						if (clientWindow !== null) clientRPC.send.planChanged(change);
					},
					calendarChanged(version) {
						if (clientWindow !== null) {
							clientRPC.send.calendarChanged({ version });
						}
					},
				},
				() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
				requireDynamicPlanningModel(),
			);
			await reconcileExecutingPlanningGoal();
			startPlanningMaintenance();
			try {
				await timelineLifecycle.ensureStarted({
					retryOnFailure: true,
				});
			} catch (error) {
				if (isObservationEncryptionUnavailable(error)) {
					// Keychain can be unavailable before first unlock or after an
					// ad-hoc development re-sign. Keep the healthy native process
					// available for monitoring/configuration, while Timeline v2
					// and decrypted export remain fail closed.
					console.warn(
						"WhaleHall Timeline v2 is unavailable because the local encryption key cannot be opened; monitoring remains available.",
					);
				} else {
					// Timeline is an optional derived view. Its lifecycle owns a
					// bounded retry and must never tear down the already-published
					// Reflection collector that feeds proactive feedback.
					console.warn(
						"WhaleHall Timeline v2 is temporarily unavailable; monitoring and Reflection remain available.",
					);
				}
				return;
			}
			if (shutdownRequested) {
				await timelineLifecycle.close();
				const runtime = currentReflectionRuntime();
				if (reflectionRuntime === runtime) reflectionRuntime = null;
				await runtime?.close();
				return;
			}
			console.log(
				"WhaleHall Timeline v2 ready; deterministic classification and cited hypotheses active.",
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
			const runtime = currentReflectionRuntime();
			if (runtime) {
				if (reflectionRuntime === runtime) reflectionRuntime = null;
				await runtime.close().catch((closeError) => {
					console.error(
						"WhaleHall reflection runtime cleanup failed:",
						closeError,
					);
				});
			}
			planningRuntime = null;
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
	const owner = authSession.captureCurrentSession();
	const configuration = activityReflectionConfiguration;
	const reflectionBridge = activityReflectionRelayBridge;
	if (reflectionBridge === null || owner === null || shutdownRequested) {
		return;
	}
	if (
		reflectionRuntime?.repository !== source ||
		proactiveFeedbackRuntime.cloudOwnerAccountId() !== owner.accountId
	) {
		throw new Error(
			"Activity window delivery cannot start without its exact live owner.",
		);
	}
	const key: ActivityWindowDeliveryLifecycleKey = {
		accountId: owner.accountId,
		sessionId: owner.sessionId,
		generation: owner.generation,
		source,
	};
	await activityWindowDeliveryLifecycle.start(key, async (attempt) => {
		const isAttemptCurrent = (): boolean =>
			attempt.isCurrent() &&
			!shutdownRequested &&
			reflectionRuntime?.repository === source &&
			authSession.isCurrentSession(owner) &&
			proactiveFeedbackRuntime.cloudOwnerAccountId() === owner.accountId;
		const assertAttemptCurrent = (): void => {
			attempt.assertCurrent();
			if (!isAttemptCurrent()) {
				throw new Error(
					"Activity window delivery owner changed during activation.",
				);
			}
		};
		assertAttemptCurrent();
		const store = new ActivityWindowDeliveryStore(
			activityWindowDeliveryDatabasePath(owner.accountId),
		);
		const bundle: ActivityWindowDeliveryLifecycleBundle = {
			analyzer: null,
			delivery: null,
			dispatcher: null,
			store,
		};
		attempt.own(bundle);
		activityWindowDeliveryStore = store;
		// Pre-policy Worker receipts have no matching encrypted archive and were
		// collected before the user had an authoritative proactive-feedback
		// setting. The pending marker blocks dispatch across both cleanup gaps.
		await completeLegacyActivityPolicyCutover(
			store,
			source,
			agentRepository,
			owner.accountId,
		);
		assertAttemptCurrent();
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: configuration.scoreThreshold,
			auth: authSession,
			coordinator,
			repository: agentRepository,
			isEligible: (identity) =>
				isAttemptCurrent() &&
				authSession.isCurrentSession(identity) &&
				identity.accountId === owner.accountId &&
				identity.sessionId === owner.sessionId &&
				identity.generation === owner.generation,
			onError: (error) => {
				console.warn(
					"WhaleHall local activity Agent job retry:",
					error instanceof Error ? error.name : "UNKNOWN",
				);
			},
		});
		bundle.dispatcher = dispatcher;
		activityAnalysisDispatcher = dispatcher;
		// Policy: Bun constructs the complete raw-window prompt and normalizes the
		// response. The no-persistence Mastra workflow calls the host-only generic
		// relay, which only authenticates and forwards to the CPU model.
		const analyzer = new MastraActivityReflectionAnalyzer({
			sidecar,
			onInvocationAbort: (invocationId) =>
				reflectionBridge.abortRun(invocationId),
		});
		bundle.analyzer = analyzer;
		activityReflectionAnalyzer = analyzer;
		const delivery = new ActivityWindowDeliveryService({
			source,
			analyzer,
			store,
			scoreThreshold: configuration.scoreThreshold,
			archiveAnalysisBeforeReceipt: async ({
				owner: archiveOwner,
				sourceWindow,
				requestId,
				analysis,
				archivedAtMs,
			}) => {
				if (
					!isAttemptCurrent() ||
					!authSession.isCurrentSession(archiveOwner) ||
					proactiveFeedbackRuntime.cloudOwnerAccountId() !==
						archiveOwner.accountId
				) {
					throw new Error(
						"Activity archive session changed before persistence.",
					);
				}
				const recentFeedback = await agentRepository.listProactiveFeedback(
					archiveOwner.accountId,
					{ limit: 2 },
				);
				if (
					!isAttemptCurrent() ||
					!authSession.isCurrentSession(archiveOwner) ||
					proactiveFeedbackRuntime.cloudOwnerAccountId() !==
						archiveOwner.accountId
				) {
					throw new Error(
						"Activity archive session changed while snapshotting support context.",
					);
				}
				await agentRepository.archiveProactiveFeedbackEventStream({
					accountId: archiveOwner.accountId,
					id: requestId,
					sourceWindowId: sourceWindow.windowId,
					windowStartedAtMs: sourceWindow.startedAtMs,
					windowEndedAtMs: sourceWindow.endedAtMs,
					analysis,
					supportPersonalization: createActivitySupportPersonalization({
						activeGoal: sourceWindow.goal,
						recentFeedback: recentFeedback.items,
					}),
					archivedAtMs,
					consumedAtMs: null,
					consumedRunId: null,
				});
			},
			recoverArchivedAnalysis: async ({
				owner: archiveOwner,
				sourceWindow,
				requestId,
			}) => {
				if (
					!isAttemptCurrent() ||
					!authSession.isCurrentSession(archiveOwner) ||
					proactiveFeedbackRuntime.cloudOwnerAccountId() !==
						archiveOwner.accountId
				) {
					return null;
				}
				let archived: Awaited<
					ReturnType<typeof agentRepository.getProactiveFeedbackEventStream>
				>;
				try {
					archived = await agentRepository.getProactiveFeedbackEventStream(
						archiveOwner.accountId,
						requestId,
					);
				} catch (error) {
					if (
						error instanceof EncryptedAgentRepositoryError &&
						(error.code === "INVALID_ARGUMENT" ||
							error.code === "ACCOUNT_KEY_MISSING" ||
							error.code === "DECRYPTION_FAILED" ||
							error.code === "SCHEMA_UNSUPPORTED")
					) {
						return { kind: "invalid" as const };
					}
					throw error;
				}
				if (archived === null) return null;
				if (
					archived.sourceWindowId !== sourceWindow.windowId ||
					archived.windowStartedAtMs !== sourceWindow.startedAtMs ||
					archived.windowEndedAtMs !== sourceWindow.endedAtMs
				) {
					return { kind: "invalid" as const };
				}
				return archived.consumedAtMs === null && archived.consumedRunId === null
					? { kind: "pending" as const, analysis: archived.analysis }
					: archived.consumedAtMs !== null && archived.consumedRunId !== null
						? { kind: "consumed" as const }
						: { kind: "invalid" as const };
			},
			acknowledgeSourceAfterReceipt: async ({
				owner: archiveOwner,
				sourceWindowId,
			}) => {
				if (
					!isAttemptCurrent() ||
					!authSession.isCurrentSession(archiveOwner) ||
					proactiveFeedbackRuntime.cloudOwnerAccountId() !==
						archiveOwner.accountId
				) {
					throw new Error(
						"Activity source session changed before acknowledgement.",
					);
				}
				const acknowledged = await source.acknowledgeWindowForAccount(
					archiveOwner.accountId,
					sourceWindowId,
				);
				if (!acknowledged) {
					throw new Error("Activity source belongs to another account.");
				}
			},
			onAgentTriggerRequired: () => dispatcher.wake(),
			currentSession: () => {
				if (!isAttemptCurrent()) return null;
				const current = authSession.captureCurrentSession();
				return current !== null && authSession.isCurrentSession(owner)
					? current
					: null;
			},
			isCurrentSession: (identity) =>
				isAttemptCurrent() &&
				authSession.isCurrentSession(identity) &&
				proactiveFeedbackRuntime.cloudOwnerAccountId() === identity.accountId,
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
		bundle.delivery = delivery;
		activityWindowDelivery = delivery;
		assertAttemptCurrent();
		await dispatcher.startAndRecover();
		assertAttemptCurrent();
		await delivery.start();
		assertAttemptCurrent();
		// Claiming an Agent job is the first provider-capable transition. Keep it
		// after delivery activation so shutdown can invalidate a blocked start
		// without a dispatcher escaping the lifecycle join barrier.
		dispatcher.start();
		assertAttemptCurrent();
	});
}

function activityWindowDeliveryDatabasePath(accountId: string): string {
	return join(
		localDataPath,
		`activity-window-worker-${encodeURIComponent(accountId)}.sqlite3`,
	);
}

function clearActivityWindowDeliveryLedger(accountId: string): void {
	const databasePath = activityWindowDeliveryDatabasePath(accountId);
	if (!existsSync(databasePath)) return;
	const store = new ActivityWindowDeliveryStore(databasePath);
	try {
		store.clearPendingActivityAnalysisData(accountId);
	} finally {
		store.close();
	}
}

function protectedActivityWindowDeliveryRunIds(
	accountId: string,
): readonly string[] {
	const liveStore = activityWindowDeliveryStore;
	if (liveStore !== null) return liveStore.phaseTwoPendingRunIds(accountId);
	const databasePath = activityWindowDeliveryDatabasePath(accountId);
	if (!existsSync(databasePath)) return [];
	const store = new ActivityWindowDeliveryStore(databasePath);
	try {
		return store.phaseTwoPendingRunIds(accountId);
	} finally {
		store.close();
	}
}

function stopActivityWindowDelivery(): Promise<void> {
	return activityWindowDeliveryLifecycle.stop();
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
async function requirePlanningRuntime(): Promise<WhaleHallPlanningRuntime> {
	if (planningRuntime !== null) return planningRuntime;
	await startupPromise;
	if (planningRuntime === null) {
		throw new Error("PLANNING_OFFLINE");
	}
	return planningRuntime;
}

function requireDynamicPlanningModel(): MastraPlanningModel {
	if (dynamicPlanningModel === null) {
		throw new Error("Dynamic Planning model bridge is not initialized.");
	}
	return dynamicPlanningModel;
}

function throwIfPlanningAnalysisUnavailable(plan: {
	analysisDiagnostic: unknown;
}): void {
	if (plan.analysisDiagnostic !== null) {
		throw new Error("MODEL_UNAVAILABLE");
	}
}

function projectNativeCalendarEvent(
	event: import("../agent/local-protocol").LocalPlanningCalendarEvent,
	title = event.title,
): PlanningCalendarEventProjection {
	return {
		id: event.eventId,
		title,
		kind: event.kind,
		state: event.state,
		schedule: structuredClone(event.schedule),
		recurrence: event.recurrence ? structuredClone(event.recurrence) : null,
		occurrenceId: event.occurrenceId,
		sourcePlanId: event.sourcePlanId,
		sourceTaskId: event.sourceTaskId,
		scheduleOrigin: event.scheduleOrigin,
		userLocked: event.userLocked,
		editable: event.editable,
		version: event.version,
	};
}

async function planningCalendarTaskTitles(
	events: readonly import("../agent/local-protocol").LocalPlanningCalendarEvent[],
): Promise<Map<string, string>> {
	const planning = await requirePlanningRuntime();
	const planIds = new Set(
		events.flatMap((event) =>
			event.redactedContent && event.sourcePlanId ? [event.sourcePlanId] : [],
		),
	);
	const tasksByPlan = new Map<string, Map<string, string>>();
	await Promise.all(
		[...planIds].map(async (planId) => {
			const plan = await planning.runtime.getPlan(planId).catch(() => null);
			if (!plan) return;
			tasksByPlan.set(
				planId,
				new Map(plan.tasks.map((task) => [task.id, task.title])),
			);
		}),
	);
	const titles = new Map<string, string>();
	for (const event of events) {
		if (!event.redactedContent || !event.sourcePlanId || !event.sourceTaskId) {
			continue;
		}
		const title = tasksByPlan.get(event.sourcePlanId)?.get(event.sourceTaskId);
		if (title) titles.set(event.eventId, title);
	}
	return titles;
}

function nativeCalendarEvent(
	event: PlanningCalendarEventProjection,
	forceUserLock: boolean,
): import("../agent/local-protocol").LocalPlanningCalendarEvent {
	return {
		schemaVersion: "calendar.v1",
		eventId: event.id,
		title:
			event.kind === "plan" && event.scheduleOrigin === "model"
				? "计划任务"
				: event.title,
		sealedContentRef: null,
		redactedContent: event.kind === "plan" && event.scheduleOrigin === "model",
		kind: event.kind,
		state: event.state,
		schedule: structuredClone(event.schedule),
		recurrence: event.recurrence ? structuredClone(event.recurrence) : null,
		occurrenceId: event.occurrenceId,
		sourcePlanId: event.sourcePlanId,
		sourceTaskId: event.sourceTaskId,
		scheduleOrigin:
			event.kind === "plan" ? (event.scheduleOrigin ?? "user") : null,
		userLocked: event.userLocked || forceUserLock,
		editable: event.editable,
		version: event.version,
	};
}

async function mutateRendererCalendar(
	batchId: string,
	mutations: readonly PlanningCalendarMutationProjection[],
): Promise<import("../shared/planning").PlanningCalendarBatchResultProjection> {
	const affectedPlanIds = [
		...new Set(
			mutations
				.flatMap((mutation) => [
					mutation.before?.sourcePlanId ?? "",
					mutation.after?.sourcePlanId ?? "",
				])
				.filter(Boolean),
		),
	];
	const mutation = await runDurableCalendarMutation({
		commit: () =>
			agent.mutatePlanningCalendar({
				operationId: batchId,
				actor: "user",
				mutations: mutations.map((mutation) => {
					if (mutation.kind === "delete") {
						return {
							action: "delete" as const,
							eventId: mutation.eventId,
							expectedVersion: mutation.expectedVersion ?? 0,
						};
					}
					if (mutation.after === null) {
						throw new Error(
							"PLANNING_VALIDATION: calendar upsert requires an after event",
						);
					}
					return {
						action: "upsert" as const,
						expectedVersion: mutation.expectedVersion,
						event: nativeCalendarEvent(
							mutation.after,
							shouldForceRendererPlanLock(mutation),
						),
					};
				}),
				outbox: [
					{
						entryId: `renderer-calendar:${batchId}`,
						kind: "calendar-changed",
						aggregateId: "calendar",
						payload: {
							batchId,
							mutationCount: mutations.length,
							planIds: affectedPlanIds,
							requiresPlanningReestimate: true,
						},
						createdAtMs: Date.now(),
					},
				],
			}),
		project: (result) =>
			result.outcomes.flatMap((outcome) =>
				outcome.event ? [projectNativeCalendarEvent(outcome.event)] : [],
			),
		followUps: [
			{
				stage: "outbox-flush",
				run: async () => {
					const planning = await requirePlanningRuntime();
					await planning.flushOutbox();
				},
			},
			{
				stage: "execution-reconciliation",
				run: reconcileExecutingPlanningGoal,
			},
		],
		onDeferredFailure: reportCommittedCalendarFailure,
	});
	if (!mutation.committed) {
		const error = mutation.error;
		const stale =
			error !== null &&
			typeof error === "object" &&
			(("code" in error && String(error.code) === "BUSY") ||
				("details" in error &&
					error.details !== null &&
					typeof error.details === "object" &&
					"reason" in error.details &&
					String(error.details.reason) === "stale-version"));
		return {
			ok: false,
			batchId,
			conflicts: [
				{
					reason: stale ? "stale-version" : "service-unavailable",
					severity: "error",
					affectedEventIds: mutations.map((item) => item.eventId),
					message: stale
						? "日程已被其他操作更新，请重新载入。"
						: "本地日历暂时不可用，原安排保持不变。",
					nextAction: stale ? "retry" : "keep-proposed",
				},
			],
		};
	}

	// A projection failure must retain the renderer's optimistic post-commit
	// state until the durable outbox invalidation reloads the authoritative
	// snapshot. Deletes intentionally have no projected event.
	const events = calendarEventsAfterDurableCommit(
		mutations,
		mutation.projection,
	);
	return { ok: true, batchId, events, warnings: [] };
}

function reportCommittedCalendarFailure(
	stage: DurableCalendarPostCommitStage,
	error: unknown,
): void {
	console.warn(
		"[planning] committed calendar follow-up deferred",
		stage,
		error instanceof Error ? error.name : "UNKNOWN",
	);
}

let planningMaintenanceRunning = false;

function startPlanningMaintenance(): void {
	if (planningMaintenanceTimer !== null) return;
	void runPlanningMaintenance();
	planningMaintenanceTimer = setInterval(() => {
		void runPlanningMaintenance();
	}, 60_000);
}

async function runPlanningMaintenance(): Promise<void> {
	if (planningMaintenanceRunning || shutdownPromise !== null) return;
	planningMaintenanceRunning = true;
	try {
		const planning = planningRuntime;
		if (!planning) return;
		await planning.flushOutbox();
		await planning.recoverPendingAdjustments();
		await planning.runDailySummaries();
		const timeline = timelineLifecycle.current;
		if (timeline) {
			await timeline.service.releaseAgentInputs();
			for (;;) {
				const batch = await timeline.service.queryAgentInputs({
					limit: 32,
					leaseDurationMs: 120_000,
				});
				if (batch.inputs.length === 0) break;
				for (const envelope of batch.inputs) {
					if (envelope.state !== "LEASED" || !envelope.leaseToken) continue;
					await planning.consumeTimelineInput(envelope.input);
					await timeline.service.commitAgentInput(
						envelope.input.agentInputId,
						envelope.leaseToken,
					);
				}
				if (batch.inputs.length < 32) break;
			}
		}
		await reconcileExecutingPlanningGoal();
		await planning.collectVaultGarbageIfDue();
	} catch (error) {
		console.warn(
			"[planning] local maintenance retry",
			error instanceof Error ? error.name : "UNKNOWN",
		);
	} finally {
		planningMaintenanceRunning = false;
	}
}

async function reconcileExecutingPlanningGoal(): Promise<void> {
	const planning = planningRuntime;
	const reflection = reflectionRuntime;
	if (!planning || !reflection) return;
	const now = Date.now();
	const events = (await agent.listAllPlanningCalendar())
		.filter(
			(event) =>
				event.kind === "plan" &&
				event.state === "committed" &&
				!event.schedule.allDay &&
				event.sourcePlanId !== null &&
				event.sourceTaskId !== null &&
				Date.parse(event.schedule.start) <= now &&
				Date.parse(event.schedule.end) > now,
		)
		.sort((left, right) =>
			left.schedule.allDay || right.schedule.allDay
				? 0
				: left.schedule.start.localeCompare(right.schedule.start),
		);
	const event = events[0];
	if (
		!event ||
		event.schedule.allDay ||
		!event.sourcePlanId ||
		!event.sourceTaskId
	) {
		await setRuntimeGoal(reflection, null);
		return;
	}
	const plan = await planning.runtime
		.getPlan(event.sourcePlanId)
		.catch(() => null);
	const task = plan?.tasks.find((item) => item.id === event.sourceTaskId);
	if (!plan || !task || plan.status !== "active" || task.status !== "pending") {
		await setRuntimeGoal(reflection, null);
		return;
	}
	await setRuntimeGoal(reflection, {
		goalId: task.id,
		planId: plan.id,
		text: task.title,
		activatedAtMs: Date.parse(event.schedule.start),
	});
	await timelineLifecycle.current?.service.pullNow();
}
