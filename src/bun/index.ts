import { join } from "node:path";
import {
	BrowserView,
	BrowserWindow,
	PATHS,
	Screen,
	Updater,
	Utils,
} from "electrobun/bun";
import { AgentRuntime } from "../agent/agent-runtime";
import {
	LocalClientError,
	LocalToolClient,
} from "../agent/local-tool-client";
import {
	createTimelineV2Runtime,
	type TimelineV2Runtime,
} from "../agent/timeline-v2/runtime";
import type { RawFiveMinuteAuditSource } from "../agent/timeline-v2/audit";
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
import { PetStateArbiter } from "./pet-state";
import { PetWindowController } from "./pet-window-controller";
import { exportFiveMinuteAuditToFile } from "./five-minute-audit-file-export";
import {
	FileAuditCaptureStore,
	FiveMinuteAuditCaptureCoordinator,
} from "./five-minute-audit-capture";
import { monitoringPermissionSettingsUrl } from "./monitoring-permission-settings";
import type {
	LocalRuntimeStatus,
	LocalToolEvent,
} from "../agent/local-protocol";
import type { ClientRPC, PetRPC } from "../shared/contracts";

const HMR_ORIGIN = "http://127.0.0.1:5173";
const runtimeChannel = parseNativeRuntimeChannel(
	await Updater.localInfo.channel(),
);
const nativeBinary = process.platform === "win32" ? "whalehall-local.exe" : "whalehall-local";
const nativePath = join(PATHS.RESOURCES_FOLDER, "app", "native", nativeBinary);
const localDataPath = join(Utils.paths.userData, "local");
const runtimeIdentity = loadOrCreateReflectionIdentity(
	join(localDataPath, "reflection-identity.v1.json"),
);
const localRuntimeEnvironment: Record<string, string> = {
	WHALEHALL_DATA_DIR: localDataPath,
	WHALEHALL_DEVICE_ID: runtimeIdentity.deviceId,
	WHALEHALL_SESSION_ID: runtimeIdentity.sessionId,
	...nativeRuntimeSecurityEnvironment(runtimeChannel),
};

const agent = new AgentRuntime(
	new LocalToolClient(nativePath, {
		environment: localRuntimeEnvironment,
	}),
	{ requireStartupGoalPreparation: true },
);
let petVisible = true;
let shutdownPromise: Promise<void> | null = null;
let startupPromise: Promise<void> | null = null;
let cancelStartupRetryWait: (() => void) | null = null;
let reflectionRuntime: WhaleHallReflectionRuntime | null = null;
let timelineRuntime: TimelineV2Runtime | null = null;
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
		const runtime = timelineRuntime;
		if (runtime === null) {
			throw new Error("Timeline v2 is unavailable.");
		}
		// Pull and process only naturally sealed production windows. An audit
		// capture must never force-seal or otherwise perturb collector state.
		try {
			await runtime.service.pullNow();
			await runtime.service.runJobsNow();
		} catch (error) {
			// A redacted audit can still be complete at the raw/semantic
			// boundary when the production-derived vault is temporarily
			// unavailable (for example after an ad-hoc development re-sign).
			// The exporter records that gap and creates audit-only projections.
			console.warn(
				"[audit-capture] production timeline settle deferred:",
				error instanceof Error ? error.name : "UNKNOWN",
			);
		}
		if (runtime.audit === null) {
			throw new Error("Timeline v2 audit exporter is unavailable.");
		}
		// Build once without decrypted content before declaring READY. This
		// verifies that the exact raw range is queryable while keeping text
		// behind the later explicit export confirmation.
		await runtime.audit.exportFiveMinutes(fromMs);
	},
	onError(error) {
		console.error(
			"[audit-capture] local session failed:",
			error instanceof Error ? error.name : "UNKNOWN",
		);
	},
});
await auditCaptureCoordinator.initialize();
const STARTUP_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 45_000, 120_000, 300_000];

let clientWindow: BrowserWindow;
let petWindow: BrowserWindow;
let petWindowController: PetWindowController;
let petStateArbiter: PetStateArbiter;

function sendLocalStatus(status = agent.getLocalStatus()): void {
	clientRPC.send.localStatusChanged(status);
	petStateArbiter.updateRuntime(status);
}

function sendToolEvent(event: LocalToolEvent): void {
	petStateArbiter.showToolEvent(event);
}

const clientRPC = BrowserView.defineRPC<ClientRPC>({
	maxRequestTime: 35_000,
	handlers: {
		requests: {
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
			refreshMonitoringPermissions: (options) =>
				agent.refreshMonitoringPermissions(options),
			openMonitoringPermissionSettings: ({ permission }) => {
				const url = monitoringPermissionSettingsUrl(permission);
				return {
					opened:
						process.platform === "darwin" &&
						url !== null &&
						Utils.openExternal(url),
				};
			},
			exportFiveMinuteAuditToFile: (request) =>
				exportFiveMinuteAuditToFile(request, {
					getExporter: () => timelineRuntime?.audit ?? null,
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
				clientRPC.send.petVisibilityChanged({ visible });
				return { visible };
			},
			presentPetEvent: (event): { accepted: boolean } => {
				petStateArbiter.showPresentationEvent(event);
				return { accepted: true };
			},
			setActiveGoalContext: async ({ goal }) => {
				const runtime = reflectionRuntime;
				if (!runtime) throw new Error("Reflection runtime is not ready.");
				const normalized = await setRuntimeGoal(
					runtime,
					goal
						? {
								goalId: goal.goalId,
								planId: goal.planId,
								text: goal.text,
								activatedAtMs: goal.activatedAtMs,
							}
						: null,
				);
				await timelineRuntime?.service.pullNow();
				return {
					goal: normalized
						? {
								schemaVersion: "active-goal.v1" as const,
								...normalized,
							}
						: null,
				};
			},
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
	if (await hmrAvailable) return hmrUrl;
	console.log(`[views] Vite is unavailable; using ${bundled}`);
	return bundled;
}

const petWidth = 360;
const petHeight = 300;
const display = Screen.getPrimaryDisplay();
const clientWidth = Math.min(1280, Math.max(1000, display.workArea.width - 80));
const clientHeight = Math.min(800, Math.max(720, display.workArea.height - 80));

clientWindow = new BrowserWindow({
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

clientWindow.setPosition(
	display.workArea.x + Math.max(0, Math.floor((display.workArea.width - clientWidth) / 2)),
	display.workArea.y + Math.max(0, Math.floor((display.workArea.height - clientHeight) / 2)),
);

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
clientWindow.webview.on("dom-ready", () => {
	sendLocalStatus();
	clientRPC.send.petVisibilityChanged({ visible: petVisible });
});
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
		await timelineRuntime?.close();
		timelineRuntime = null;
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

clientWindow.on("close", () => {
	void shutdown();
});
process.once("SIGINT", () => {
	void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0));
});

startupPromise = (async () => {
	let attempt = 0;
	while (!shutdownPromise) {
		let candidate: WhaleHallReflectionRuntime | null = null;
		let timelineCandidate: TimelineV2Runtime | null = null;
		try {
			candidate = await createWhaleHallReflectionRuntime({
				agent,
				dataDirectory: localDataPath,
				environment: {
					...process.env,
					// v2 phase one is local-only. Ignore remote ModernBERT
					// overrides even when the parent shell exports them.
					WHALEHALL_MODERNBERT_ENDPOINT: undefined,
					WHALEHALL_MODERNBERT_ALLOWED_ORIGINS: undefined,
				},
			});
			if (shutdownPromise) {
				await candidate.close();
				return;
			}
			await candidate.service.start();
			if (shutdownPromise) {
				await candidate.close();
				return;
			}
			try {
				timelineCandidate = await createTimelineV2Runtime({
					agent,
					dataDirectory: localDataPath,
					initialGoal: candidate.service.getActiveGoalContext(),
					rawAuditSource: createRawFiveMinuteAuditSource(agent),
				});
				await timelineCandidate.start();
			} catch (error) {
				if (!isObservationEncryptionUnavailable(error)) throw error;
				await timelineCandidate?.close().catch(() => {});
				timelineCandidate = null;
				// Keychain can be unavailable before first unlock or after an
				// ad-hoc development re-sign. Keep the healthy native process
				// available for monitoring/configuration, while Timeline v2
				// and decrypted export remain fail closed.
				reflectionRuntime = candidate;
				candidate = null;
				console.warn(
					"WhaleHall Timeline v2 is unavailable because the local encryption key cannot be opened; monitoring remains available.",
				);
				return;
			}
			if (shutdownPromise) {
				await timelineCandidate.close();
				await candidate.close();
				return;
			}
			reflectionRuntime = candidate;
			timelineRuntime = timelineCandidate;
			console.log(
				`WhaleHall Timeline v2 ready; Qwen hypothesis lock: ${
					timelineCandidate.teacherVerified
						? "verified"
						: "deterministic fallback"
				}`,
			);
			return;
		} catch (error) {
			if (timelineCandidate) {
				await timelineCandidate.close().catch((closeError) => {
					console.error(
						"WhaleHall Timeline v2 candidate cleanup failed:",
						closeError,
					);
				});
			}
			if (candidate) {
				await candidate.close().catch((closeError) => {
					console.error(
						"WhaleHall reflection candidate cleanup failed:",
						closeError,
					);
				});
			}
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
