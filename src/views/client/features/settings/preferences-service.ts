import type {
	PreferenceValues,
	PreferencesSnapshot,
} from "./domain";

export type PreferencesFailureKind =
	| "offline"
	| "load-failed"
	| "save-failed"
	| "version-conflict";

export class PreferencesServiceError extends Error {
	constructor(readonly kind: PreferencesFailureKind) {
		super(`Preferences service failed: ${kind}`);
		this.name = "PreferencesServiceError";
	}
}

export interface PreferencesService {
	load(): Promise<PreferencesSnapshot>;
	save(
		values: PreferenceValues,
		expectedVersion: number,
	): Promise<PreferencesSnapshot>;
}

export function preferencesFailureMessage(
	reason: unknown,
	operation: "load" | "save" | "restore-defaults",
): string {
	if (reason instanceof PreferencesServiceError) {
		if (reason.kind === "offline") {
			return operation === "load"
				? "当前设备离线，暂时无法读取本机设置。"
				: "当前设备离线，设置没有保存。";
		}
		if (reason.kind === "version-conflict") {
			return "设置已在另一处更新。请重新载入后再保存。";
		}
	}
	if (operation === "load") {
		return "暂时无法读取设置，请稍后重试。";
	}
	if (operation === "restore-defaults") {
		return "未能恢复默认设置，已保留上次保存的内容。";
	}
	return "未能保存设置，已恢复到上次保存的内容。";
}
