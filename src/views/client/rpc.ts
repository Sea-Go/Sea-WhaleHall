import { Electroview } from "electrobun/view";
import type { ClientRPC, RuntimeStatus } from "../../shared/contracts";

type StatusListener = (status: RuntimeStatus) => void;
type VisibilityListener = (visible: boolean) => void;

const statusListeners = new Set<StatusListener>();
const visibilityListeners = new Set<VisibilityListener>();

const rpc = Electroview.defineRPC<ClientRPC>({
	maxRequestTime: 7000,
	handlers: {
		requests: {},
		messages: {
			runtimeStatusChanged: (status) => {
				for (const listener of statusListeners) listener(status);
			},
			petVisibilityChanged: ({ visible }) => {
				for (const listener of visibilityListeners) listener(visible);
			},
		},
	},
});

new Electroview({ rpc });

export const clientApi = {
	getRuntimeStatus: () => rpc.request.getRuntimeStatus({}),
	healthCheck: () => rpc.request.healthCheck({}),
	echo: (message: string) => rpc.request.echo({ message }),
	setPetVisible: (visible: boolean) => rpc.request.setPetVisible({ visible }),
	onStatus(listener: StatusListener): () => void {
		statusListeners.add(listener);
		return () => statusListeners.delete(listener);
	},
	onPetVisibility(listener: VisibilityListener): () => void {
		visibilityListeners.add(listener);
		return () => visibilityListeners.delete(listener);
	},
};
