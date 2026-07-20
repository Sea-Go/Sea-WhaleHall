import type { RPCSchema } from "electrobun/bun";
import type {
	LocalRuntimeStatus,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
} from "../agent/local-protocol";

export type {
	LocalRuntimeStatus,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
};

export type PetMood = "idle" | "happy" | "busy" | "error";

export type PetState = {
	mood: PetMood;
	message: string;
};

export type ClientRPC = {
	bun: RPCSchema<{
		requests: {
			getLocalStatus: {
				params: Record<string, never>;
				response: LocalRuntimeStatus;
			};
			listLocalTools: {
				params: Record<string, never>;
				response: { tools: LocalToolDescriptor[] };
			};
			callLocalTool: {
				params: LocalToolCall;
				response: LocalToolCallResult;
			};
			cancelLocalTool: {
				params: { callId: string };
				response: LocalToolCancelResult;
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
			localStatusChanged: LocalRuntimeStatus;
			localToolEvent: LocalToolEvent;
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
