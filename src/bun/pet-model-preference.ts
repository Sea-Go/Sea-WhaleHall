import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 桌宠形象（皮肤）的 Bun 侧持久化：user-data 下的一个小 JSON。设置页经
 * `setPetModel` RPC 写入后，由 PetState 下发链路盖章 `modelId`，桌宠
 * 渲染器据此热切换。独立于 config.yaml——那是模型网关/云同步配置。
 */
const PET_MODEL_PREFERENCE_FILE = "pet-model.json";

export interface PetModelPreference {
	modelId: string;
}

export function loadPetModelPreference(
	userDataDirectory: string,
): PetModelPreference {
	const path = join(userDataDirectory, PET_MODEL_PREFERENCE_FILE);
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			modelId?: unknown;
		};
		if (typeof raw.modelId === "string" && raw.modelId.length > 0) {
			return { modelId: raw.modelId };
		}
	} catch {
		// 读取或解析失败：按未配置处理。
	}
	// 未配置:交由 PackageManager 按资源清单 default 标记解析(标准 §1.2)。
	return { modelId: "" };
}

export function savePetModelPreference(
	userDataDirectory: string,
	modelId: string,
): void {
	if (typeof modelId !== "string" || modelId.length === 0) {
		throw new Error("未知的桌宠形象。");
	}
	const path = join(userDataDirectory, PET_MODEL_PREFERENCE_FILE);
	mkdirSync(userDataDirectory, { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ modelId }, null, "\t")}\n`,
		"utf8",
	);
}
