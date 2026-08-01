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
import { ConversationAgentClient } from "../agent/conversation-agent-client";
import { TaskPlanningAgentClient } from "../agent/task-planning-agent-client";
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
import {
	clampWindowPositionToVisibleBounds,
	clampPetPositionForBelowWindow,
	displayForPoint,
	PetWindowController,
	positionWindowBelowPet,
} from "./pet-window-controller";
import { PetSurfaceRouter } from "./pet-surface-router";
import { WHALE_MODEL } from "../views/pet/models/registry";
import type {
	LocalRuntimeStatus,
	LocalToolEvent,
} from "../agent/local-protocol";
import type { ClientRPC, PetPanelRPC, PetRPC } from "../shared/contracts";
import type { PetTodaySchedule } from "../shared/pet-panel";

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
const conversationAgent = new ConversationAgentClient();
const taskPlanningAgent = new TaskPlanningAgentClient();
let petVisible = true;
let shutdownPromise: Promise<void> | null = null;
let startupPromise: Promise<void> | null = null;
let cancelStartupRetryWait: (() => void) | null = null;
let reflectionRuntime: WhaleHallReflectionRuntime | null = null;
const STARTUP_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 45_000, 120_000, 300_000];

let clientWindow: BrowserWindow;
let petWindow: BrowserWindow;
let panelWindow: BrowserWindow | null = null;
let petPanelVisible = false;
let petWindowController: PetWindowController;
let petStateArbiter: PetStateArbiter;
let petSurfaceRouter: PetSurfaceRouter;
let petTodaySchedule: PetTodaySchedule = {
	status: "loading",
	date: "",
	timeZone: "",
	tasks: [],
};

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
			updatePetTodaySchedule: (schedule): { accepted: boolean } => {
				petTodaySchedule = schedule;
				panelRPC.send.todayScheduleChanged(schedule);
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
			loadActiveConversation: ({ userId }) =>
				conversationAgent.loadActiveConversation(userId),
			createConversation: ({ userId, title }) =>
				conversationAgent.createConversation(userId, title),
			sendConversationMessage: (input) =>
				conversationAgent.sendMessage(input),
			createTaskPlanningSession: ({ userId, input }) =>
				taskPlanningAgent.createSession(userId, input),
			submitTaskPlanningAnswers: ({ userId, sessionId, answers }) =>
				taskPlanningAgent.submitAnswers(userId, sessionId, answers),
		},
		messages: {},
	},
});

const panelRPC = BrowserView.defineRPC<PetPanelRPC>({
	maxRequestTime: 5_000,
	handlers: {
		requests: {
			getTodaySchedule: () => petTodaySchedule,
			closePetPanel: () => ({ visible: hidePetPanel() }),
			openMainWindow: () => ({ visible: showMainWindow() }),
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
				petSurfaceRouter.handle(event);
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

async function viewUrl(view: "client" | "pet" | "panel"): Promise<string> {
	const bundled = `views://${view}/index.html`;
	const hmrUrl = `${HMR_ORIGIN}/${view}/index.html`;
	if (await hmrAvailable) return hmrUrl;
	console.log(`[views] Vite is unavailable; using ${bundled}`);
	return bundled;
}

const petWidth = 360;
const petHeight = 300;
const panelWidth = 360;
const panelHeight = 430;
const petEdgeGap = 6;
const petVisibleBounds = {
	x: petWidth * 0.52 + WHALE_MODEL.skeleton.visualBounds.x,
	y: petHeight * 0.54 + WHALE_MODEL.skeleton.visualBounds.y,
	width: WHALE_MODEL.skeleton.visualBounds.width,
	height: WHALE_MODEL.skeleton.visualBounds.height,
};
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

const initialPetPosition = clampWindowPositionToVisibleBounds(
	{ x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER },
	petVisibleBounds,
	display.workArea,
	petEdgeGap,
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
		x: initialPetPosition.x,
		y: initialPetPosition.y,
		width: petWidth,
		height: petHeight,
	},
});

petWindow.setAlwaysOnTop(true);
petWindow.setVisibleOnAllWorkspaces(true);
petWindowController = new PetWindowController(petWindow, Screen, {
	visibleBounds: petVisibleBounds,
	edgeGap: petEdgeGap,
	constrainPosition: (position, workArea) =>
		petPanelVisible
			? clampPetPositionForBelowWindow(
				position,
				petVisibleBounds,
				{ width: panelWidth, height: panelHeight },
				workArea,
				28,
			)
			: position,
	onDragStateChange: ({ dragging, reason }) => {
		console.log(`[pet] native drag ${dragging ? "started" : `ended (${reason ?? "unknown"})`}`);
		petRPC.send.nativeDragChanged({ dragging, reason });
		if (!dragging && reason !== "disposed") petStateArbiter.finishNativeDrag();
	},
	onPositionChange: () => {
		positionPetPanelBelowPet();
	},
});
petSurfaceRouter = new PetSurfaceRouter({
	onOpenPanel: () => {
		void showPetPanel();
	},
	onOpenMain: () => {
		showMainWindow();
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

function showMainWindow(): boolean {
	clientWindow.unminimize();
	clientWindow.show();
	clientWindow.activate();
	return true;
}

async function showPetPanel(): Promise<boolean> {
	petPanelVisible = true;
	positionPetForPanel();
	if (panelWindow) {
		positionPetPanelBelowPet();
		panelWindow.showInactive();
		panelRPC.send.todayScheduleChanged(petTodaySchedule);
		return true;
	}
	const petFrame = petWindow.getFrame();
	const position = petPanelPosition(petFrame);
	panelWindow = new BrowserWindow({
		title: "WhaleHall 今日任务",
		url: await viewUrl("panel"),
		rpc: panelRPC,
		titleBarStyle: "hidden",
		activate: false,
		frame: { x: position.x, y: position.y, width: panelWidth, height: panelHeight },
	});
	panelWindow.setVisibleOnAllWorkspaces(true);
	petWindow.showInactive();
	return true;
}

function petPanelPosition(petFrame = petWindow.getFrame()): { x: number; y: number } {
	return positionWindowBelowPet(
		petFrame,
		petVisibleBounds,
		28,
	);
}

function positionPetForPanel(): void {
	const frame = petWindow.getFrame();
	const display = displayForPoint(
		Screen.getAllDisplays(),
		{ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
		Screen.getPrimaryDisplay(),
	);
	const position = clampPetPositionForBelowWindow(
		{ x: frame.x, y: frame.y },
		petVisibleBounds,
		{ width: panelWidth, height: panelHeight },
		display.workArea,
		28,
	);
	if (position.x !== frame.x || position.y !== frame.y) {
		petWindow.setPosition(position.x, position.y);
	}
}

function positionPetPanelBelowPet(): void {
	if (!panelWindow) return;
	const position = petPanelPosition();
	panelWindow.setPosition(position.x, position.y);
}

function hidePetPanel(): boolean {
	if (!panelWindow) return false;
	petPanelVisible = false;
	panelWindow.hide();
	return false;
}

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
		petSurfaceRouter.dispose();
		try {
			panelWindow?.close();
		} catch {}
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
