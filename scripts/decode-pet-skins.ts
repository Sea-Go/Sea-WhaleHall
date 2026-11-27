import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 桌宠包帧生成器：包仓库以 GIF 为源（pets/<id>/clips/<clip>.gif 与
 * stickers/<pack>/<name>.gif），本脚本用 ffmpeg 解帧直写
 * dist/views/petpacks/<id>/<clip>/f_NN.png，并按 ffprobe 实际帧数写
 * clips.json（适配器运行时帧数表）——GIF 缺失或动作表引用了不存在的
 * 片段直接构建失败。
 *
 * 生成产物不进 git（dist/ 已整体忽略）；CI 无 ffmpeg 时跳过并告警（包
 * 空白但不作为构建失败；打包发布前需在有 ffmpeg 的环境执行）。
 */

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const petsRoot = resolve(projectRoot, "pets");
const stickersRoot = resolve(projectRoot, "stickers");
const outputRoot = resolve(projectRoot, "dist/views/pet/petpacks");

function whichFfmpeg(): boolean {
	const probe = spawnSync("ffmpeg", ["-version"]);
	return probe.error === undefined && probe.status === 0;
}

function whichFfprobe(): boolean {
	const probe = spawnSync("ffprobe", ["-version"]);
	return probe.error === undefined && probe.status === 0;
}

function probeFrameCount(gifPath: string): number {
	const probe = spawnSync(
		"ffprobe",
		["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", gifPath],
		{ encoding: "utf8" },
	);
	const parsed = Number.parseInt((probe.stdout ?? "").trim(), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

export async function decodePetSkins(): Promise<void> {
	if (!whichFfmpeg() || !whichFfprobe()) {
		console.warn(
			"[pet-packs] ffmpeg/ffprobe 不可用，跳过包帧生成（序列帧包在本次构建产物中将为空白）。本地开发请安装 ffmpeg。",
		);
		return;
	}
	// 桌宠包:pets/<id>/clips/*.gif → petpacks/<id>/<clip>/f_NN.png + clips.json
	if (existsSync(petsRoot)) {
		const packIds = readdirSync(petsRoot).filter((name) =>
			statSync(resolve(petsRoot, name)).isDirectory(),
		);
		for (const packId of packIds) {
			const clipsDir = resolve(petsRoot, packId, "clips");
			if (!existsSync(clipsDir)) continue;
			const gifClips = readdirSync(clipsDir).filter((name) => name.endsWith(".gif"));
			if (gifClips.length === 0) continue;
			// 动作表引用闭包:解帧前校验引用的片段都存在。
			const actionsFile = JSON.parse(
				readFileSync(resolve(petsRoot, packId, "actions.json"), "utf8"),
			) as { actions: { clip?: string }[] };
			const referenced = new Set(
				actionsFile.actions.map((a) => a.clip).filter((c): c is string => c !== undefined),
			);
			for (const clip of referenced) {
				if (!gifClips.includes(`${clip}.gif`)) {
					throw new Error(
						`包 ${packId} 的动作表引用了片段 ${clip}，但 clips/ 缺少对应 GIF——动作引用与素材必须严格一致。`,
					);
				}
			}
			const clipIndex: Record<string, number> = {};
			for (const gifName of gifClips) {
				const clip = gifName.replace(/\.gif$/, "");
				const source = resolve(clipsDir, gifName);
				const outputDirectory = resolve(outputRoot, packId, clip);
				rmSync(outputDirectory, { recursive: true, force: true });
				mkdirSync(outputDirectory, { recursive: true });
				const extraction = spawnSync("ffmpeg", [
					"-hide_banner", "-loglevel", "error", "-y",
					"-i", source,
					resolve(outputDirectory, "f_%02d.png"),
				]);
				if (extraction.error !== undefined || extraction.status !== 0) {
					throw new Error(`ffmpeg 解帧 ${packId}/${gifName} 失败。`);
				}
				const frames = readdirSync(outputDirectory).filter((n) => n.endsWith(".png")).length;
				const probed = probeFrameCount(source);
				if (frames === 0) {
					throw new Error(`ffmpeg 解帧 ${packId}/${gifName} 得到 0 帧。`);
				}
				if (probed > 0 && frames !== probed) {
					// 社区 GIF 末帧常有重复/半帧,ffprobe 计数与解帧数可差 1:
					// 以解帧产物为准(适配器播的就是这些帧),仅告警。
					console.warn(
						`[pet-packs] ${packId}/${gifName} 解帧 ${frames} 帧,ffprobe 报 ${probed} 帧(以解帧为准)。`,
					);
				}
				clipIndex[clip] = frames;
				console.log(`[pet-packs] ${packId}/${clip}: ${frames} 帧 ✓`);
			}
			writeFileSync(
				resolve(outputRoot, packId, "clips.json"),
				`${JSON.stringify({ schema: "whalehall.pet-clip-index.v1", clips: clipIndex, fps: 16 }, null, 2)}\n`,
			);
		}
	}
	// 表情包:stickers/<pack>/*.gif → petpacks/<pack>/<name>/f_NN.png + clips.json
	if (existsSync(stickersRoot)) {
		const packIds = readdirSync(stickersRoot).filter((name) =>
			statSync(resolve(stickersRoot, name)).isDirectory(),
		);
		for (const packId of packIds) {
			const packDir = resolve(stickersRoot, packId);
			const manifestPath = resolve(packDir, "stickers.json");
			if (!existsSync(manifestPath)) continue;
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
					stickers: { id: string; file: string }[];
				};
				// 目录名用 ASCII slug(st-NN):中文 sticker id 进 views:// 自定义协议
				// 路径会悬挂(请求既不成功也不失败),素材布局必须 ASCII;中文 id
				// 经 clips.json 的 stickerDirs 映射,命名空间动作仍用中文 id。
				const clipIndex: Record<string, number> = {};
				const stickerDirs: Record<string, string> = {};
				for (const [index, sticker] of manifest.stickers.entries()) {
					const name = `st-${String(index + 1).padStart(2, "0")}`;
					stickerDirs[sticker.id] = name;
					const source = resolve(packDir, sticker.file);
					const outputDirectory = resolve(outputRoot, packId, name);
					rmSync(outputDirectory, { recursive: true, force: true });
					mkdirSync(outputDirectory, { recursive: true });
					const extraction = spawnSync("ffmpeg", [
						"-hide_banner", "-loglevel", "error", "-y",
						"-i", source,
						resolve(outputDirectory, "f_%02d.png"),
					]);
					if (extraction.error !== undefined || extraction.status !== 0) {
						throw new Error(`ffmpeg 解帧表情 ${packId}/${sticker.file} 失败。`);
					}
					clipIndex[name] = readdirSync(outputDirectory).filter((n) =>
						n.endsWith(".png"),
					).length;
				}
				writeFileSync(
					resolve(outputRoot, packId, "clips.json"),
					`${JSON.stringify({ schema: "whalehall.pet-clip-index.v1", clips: clipIndex, stickerDirs, fps: 16 }, null, 2)}\n`,
				);
				console.log(`[pet-packs] 表情包 ${packId}: ${manifest.stickers.length} 条 ✓`);
		}
	}
}

if (import.meta.main) {
	await decodePetSkins();
}
