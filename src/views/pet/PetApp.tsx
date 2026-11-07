import { useEffect, useRef, useState } from "react";
import { PetBehaviorController } from "./behavior";
import { CanvasPetRenderer } from "./CanvasPetRenderer";
import { PetChatController } from "./chat";
import { PetActivityFeedbackBubble } from "./PetActivityFeedbackBubble";
import { PetChatPanel } from "./PetChatPanel";
import { createPetChatPort, petApi } from "./rpc";

export function PetApp() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [chatController, setChatController] = useState<PetChatController | null>(
		null,
	);

	// 必须先于 petApi.ready() 注册，Bun 会在 ready 时推送当前可用性；事件流
	// 终身订阅（控制器内部按 requestId 过滤本面板的 turn）。
	useEffect(() => {
		const controller = new PetChatController(createPetChatPort());
		const unsubscribeAvailability = petApi.onPetChatAvailability((available) => {
			controller.setAvailable(available);
			setChatController(available ? controller : null);
		});
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
		const renderer = new CanvasPetRenderer({
			model: "whale",
			onInteract: (event) => {
				behavior.markInteraction();
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
		const unsubscribeState = petApi.onState((state) => {
			renderer.setState(state);
			const stateAction = state.action ?? state.animation;
			behavior.setEnabled(
				state.mood === "idle" && (!stateAction || stateAction === "idle"),
			);
			if (state.environment) behavior.setEnvironment(state.environment);
		});
		const unsubscribeNativeDrag = petApi.onNativeDrag((state) => {
			if (!state.dragging) renderer.play("drop");
		});
		const handleVisibility = () => behavior.setPresent(!document.hidden);
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
			<PetActivityFeedbackBubble />
			<PetChatPanel controller={chatController} />
		</div>
	);
}
