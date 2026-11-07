import { Electroview } from "electrobun/view";
import type {
	NativePetDragState,
	PetInteractionMessage,
	PetState,
} from "../../shared/contracts";
import type { PetActivityFeedbackPresentation } from "../../shared/pet-activity-feedback";
import type { PetChatRPC } from "../../shared/pet-chat";
import type { PetChatPort } from "./chat";

type PetStateListener = (state: PetState) => void;
const listeners = new Set<PetStateListener>();
type NativeDragListener = (state: NativePetDragState) => void;
const nativeDragListeners = new Set<NativeDragListener>();
type ActivityFeedbackListener = (
	presentation: PetActivityFeedbackPresentation,
) => void;
const activityFeedbackListeners = new Set<ActivityFeedbackListener>();
type ActivityFeedbackClearListener = () => void;
const activityFeedbackClearListeners = new Set<ActivityFeedbackClearListener>();
type PetChatAvailabilityListener = (available: boolean) => void;
const petChatAvailabilityListeners = new Set<PetChatAvailabilityListener>();
type PetChatEventListener = (requestId: string, envelope: unknown) => void;
const petChatEventListeners = new Set<PetChatEventListener>();
type PetChatRejectedListener = (requestId: string, message: string) => void;
const petChatRejectedListeners = new Set<PetChatRejectedListener>();
type PetChatProactiveListener = (requestId: string) => void;
const petChatProactiveListeners = new Set<PetChatProactiveListener>();

let rendererMounted = false;

function setRendererMounted(mounted: boolean): void {
	rendererMounted = mounted;
}

function assertRendererMounted(): void {
	if (
		!rendererMounted ||
		activityFeedbackListeners.size === 0 ||
		activityFeedbackClearListeners.size === 0
	) {
		throw new Error("The pet renderer is not mounted yet.");
	}
}

const rpc = Electroview.defineRPC<PetChatRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {
			clearActivityFeedback: ({ clearId }) => {
				for (const listener of activityFeedbackClearListeners) listener();
				return { clearId, cleared: true };
			},
			proveActivityFeedbackRenderer: (challenge) => {
				assertRendererMounted();
				return challenge;
			},
		},
		messages: {
			setPetState: (state) => {
				for (const listener of listeners) listener(state);
			},
			nativeDragChanged: (state) => {
				for (const listener of nativeDragListeners) listener(state);
			},
			presentActivityFeedback: (presentation) => {
				for (const listener of activityFeedbackListeners) {
					listener(presentation);
				}
			},
			petChatAvailability: ({ available }) => {
				for (const listener of petChatAvailabilityListeners)
					listener(available);
			},
			petChatEvent: ({ requestId, envelope }) => {
				for (const listener of petChatEventListeners)
					listener(requestId, envelope);
			},
			petChatTurnRejected: ({ requestId, message }) => {
				for (const listener of petChatRejectedListeners)
					listener(requestId, message);
			},
			petChatProactiveTurn: ({ requestId }) => {
				for (const listener of petChatProactiveListeners) listener(requestId);
			},
		},
	},
});

new Electroview({ rpc });

/** 桌宠对话端口：turn 的生命周期经消息驱动，事件由 petApi 订阅者消化。 */
export function createPetChatPort(): PetChatPort {
	return {
		startTurn: ({ requestId, text }) => {
			rpc.send.startPetChatTurn({ requestId, text });
		},
		cancelTurn: ({ requestId, runId, expectedRevision }) => {
			rpc.send.cancelPetChat({ requestId, runId, expectedRevision });
		},
		reportState: (state) => {
			rpc.send.petChatStateReport(state);
		},
	};
}

export const petApi = {
	ready: () => {
		setRendererMounted(true);
		rpc.send.ready();
	},
	unready: () => setRendererMounted(false),
	interacted: (event: PetInteractionMessage) => rpc.send.interacted(event),
	onState(listener: PetStateListener): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	onNativeDrag(listener: NativeDragListener): () => void {
		nativeDragListeners.add(listener);
		return () => nativeDragListeners.delete(listener);
	},
	onActivityFeedback(listener: ActivityFeedbackListener): () => void {
		activityFeedbackListeners.add(listener);
		return () => activityFeedbackListeners.delete(listener);
	},
	onActivityFeedbackClear(listener: ActivityFeedbackClearListener): () => void {
		activityFeedbackClearListeners.add(listener);
		return () => activityFeedbackClearListeners.delete(listener);
	},
	onPetChatAvailability(listener: PetChatAvailabilityListener): () => void {
		petChatAvailabilityListeners.add(listener);
		return () => petChatAvailabilityListeners.delete(listener);
	},
	onPetChatEvent(listener: PetChatEventListener): () => void {
		petChatEventListeners.add(listener);
		return () => petChatEventListeners.delete(listener);
	},
	onPetChatRejected(listener: PetChatRejectedListener): () => void {
		petChatRejectedListeners.add(listener);
		return () => petChatRejectedListeners.delete(listener);
	},
	onPetChatProactiveTurn(listener: PetChatProactiveListener): () => void {
		petChatProactiveListeners.add(listener);
		return () => petChatProactiveListeners.delete(listener);
	},
};
