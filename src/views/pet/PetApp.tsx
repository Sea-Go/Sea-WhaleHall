import { useEffect, useRef, useState } from "react";
import { PetBehaviorController } from "./behavior";
import { CanvasPetRenderer } from "./CanvasPetRenderer";
import { PetPackModelBridge } from "./renderers/pet-model-bridge";
import { petRenderObserver } from "./renderers/pet-render-observer";
import { PetChatController } from "./chat";
import { PetActivityFeedbackBubble } from "./PetActivityFeedbackBubble";
import { PetDevDebugOverlay } from "./PetDevDebugOverlay";
import { PetChatPanel } from "./PetChatPanel";
import { createPetChatPort, petApi } from "./rpc";

export function PetApp() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [chatController, setChatController] =
		useState<PetChatController | null>(null);
	const [debugOverlays, setDebugOverlays] = useState(false);
	const [petHovered, setPetHovered] = useState(false);
	// dev 对话区调试框与气泡同隐同显：可见性由 PetChatPanel 上报。
	const [chatVisible, setChatVisible] = useState(false);

	// 必须先于 petApi.ready() 注册，Bun 会在 ready 时推送当前可用性；事件流
	// 终身订阅（控制器内部按 requestId 过滤本面板的 turn）。
	useEffect(() => {
		const controller = new PetChatController(createPetChatPort());
		const unsubscribeAvailability = petApi.onPetChatAvailability(
			(available) => {
				controller.setAvailable(available);
				setChatController(available ? controller : null);
			},
		);
		const unsubscribeEvents = petApi.onPetChatEvent((requestId, envelope) => {
			controller.applyEvent(requestId, envelope);
		});
		const unsubscribeRejected = petApi.onPetChatRejected(
			(requestId, message) => {
				controller.rejectTurn(requestId, message);
			},
		);
		const unsubscribeProactive = petApi.onPetChatProactiveTurn((requestId) => {
			controller.enterProactiveTurn(requestId);
		});
		return () => {
			unsubscribeAvailability();
			unsubscribeEvents();
			unsubscribeRejected();
			unsubscribeProactive();
		};
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		let behavior: PetBehaviorController;
		// 形象一律来自 PetState.pack(《桌宠包标准 v1》):构造期不注入
		// 任何形象,包描述符到达即经桥热切换——代码零形象知识。
		const renderer = new CanvasPetRenderer({
			onInteract: (event) => {
				behavior.markInteraction();
				// 兼容模式显隐信号：悬停/拖拽桌宠即唤出对话气泡。
				if (event.kind === "hover" || event.kind === "dragStart") {
					setPetHovered(true);
				} else if (event.kind === "hoverEnd") {
					setPetHovered(false);
				}
				if (
					event.kind === "hover" ||
					event.kind === "pet" ||
					(event.kind === "petEnd" && event.action === "hoverLookAtPointer") ||
					event.kind === "dragStart"
				) {
					behavior.setEngaged(true);
				} else if (
					event.kind === "hoverEnd" ||
					(event.kind === "petEnd" && event.action !== "hoverLookAtPointer") ||
					event.kind === "dragEnd"
				) {
					behavior.setEngaged(false);
				}
				petApi.interacted(event);
			},
		});
		behavior = new PetBehaviorController({
			play: (action) => renderer.play(action),
		});
		behavior.setEnabled(false);
		renderer.mount(canvas);
		let bridgedPackId = "";
		let lastBehaviorEnabled = false;
		const unsubscribeState = petApi.onState((state) => {
			// dev 通道盖章的调试开关：true 时叠加"活动区/对话区"接触范围框。
			setDebugOverlays(Boolean(state.debugOverlays));
			// 包描述符(《桌宠包标准 v1》):经桥适配为模型,场景零改动热切换。
			if (state.pack && state.pack.id !== bridgedPackId) {
				bridgedPackId = state.pack.id;
				const bridge = new PetPackModelBridge(state.pack);
				bridge.setOnImageReady(() => renderer.requestRender());
				renderer.setModel(bridge);
			}
			renderer.setState(state);
			// 包模式:行为启停只在 mood 边沿变化时操作,不每次推送都重设——
			// 反复 setEnabled 会打断动作控制器造成桌宠闪缩。
			const stateAction = state.action ?? state.animation;
			const shouldBeEnabled =
				state.mood === "idle" && (!stateAction || stateAction === "idle");
			if (shouldBeEnabled !== lastBehaviorEnabled) {
				lastBehaviorEnabled = shouldBeEnabled;
				behavior.setEnabled(shouldBeEnabled);
			}
			if (state.environment) behavior.setEnvironment(state.environment);
		});
		const unsubscribeNativeDrag = petApi.onNativeDrag((state) => {
			if (!state.dragging) renderer.play("drop");
		});
		const handleVisibility = () => {
				petRenderObserver.onVisibilityChange(!document.hidden, performance.now());
				behavior.setPresent(!document.hidden);
			};
		document.addEventListener("visibilitychange", handleVisibility);
		const behaviorTimer = window.setTimeout(() => behavior.start(true), 900);
		petApi.ready();
		return () => {
			petApi.unready();
			window.clearTimeout(behaviorTimer);
			document.removeEventListener("visibilitychange", handleVisibility);
			unsubscribeState();
			unsubscribeNativeDrag();
			behavior.dispose();
			renderer.dispose();
		};
	}, []);

	return (
		<div className="pet-stage">
			<canvas ref={canvasRef} aria-label="WhaleHall 可交互桌面伙伴" />
			<PetDevDebugOverlay active={debugOverlays && chatVisible} />
			<PetActivityFeedbackBubble />
			<PetChatPanel
				controller={chatController}
				petHovered={petHovered}
				onVisibleChange={setChatVisible}
			/>
		</div>
	);
}
