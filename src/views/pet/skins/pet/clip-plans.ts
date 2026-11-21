import {
	PET_ACTION_CATALOG,
	type PetActionId,
} from "../../../../shared/pet-actions";

/**
 * whale/cat 序列帧烘焙计划（唯一真相）：由完整动作目录程序化派生——
 * 每个真实动作一个 GIF 片段（片段名 = 动作名，保证"库里每个 GIF 都是
 * 皮肤真实存在的行为"），render-pet-skins.ts 据此烘焙，
 * whale/cat 的 index.ts 据此声明帧数表/动作映射。
 *
 * - 镜像对（walkLeft/walkRight 等）合并为一份片段：左右朝向由运行时
 *   root.facingX 翻转，一份素材服务两侧。
 * - fps 统一 16；frames = 动作时长换算（循环动作恰好一个周期）。
 * - cat 的情绪动作使用其专属调色板烘焙（与运行时该动作的 tone 语义
 *   一致）；whale 主题本就只有中性调色板，全部中性烘焙。
 */

export const BAKED_FPS = 16;

export type ClipPlan = {
	clip: string;
	actions: readonly PetActionId[];
	frames: number;
	once: boolean;
	tone?: string;
};

const MERGED_ACTIONS: Record<string, string> = {
	walkLeft: "walk",
	walkRight: "walk",
	runLeft: "run",
	runRight: "run",
	turnLeft: "turn",
	turnRight: "turn",
};

const CAT_TONE_BY_ACTION: Record<string, string> = {
	happy: "happy",
	shy: "shy",
	angry: "angry",
	sleepy: "sleepy",
	proud: "proud",
	confused: "confused",
	afraid: "afraid",
	loveReaction: "love",
	sick: "sick",
	focus: "focused",
	taskComplete: "celebration",
};

function plansForSkin(skin: "whale" | "cat"): ClipPlan[] {
	const plans = new Map<string, ClipPlan>();
	for (const entry of PET_ACTION_CATALOG) {
		const clip = MERGED_ACTIONS[entry.id] ?? entry.id;
		const frames = Math.max(
			4,
			Math.round((entry.durationMs * BAKED_FPS) / 1000),
		);
		const existing = plans.get(clip);
		if (existing) {
			existing.actions = [...existing.actions, entry.id];
			existing.frames = Math.max(existing.frames, frames);
			continue;
		}
		plans.set(clip, {
			clip,
			actions: [entry.id],
			frames,
			once: !entry.loop,
			tone: skin === "cat" ? CAT_TONE_BY_ACTION[entry.id] : undefined,
		});
	}
	return [...plans.values()];
}

export const CLIP_PLANS: Record<"whale" | "cat", readonly ClipPlan[]> = {
	whale: plansForSkin("whale"),
	cat: plansForSkin("cat"),
};
