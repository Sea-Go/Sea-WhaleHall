import { Electroview } from "electrobun/view";
import type { PetRPC, PetState } from "../../shared/contracts";

type PetStateListener = (state: PetState) => void;
const listeners = new Set<PetStateListener>();

const rpc = Electroview.defineRPC<PetRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			setPetState: (state) => {
				for (const listener of listeners) listener(state);
			},
		},
	},
});

new Electroview({ rpc });

export const petApi = {
	ready: () => rpc.send.ready(),
	interacted: () => rpc.send.interacted({ kind: "click" }),
	onState(listener: PetStateListener): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
