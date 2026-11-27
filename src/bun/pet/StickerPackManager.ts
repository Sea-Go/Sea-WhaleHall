/**
 * 表情包管理器:扫描/校验 stickers/,把表情注册为命名空间动作
 * `@<packId>/<stickerId>`(标准 §8)。与形象解耦,任何桌宠包可引用。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	validateStickerPack,
	type StickerEntry,
	type StickerPackFile,
} from "./PetPackageTypes";

export interface ResolvedSticker {
	packId: string;
	entry: StickerEntry;
	/** 表情素材基址(相对 pet 视图根)。 */
	assetBase: string;
}

export interface StickerPackManagerOptions {
	scanDirs: readonly string[];
	assetBasePrefix: string;
	log?: (message: string) => void;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export class StickerPackManager {
	private readonly options: StickerPackManagerOptions;
	private readonly packs = new Map<string, StickerPackFile>();

	constructor(options: StickerPackManagerOptions) {
		this.options = options;
	}

	async scan(): Promise<void> {
		this.packs.clear();
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
				const manifestPath = join(packDir, "stickers.json");
				if (!(await pathExists(manifestPath))) continue;
				try {
					const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
					const result = validateStickerPack(dirName, raw);
					if (result.errors.length > 0 || result.pack === undefined) {
						this.options.log?.(
							`[sticker-pack] 包 ${dirName} 校验失败被剔除:${result.errors
								.map((error) => `${error.field}: ${error.message}`)
								.join("; ")}`,
						);
						continue;
					}
					// 素材存在性校验(标准 §8):清单引用的文件必须真实存在。
					// 不按 GIF 字节数设限——运行时只加载解帧后的 PNG,从不读 GIF
					// 原件,文件大小不构成任何运行时代价;按字节拦截只会误伤
					// 正常的高帧率/大尺寸表情(真实的解帧成本在构建解码处把关)。
					let complete = true;
					for (const sticker of result.pack.stickers) {
						const info = await stat(join(packDir, sticker.file)).catch(
							() => undefined,
						);
						if (info === undefined) {
							this.options.log?.(
								`[sticker-pack] ${dirName}: 素材缺失 ${sticker.file},剔除`,
							);
							complete = false;
							break;
						}
					}
					if (!complete) continue;
					this.packs.set(dirName, result.pack);
				} catch (error) {
					this.options.log?.(
						`[sticker-pack] 包 ${dirName} 读取失败:${String(error)}`,
					);
				}
			}
		}
	}

	list(): readonly StickerPackFile[] {
		return [...this.packs.values()];
	}

	/** 解析命名空间动作引用 `@<packId>/<stickerId>`;非该形式返回 undefined。 */
	resolveReference(actionId: string): ResolvedSticker | undefined {
		const match = /^@([a-z][a-z0-9-]{1,31})\/(.+)$/.exec(actionId);
		if (match === null || match[1] === undefined || match[2] === undefined) {
			return undefined;
		}
		const packId = match[1];
		const stickerId = match[2];
		const pack = this.packs.get(packId);
		if (pack === undefined) return undefined;
		const entry = pack.stickers.find((sticker) => sticker.id === stickerId);
		if (entry === undefined) return undefined;
		return {
			packId,
			entry,
			assetBase: `${this.options.assetBasePrefix}${packId}/`,
		};
	}
}
