import type { PetMood, PetState } from "../../shared/contracts";

export interface PetRenderer {
	mount(canvas: HTMLCanvasElement): void;
	setState(state: PetState): void;
	dispose(): void;
}

export class CanvasWhaleRenderer implements PetRenderer {
	private canvas: HTMLCanvasElement | null = null;
	private context: CanvasRenderingContext2D | null = null;
	private frame = 0;
	private state: PetState = { mood: "idle", message: "WhaleHall" };
	private startedAt = performance.now();
	private whaleBounds = { x: 0, y: 0, width: 0, height: 0 };

	constructor(private readonly onInteract: () => void) {}

	mount(canvas: HTMLCanvasElement): void {
		this.dispose();
		this.canvas = canvas;
		this.context = canvas.getContext("2d");
		if (!this.context) throw new Error("Canvas 2D context is unavailable.");
		this.startedAt = performance.now();
		window.addEventListener("resize", this.resize);
		canvas.addEventListener("pointerdown", this.handlePointerDown);
		this.resize();
		this.render(performance.now());
	}

	setState(state: PetState): void {
		this.state = state;
	}

	dispose(): void {
		if (this.frame) cancelAnimationFrame(this.frame);
		window.removeEventListener("resize", this.resize);
		this.canvas?.removeEventListener("pointerdown", this.handlePointerDown);
		this.canvas = null;
		this.context = null;
		this.frame = 0;
	}

	private readonly resize = () => {
		if (!this.canvas || !this.context) return;
		const rect = this.canvas.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
		this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
		this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
	};

	private readonly handlePointerDown = (event: PointerEvent) => {
		if (!this.canvas) return;
		const rect = this.canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const bounds = this.whaleBounds;
		if (
			x >= bounds.x &&
			x <= bounds.x + bounds.width &&
			y >= bounds.y &&
			y <= bounds.y + bounds.height
		) {
			this.onInteract();
		}
	};

	private readonly render = (now: number) => {
		if (!this.canvas || !this.context) return;
		const context = this.context;
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		const time = (now - this.startedAt) / 1000;
		context.clearRect(0, 0, width, height);

		const centerX = width * 0.52;
		const centerY = height * 0.56 + Math.sin(time * 1.8) * 7;
		const scale = this.state.mood === "happy" ? 1.04 + Math.sin(time * 9) * 0.025 : 1;
		this.whaleBounds = {
			x: centerX - 125 * scale,
			y: centerY - 72 * scale,
			width: 250 * scale,
			height: 144 * scale,
		};

		context.save();
		context.translate(centerX, centerY);
		context.scale(scale, scale);
		this.drawShadow(context);
		this.drawWhale(context, time);
		context.restore();
		this.drawMessage(context, width, centerY);

		this.frame = requestAnimationFrame(this.render);
	};

	private drawShadow(context: CanvasRenderingContext2D): void {
		const gradient = context.createRadialGradient(0, 58, 10, 0, 58, 105);
		gradient.addColorStop(0, "rgba(0, 20, 28, 0.34)");
		gradient.addColorStop(1, "rgba(0, 20, 28, 0)");
		context.fillStyle = gradient;
		context.beginPath();
		context.ellipse(0, 58, 105, 18, 0, 0, Math.PI * 2);
		context.fill();
	}

	private drawWhale(context: CanvasRenderingContext2D, time: number): void {
		const palettes: Record<PetMood, readonly [string, string]> = {
			idle: ["#36c6d3", "#167a9b"],
			happy: ["#6de8d8", "#2397ac"],
			busy: ["#84c9f4", "#435ca8"],
			error: ["#ff8b9d", "#a64266"],
		};
		const palette = palettes[this.state.mood];

		context.save();
		context.rotate(Math.sin(time * 1.4) * 0.025);
		const body = context.createLinearGradient(-80, -42, 80, 44);
		body.addColorStop(0, palette[0]);
		body.addColorStop(1, palette[1]);
		context.fillStyle = body;
		context.beginPath();
		context.moveTo(-96, 0);
		context.bezierCurveTo(-85, -55, 30, -67, 93, -22);
		context.bezierCurveTo(113, -7, 105, 31, 62, 48);
		context.bezierCurveTo(4, 70, -78, 45, -96, 0);
		context.fill();

		context.fillStyle = "rgba(224, 255, 255, 0.72)";
		context.beginPath();
		context.ellipse(17, 33, 58, 22, -0.08, 0, Math.PI * 2);
		context.fill();

		const tailWave = Math.sin(time * 3.2) * 0.15;
		context.save();
		context.translate(-92, -1);
		context.rotate(tailWave);
		context.fillStyle = palette[1];
		context.beginPath();
		context.moveTo(0, 0);
		context.quadraticCurveTo(-42, -49, -57, -21);
		context.quadraticCurveTo(-48, 1, -6, 9);
		context.quadraticCurveTo(-48, 20, -55, 48);
		context.quadraticCurveTo(-22, 53, 0, 8);
		context.closePath();
		context.fill();
		context.restore();

		context.fillStyle = "rgba(20, 102, 133, 0.8)";
		context.beginPath();
		context.ellipse(22, 43, 36, 10, 0.55, 0, Math.PI * 2);
		context.fill();

		context.fillStyle = "#062b3b";
		context.beginPath();
		context.arc(59, -16, 5, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = "white";
		context.beginPath();
		context.arc(61, -18, 1.7, 0, Math.PI * 2);
		context.fill();

		context.strokeStyle = "rgba(4, 48, 65, 0.78)";
		context.lineWidth = 2;
		context.lineCap = "round";
		context.beginPath();
		context.arc(73, -4, 15, 0.35, 1.55);
		context.stroke();
		context.restore();

		if (this.state.mood === "busy") this.drawBubbles(context, time);
	}

	private drawBubbles(context: CanvasRenderingContext2D, time: number): void {
		context.strokeStyle = "rgba(183, 242, 255, 0.8)";
		context.lineWidth = 2;
		for (let index = 0; index < 3; index += 1) {
			const phase = (time * 35 + index * 24) % 74;
			context.beginPath();
			context.arc(48 + index * 13, -52 - phase, 3 + index, 0, Math.PI * 2);
			context.stroke();
		}
	}

	private drawMessage(
		context: CanvasRenderingContext2D,
		width: number,
		centerY: number,
	): void {
		const text = truncate(this.state.message, 42);
		context.font = "600 12px ui-sans-serif, system-ui, sans-serif";
		const textWidth = Math.min(width - 42, context.measureText(text).width + 28);
		const x = (width - textWidth) / 2;
		const y = Math.min(centerY + 86, this.canvas?.clientHeight ? this.canvas.clientHeight - 36 : 260);
		context.fillStyle = "rgba(4, 20, 29, 0.82)";
		context.beginPath();
		context.roundRect(x, y, textWidth, 28, 14);
		context.fill();
		context.fillStyle = "rgba(225, 251, 255, 0.94)";
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(text, width / 2, y + 14, textWidth - 16);
	}
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
