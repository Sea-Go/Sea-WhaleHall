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
import { LocalToolClient } from "../agent/local-tool-client";
import {
	createWhaleHallReflectionRuntime,
	setRuntimeGoal,
	type WhaleHallReflectionRuntime,
} from "./reflection-runtime";
import type { ActiveReflectionFeedbackCode } from "./reflection-feedback";
import {
	PetStateArbiter,
} from "./pet-state";
import { PetWindowController } from "./pet-window-controller";
import type {
	LocalRuntimeStatus,
	LocalToolEvent,
} from "../agent/local-protocol";
import type { ClientRPC, PetRPC } from "../shared/contracts";

const HMR_ORIGIN = "http://127.0.0.1:5173";
const nativeBinary = process.platform === "win32" ? "whalehall-local.exe" : "whalehall-local";
const nativePath = join(PATHS.RESOURCES_FOLDER, "app", "native", nativeBinary);
const localDataPath = join(Utils.paths.userData, "local");

const agent = new AgentRuntime(
	new LocalToolClient(nativePath, {
		environment: { WHALEHALL_DATA_DIR: localDataPath },
	}),
	{ requireStartupGoalPreparation: true },
);
let petVisible = true;
let shutdownPromise: Promise<void> | null = null;
let startupPromise: Promise<void> | null = null;
let cancelStartupRetryWait: (() => void) | null = null;
let reflectionRuntime: WhaleHallReflectionRuntime | null = null;
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
	clientRPC.send.localToolEvent(event);
	petStateArbiter.showToolEvent(event);
}

const clientRPC = BrowserView.defineRPC<ClientRPC>({
	maxRequestTime: 35_000,
	handlers: {
		requests: {
			getLocalStatus: () => agent.getLocalStatus(),
			listLocalTools: async () => ({ tools: await agent.listLocalTools() }),
			callLocalTool: (call) => agent.callLocalTool(call),
			cancelLocalTool: ({ callId }) => agent.cancelLocalTool(callId),
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
	if ((await Updater.localInfo.channel()) !== "dev") return false;
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
		// Startup owns both the initial native start and any reflection-service
		// start. Waiting here prevents a late candidate from restarting the
		// native sensor process after shutdown has already stopped it.
		await startupPromise;
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
		try {
			candidate = await createWhaleHallReflectionRuntime({
				agent,
				dataDirectory: localDataPath,
				canPresentFeedback: () => petVisible,
				onFeedback: (code) => {
					petStateArbiter.showPresentationEvent(
						reflectionPresentationEvent(code),
					);
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
			reflectionRuntime = candidate;
			console.log(
				`WhaleHall reflection runtime ready; qwen teacher lock: ${
					candidate.teacherVerified ? "verified" : "unavailable"
				}`,
			);
			return;
		} catch (error) {
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

function reflectionPresentationEvent(
	code: ActiveReflectionFeedbackCode,
):
	| { kind: "reflection-encourage" }
	| { kind: "reflection-refocus" }
	| { kind: "reflection-clarify-goal" }
	| { kind: "reflection-take-break" } {
	switch (code) {
		case "encourage":
			return { kind: "reflection-encourage" };
		case "refocus":
			return { kind: "reflection-refocus" };
		case "clarifyGoal":
			return { kind: "reflection-clarify-goal" };
		case "takeBreak":
			return { kind: "reflection-take-break" };
	}
}
