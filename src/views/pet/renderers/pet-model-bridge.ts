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

function ensureImage(url: string, onReady?: () => void): void {
	if (imageCache.has(url)) {
		petRenderObserver.onImageHit();
		onReady?.();
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
		onReady?.();
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
