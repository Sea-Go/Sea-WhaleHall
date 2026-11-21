/**
 * 一次性迁移:把旧 skins/pet/<id>/ 三皮肤转换为 pets/ 包标准布局。
 *
 * 用法:bun run scripts/convert-skin-to-pack.ts
 * 产出:pets/<id>/{pet.json,actions.json,behaviors.json,clips/*.gif,cover.png}
 * 幂等:重复运行覆盖 JSON,GIF 仅在缺失时拷贝。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PET_ACTION_CATALOG,
	PET_ACTION_IDS,
} from "../src/shared/pet-actions";
import { CLIP_PLANS } from "../src/views/pet/skins/pet/clip-plans";
// @ts-expect-error 迁移期读取旧皮肤常量(转换后本脚本与旧皮肤一并退役)。

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKINS_ROOT = join(projectRoot, "src/views/pet/skins/pet");
const PETS_ROOT = join(projectRoot, "pets");

interface LegacyPlan {
	clip: string;
	actions: readonly string[];
	frames: number;
	once: boolean;
	tone?: string;
}

/** deepseek 的 6 片段近似映射:必备 20 动作全过(core tier),参考词表取近似。 */
const DEEPSEEK_CLIP_MAP: Record<string, string> = {
	idle: "idle", breathe: "idle", blink: "idle", lookAround: "idle",
	stretch: "waving", yawn: "waving", walkLeft: "running", walkRight: "running",
	turnLeft: "running", turnRight: "running", sitDown: "waiting",
	standUp: "waiting", dragged: "jumping", drop: "jumping",
	clickFeedback: "waving", sleepIn: "waiting", sleepLoop: "waiting",
	wake: "waving", enter: "waving", exit: "waving",
};

const DEEPSEEK_APPROX: Record<string, string> = {
	happy: "waving", laugh: "waving", shy: "waving", angry: "failed",
	wronged: "failed", sad: "failed", cry: "failed", surprised: "jumping",
	afraid: "failed", confused: "waiting", bored: "waiting", sleepy: "waiting",
	proud: "waving", impatient: "failed", expectant: "waiting",
	loveReaction: "waving", think: "waiting", searching: "running",
	loading: "waiting", taskComplete: "waving", operationFailed: "failed",
	runLeft: "running", runRight: "running", jump: "jumping", takeOff: "jumping",
	land: "jumping", exercise: "running", levelUp: "waving", focus: "waiting",
};

interface SkinFacts {
	label: string;
	sprite: { left: number; top: number };
	hitZones: { id: string; cx: number; cy: number; rx: number; ry: number }[];
	toneMap: Record<string, string>;
	clipFor(actionId: string): string | undefined;
	isDefault?: boolean;
}

const WHALE_FACTS: SkinFacts = {
	label: "深海鲸",
	sprite: { left: -153, top: -68 },
	hitZones: [
		{ id: "body", cx: 20, cy: 10, rx: 80, ry: 50 },
		{ id: "head", cx: -40, cy: -30, rx: 55, ry: 40 },
	],
	toneMap: {
		error: "fallDown", sick: "fallDown", sleepy: "sleepLoop",
		love: "petHead", happy: "petHead", celebration: "jump",
		confused: "lookAround",
	},
	clipFor: (actionId) => {
		const plan = (CLIP_PLANS.whale as readonly LegacyPlan[]).find(
			(entry) => entry.actions.includes(actionId as never),
		);
		return plan?.clip;
	},
	isDefault: true,
};

const CAT_FACTS: SkinFacts = {
	label: "橘子猫",
	sprite: { left: -153, top: -68 },
	hitZones: [
		{ id: "body", cx: 20, cy: 10, rx: 80, ry: 50 },
		{ id: "head", cx: -40, cy: -30, rx: 55, ry: 40 },
	],
	toneMap: {
		error: "fallDown", sleepy: "sleepLoop", happy: "petHead",
		celebration: "jump", confused: "lookAround",
	},
	clipFor: (actionId) => {
		const plan = (CLIP_PLANS.cat as readonly LegacyPlan[]).find(
			(entry) => entry.actions.includes(actionId as never),
		);
		return plan?.clip;
	},
};

const DEEPSEEK_FACTS: SkinFacts = {
	label: "DeepSeek 娘",
	sprite: { left: -80, top: -80 },
	hitZones: [{ id: "body", cx: 0, cy: 0, rx: 80, ry: 80 }],
	toneMap: { error: "failed", happy: "waving" },
	clipFor: (actionId) =>
		DEEPSEEK_CLIP_MAP[actionId] ?? DEEPSEEK_APPROX[actionId] ?? undefined,
};

function buildActions(facts: SkinFacts): {
	actions: {
		id: string;
		clip: string;
		durationMs: number;
		loop: boolean;
		next?: string;
		facing?: number;
	}[];
	toneMap: Record<string, string>;
} {
	const actions: {
		id: string;
		clip: string;
		durationMs: number;
		loop: boolean;
		next?: string;
		facing?: number;
	}[] = [];
	for (const id of PET_ACTION_IDS) {
		const clip = facts.clipFor(id);
		if (clip === undefined) continue;
		const definition = PET_ACTION_CATALOG.find(
			(entry) => entry.id === id,
		) as { durationMs: number; loop: boolean } | undefined;
		if (definition === undefined) continue;
		const facing = id.endsWith("Left") ? -1 : id.endsWith("Right") ? 1 : 0;
		// 规范区间钳制:历史目录有 <200ms 的过渡动作(如 takeOffToAirborne 180ms)。
		const durationMs = Math.min(20_000, Math.max(200, definition.durationMs));
		actions.push({
			id,
			clip,
			durationMs,
			loop: definition.loop,
			next: "idle",
			...(facing !== 0 ? { facing } : {}),
		});
	}
	return { actions, toneMap: facts.toneMap };
}

/** 行为数据化:现 action-director/behavior 的通用节奏转为例程与状态机。 */
function buildBehaviors(facts: SkinFacts): Record<string, unknown> {
	const clipAction = (preferred: string): string => {
		const clip = facts.clipFor(preferred);
		if (clip === undefined) return "idle";
		const action = PET_ACTION_IDS.find(
			(id) => facts.clipFor(id) === clip && !id.endsWith("Left") && !id.endsWith("Right"),
		);
		return action ?? "idle";
	};
	return {
		schema: "whalehall.pet-behaviors.v1",
		movement: {
			locomotion: "ground",
			speedPxPerSec: { walk: 48, run: 96 },
			gravity: true,
			edges: "turn",
			windowEdges: "hold",
		},
		stateMachine: {
			initial: "idle",
			states: {
				idle: {
					action: "idle",
					transitions: [
						{ on: "timer", afterMs: [8000, 20000], to: "walk", weight: 3 },
						{ on: "timer", afterMs: [25000, 50000], to: "idleVariation", weight: 2 },
						{ on: "schedule", hours: [[23, 6]], to: "sleep" },
						{ on: "pointer:hover", to: "notice" },
						{ on: "pointer:click", to: "react" },
					],
				},
				walk: {
					action: "walkLeft",
					duration: [3000, 8000],
					transitions: [{ on: "expire", to: "idle" }],
				},
				notice: {
					action: clipAction("hoverLookAtPointer"),
					duration: [900, 1400],
					transitions: [{ on: "expire", to: "idle" }],
				},
				react: {
					action: "clickFeedback",
					duration: [700, 1100],
					transitions: [{ on: "expire", to: "idle" }],
				},
				idleVariation: {
					action: clipAction("lookAround"),
					duration: [1800, 2600],
					transitions: [{ on: "expire", to: "idle" }],
				},
				sleep: {
					action: "sleepLoop",
					transitions: [{ on: "pointer:click", to: "waking" }],
				},
				waking: {
					action: "wake",
					duration: [900, 1200],
					transitions: [{ on: "expire", to: "idle" }],
				},
			},
		},
		routines: [
			{
				id: "stretch-yawn",
				steps: [
					{ action: clipAction("stretch"), holdMs: 1800 },
					{ action: clipAction("yawn"), holdMs: 2100 },
				],
			},
		],
		emotionMap: {},
	};
}

function writePack(id: string, facts: SkinFacts): void {
	const skinDir = join(SKINS_ROOT, id);
	const packDir = join(PETS_ROOT, id);
	const clipsDir = join(packDir, "clips");
	if (!existsSync(skinDir)) {
		console.error(`跳过 ${id}:旧皮肤目录不存在`);
		return;
	}
	mkdirSync(clipsDir, { recursive: true });

	const { actions, toneMap } = buildActions(facts);
	const tier = id === "deepseek" ? "core" : "full";
	const manifest = {
		schema: "whalehall.pet-package.v1",
		id,
		label: facts.label,
		version: "1.0.0",
		renderer: "sequence",
		canvas: { width: 267, height: 139, groundAnchorY: 139 },
		sprite: facts.sprite,
		tier,
		fallbackAction: "idle",
		hitZones: facts.hitZones,
		cover: "cover.png",
		authors: ["Sea"],
		license: "见 SKIN.md(社区二创,非商业许可)",
		summary: `${facts.label}桌宠包`,
		...(facts.isDefault ? { default: true } : {}),
	};
	writeFileSync(join(packDir, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(
		join(packDir, "actions.json"),
		`${JSON.stringify({ schema: "whalehall.pet-actions.v1", actions, toneMap }, null, 2)}\n`,
	);
	writeFileSync(
		join(packDir, "behaviors.json"),
		`${JSON.stringify(buildBehaviors(facts), null, 2)}\n`,
	);

	// GIF 拷贝:动作表引用到的片段。
	const referencedClips = new Set(actions.map((action) => action.clip));
	let copied = 0;
	for (const clip of referencedClips) {
		const source = join(skinDir, `${clip}.gif`);
		if (!existsSync(source)) {
			console.warn(`  缺片段 ${id}/${clip}.gif(该动作将走回退)`);
			continue;
		}
		copyFileSync(source, join(clipsDir, `${clip}.gif`));
		copied += 1;
	}
	const sourceSkinMd = join(skinDir, "SKIN.md");
	if (existsSync(sourceSkinMd)) {
		copyFileSync(sourceSkinMd, join(packDir, "SKIN.md"));
	}
	console.log(
		`pets/${id}: ${actions.length} 动作 / ${copied} 片段 / ${referencedClips.size} 引用${facts.isDefault ? " [默认]" : ""}`,
	);
}

writePack("whale", WHALE_FACTS);
writePack("cat", CAT_FACTS);
writePack("deepseek", DEEPSEEK_FACTS);
console.log("迁移完成。deepseek 按 6 片段近似映射(必备 20 全过,core tier)。");
