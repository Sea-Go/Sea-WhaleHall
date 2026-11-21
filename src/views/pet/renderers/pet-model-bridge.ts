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

	private static debugLogged = false;

	draw(context: CanvasRenderingContext2D, frame: PetFrame): void {
		if (!PetPackModelBridge.debugLogged) {
			PetPackModelBridge.debugLogged = true;
			const probe = new Image();
			probe.onload = () => console.log(`[pack-bridge] probe OK: ${probe.width}x${probe.height}`);
			probe.onerror = () => console.log(`[pack-bridge] probe FAIL`);
			probe.src = `${this.pack.assetBase}idle/f_01.png`;
			console.log(`[pack-bridge] draw called action=${frame.action.id} opacity=${frame.root.opacity} clipIdx=${JSON.stringify(Object.keys(this.clipIndex).slice(0, 3))}`);
		}
		const actionId = frame.action.id;
		if (actionId !== this.lastActionId) {
			this.lastActionId = actionId;
			const first = this.frameUrlFor(actionId, 1);
			if (first !== undefined) ensureImage(first);
		}
		const total = Math.max(1, this.clipIndex[this.clipFor(actionId) ?? ""] ?? 1);
		const index =
			Math.floor(Math.min(0.9999, Math.max(0, frame.action.progress)) * total) + 1;
		const url = this.frameUrlFor(actionId, index);
		if (url === undefined) return;
		ensureImage(url, () => undefined);
		const image = imageCache.get(url);
		if (image === undefined) return;
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
			case "message":
				return { x: centerX, y: canvas.groundAnchorY };
			default:
				return { x: centerX, y: sprite.top + canvas.height / 2 };
		}
	}
}
