import { Electroview } from "electrobun/view";
import type {
	ClientRPC,
	ActiveGoalContextV1,
	LocalRuntimeStatus,
	LocalToolCall,
	LocalToolEvent,
	PetPresentationEvent,
} from "../../shared/contracts";

type StatusListener = (status: LocalRuntimeStatus) => void;
type ToolEventListener = (event: LocalToolEvent) => void;
type VisibilityListener = (visible: boolean) => void;

const statusListeners = new Set<StatusListener>();
const toolEventListeners = new Set<ToolEventListener>();
const visibilityListeners = new Set<VisibilityListener>();

const rpc = Electroview.defineRPC<ClientRPC>({
	maxRequestTime: 35_000,
	handlers: {
		requests: {},
		messages: {
			localStatusChanged: (status) => {
				for (const listener of statusListeners) listener(status);
			},
			localToolEvent: (event) => {
				for (const listener of toolEventListeners) listener(event);
			},
			petVisibilityChanged: ({ visible }) => {
				for (const listener of visibilityListeners) listener(visible);
			},
		},
	},
});

new Electroview({ rpc });

export const clientApi = {
	getLocalStatus: () => rpc.request.getLocalStatus({}),
	listLocalTools: () => rpc.request.listLocalTools({}),
	callLocalTool: (call: LocalToolCall) => rpc.request.callLocalTool(call),
	cancelLocalTool: (callId: string) => rpc.request.cancelLocalTool({ callId }),
	setPetVisible: (visible: boolean) => rpc.request.setPetVisible({ visible }),
	presentPetEvent: (event: PetPresentationEvent) =>
		rpc.request.presentPetEvent(event),
	setActiveGoalContext: (goal: ActiveGoalContextV1 | null) =>
		rpc.request.setActiveGoalContext({ goal }),
	onStatus(listener: StatusListener): () => void {
		statusListeners.add(listener);
		return () => statusListeners.delete(listener);
	},
	onToolEvent(listener: ToolEventListener): () => void {
		toolEventListeners.add(listener);
		return () => toolEventListeners.delete(listener);
	},
	onPetVisibility(listener: VisibilityListener): () => void {
		visibilityListeners.add(listener);
		return () => visibilityListeners.delete(listener);
	},
};
