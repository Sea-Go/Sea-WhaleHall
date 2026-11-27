/**
 * 序列帧渲染适配器(标准 §6 sequence 实现):
 * 选 clip/帧缓存懒加载/facing 镜像/椭圆命中/表情 letterbox 绘制。
 * 纯绘制——不做行为决策;一切差异来自包声明。
 */

import type {
	PetHitZoneId,
	PetPlayOptions,
	PetRendererAdapter,
	PetVector2,
	ResolvedPetPack,
} from "./types";
import { frameUrl } from "./types";

const BAKED_FPS = 16;
const STICKER_REF = /^@([a-z][a-z0-9-]{1,31})\/(.+)$/;

interface ClipPlayback {
	clip: string;
	frames: number;
	loop: boolean;
	startedAt: number;
	holdMs: number | undefined;
}

/** 帧数表:由解帧产物约定(构建期写入 clips.json,适配器只读)。 */
interface ClipIndexFile {
	schema: "whalehall.pet-clip-index.v1";
	clips: Record<string, number>;
	fps?: number;
}

const imageCache = new Map<string, HTMLImageElement>();
const pendingLoads = new Set<string>();

function ensureImage(url: string, onReady?: () => void): void {
	if (imageCache.has(url)) {
		onReady?.();
		return;
	}
	if (pendingLoads.has(url)) return;
	pendingLoads.add(url);
	const image = new Image();
	image.onload = () => {
		pendingLoads.delete(url);
		imageCache.set(url, image);
		onReady?.();
	};
	image.onerror = () => {
		// 失败不缓存:帧文件补齐后下一次绘制即可恢复。
		pendingLoads.delete(url);
	};
	image.src = url;
}

export class SequenceRendererAdapter implements PetRendererAdapter {
	readonly kind = "sequence" as const;

	private pack: ResolvedPetPack;
	private clipIndex: Record<string, number> = {};
	private fps = BAKED_FPS;
	private playback: ClipPlayback | null = null;
	private facing: -1 | 0 | 1 = 0;
	private stickerPlayback: { base: string; durationMs: number; startedAt: number } | null =
		null;
	/** 表情描述符:由宿主经 setStickerSources 提供的命名空间表。 */
	private stickerSources = new Map<string, { base: string; durationMs: number }>();
	private canvas: HTMLCanvasElement | null = null;
	private rafHandle = 0;
	private destroyed = false;
	private onDrawn: (() => void) | null = null;

	constructor(pack: ResolvedPetPack) {
		this.pack = pack;
	}

	/** 表情命名空间来源注册(bun 经 RPC 下发的表情清单)。 */
	setStickerSources(
		sources: ReadonlyMap<string, { base: string; durationMs: number }>,
	): void {
		this.stickerSources = new Map(sources);
	}

	/** 单帧绘制完成回调(场景层挂命中区/调试框用)。 */
	onFrameDrawn(callback: () => void): void {
		this.onDrawn = callback;
	}

	mount(container: HTMLElement): void {
		const canvas = document.createElement("canvas");
		canvas.width = this.pack.manifest.canvas.width;
		canvas.height = this.pack.manifest.canvas.height;
		canvas.style.width = "100%";
		canvas.style.height = "auto";
		container.replaceChildren(canvas);
		this.canvas = canvas;
		this.scheduleFrame();
	}

	async load(pack: ResolvedPetPack): Promise<void> {
		this.pack = pack;
		this.playback = null;
		this.stickerPlayback = null;
		const response = await fetch(`${pack.assetBase}clips.json`);
		if (response.ok) {
			const index = (await response.json()) as ClipIndexFile;
			this.clipIndex = index.clips;
			this.fps = index.fps ?? BAKED_FPS;
		}
		if (this.canvas !== null) {
			this.canvas.width = pack.manifest.canvas.width;
			this.canvas.height = pack.manifest.canvas.height;
		}
		this.play("idle");
	}

	play(actionId: string, opts?: PetPlayOptions): void {
		const stickerMatch = STICKER_REF.exec(actionId);
		if (stickerMatch !== null) {
			const source = this.stickerSources.get(actionId);
			if (source === undefined) return;
			this.stickerPlayback = {
				base: source.base,
				durationMs: source.durationMs,
				startedAt: performance.now(),
			};
			this.playback = null;
			return;
		}
		this.stickerPlayback = null;
		const action = this.pack.actions.find((entry) => entry.id === actionId) ??
			this.pack.actions.find(
				(entry) => entry.id === this.pack.manifest.fallbackAction,
			);
		if (action?.clip === undefined) return;
		if (action.facing !== undefined && action.facing !== 0) {
			this.facing = action.facing;
		}
		const frames = this.clipIndex[action.clip] ?? 1;
		this.playback = {
			clip: action.clip,
			frames,
			loop: action.loop,
			startedAt: performance.now(),
			holdMs: opts?.holdMs,
		};
		// 预载首帧。
		ensureImage(frameUrl(`${this.pack.assetBase}${action.clip}/`, 1));
	}

	setFacing(facing: -1 | 0 | 1): void {
		this.facing = facing;
	}

	hitTest(localPoint: PetVector2): PetHitZoneId | null {
		const { sprite, canvas } = this.pack.manifest;
		const scaleX = canvas.width / Math.max(1, canvas.width);
		for (const zone of this.pack.manifest.hitZones) {
			const zx = sprite.left + zone.cx;
			const zy = sprite.top + zone.cy;
			const dx = localPoint.x - zx;
			const dy = localPoint.y - zy;
			if ((dx / zone.rx) ** 2 + (dy / zone.ry) ** 2 <= 1) {
				return zone.id;
			}
		}
		return null;
	}

	setGaze(): void {
		// sequence 渲染器无参数化视线;空实现(标准 §6)。
	}

	setExpression(): void {
		// sequence 渲染器无表情通道;空实现。
	}

	destroy(): void {
		this.destroyed = true;
		cancelAnimationFrame(this.rafHandle);
		this.canvas?.remove();
		this.canvas = null;
	}

	private scheduleFrame(): void {
		if (this.destroyed) return;
		this.rafHandle = requestAnimationFrame(() => {
			this.draw();
			this.scheduleFrame();
		});
	}

	private currentFrameIndex(): { url: string; done: boolean } {
		const playback = this.playback;
		if (playback === null) {
			return { url: "", done: true };
		}
		const elapsed = performance.now() - playback.startedAt;
		const totalFrames = Math.max(1, playback.frames);
		const frameIndex = Math.floor((elapsed / 1000) * this.fps) + 1;
		if (playback.loop) {
			return {
				url: frameUrl(
					`${this.pack.assetBase}${playback.clip}/`,
					((frameIndex - 1) % totalFrames) + 1,
				),
				done: false,
			};
		}
		const limited =
			playback.holdMs !== undefined
				? Math.min(frameIndex, Math.ceil((playback.holdMs / 1000) * this.fps))
				: Math.min(frameIndex, totalFrames);
		const clamped = Math.min(Math.max(1, limited), totalFrames);
		return {
			url: frameUrl(`${this.pack.assetBase}${playback.clip}/`, clamped),
			done:
				playback.holdMs !== undefined
					? elapsed >= playback.holdMs
					: frameIndex > totalFrames,
		};
	}

	private draw(): void {
		const canvas = this.canvas;
		if (canvas === null) return;
		const context = canvas.getContext("2d");
		if (context === null) return;
		context.clearRect(0, 0, canvas.width, canvas.height);

		if (this.stickerPlayback !== null) {
			this.drawSticker(context);
			return;
		}

		const { url, done } = this.currentFrameIndex();
		if (url === "") return;
		ensureImage(url, () => this.draw());
		const image = imageCache.get(url);
		if (image === undefined) return;

		const { sprite, canvas: manifestCanvas } = this.pack.manifest;
		context.save();
		if (this.facing === -1) {
			context.translate(manifestCanvas.width, 0);
			context.scale(-1, 1);
		}
		context.drawImage(
			image,
			manifestCanvas.width / 2 + sprite.left,
			manifestCanvas.height / 2 + sprite.top,
		);
		context.restore();

		if (done) {
			// 播完去向由行为解释器决定;适配器只报告本片段结束。
			this.onDrawn?.();
		}
		this.onDrawn?.();
	}

	/** 表情渲染模式:任意宽高比等比缩放居中(标准 §8)。 */
	private drawSticker(context: CanvasRenderingContext2D): void {
		const sticker = this.stickerPlayback;
		if (sticker === null) return;
		const frameCount = this.clipIndex[sticker.base] ?? 1;
		const elapsed = performance.now() - sticker.startedAt;
		if (elapsed >= sticker.durationMs) {
			this.stickerPlayback = null;
			this.play("idle");
			return;
		}
		const frameIndex = (Math.floor((elapsed / 1000) * this.fps) % frameCount) + 1;
		const url = frameUrl(sticker.base, frameIndex);
		ensureImage(url, () => this.draw());
		const image = imageCache.get(url);
		if (image === undefined) return;
		const { width, height } = this.pack.manifest.canvas;
		const scale = Math.min(width / image.width, height / image.height);
		const drawWidth = image.width * scale;
		const drawHeight = image.height * scale;
		context.drawImage(
			image,
			(width - drawWidth) / 2,
			(height - drawHeight) / 2,
			drawWidth,
			drawHeight,
		);
	}
}
