/**
 * 表情包导入工具(《桌宠包标准 v1》§8):
 * 任何 QQ 表情包 GIF 文件夹一条命令成包。
 *
 * 用法:bun run scripts/import-sticker-pack.ts <gif目录> <packId> <label>
 * 产出:stickers/<packId>/{stickers.json,*.gif}
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stickersRoot = join(projectRoot, "stickers");

const [sourceDir, packId, labelArg] = process.argv.slice(2);
if (!sourceDir || !packId) {
	console.error("用法:bun run scripts/import-sticker-pack.ts <gif目录> <packId> [label]");
	process.exit(1);
}
if (!/^[a-z][a-z0-9-]{1,31}$/.test(packId)) {
	console.error("packId 须符合 ^[a-z][a-z0-9-]{1,31}$");
	process.exit(1);
}

const label = labelArg ?? packId;
const gifs = readdirSync(sourceDir).filter((name) => name.endsWith(".gif"));
if (gifs.length === 0) {
	console.error("目录中没有 GIF 文件。");
	process.exit(1);
}

function probeDurationMs(path: string): number {
	const probe = spawnSync(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
		{ encoding: "utf8" },
	);
	const seconds = Number.parseFloat((probe.stdout ?? "").trim());
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 2000;
}

const packDir = join(stickersRoot, packId);
mkdirSync(packDir, { recursive: true });

const entries = gifs.map((file) => {
	copyFileSync(join(sourceDir, file), join(packDir, file));
	const id = file.replace(/\.gif$/, "");
	return { id, file, durationMs: probeDurationMs(join(packDir, file)) };
});

const totalBytes = entries.reduce(
	(sum, entry) => sum + statSync(join(packDir, entry.file)).size,
	0,
);

const manifest = {
	schema: "whalehall.sticker-pack.v1",
	id: packId,
	label,
	version: "1.0.0",
	cover: entries[0]?.file ?? "",
	license: "待补:QQ 表情包多为网络二创,标注出处与非商用",
	stickers: entries,
};

const manifestPath = join(packDir, "stickers.json");
const { writeFileSync } = await import("node:fs");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
	`stickers/${packId}: ${entries.length} 条 / ${(totalBytes / 1024 / 1024).toFixed(1)}MB。请补 stickers.json 的 license 出处。`,
);
