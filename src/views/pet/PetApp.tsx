import { useEffect, useRef } from "react";
import { CanvasWhaleRenderer } from "./PetRenderer";
import { petApi } from "./rpc";

export function PetApp() {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const renderer = new CanvasWhaleRenderer(() => petApi.interacted());
		renderer.mount(canvas);
		const unsubscribe = petApi.onState((state) => renderer.setState(state));
		petApi.ready();
		return () => {
			unsubscribe();
			renderer.dispose();
		};
	}, []);

	return <canvas ref={canvasRef} aria-label="Animated WhaleHall desktop companion" />;
}
