import { useEffect, useRef } from "react";
import { PetBehaviorController } from "./behavior";
import { CanvasPetRenderer } from "./CanvasPetRenderer";
import { PetActivityFeedbackBubble } from "./PetActivityFeedbackBubble";
import { petApi } from "./rpc";

export function PetApp() {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		let behavior: PetBehaviorController;
		const renderer = new CanvasPetRenderer({
			model: "whale",
			onInteract: (event) => {
				behavior.markInteraction();
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
			behavior.setEnabled(state.mood === "idle");
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
		</div>
	);
}
