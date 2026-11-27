/**
 * 渲染适配器接口(《桌宠包标准 v1》§6):宿主逻辑与绘制的唯一边界。
 * sequence(现役)与 live2d(后续)同构实现;新增渲染器=实现此接口
 * +注册表加一行。
 */

export interface PetVector2 {
	x: number;
	y: number;
}

export type PetHitZoneId = "head" | "face" | "body" | "tail" | "limb";

/** 视图侧解析后的包描述符(经 RPC 从 bun 下发)。 */
export interface ResolvedPetPack {
	manifest: {
		id: string;
		label: string;
		renderer: "sequence" | "live2d";
		canvas: { width: number; height: number; groundAnchorY: number };
		sprite: { left: number; top: number };
		tier: "full" | "core";
		fallbackAction: string;
		hitZones: readonly {
			id: PetHitZoneId;
			cx: number;
			cy: number;
			rx: number;
			ry: number;
		}[];
		summary: string;
	};
	actions: readonly {
		id: string;
		clip?: string;
		motionGroup?: string;
		durationMs: number;
		loop: boolean;
		next?: string;
		facing?: -1 | 0 | 1;
	}[];
	/** 素材基址(相对 pet 视图根,如 petpacks/alpha/)。 */
	assetBase: string;
}

export interface PetPlayOptions {
	holdMs?: number;
}

export interface PetRendererAdapter {
	readonly kind: "sequence" | "live2d";
	mount(container: HTMLElement): void;
	load(pack: ResolvedPetPack): Promise<void>;
	play(actionId: string, opts?: PetPlayOptions): void;
	setFacing(facing: -1 | 0 | 1): void;
	hitTest(localPoint: PetVector2): PetHitZoneId | null;
	/** live2d 期启用;sequence 空实现。 */
	setGaze?(v: PetVector2): void;
	setExpression?(id: string): void;
	destroy(): void;
}

export interface PetStickerDescriptor {
	/** 表情素材帧基址(解帧产物目录,如 petpacks/memepack/开心/)。 */
	assetBase: string;
	durationMs: number;
}

/** 帧产物命名约定:解帧脚本写 f_01.png..(标准构建管线)。 */
export function frameUrl(base: string, index: number): string {
	return `${base}f_${String(index).padStart(2, "0")}.png`;
}
