/**
 * 桌宠包管理器:扫描/校验/tier 重算/回退解析(标准 §1/§5)。
 *
 * 遵守桌宠无关性硬约束:目录由调用方注入(dev=仓库 pets/,生产=
 * Resources+用户数据);本模块不含任何形象知识,默认包按清单
 * default 标记解析,无代码回退。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	crossValidatePetPackage,
	recomputeTier,
	resolvePetAction,
	validatePetActions,
	validatePetBehaviors,
	validatePetManifest,
	type PetActionDefinition,
	type PetActionsFile,
	type PetBehaviorsFile,
	type PetManifest,
	type PetPackageValidationError,
	type PetTier,
} from "./PetPackageTypes";

export interface PetPackage {
	manifest: PetManifest;
	actions: PetActionsFile;
	behaviors: PetBehaviorsFile;
	tier: PetTier;
	/** 素材基址(相对 pet 视图根,如 petpacks/whale/)。 */
	assetBase: string;
}

export interface PetPackageDiagnostic {
	packId: string;
	errors: readonly PetPackageValidationError[];
}

export interface PetPackageManagerOptions {
	/** 候选扫描目录(按序),目录不存在则跳过。 */
	scanDirs: readonly string[];
	/** 素材基址前缀(构建产物布局)。 */
	assetBasePrefix: string;
	/** 校验失败等异常的日志出口。 */
	log?: (message: string) => void;
}

const PACK_JSON_FILES = ["pet.json", "actions.json", "behaviors.json"] as const;

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function readJsonFile(path: string): Promise<unknown> {
	const text = await readFile(path, "utf8");
	return JSON.parse(text) as unknown;
}

export class PetPackageManager {
	private readonly options: PetPackageManagerOptions;
	private readonly packs = new Map<string, PetPackage>();
	private diagnostics: readonly PetPackageDiagnostic[] = [];

	constructor(options: PetPackageManagerOptions) {
		this.options = options;
	}

	async scan(): Promise<void> {
		this.packs.clear();
		const diagnostics: PetPackageDiagnostic[] = [];
		const seenDirs = new Set<string>();
		for (const scanDir of this.options.scanDirs) {
			if (!(await pathExists(scanDir))) continue;
			const entries = await readdir(scanDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const dirName = entry.name;
				if (seenDirs.has(dirName)) continue;
				seenDirs.add(dirName);
				const packDir = join(scanDir, dirName);
				const loaded = await this.loadPack(packDir, dirName);
				if (loaded.errors.length > 0) {
					diagnostics.push({ packId: dirName, errors: loaded.errors });
					this.options.log?.(
						`[pet-package] 包 ${dirName} 校验失败被剔除:${loaded.errors
							.map((error) => `${error.field}: ${error.message}`)
							.join("; ")}`,
					);
					continue;
				}
				this.packs.set(dirName, loaded.pack as PetPackage);
			}
		}
		this.diagnostics = diagnostics;
	}

	private async loadPack(
		packDir: string,
		dirName: string,
	): Promise<{ pack?: PetPackage; errors: PetPackageValidationError[] }> {
		const errors: PetPackageValidationError[] = [];
		const raws: unknown[] = [];
		for (const file of PACK_JSON_FILES) {
			const path = join(packDir, file);
			if (!(await pathExists(path))) {
				errors.push({ field: file, message: "缺失" });
				raws.push(undefined);
				continue;
			}
			try {
				raws.push(await readJsonFile(path));
			} catch (error) {
				errors.push({ field: file, message: `JSON 解析失败: ${String(error)}` });
				raws.push(undefined);
			}
		}
		if (errors.length > 0) return { errors };

		const manifestResult = validatePetManifest(dirName, raws[0]);
		errors.push(...manifestResult.errors);
		const actionsResult = validatePetActions(raws[1]);
		errors.push(...actionsResult.errors);
		const behaviorsResult = validatePetBehaviors(raws[2]);
		errors.push(...behaviorsResult.errors);
		if (errors.length > 0) return { errors };

		const manifest = manifestResult.manifest as PetManifest;
		const actions = actionsResult.actions as PetActionsFile;
		const behaviors = behaviorsResult.behaviors as PetBehaviorsFile;

		errors.push(...crossValidatePetPackage({ manifest, actions, behaviors }));
		const tier = recomputeTier(manifest, actions);
		if (tier === "rejected") {
			errors.push({ field: "tier", message: "重算为 rejected(缺必备动作)" });
			return { errors };
		}
		return {
			pack: {
				manifest,
				actions,
				behaviors,
				tier,
				assetBase: `${this.options.assetBasePrefix}${dirName}/`,
			},
			errors: [],
		};
	}

	list(): readonly PetPackage[] {
		return [...this.packs.values()];
	}

	get(id: string): PetPackage | undefined {
		return this.packs.get(id);
	}

	/** 默认包:清单 default 标记;无标记时取扫描序第一个;无包返回 undefined。 */
	defaultPack(): PetPackage | undefined {
		const marked = this.list().find((pack) => pack.manifest.default === true);
		if (marked !== undefined) return marked;
		return this.list()[0];
	}

	resolveAction(
		packId: string,
		actionId: string,
	): { action?: PetActionDefinition; fallbackUsed: boolean } | undefined {
		const pack = this.packs.get(packId);
		if (pack === undefined) return undefined;
		return resolvePetAction(pack.manifest, pack.actions, actionId);
	}

	getDiagnostics(): readonly PetPackageDiagnostic[] {
		return this.diagnostics;
	}
}
