import { Electroview } from "electrobun/view";
import type {
	NativePetDragState,
	PetInteractionMessage,
	PetState,
} from "../../shared/contracts";
import type {
	PetActivityFeedbackPresentation,
	PetActivityFeedbackRPC,
} from "../../shared/pet-activity-feedback";

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

const rpc = Electroview.defineRPC<PetActivityFeedbackRPC>({
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
		},
	},
});

new Electroview({ rpc });

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
};
