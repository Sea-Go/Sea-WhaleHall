import { join } from "node:path";
import {
	BrowserView,
	BrowserWindow,
	PATHS,
	Screen,
	Updater,
} from "electrobun/bun";
import { AgentService } from "./agent/agent-service";
import { RustBridge } from "./agent/rust-bridge";
import type {
	ClientRPC,
	PetRPC,
	PetState,
	RuntimeStatus,
} from "../shared/contracts";

const HMR_ORIGIN = "http://127.0.0.1:5173";
const nativeBinary = process.platform === "win32" ? "whalehall-core.exe" : "whalehall-core";
const nativePath = join(PATHS.RESOURCES_FOLDER, "app", "native", nativeBinary);

const agent = new AgentService(new RustBridge(nativePath));
let petVisible = true;
let shuttingDown = false;

let clientWindow: BrowserWindow;
let petWindow: BrowserWindow;

function petStateFor(status: RuntimeStatus): PetState {
	if (status.state === "ready") return { mood: "idle", message: "Rust agent ready" };
	if (status.state === "starting") return { mood: "busy", message: "Starting agent…" };
	if (status.state === "degraded") {
		return { mood: "error", message: status.lastError ?? "Agent unavailable" };
	}
	return { mood: "idle", message: "Agent stopped" };
}

function sendRuntimeStatus(status = agent.getStatus()): void {
	clientRPC.send.runtimeStatusChanged(status);
	petRPC.send.setPetState(petStateFor(status));
}

const clientRPC = BrowserView.defineRPC<ClientRPC>({
	maxRequestTime: 6000,
	handlers: {
		requests: {
			getRuntimeStatus: () => agent.getStatus(),
			healthCheck: () => agent.healthCheck(),
			echo: ({ message }) => agent.echo(message),
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
				petRPC.send.setPetState(petStateFor(agent.getStatus()));
			},
			interacted: () => {
				petRPC.send.setPetState({
					mood: "happy",
					message: "Hello from WhaleHall!",
				});
				setTimeout(() => sendRuntimeStatus(), 900);
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

agent.onStatusChange(sendRuntimeStatus);
clientWindow.webview.on("dom-ready", () => {
	sendRuntimeStatus();
	clientRPC.send.petVisibilityChanged({ visible: petVisible });
});
petWindow.webview.on("dom-ready", () => {
	console.log("[pet] DOM ready");
	sendRuntimeStatus();
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
console.log(`WhaleHall started; native agent: ${nativePath}`);
