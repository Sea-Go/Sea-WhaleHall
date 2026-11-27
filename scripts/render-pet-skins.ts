import { createCanvas } from "@napi-rs/canvas";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PetActionId } from "../src/shared/pet-actions";
import {
	PET_ANIMATION_CONFIG,
	PetAnimator,
	type AnimationContext,
	type PetFrame,
} from "../src/views/pet/animations";
import {
	VECTOR_SKIN_BOUNDS,
	drawWhale,
	drawCat,
	type VectorSkinId,
} from "./pet-vector-sources";
import { CLIP_PLANS, type ClipPlan } from "../src/views/pet/skins/pet/clip-plans";

/**
 * 矢量皮肤离线烘焙器：whale/cat 的绘制源（pet-vector-sources.ts）经真实
 * PetAnimator 驱动，按 clip-plans.ts 的全目录计划逐帧烘焙为
 * skins/pet/<id>/<clip>.gif——片段名 = 真实动作名，运行时与 deepseek 同构。
 *
 * 用法：bun run render:pet-skins
 */

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skinRoot = resolve(projectRoot, "src/views/pet/skins/pet");

const FPS = 16;

type BakeJob = {
	clip: string;
	action: PetActionId;
	frames: number;
	once: boolean;
	tone?: string;
};

function bakeJobs(skin: VectorSkinId): BakeJob[] {
	return CLIP_PLANS[skin].map((plan) => {
		const action = plan.actions[0];
		if (action === undefined) {
			throw new Error(`皮肤 ${skin} 的片段 ${plan.clip} 没有动作。`);
		}
		return {
			clip: plan.clip,
			action,
			frames: plan.frames,
			once: plan.once,
			tone: plan.tone,
		};
	});
}

function deterministicRandom(): number {
	// 固定种子：烘焙可复现。
	return 0.001;
}

function animationContext(
	width: number,
	height: number,
	time: number,
	deltaSeconds: number,
): AnimationContext {
	return {
		width,
		height,
		travelBounds: { minX: -10_000, maxX: 10_000 },
		time,
		deltaSeconds,
		reducedMotion: false,
		pointerLocal: { x: 0, y: 0 },
		aim: { x: 0, y: 0 },
		dragDelta: { x: 0, y: 0 },
		message: "",
		hoverAmount: 0,
		pressAmount: 0,
	};
}

function roundRectShim(context: CanvasRenderingContext2D): void {
	if (typeof context.roundRect === "function") return;
	const shim = (
		x: number,
		y: number,
		w: number,
		h: number,
		radii: number | number[] | DOMPointInit | (number | DOMPointInit)[],
	): void => {
		const list = typeof radii === "number" ? [radii] : [4];
		const radius = Math.min(Number(list[0] ?? 4), w / 2, h / 2);
		context.moveTo(x + radius, y);
		context.arcTo(x + w, y, x + w, y + h, radius);
		context.arcTo(x + w, y + h, x, y + h, radius);
		context.arcTo(x, y + h, x, y, radius);
		context.arcTo(x, y, x + w, y, radius);
		context.closePath();
	};
	(context as unknown as Record<string, unknown>).roundRect = shim;
}

async function bakeClip(
	id: VectorSkinId,
	job: BakeJob,
	bounds: { x: number; y: number; width: number; height: number },
	draw: (context: CanvasRenderingContext2D, frame: PetFrame) => void,
): Promise<void> {
	const canvas = createCanvas(bounds.width, bounds.height);
	const context = canvas.getContext("2d");
	roundRectShim(context as unknown as CanvasRenderingContext2D);
	const animator = new PetAnimator(false, deterministicRandom);
	const startNow = 0;
	animator.start(startNow);
	animator.play(job.action, startNow);
	const encoder = GIFEncoder();
	let held: { data: Uint8ClampedArray; width: number; height: number } | null =
		null;
	for (let index = 0; index < job.frames; index += 1) {
		const now = startNow + index * (1000 / FPS);
		const animated = animator.update(
			animationContext(320, 250, now / 1000, 1000 / FPS / 1000),
			now,
		) as PetFrame;
		const onTarget = animated.action.id === job.action;
		if (onTarget) {
			// 计划内色调覆盖（cat 情绪动作带专属调色板；其余中性）。
			animated.tone = (job.tone ?? "neutral") as PetFrame["tone"];
			context.clearRect(0, 0, bounds.width, bounds.height);
			context.save();
			context.translate(-bounds.x, -bounds.y);
			draw(context as unknown as CanvasRenderingContext2D, animated);
			context.restore();
			held = context.getImageData(0, 0, bounds.width, bounds.height);
		} else {
			// 动作提前完成并切换：持住最后一帧（与运行时 hold-last 语义一致）。
			if (held === null) {
				throw new Error(
					`${id}/${job.clip} 首帧就离开了目标动作（${animated.action.id}），检查动作时长。`,
				);
			}
		}
		const palette = quantize(held.data, 256, { format: "rgba4444" });
		const index8 = applyPalette(held.data, palette, "rgba4444");
		encoder.writeFrame(index8, held.width, held.height, {
			palette,
			delay: Math.round(1000 / FPS),
			transparent: true,
		});
	}
	encoder.finish();
	const out = resolve(skinRoot, id, `${job.clip}.gif`);
	await Bun.write(out, encoder.bytes());
	console.log(`[render] ${id}/${job.clip}.gif ${job.frames} 帧 ✓`);
}

async function bakeSkin(id: VectorSkinId): Promise<void> {
	const draw = id === "whale" ? drawWhale : drawCat;
	const bounds = VECTOR_SKIN_BOUNDS[id];
	mkdirSync(resolve(skinRoot, id), { recursive: true });
	for (const job of bakeJobs(id)) {
		await bakeClip(id, job, bounds, draw);
	}
}

async function main(): Promise<void> {
	// 只清理烘焙产物 GIF；目录内的 index.ts/SKIN.md 是源文件，绝不能动。
	await bakeSkin("whale");
	await bakeSkin("cat");
}

await main();
