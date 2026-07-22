import { Electroview } from "electrobun/view";
import type {
	NativePetDragState,
	PetInteractionMessage,
	PetRPC,
	PetState,
} from "../../shared/contracts";

type PetStateListener = (state: PetState) => void;
const listeners = new Set<PetStateListener>();
type NativeDragListener = (state: NativePetDragState) => void;
const nativeDragListeners = new Set<NativeDragListener>();

const rpc = Electroview.defineRPC<PetRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			setPetState: (state) => {
				for (const listener of listeners) listener(state);
			},
			nativeDragChanged: (state) => {
				for (const listener of nativeDragListeners) listener(state);
			},
		},
	},
});

new Electroview({ rpc });

export const petApi = {
	ready: () => rpc.send.ready(),
	interacted: (event: PetInteractionMessage) => rpc.send.interacted(event),
	onState(listener: PetStateListener): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	onNativeDrag(listener: NativeDragListener): () => void {
		nativeDragListeners.add(listener);
		return () => nativeDragListeners.delete(listener);
	},
};
