/**
 * 桌宠内核合成夹具测试:用合成包(非任何现役形象)驱动,证明
 * 解释器/校验器/管理器对任意包同构工作(桌宠无关性验收 ①③)。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	describe,
	expect,
	test,
} from "bun:test";
import {
	PetPackageManager,
} from "../../src/bun/pet/PetPackageManager";
import {
	StickerPackManager,
} from "../../src/bun/pet/StickerPackManager";
import {
	PetBehaviorInterpreter,
	type PetInterpreterCommand,
} from "../../src/bun/pet/PetBehaviorInterpreter";
import {
	PetInteractionRouter,
} from "../../src/bun/pet/PetInteractionRouter";
import {
	MANDATORY_ACTIONS,
	crossValidatePetPackage,
	recomputeTier,
	validatePetActions,
	validatePetBehaviors,
	validatePetManifest,
	type PetActionsFile,
	type PetBehaviorsFile,
	type PetManifest,
} from "../../src/bun/pet/PetPackageTypes";

/** 合成夹具包 alpha:与任何现役形象无关。 */
function syntheticManifest(overrides: Partial<PetManifest> = {}): PetManifest {
	return {
		schema: "whalehall.pet-package.v1",
		id: "alpha",
		label: "合成夹具 A",
		version: "1.0.0",
		renderer: "sequence",
		canvas: { width: 100, height: 100, groundAnchorY: 100 },
		sprite: { left: -50, top: -50 },
		tier: "full",
		fallbackAction: "idle",
		hitZones: [{ id: "body", cx: 0, cy: 0, rx: 50, ry: 50 }],
		cover: "cover.png",
		authors: ["fixture"],
		license: "test",
		summary: "合成夹具",
		...overrides,
	};
}

function syntheticActions(extra: string[] = []): PetActionsFile {
	const ids = [...MANDATORY_ACTIONS, ...extra];
	return {
		schema: "whalehall.pet-actions.v1",
		actions: ids.map((id) => ({
			id,
			clip: "clip-a",
			durationMs: 1000,
			loop: true,
		})),
	};
}

function syntheticBehaviors(overrides: Partial<PetBehaviorsFile> = {}): PetBehaviorsFile {
	return {
		schema: "whalehall.pet-behaviors.v1",
		movement: { locomotion: "ground", speedPxPerSec: { walk: 40 } },
		stateMachine: {
			initial: "idle",
			states: {
				idle: {
					action: "idle",
					transitions: [{ on: "timer", afterMs: [100, 200], to: "walk", weight: 1 }],
				},
				walk: {
					action: "walkLeft",
					duration: [500, 600],
					transitions: [{ on: "expire", to: "idle" }],
				},
			},
		},
		...overrides,
	};
}

describe("validatePetManifest", () => {
	test("合成夹具通过", () => {
		const result = validatePetManifest("alpha", syntheticManifest());
		expect(result.errors).toHaveLength(0);
	});

	test("id 与目录名不一致被拒", () => {
		const result = validatePetManifest("beta", syntheticManifest());
		expect(result.errors.some((e) => e.field === "id")).toBe(true);
	});

	test("未知字段被拒", () => {
		const result = validatePetManifest("alpha", {
			...syntheticManifest(),
			whaleOnlyHack: true,
		});
		expect(result.errors.some((e) => e.field === "whaleOnlyHack")).toBe(true);
	});
});

describe("validatePetActions", () => {
	test("clip 与 motionGroup 二选一", () => {
		const actions = syntheticActions();
		(actions.actions[0] as { clip?: string; motionGroup?: string }).clip = undefined;
		const result = validatePetActions(actions);
		expect(result.errors.some((e) => e.field === "actions.clip")).toBe(true);
	});

	test("未知 tone 被拒", () => {
		const result = validatePetActions({
			...syntheticActions(),
			toneMap: { sparkleTone: "idle" },
		});
		expect(result.errors.some((e) => e.field === "toneMap")).toBe(true);
	});
});

describe("validatePetBehaviors", () => {
	test("保留态被包定义则拒绝", () => {
		const behaviors = syntheticBehaviors();
		behaviors.stateMachine.states.dragged = { action: "dragged" };
		const result = validatePetBehaviors(behaviors);
		expect(
			result.errors.some((e) => e.message.includes("宿主保留态")),
		).toBe(true);
	});

	test("非法转移词被拒", () => {
		const behaviors = syntheticBehaviors();
		(behaviors.stateMachine.states.idle.transitions ?? [])[0] = {
			on: "telepathy",
			to: "walk",
		} as never;
		const result = validatePetBehaviors(behaviors);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

describe("crossValidate + tier", () => {
	test("缺必备动作被拒", () => {
		const actions = syntheticActions();
		actions.actions = actions.actions.filter((a) => a.id !== "blink");
		const errors = crossValidatePetPackage({
			manifest: syntheticManifest(),
			actions,
			behaviors: syntheticBehaviors(),
		});
		expect(errors.some((e) => e.message.includes("blink"))).toBe(true);
		expect(recomputeTier(syntheticManifest(), actions)).toBe("rejected");
	});

	test("死态被拒", () => {
		const behaviors = syntheticBehaviors();
		behaviors.stateMachine.states.orphan = { action: "idle" };
		const errors = crossValidatePetPackage({
			manifest: syntheticManifest(),
			actions: syntheticActions(),
			behaviors,
		});
		expect(errors.some((e) => e.message.includes("不可达"))).toBe(true);
	});

	test("emotionMap 表情引用不做动作闭包校验", () => {
		const behaviors = syntheticBehaviors({
			emotionMap: { happy: "@memepack/开心" },
		});
		const errors = crossValidatePetPackage({
			manifest: syntheticManifest(),
			actions: syntheticActions(),
			behaviors,
		});
		expect(errors).toHaveLength(0);
	});

	test("full 只升不降:声明 core 但覆盖达标仍 core", () => {
		const actions = syntheticActions([...Array(90)].map((_, i) => `extra${i}`));
		const manifest = syntheticManifest({ tier: "core" });
		expect(recomputeTier(manifest, actions)).toBe("core");
	});
});

describe("PetPackageManager", () => {
	test("扫描合成包目录:合法包入册、非法包剔除并记诊断", async () => {
		const root = join(tmpdir(), `pet-pkgs-${Date.now()}`);
		const goodDir = join(root, "pets", "alpha");
		const badDir = join(root, "pets", "gamma");
		await mkdir(goodDir, { recursive: true });
		await mkdir(badDir, { recursive: true });
		await writeFile(join(goodDir, "pet.json"), JSON.stringify(syntheticManifest()));
		await writeFile(join(goodDir, "actions.json"), JSON.stringify(syntheticActions()));
		await writeFile(join(goodDir, "behaviors.json"), JSON.stringify(syntheticBehaviors()));
		await writeFile(
			join(badDir, "pet.json"),
			JSON.stringify(syntheticManifest({ id: "gamma" })),
		);
		// gamma 缺 actions.json/behaviors.json → 剔除。
		const logs: string[] = [];
		const manager = new PetPackageManager({
			scanDirs: [join(root, "pets")],
			assetBasePrefix: "petpacks/",
			log: (m) => logs.push(m),
		});
		await manager.scan();
		expect(manager.list().map((p) => p.manifest.id)).toEqual(["alpha"]);
		expect(manager.get("alpha")?.assetBase).toBe("petpacks/alpha/");
		expect(manager.getDiagnostics().length).toBe(1);
		expect(logs.some((m) => m.includes("gamma"))).toBe(true);
		// 默认包:无 default 标记取扫描序第一个。
		expect(manager.defaultPack()?.manifest.id).toBe("alpha");
		await rm(root, { recursive: true, force: true });
	});

	test("空目录:defaultPack 为 undefined,不回退任何硬编码形象", async () => {
		const root = join(tmpdir(), `pet-empty-${Date.now()}`);
		await mkdir(join(root, "pets"), { recursive: true });
		const manager = new PetPackageManager({
			scanDirs: [join(root, "pets")],
			assetBasePrefix: "petpacks/",
		});
		await manager.scan();
		expect(manager.list()).toHaveLength(0);
		expect(manager.defaultPack()).toBeUndefined();
		await rm(root, { recursive: true, force: true });
	});
});

describe("StickerPackManager", () => {
	test("命名空间引用解析与未注册包返回 undefined", async () => {
		const root = join(tmpdir(), `stk-${Date.now()}`);
		const packDir = join(root, "stickers", "memepack");
		await mkdir(packDir, { recursive: true });
		await writeFile(
			join(packDir, "stickers.json"),
			JSON.stringify({
				schema: "whalehall.sticker-pack.v1",
				id: "memepack",
				label: "夹具表情包",
				version: "1.0.0",
				cover: "happy.gif",
				license: "fixture",
				stickers: [
					{ id: "开心", file: "happy.gif", durationMs: 900, tags: ["happy"] },
				],
			}),
		);
		await writeFile(join(packDir, "happy.gif"), "");
		const manager = new StickerPackManager({
			scanDirs: [join(root, "stickers")],
			assetBasePrefix: "petpacks/",
		});
		await manager.scan();
		const resolved = manager.resolveReference("@memepack/开心");
		expect(resolved?.entry.durationMs).toBe(900);
		expect(manager.resolveReference("@unknown/x")).toBeUndefined();
		expect(manager.resolveReference("idle")).toBeUndefined();
		await rm(root, { recursive: true, force: true });
	});

	test("不按 GIF 字节数拦截;素材缺失的包才剔除", async () => {
		const root = join(tmpdir(), `stk-size-${Date.now()}`);
		const manifest = (id: string): string =>
			JSON.stringify({
				schema: "whalehall.sticker-pack.v1",
				id,
				label: "夹具表情包",
				version: "1.0.0",
				cover: "big.gif",
				license: "fixture",
				stickers: [{ id: "大图", file: "big.gif", durationMs: 1000 }],
			});
		const bigDir = join(root, "stickers", "bigpack");
		await mkdir(bigDir, { recursive: true });
		await writeFile(join(bigDir, "stickers.json"), manifest("bigpack"));
		// 运行时只加载解帧 PNG、从不读 GIF 原件:素材存在即入册,与体积无关。
		await writeFile(join(bigDir, "big.gif"), Buffer.alloc(6 * 1024 * 1024));
		const brokenDir = join(root, "stickers", "brokenpack");
		await mkdir(brokenDir, { recursive: true });
		await writeFile(join(brokenDir, "stickers.json"), manifest("brokenpack"));
		const diagnostics: string[] = [];
		const manager = new StickerPackManager({
			scanDirs: [join(root, "stickers")],
			assetBasePrefix: "petpacks/",
			log: (message) => diagnostics.push(message),
		});
		await manager.scan();
		expect(manager.resolveReference("@bigpack/大图")).toBeDefined();
		expect(manager.resolveReference("@brokenpack/大图")).toBeUndefined();
		expect(
			diagnostics.some(
				(message) =>
					message.includes("brokenpack") && message.includes("素材缺失"),
			),
		).toBe(true);
		await rm(root, { recursive: true, force: true });
	});
});

describe("PetBehaviorInterpreter", () => {
	function fixtureInterpreter(commands: PetInterpreterCommand[]) {
		return new PetBehaviorInterpreter({
			behaviors: syntheticBehaviors(),
			resolveAction: (id) => ({
				action: { id, clip: "clip-a", durationMs: 1000, loop: true },
			}),
			onPlay: (command) => commands.push(command),
			onFacing: () => {},
			onMove: () => {},
			now: () => 0,
		});
	}

	test("构造即播初始态动作", () => {
		const commands: PetInterpreterCommand[] = [];
		fixtureInterpreter(commands);
		expect(commands[0]?.actionId).toBe("idle");
	});

	test("timer 到点按声明转移(walk→expire→idle)", () => {
		const commands: PetInterpreterCommand[] = [];
		const interpreter = fixtureInterpreter(commands);
		// 通过 tick 的 screen 参数驱动;now 由内部 Date.now。
		interpreter.tick(Date.now() + 5000, { width: 1920, height: 1080 });
		expect(commands.some((c) => c.actionId === "walkLeft")).toBe(true);
		expect(interpreter.snapshot().state).toBe("walk");
	});

	test("宿主保留态强制与释放", () => {
		const commands: PetInterpreterCommand[] = [];
		const interpreter = fixtureInterpreter(commands);
		const router = new PetInteractionRouter({
			interpreter,
			onPlay: (c) => commands.push({ kind: "play", actionId: c.actionId }),
		});
		router.pointer({ kind: "dragStart" });
		expect(interpreter.snapshot().reserved).toBe("dragged");
		router.pointer({ kind: "dragEnd" });
		expect(interpreter.snapshot().reserved).toBe("drop");
		router.settleAfterDrop();
		expect(interpreter.snapshot().reserved).toBeNull();
		expect(interpreter.snapshot().state).toBe("idle");
	});

	test("外部直派(语义事件同名约定)播完回当前态", () => {
		const commands: PetInterpreterCommand[] = [];
		const interpreter = fixtureInterpreter(commands);
		interpreter.playOverride("taskComplete", 300);
		expect(commands[commands.length - 1]?.actionId).toBe("taskComplete");
		expect(interpreter.snapshot().overrideActive).toBe(true);
		// override 期间 tick 不推进状态机。
		interpreter.tick(Date.now() + 10, { width: 1000, height: 800 });
		expect(interpreter.snapshot().state).toBe("idle");
	});
});
