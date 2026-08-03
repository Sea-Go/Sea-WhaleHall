import type { AgentReadPermissionsSnapshot } from "../../../../shared/agent-permissions";

export type AgentPermissionsFailureKind =
	| "offline"
	| "unavailable"
	| "load-failed"
	| "save-failed"
	| "version-conflict"
	| "invalid-response";

export class AgentPermissionsServiceError extends Error {
	constructor(
		readonly kind: AgentPermissionsFailureKind,
		message = `Agent permissions service failed: ${kind}`,
		readonly currentRevision?: number,
	) {
		super(message);
		this.name = "AgentPermissionsServiceError";
	}
}

export interface AgentPermissionsService {
	load(): Promise<AgentReadPermissionsSnapshot>;
	setEnabled(
		enabled: boolean,
		expectedRevision: number,
	): Promise<AgentReadPermissionsSnapshot>;
}

export function agentPermissionsFailureMessage(
	reason: unknown,
	operation: "load" | "save",
): string {
	if (reason instanceof AgentPermissionsServiceError) {
		switch (reason.kind) {
			case "offline":
				return operation === "load"
					? "当前设备离线，暂时无法读取 Agent 授权。"
					: "当前设备离线，Agent 授权没有更改。";
			case "unavailable":
				return "本机授权服务暂不可用。";
			case "version-conflict":
				return "Agent 授权已在另一处更新，请重新读取后再操作。";
			case "invalid-response":
				return "本机授权服务返回了无法识别的结果。";
			case "load-failed":
			case "save-failed":
				break;
		}
	}
	return operation === "load"
		? "暂时无法读取 Agent 授权，请稍后重试。"
		: "未能更改 Agent 授权，已保留原来的设置。";
}
