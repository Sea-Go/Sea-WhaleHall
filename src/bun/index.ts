import { join } from "node:path";
import {
	BrowserView,
	BrowserWindow,
	PATHS,
	Screen,
	Updater,
} from "electrobun/bun";
import { AgentRuntime } from "../agent/agent-runtime";
import { LocalToolClient } from "../agent/local-tool-client";
import type {
	LocalRuntimeStatus,
	LocalToolEvent,
} from "../agent/local-protocol";
import type {
	ClientRPC,
	PetRPC,
	PetState,
} from "../shared/contracts";

const HMR_ORIGIN = "http://127.0.0.1:5173";
const nativeBinary = process.platform === "win32" ? "whalehall-local.exe" : "whalehall-local";
const nativePath = join(PATHS.RESOURCES_FOLDER, "app", "native", nativeBinary);

const agent = new AgentRuntime(new LocalToolClient(nativePath));
let petVisible = true;
let shuttingDown = false;

let clientWindow: BrowserWindow;
let petWindow: BrowserWindow;

function petStateFor(status: LocalRuntimeStatus): PetState {
	if (status.activeCalls > 0) {
		return { mood: "busy", message: `${status.activeCalls} local tool running…` };
	}
	if (status.state === "ready") return { mood: "idle", message: "Rust agent ready" };
	if (status.state === "starting") return { mood: "busy", message: "Starting local tools…" };
	if (status.state === "degraded") {
		return { mood: "error", message: status.lastError ?? "Local tools unavailable" };
	}
	return { mood: "idle", message: "Local tools stopped" };
}

function sendLocalStatus(status = agent.getLocalStatus()): void {
	clientRPC.send.localStatusChanged(status);
	petRPC.send.setPetState(petStateFor(status));
}

function sendToolEvent(event: LocalToolEvent): void {
	clientRPC.send.localToolEvent(event);
	const name = typeof event.data.name === "string" ? event.data.name : "local tool";
	if (event.event === "tool.started" || event.event === "tool.progress") {
		petRPC.send.setPetState({ mood: "busy", message: `Running ${name}…` });
	} else if (event.event === "tool.completed") {
		petRPC.send.setPetState({ mood: "happy", message: `${name} completed` });
	} else if (event.event === "tool.failed") {
		petRPC.send.setPetState({ mood: "error", message: `${name} failed` });
	} else {
		petRPC.send.setPetState({ mood: "idle", message: `${name} cancelled` });
	}
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
				if (visible) petWindow.showInactive();
				else petWindow.hide();
				clientRPC.send.petVisibilityChanged({ visible });
				return { visible };
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
				petRPC.send.setPetState(petStateFor(agent.getLocalStatus()));
			},
			interacted: () => {
				petRPC.send.setPetState({
					mood: "happy",
					message: "Hello from WhaleHall!",
				});
				setTimeout(() => sendLocalStatus(), 900);
			},
		},
	},
});

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

clientWindow = new BrowserWindow({
	title: "WhaleHall",
	url: await viewUrl("client"),
	rpc: clientRPC,
	frame: {
		x: 120,
		y: 100,
		width: 1000,
		height: 720,
	},
});

const display = Screen.getPrimaryDisplay();
clientWindow.setPosition(
	display.workArea.x + Math.max(40, Math.floor((display.workArea.width - 1000) / 2)),
	display.workArea.y + Math.max(40, Math.floor((display.workArea.height - 720) / 2)),
);

petWindow = new BrowserWindow({
	title: "WhaleHall Pet",
	url: await viewUrl("pet"),
	rpc: petRPC,
	titleBarStyle: "hidden",
	transparent: true,
	passthrough: true,
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

function shutdown(): void {
	if (shuttingDown) return;
	shuttingDown = true;
	agent.stop();
	try {
		petWindow.close();
	} catch {}
}

clientWindow.on("close", shutdown);
process.once("exit", () => agent.stop());
process.once("SIGINT", () => {
	shutdown();
	process.exit(0);
});
process.once("SIGTERM", () => {
	shutdown();
	process.exit(0);
});

void agent.start();
console.log(`WhaleHall started; local tool host: ${nativePath}`);
