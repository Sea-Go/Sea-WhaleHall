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

/** 表情卡死保护:超过时长这么久仍未播完即释放桌宠。 */
const STICKER_STALL_LIMIT_MS = 2_000;

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
	/**
	 * 表情播放态(标准 §8):任意宽高比 GIF 帧等比缩放居中。播放头只在
	 * 目标帧就绪的刷新间隔内推进——加载延迟既不吃表情时长,也不会空窗。
	 */
	private stickerPlayback: {
		packId: string;
		stickerId: string;
		dir: string;
		frames: number;
		frameIntervalMs: number;
		durationMs: number;
		/** 起表时刻(墙钟),仅用于卡死保护。 */
		startedAt: number;
		lastTickAt: number;
		/** 已播放时长(ms):只在目标帧就绪的刷新间隔内累加。 */
		playheadMs: number;
		starved: boolean;
		hold: HTMLImageElement | null;
		/** 对账:实际显示过的帧号、按住旧帧的刷新次数。 */
		shown: Set<number>;
		starvedTicks: number;
	} | null = null;
	/** 连发时后到的表情优先:令牌不匹配的旧请求不再切入。 */
	private stickerRequest = 0;
	private foreignClipIndexes = new Map<string, ClipIndexFile>();

	/**
	 * 播放表情包条目(命名空间动作经 Bun 解析后下发);播满时长自动回到
	 * 当前行为动作。
	 */
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
		const frameUrl = (index: number): string =>
			this.stickerFrameUrl(sticker.packId, dir, index);
		// 首帧就绪才切入表情模式并起表:此前桌宠照常绘制,加载延迟不产生
		// 空窗、也不吞掉短表情的时长。其余帧整段预热。
		const request = ++this.stickerRequest;
		ensureImage(frameUrl(1), () => {
			if (request !== this.stickerRequest) return;
			const now = performance.now();
			const durationMs = Math.max(1, sticker.durationMs);
			this.stickerPlayback = {
				packId: sticker.packId,
				stickerId: sticker.stickerId,
				dir,
				frames,
				// 素材原生节拍(时长/解帧数),不设帧率上限:高帧率表情由显示
				// 刷新自然丢帧,节拍与时长保持原样(钳到 30fps 会截掉尾部帧)。
				frameIntervalMs: durationMs / frames,
				durationMs,
				startedAt: now,
				lastTickAt: now,
				playheadMs: 0,
				starved: false,
				hold: null,
				shown: new Set(),
				starvedTicks: 0,
			};
			this.onImageReady?.();
		});
		for (let index = 2; index <= frames; index += 1) ensureImage(frameUrl(index));
	}

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
			// 表情是独立素材:抵消场景的朝向镜像/按压形变/旋转(带文字的
			// 表情不能跟着桌宠翻面),只保留位置偏移。
			context.save();
			const scaleX = frame.root.scaleX * frame.root.facingX;
			const scaleY = frame.root.scaleY;
			if (scaleX !== 0 && scaleY !== 0) {
				context.scale(1 / scaleX, 1 / scaleY);
				context.rotate(-frame.root.rotation);
			}
			// 表情播放中画表情;播满时长的这次刷新直接落回行为动作,同帧不空窗。
			const playing = this.drawSticker(context);
			context.restore();
			if (playing) return;
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

	private stickerFrameUrl(packId: string, dir: string, index: number): string {
		return `petpacks/${packId}/${dir}/f_${String(index).padStart(2, "0")}.png`;
	}

	/**
	 * 表情渲染:等比缩放居中(letterbox)画进本包画布。返回 false 表示表情
	 * 已播完,调用方在这次刷新继续画行为动作。
	 */
	private drawSticker(context: CanvasRenderingContext2D): boolean {
		const sticker = this.stickerPlayback;
		if (sticker === null) return false;
		const now = performance.now();
		// 卡死保护:素材帧缺失或加载停滞时不让表情占住桌宠。
		if (now - sticker.startedAt > sticker.durationMs + STICKER_STALL_LIMIT_MS) {
			this.finishSticker(now);
			return false;
		}
		// 上个刷新间隔里显示的是就绪帧才计时;按住旧帧的间隔不计入时长。
		const delta = Math.min(100, Math.max(0, now - sticker.lastTickAt));
		sticker.lastTickAt = now;
		if (!sticker.starved) sticker.playheadMs += delta;
		const frameIndex =
			Math.floor(sticker.playheadMs / sticker.frameIntervalMs) + 1;
		if (frameIndex > sticker.frames) {
			this.finishSticker(now);
			return false;
		}
		petRenderObserver.onActionSwitch(
			`@${sticker.packId}/${sticker.stickerId}`,
			now,
		);
		const url = this.stickerFrameUrl(sticker.packId, sticker.dir, frameIndex);
		const image = imageCache.get(url);
		if (image === undefined) {
			// 目标帧未就绪:按住上一帧且播放头暂停,绝不空窗。
			ensureImage(url, () => this.onImageReady?.());
			sticker.starvedTicks += 1;
			sticker.starved = true;
			if (sticker.hold !== null) this.drawLetterboxed(context, sticker.hold);
			return true;
		}
		petRenderObserver.onSpriteBlank(null);
		sticker.starved = false;
		sticker.hold = image;
		sticker.shown.add(frameIndex);
		this.drawLetterboxed(context, image);
		return true;
	}

	private finishSticker(now: number): void {
		const sticker = this.stickerPlayback;
		this.stickerPlayback = null;
		if (sticker !== null) {
			petRenderObserver.onStickerFinished({
				ref: `@${sticker.packId}/${sticker.stickerId}`,
				frames: sticker.frames,
				shown: sticker.shown.size,
				starvedTicks: sticker.starvedTicks,
				clockMs: sticker.playheadMs,
				wallMs: now - sticker.startedAt,
				durationMs: sticker.durationMs,
			});
		}
		petRenderObserver.onActionSwitch(this.lastActionId || "idle", now);
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
