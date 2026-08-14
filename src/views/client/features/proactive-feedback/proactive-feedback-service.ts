import type {
	ProactiveFeedbackAvailable,
	ProactiveFeedbackHistoryCursor,
	ProactiveFeedbackPage,
	ProactiveFeedbackPolicy,
	ProactiveFeedbackPolicySnapshot,
} from "../../../../shared/proactive-feedback";

export type ProactiveFeedbackServiceFailure =
	| "signed-out"
	| "offline"
	| "service-unavailable"
	| "version-conflict"
	| "invalid-request"
	| "invalid-response"
	| "unexpected";

export class ProactiveFeedbackServiceError extends Error {
	constructor(
		readonly failure: ProactiveFeedbackServiceFailure,
		message: string,
		readonly currentRevision?: number,
	) {
		super(message);
		this.name = "ProactiveFeedbackServiceError";
	}
}

export interface ProactiveFeedbackService {
	loadPolicy(): Promise<ProactiveFeedbackPolicySnapshot>;
	setPolicy(
		policy: ProactiveFeedbackPolicy,
		expectedRevision: number,
	): Promise<ProactiveFeedbackPolicySnapshot>;
	listHistory(input: {
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}): Promise<ProactiveFeedbackPage>;
	clear(): Promise<{ clearedAtMs: number }>;
	onAvailable(
		listener: (event: ProactiveFeedbackAvailable) => void,
	): () => void;
}

export function proactiveFeedbackFailureMessage(
	reason: unknown,
	operation: "load-policy" | "save-policy" | "load-history" | "clear",
): string {
	if (reason instanceof ProactiveFeedbackServiceError) {
		if (reason.failure === "signed-out") return "登录状态已失效，请重新登录。";
		if (reason.failure === "offline") {
			return operation === "load-history"
				? "当前设备离线，暂时无法读取历史记录。"
				: "当前设备离线，本次更改没有保存。";
		}
		if (reason.failure === "version-conflict") {
			return "主动反馈设置已在另一处更新，请重新读取后再操作。";
		}
		if (reason.failure === "invalid-response") {
			return "主动反馈服务返回了无法验证的数据，请稍后重试。";
		}
	}
	if (operation === "load-policy") return "暂时无法读取主动反馈设置。";
	if (operation === "save-policy")
		return "未能保存主动反馈设置，原设置保持不变。";
	if (operation === "clear") return "未能清除主动反馈数据，请稍后重试。";
	return "暂时无法读取历史记录，请稍后重试。";
}
