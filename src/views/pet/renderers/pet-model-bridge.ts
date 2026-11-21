/**
 * 包模型桥:把 PetPackDescriptor 适配为既有 PetModel 接口,让
 * CanvasPetRenderer 的场景/指针/行为粘合原样工作——序列帧通路经包
 * 声明绘制,姿态权重不消费(标准 §6 的 sequence 实现经由既有场景落地;
 * PetFrame 语义体系的完整退役在下一增量化提交)。
 */

import type {
	PetAnchorId,
	PetFrame,
	PetHitZone,
	PetModel,
	PetModelSkeleton,
	PetModelTheme,
	PetVector2,
} from "../core/types";
import type { PetPackDescriptor } from "../../../shared/contracts";
import { petRenderObserver } from "./pet-render-observer";

const imageCache = new Map<string, HTMLImageElement>();
const pendingLoads = new Set<string>();

function ensureImage(
	url: string,
	onReady?: (image: HTMLImageElement) => void,
): void {
	if (imageCache.has(url)) {
		petRenderObserver.onImageHit();
		const cached = imageCache.get(url);
		if (cached !== undefined) onReady?.(cached);
		return;
	}
	if (pendingLoads.has(url)) return;
	petRenderObserver.onImageMiss(url);
	pendingLoads.add(url);
	const image = new Image();
	image.onload = () => {
		petRenderObserver.onImageHit();
		pendingLoads.delete(url);
		imageCache.set(url, image);
		onReady?.(image);
	};
	image.onerror = () => {
		petRenderObserver.onImageError(url);
		pendingLoads.delete(url);
	};
	image.src = url;
}

interface ClipIndexFile {
	schema: "whalehall.pet-clip-index.v1";
	clips: Record<string, number>;
	/** 表情包专用:中文 sticker id → ASCII slug 目录(规避 views:// 中文路径悬挂)。 */
	stickerDirs?: Record<string, string>;
	fps?: number;
}

export class PetPackModelBridge implements PetModel {
	readonly id: string;
	readonly label: string;
	readonly skeleton: PetModelSkeleton;
	readonly theme: PetModelTheme = { colors: {} };
	readonly selfContainedOverlays = true;

	private readonly pack: PetPackDescriptor;
	private clipIndex: Record<string, number> = {};
	private lastActionId = "";
	private lastImage: HTMLImageElement | null = null;
	private prefetchedClips = new Set<string>();
	/** 外部表情包的帧数索引缓存(packId → clipIndex)。 */
	/** 表情播放模式(标准 §8):任意宽高比 GIF 帧等比缩放居中,时长截断。 */
	private stickerPlayback: {
		packId: string;
		stickerId: string;
		dir: string;
		frames: number;
		fps: number;
		startedAt: number;
		untilMs: number;
		lastImage: HTMLImageElement | null;
	} | null = null;

	/** 播放表情包条目(命名空间动作经 Bun 解析后下发);播完自动回当前行为动作。 */
	async playSticker(sticker: {
		packId: string;
		stickerId: string;
		durationMs: number;
	}): Promise<void> {
		let dir = sticker.stickerId;
		let frames = 1;
		try {
			const index = await this.foreignClipIndex(sticker.packId);
			dir = index.stickerDirs?.[sticker.stickerId] ?? sticker.stickerId;
			frames = Math.max(1, index.clips[dir] ?? 1);
		} catch {
			// 索引缺失按单帧兜底;构建管线保证其存在。
		}
		const fps = Math.min(
			30,
			Math.max(4, frames / Math.max(0.2, sticker.durationMs / 1000)),
		);
		const now = performance.now();
		this.stickerPlayback = {
			...sticker,
			dir,
			frames,
			fps,
			startedAt: now,
			untilMs: now + sticker.durationMs,
			lastImage: null,
		};
		this.onImageReady?.();
	}

	private foreignClipIndexes = new Map<string, ClipIndexFile>();

	private async foreignClipIndex(packId: string): Promise<ClipIndexFile> {
		const cached = this.foreignClipIndexes.get(packId);
		if (cached !== undefined) return cached;
		const response = await fetch(`petpacks/${packId}/clips.json`);
		if (!response.ok) throw new Error(`clips.json unavailable for ${packId}`);
		const index = (await response.json()) as ClipIndexFile;
		this.foreignClipIndexes.set(packId, index);
		return index;
	}

	/** 整段片段预热:动作首启时把该 clip 全部帧提交加载(本地小图,量有限),
	 * 消除逐帧冷加载造成的逐帧空窗。 */
	private prefetchClip(actionId: string): void {
		const clip = this.clipFor(actionId);
		if (clip === undefined || this.prefetchedClips.has(clip)) return;
		this.prefetchedClips.add(clip);
		const total = Math.max(1, this.clipIndex[clip] ?? 1);
		for (let index = 1; index <= total; index += 1) {
			const url = this.frameUrlFor(actionId, index);
			if (url !== undefined) ensureImage(url);
		}
	}

	constructor(pack: PetPackDescriptor) {
		this.pack = pack;
		this.id = pack.id;
		this.label = pack.label;
		const { canvas, sprite } = pack;
		this.skeleton = {
			visualBounds: {
				x: sprite.left,
				y: sprite.top,
				width: canvas.width,
				height: canvas.height,
			},
			groundAnchor: { x: -sprite.left, y: canvas.groundAnchorY },
			anchors: ["bodyCenter", "message"] as readonly PetAnchorId[],
			hitZones: pack.hitZones.map(
				(zone) => zone.id,
			) as readonly PetHitZone[],
		};
		void this.loadClipIndex();
	}

	private async loadClipIndex(): Promise<void> {
		try {
			const response = await fetch(`${this.pack.assetBase}clips.json`);
			if (!response.ok) return;
			const index = (await response.json()) as ClipIndexFile;
			this.clipIndex = index.clips;
		} catch {
			// 帧数表缺失时逐帧 1 兜底;构建管线保证其存在。
		}
		// 帧数表就绪后重做当前动作的整段预热(启动早期索引未到时只预了 1 帧)。
		this.prefetchedClips.clear();
		if (this.lastActionId !== "") this.prefetchClip(this.lastActionId);
	}

	preload(): Promise<void> {
		return Promise.resolve();
	}

	private clipFor(actionId: string): string | undefined {
		const action = this.pack.actions.find((entry) => entry.id === actionId) ??
			this.pack.actions.find(
				(entry) => entry.id === this.pack.fallbackAction,
			);
		return action?.clip;
	}

	/** 帧图片就绪回调:通知场景重绘(图片加载是异步的,需要触发一帧)。 */
	private onImageReady: (() => void) | null = null;

	/** 场景层注入重绘触发器(经 scheduleFrame 合并,不产生递归渲染)。 */
	setOnImageReady(callback: () => void): void {
		this.onImageReady = callback;
	}

	draw(context: CanvasRenderingContext2D, frame: PetFrame): void {
		if (this.stickerPlayback !== null) {
			this.drawSticker(context);
			return;
		}
		const actionId = frame.action.id;
		petRenderObserver.onActionSwitch(actionId, performance.now());
		if (actionId !== this.lastActionId) {
			this.lastActionId = actionId;
			this.prefetchClip(actionId);
		}
		const total = Math.max(1, this.clipIndex[this.clipFor(actionId) ?? ""] ?? 1);
		const index =
			Math.floor(Math.min(0.9999, Math.max(0, frame.action.progress)) * total) + 1;
		const url = this.frameUrlFor(actionId, index);
		const image = url === undefined ? undefined : imageCache.get(url);
		if (url === undefined || image === undefined) {
			// 目标帧未就绪:提交加载并请求补帧;期间回退上一成功帧,
			// 绝不空窗(空窗=用户看到的闪帧/消失)。
			if (url !== undefined) {
				ensureImage(url, () => this.onImageReady?.());
			}
			petRenderObserver.onSpriteBlank(url === undefined ? "no-clip" : "loading");
			if (this.lastImage === null) return;
			context.drawImage(
				this.lastImage,
				this.pack.sprite.left,
				this.pack.sprite.top,
			);
			return;
		}
		petRenderObserver.onSpriteBlank(null);
		this.lastImage = image;
		context.drawImage(
			image,
			this.pack.sprite.left,
			this.pack.sprite.top,
		);
	}

	private frameUrlFor(actionId: string, index: number): string | undefined {
		const clip = this.clipFor(actionId);
		if (clip === undefined) return undefined;
		return `${this.pack.assetBase}${clip}/f_${String(index).padStart(2, "0")}.png`;
	}

	/** 表情渲染:等比缩放居中(letterbox)画进本包画布,时长到期回行为动作。 */
	private drawSticker(context: CanvasRenderingContext2D): void {
		const sticker = this.stickerPlayback;
		if (sticker === null) return;
		const now = performance.now();
		if (now >= sticker.untilMs) {
			this.stickerPlayback = null;
			petRenderObserver.onActionSwitch(this.lastActionId || "idle", now);
			return;
		}
		petRenderObserver.onActionSwitch(
			`@${sticker.packId}/${sticker.stickerId}`,
			now,
		);
		const elapsedSeconds = (now - sticker.startedAt) / 1000;
		const frameIndex =
			(Math.floor(elapsedSeconds * sticker.fps) % sticker.frames) + 1;
		const url = `petpacks/${sticker.packId}/${sticker.dir}/f_${String(frameIndex).padStart(2, "0")}.png`;
		const image = imageCache.get(url);
		if (image === undefined) {
			// 目标帧未就绪:提交加载,加载完成即"收养"为保持帧——加载速度
			// 落后于播放步进时按住最近已加载的表情帧,绝不回退桌宠本体。
			ensureImage(url, (loaded) => {
				const current = this.stickerPlayback;
				if (current !== null) current.lastImage = loaded;
				this.onImageReady?.();
			});
			petRenderObserver.onSpriteBlank("sticker-loading");
			const fallback = sticker.lastImage;
			if (fallback === null) return;
			this.drawLetterboxed(context, fallback);
			return;
		}
		petRenderObserver.onSpriteBlank(null);
		sticker.lastImage = image;
		this.drawLetterboxed(context, image);
	}

	private drawLetterboxed(
		context: CanvasRenderingContext2D,
		image: HTMLImageElement,
	): void {
		const { canvas, sprite } = this.pack;
		const scale = Math.min(
			canvas.width / image.width,
			canvas.height / image.height,
		);
		const width = image.width * scale;
		const height = image.height * scale;
		context.drawImage(
			image,
			sprite.left + (canvas.width - width) / 2,
			sprite.top + (canvas.height - height) / 2,
			width,
			height,
		);
	}

	hitTest(localPoint: PetVector2): PetHitZone | null {
		for (const zone of this.pack.hitZones) {
			const dx = localPoint.x - zone.cx;
			const dy = localPoint.y - zone.cy;
			if ((dx / zone.rx) ** 2 + (dy / zone.ry) ** 2 <= 1) return zone.id;
		}
		return null;
	}

	resolveAnchor(anchor: PetAnchorId): PetVector2 {
		const { canvas, sprite } = this.pack;
		const centerX = sprite.left + canvas.width / 2;
		switch (anchor) {
			case "ground":
				// 地面线:立足锚(阴影绘制用)。局部坐标原点在精灵中心,
				// 立足线 = groundAnchorY + sprite.top(贴底画布即 h/2)。
				return { x: centerX, y: canvas.groundAnchorY + sprite.top };
			case "message":
				return { x: centerX, y: canvas.groundAnchorY };
			default:
				return { x: centerX, y: sprite.top + canvas.height / 2 };
		}
	}
}
