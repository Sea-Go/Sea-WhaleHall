import type { PetPresentationBridge } from "../features/pet-bridge/public";
import type { PreferencesController } from "../features/settings/public";

/**
 * Applies only persisted pet visibility. The native process starts hidden, so
 * an unavailable or still-loading preference store remains fail closed.
 */
export function subscribePetVisibilityPreference(
	controller: Pick<PreferencesController, "getSnapshot" | "subscribe">,
	bridge: Pick<PetPresentationBridge, "setVisible">,
): () => void {
	let disposed = false;
	let lastScheduledVersion: number | null = null;
	let deliveryTail = Promise.resolve();

	const synchronize = () => {
		const state = controller.getSnapshot();
		if (!("snapshot" in state)) return;
		if (lastScheduledVersion === state.snapshot.version) return;
		lastScheduledVersion = state.snapshot.version;
		const visible = state.snapshot.values.pet.visible;
		// Preserve preference order if consecutive saves complete while the bridge
		// is still delivering an earlier visibility update.
		deliveryTail = deliveryTail
			.then(async () => {
				if (!disposed) await bridge.setVisible(visible);
			})
			.catch(() => undefined);
	};

	const unsubscribe = controller.subscribe(synchronize);
	synchronize();
	return () => {
		disposed = true;
		unsubscribe();
	};
}
