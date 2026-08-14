import { join } from "node:path";
import {
	BrowserView,
	BrowserWindow,
	PATHS,
	Screen,
	Updater,
	Utils,
	app,
} from "electrobun/bun";
import { AgentRuntime } from "../agent/agent-runtime";
import {
	ActivityEventWorkerClient,
} from "../agent/activity-event-worker";
import {
	ActivityWindowDeliveryService,
	ActivityWindowDeliveryStore,
	activityWindowWorkerDiagnostic,
} from "../agent/activity-window-worker";
import {
	LocalClientError,
	LocalToolClient,
} from "../agent/local-tool-client";
import {
	createTimelineV2Runtime,
	type TimelineV2Runtime,
} from "../agent/timeline-v2/runtime";
import {
	TimelineFiveMinuteAuditExporter,
	type RawFiveMinuteAuditSource,
} from "../agent/timeline-v2/audit";
import { loadOrCreateReflectionIdentity } from "../agent/reflection";
import {
	createWhaleHallReflectionRuntime,
	setRuntimeGoal,
	type WhaleHallReflectionRuntime,
} from "./reflection-runtime";
import {
	isObservationEncryptionUnavailable,
	nativeRuntimeSecurityEnvironment,
	parseNativeRuntimeChannel,
} from "./native-runtime-security";
import {
	agentModelConfigurationFromConfiguration,
	activityEventWorkerConfigurationFromConfiguration,
	datacenterRuntimeConfigurationFromConfiguration,
	loadOrCreateClientConfiguration,
} from "./client-config";
import { DataCenterAuthError, DataCenterService } from "./datacenter";
import { loadTimelineModernBertConfiguration } from "./timeline-modernbert-config";
import { BackgroundAppLifecycle } from "./app-lifecycle";
import {
	TimelineRuntimeLifecycle,
	resumeTimelineRuntimeForAvailableVault,
} from "./timeline-runtime-lifecycle";
import { PetStateArbiter } from "./pet-state";
import { PetWindowController } from "./pet-window-controller";
import { exportFiveMinuteAuditToFile } from "./five-minute-audit-file-export";
import { PrivateTrainingWindowExportCoordinator } from "./private-training-window-export";
import {
	FileAuditCaptureStore,
	FiveMinuteAuditCaptureCoordinator,
	settleEffectiveAuditAuthorities,
} from "./five-minute-audit-capture";
import { monitoringPermissionSettingsUrl } from "./monitoring-permission-settings";
import type {
	LocalRuntimeStatus,
	LocalToolEvent,
	LocalVaultLegacyMigrationResult,
} from "../agent/local-protocol";
import type { ClientRPC, PetRPC } from "../shared/contracts";
import {
	WhaleHallPlanningRuntime,
} from "./planning-runtime";
import type {
	PlanningCalendarEventProjection,
	PlanningCalendarMutationProjection,
} from "../shared/planning";
import {
	developmentQaWindowSize,
	DevelopmentQaAuthSession,
	isDevelopmentQaMode,
} from "./development-qa-auth";
import { shouldForceRendererPlanLock } from "./calendar-mutation-policy";

const HMR_ORIGIN = "http://127.0.0.1:5173";
const runtimeChannel = parseNativeRuntimeChannel(
	await Updater.localInfo.channel(),
);
const developmentQaMode = isDevelopmentQaMode(runtimeChannel, process.env);
const developmentQaAuth = developmentQaMode
	? new DevelopmentQaAuthSession()
	: null;
const nativeBinary = process.platform === "win32" ? "whalehall-local.exe" : "whalehall-local";
const nativePath = join(PATHS.RESOURCES_FOLDER, "app", "native", nativeBinary);
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
const timelineModernBertConfiguration =
	loadTimelineModernBertConfiguration(process.env);
if (timelineModernBertConfiguration.code === "invalid_config") {
	console.warn(
		"WhaleHall Timeline v2 ModernBERT configuration is incomplete or invalid; deterministic cold-start remains active.",
	);
}
const activityEventWorkerConfiguration =
	activityEventWorkerConfigurationFromConfiguration(
		clientConfiguration.configuration,
		process.env,
	);
const agentModelConfiguration = agentModelConfigurationFromConfiguration(
	clientConfiguration.configuration,
	process.env,
);
if (activityEventWorkerConfiguration === null) {
	console.warn(
		"WhaleHall cloud reflection is inactive because its configured apikey is unavailable.",
	);
}
if (agentModelConfiguration === null) {
	console.warn(
		"WhaleHall Agent model is inactive because its configured apikey is unavailable.",
	);
}

const agent = new AgentRuntime(
	new LocalToolClient(nativePath, {
		environment: localRuntimeEnvironment,
	}),
	{ requireStartupGoalPreparation: true },
);
const datacenterConfiguration = datacenterRuntimeConfigurationFromConfiguration(
	clientConfiguration.configuration,
	process.env,
);
const datacenterService = new DataCenterService({
	configuration: datacenterConfiguration,
	localDataPath,
	agent: {
		queryEvents: (consumerId, limit) =>
			agent.queryDesktopEvents({ consumerId, limit }),
		commitCursor: (consumerId, cursor) =>
			agent.commitDesktopEventCursor(consumerId, cursor),
		getMonitoringStatus: () => agent.getMonitoringStatus(),
	},
});
datacenterService.start();
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
let shutdownPromise: Promise<void> | null = null;
let startupPromise: Promise<void> | null = null;
let cancelStartupRetryWait: (() => void) | null = null;
let reflectionRuntime: WhaleHallReflectionRuntime | null = null;
let planningRuntime: WhaleHallPlanningRuntime | null = null;
let planningMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let activityWindowDelivery: ActivityWindowDeliveryService | null = null;
let activityWindowDeliveryStore: ActivityWindowDeliveryStore | null = null;
const STARTUP_RETRY_DELAYS_MS = [
	1_000,
	5_000,
	15_000,
	45_000,
	120_000,
	300_000,
];
const timelineLifecycle = new TimelineRuntimeLifecycle<TimelineV2Runtime>({
	async createRuntime() {
		const reflection = reflectionRuntime;
		if (reflection === null || shutdownPromise !== null) {
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
		getExporter: () =>
			timelineLifecycle.current?.privateTrainingExport ?? null,
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
		sessionTimezone:
			Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	});

let clientWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow;
let petWindowController: PetWindowController;
let petStateArbiter: PetStateArbiter;

function toDataCenterAuthRpcError(error: unknown): Error {
	if (error instanceof DataCenterAuthError) {
		return new Error(`DATACENTER_AUTH:${error.kind}`);
	}
	return new Error("DATACENTER_AUTH:unexpected");
}

function sendLocalStatus(status = agent.getLocalStatus()): void {
	if (clientWindow !== null) clientRPC.send.localStatusChanged(status);
	petStateArbiter.updateRuntime(status);
}

function sendToolEvent(event: LocalToolEvent): void {
	petStateArbiter.showToolEvent(event);
}

const clientRPC = BrowserView.defineRPC<ClientRPC>({
	// A planning turn may consume the full verified-model budget and then make
	// one schema-repair attempt. Keep the transport alive for that bounded work;
	// normal monitoring/status requests retain their shorter service deadlines.
	maxRequestTime: 260_000,
	handlers: {
		requests: {
			listPlans: async () => ({
				plans: await (await requirePlanningRuntime()).listPlans(),
			}),
			getPlan: async ({ planId }) => ({
				plan: await (await requirePlanningRuntime()).getPlan(planId),
			}),
			createPlanDraft: async ({ input, operationId, timeZone }) => {
				assertRendererTimeZone(timeZone);
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
				const events = (await agent.listPlanningCalendar()).events;
				const redactedTaskTitles = await planningCalendarTaskTitles(events);
				return {
					events: events.map((event) =>
						projectNativeCalendarEvent(
							event,
							redactedTaskTitles.get(event.eventId) ?? event.title,
						),
					),
					timeZone:
						Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
				};
			},
			mutatePlanningCalendar: async (mutation) => {
				const result = await mutateRendererCalendar(
					mutation.mutationId,
					[mutation],
				);
				if (!result.ok) {
					return {
						ok: false as const,
						mutationId: mutation.mutationId,
						conflict: result.conflicts[0]!,
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
			refreshMonitoringPermissions: () =>
				agent.refreshMonitoringPermissions(),
			setupMonitoringPermissions: () =>
				agent.setupMonitoringPermissions(),
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
					shutdownPromise === null &&
					timelineLifecycle.current === null &&
					!timelineLifecycle.recoveryPending
				) {
					void resumeTimelineRuntimeForAvailableVault(
						vault,
						timelineLifecycle,
					);
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
			startFiveMinuteAuditCapture: () =>
				auditCaptureCoordinator.start(),
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
			datacenterSignIn: async ({ email, password }) => {
				try {
					if (developmentQaAuth) {
						const session = developmentQaAuth.signIn(email, password);
						if (!session) {
							throw new DataCenterAuthError(
								"invalid_credentials",
								"QA credentials are invalid.",
							);
						}
						return { session };
					}
					const session = await datacenterService.signIn(
						email,
						password,
					);
					return { session };
				} catch (error) {
					throw toDataCenterAuthRpcError(error);
				}
			},
			datacenterSignOut: async () => {
				if (developmentQaAuth) {
					developmentQaAuth.signOut();
					return { signedOut: true };
				}
				await datacenterService.signOut();
				return { signedOut: true };
			},
			datacenterRestoreSession: async () => ({
				session: developmentQaAuth
					? developmentQaAuth.restore()
					: await datacenterService.restoreSession(),
			}),
			datacenterSyncStatus: async () => ({
				status: await datacenterService.getSyncStatus(),
			}),
			datacenterSetSyncEnabled: async ({ enabled }) => ({
				status: await datacenterService.setSyncEnabled(enabled),
			}),
			datacenterRefreshConsents: async () => ({
				status: await datacenterService.refreshConsents(),
			}),
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

petStateArbiter = new PetStateArbiter((state) => petRPC.send.setPetState(state));

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
	const qaEnabled = developmentQaMode && view === "client";
	if (await hmrAvailable) return `${hmrUrl}${qaEnabled ? "?qa=1" : ""}`;
	console.log(`[views] Vite is unavailable; using ${bundled}`);
	// Electrobun's views:// handler treats both query and fragment text as part
	// of the asset path. The trusted Bun QA auth gate remains active; fixture
	// controls are available only on the HMR URL where query routing is valid.
	return bundled;
}

const petWidth = 360;
const petHeight = 300;
const display = Screen.getPrimaryDisplay();
const qaWindowSize = developmentQaWindowSize(runtimeChannel, process.env);
const clientWidth = qaWindowSize?.width ??
	Math.min(1280, Math.max(1000, display.workArea.width - 80));
const clientHeight = qaWindowSize?.height ??
	Math.min(800, Math.max(720, display.workArea.height - 80));

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
		console.log(`[pet] native drag ${dragging ? "started" : `ended (${reason ?? "unknown"})`}`);
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
	if (shutdownPromise) return shutdownPromise;
	shutdownPromise = (async () => {
		cancelStartupRetryWait?.();
		auditCaptureCoordinator.dispose();
		// Startup owns both the initial native start and any reflection-service
		// start. Waiting here prevents a late candidate from restarting the
		// native sensor process after shutdown has already stopped it.
		await startupPromise;
		await stopActivityWindowDelivery();
		if (planningMaintenanceTimer !== null) {
			clearInterval(planningMaintenanceTimer);
			planningMaintenanceTimer = null;
		}
		planningRuntime = null;
		datacenterService.stop();
		await timelineLifecycle.close();
		await reflectionRuntime?.close();
		reflectionRuntime = null;
		await agent.stop();
		petStateArbiter.dispose();
		petWindowController.dispose();
		try {
			petWindow.close();
		} catch {}
	})();
	return shutdownPromise;
}

app.on("reopen", () => {
	void clientLifecycle.open();
});
app.on("before-quit", () => {
	// Normal menu/Dock quit still starts the same idempotent persistence path.
	// Explicit WhaleHall quit actions await this path before calling Utils.quit.
	void shutdown();
});
process.once("SIGINT", () => {
	void clientLifecycle.quit();
});
process.once("SIGTERM", () => {
	void clientLifecycle.quit();
});

startupPromise = (async () => {
	let attempt = 0;
	while (!shutdownPromise) {
		let candidate: WhaleHallReflectionRuntime | null = null;
		try {
			candidate = await createWhaleHallReflectionRuntime({
				agent,
				dataDirectory: localDataPath,
				onWindowSealed: (window) => {
					const delivery = activityWindowDelivery;
					if (delivery === null || shutdownPromise !== null) return;
					return delivery.enqueueWindow(window);
				},
			});
			if (shutdownPromise) {
				await candidate.close();
				return;
			}
			await startActivityWindowDelivery(candidate.repository);
			await candidate.service.start();
			if (shutdownPromise) {
				await candidate.close();
				return;
			}
			reflectionRuntime = candidate;
			candidate = null;
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
					notification(notification) {
						if (clientWindow !== null) {
							clientRPC.send.planningNotification(notification);
						}
					},
				},
				() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
			);
			await reconcileExecutingPlanningGoal();
			startPlanningMaintenance();
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
			if (shutdownPromise) {
				await timelineLifecycle.close();
				await reflectionRuntime?.close();
				reflectionRuntime = null;
				return;
			}
			console.log(
				`WhaleHall Timeline v2 ready; Qwen hypothesis lock: ${
					timeline.teacherVerified
						? "verified"
						: "deterministic fallback"
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
			planningRuntime = null;
			if (shutdownPromise) return;
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
		activityEventWorkerConfiguration === null ||
		activityWindowDelivery !== null ||
		shutdownPromise !== null
	) {
		return;
	}
	const store = new ActivityWindowDeliveryStore(
		join(localDataPath, "activity-window-worker.sqlite3"),
	);
	const delivery = new ActivityWindowDeliveryService({
		source,
		analyzer: new ActivityEventWorkerClient({
			endpoint: activityEventWorkerConfiguration.endpoint,
			authorizationToken: activityEventWorkerConfiguration.authorizationToken,
		}),
		store,
		scoreThreshold: activityEventWorkerConfiguration.scoreThreshold,
		onAgentTriggerRequired: () => {
			// The Worker endpoint has the activity-analysis contract, not a
			// generic chat contract. Keep the durable trigger pending until the
			// local Agent executor explicitly claims it.
			console.info(
				agentModelConfiguration === null
					? "WhaleHall activity score reached its local Agent trigger threshold."
					: "WhaleHall activity score reached its local Agent trigger threshold; the configured Agent model is ready for an executor claim.",
			);
		},
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
	activityWindowDelivery = delivery;
	try {
		await delivery.start();
	} catch (error) {
		activityWindowDelivery = null;
		activityWindowDeliveryStore = null;
		store.close();
		throw error;
	}
}

async function stopActivityWindowDelivery(): Promise<void> {
	const delivery = activityWindowDelivery;
	const store = activityWindowDeliveryStore;
	activityWindowDelivery = null;
	activityWindowDeliveryStore = null;
	await delivery?.stop();
	store?.close();
}

function createRawFiveMinuteAuditSource(
	runtime: AgentRuntime,
): RawFiveMinuteAuditSource {
	return {
		async queryAuditRange({
			fromMs,
			toMs,
			includeDecryptedContent,
		}) {
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

function assertRendererTimeZone(timeZone: string): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone }).format();
	} catch {
		throw new Error("PLANNING_VALIDATION: invalid IANA time zone");
	}
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
		redactedContent:
			event.kind === "plan" && event.scheduleOrigin === "model",
		kind: event.kind,
		state: event.state,
		schedule: structuredClone(event.schedule),
		recurrence: event.recurrence ? structuredClone(event.recurrence) : null,
		occurrenceId: event.occurrenceId,
		sourcePlanId: event.sourcePlanId,
		sourceTaskId: event.sourceTaskId,
		scheduleOrigin: event.kind === "plan" ? event.scheduleOrigin ?? "user" : null,
		userLocked: event.userLocked || forceUserLock,
		editable: event.editable,
		version: event.version,
	};
}

async function mutateRendererCalendar(
	batchId: string,
	mutations: readonly PlanningCalendarMutationProjection[],
): Promise<
	import("../shared/planning").PlanningCalendarBatchResultProjection
> {
	try {
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
		const result = await agent.mutatePlanningCalendar({
			operationId: batchId,
			mutations: mutations.map((mutation) =>
				mutation.kind === "delete"
					? {
							action: "delete" as const,
							eventId: mutation.eventId,
							expectedVersion: mutation.expectedVersion ?? 0,
						}
					: {
							action: "upsert" as const,
							expectedVersion: mutation.expectedVersion,
							event: nativeCalendarEvent(
								mutation.after!,
								shouldForceRendererPlanLock(mutation),
							),
						},
			),
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
		});
		const events = result.outcomes.flatMap((outcome) =>
			outcome.event ? [projectNativeCalendarEvent(outcome.event)] : [],
		);
		const planning = await requirePlanningRuntime();
		await planning.flushOutbox();
		await reconcileExecutingPlanningGoal();
		return { ok: true, batchId, events, warnings: [] };
	} catch (error) {
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
	const events = (await agent.listPlanningCalendar()).events
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
	if (!event || event.schedule.allDay || !event.sourcePlanId || !event.sourceTaskId) {
		await setRuntimeGoal(reflection, null);
		return;
	}
	const plan = await planning.runtime.getPlan(event.sourcePlanId).catch(() => null);
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
