import type { PetPresentationBridge } from "../features/pet-bridge/public";
import type { PreferencesController } from "../features/settings/public";

/**
 * 把持久化的桌宠形象（皮肤）选择同步给桌宠链路：偏好保存后经
 * `setPetModel` RPC 写入 Bun 侧持久化，PetState 下发链路据此盖章
 * `modelId`，桌宠渲染器热切换。加载失败时保持默认鲸鱼（fail closed）。
 */
export function subscribePetModelPreference(
	controller: Pick<PreferencesController, "getSnapshot" | "subscribe">,
	bridge: Pick<PetPresentationBridge, "setModel">,
): () => void {
	let disposed = false;
	let initialVersion: number | null = null;
	let lastScheduledVersion: number | null = null;
	let deliveryTail = Promise.resolve();

	const synchronize = () => {
		const state = controller.getSnapshot();
		if (!("snapshot" in state)) return;
		// 首个快照是启动恢复而非用户意图：跳过，避免客户端默认值覆盖
		// Bun 侧已持久化的选择（桌宠形象以 Bun 持久化为启动真相）。
		if (initialVersion === null) {
			initialVersion = state.snapshot.version;
			lastScheduledVersion = state.snapshot.version;
			return;
		}
		if (lastScheduledVersion === state.snapshot.version) return;
		lastScheduledVersion = state.snapshot.version;
		const modelId = state.snapshot.values.pet.modelId;
		// Preserve preference order if consecutive saves complete while the bridge
		// is still delivering an earlier model update.
		deliveryTail = deliveryTail
			.then(async () => {
				if (!disposed) await bridge.setModel(modelId);
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
