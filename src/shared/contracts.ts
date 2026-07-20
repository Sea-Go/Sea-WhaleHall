import type { RPCSchema } from "electrobun/bun";
import type { EchoResult, HealthResult } from "./protocol";

export type AgentState = "starting" | "ready" | "degraded" | "stopped";

export type RuntimeStatus = {
	state: AgentState;
	pid: number | null;
	lastError: string | null;
};

export type PetMood = "idle" | "happy" | "busy" | "error";

export type PetState = {
	mood: PetMood;
	message: string;
};

export type ClientRPC = {
	bun: RPCSchema<{
		requests: {
			getRuntimeStatus: {
				params: Record<string, never>;
				response: RuntimeStatus;
			};
			healthCheck: {
				params: Record<string, never>;
				response: HealthResult;
			};
			echo: {
				params: { message: string };
				response: EchoResult;
			};
			setPetVisible: {
				params: { visible: boolean };
				response: { visible: boolean };
			};
		};
		messages: Record<never, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			runtimeStatusChanged: RuntimeStatus;
			petVisibilityChanged: { visible: boolean };
		};
	}>;
};

export type PetRPC = {
	bun: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			ready: void;
			interacted: { kind: "click" };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			setPetState: PetState;
		};
	}>;
};
