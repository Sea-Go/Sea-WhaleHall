import type { RPCSchema } from "electrobun/bun";
import type { AgentRunEventEnvelope } from "./agent-runs";
import type { PetActivityFeedbackRPC } from "./pet-activity-feedback";

export const PET_CHAT_TEXT_MAX_BYTES = 8192;
export const PET_CHAT_REQUEST_ID_MAX_CHARACTERS = 64;
export const PET_CHAT_REJECT_MESSAGE_MAX_CHARACTERS = 200;

/**
 * 桌宠对话：桌宠输入框与客户端「对话」页共用同一 conversation（同一
 * AgentRunCoordinator 链路）。对话可能运行 30-120 秒，与云搜索一样走消息
 * 而非请求；事件按发起 requestId 过滤后推送（petChatEvent）。
 */
export type PetChatStartMessage = {
	requestId: string;
	text: string;
};

export type PetChatCancelMessage = {
	requestId: string;
	runId: string;
	/** 取消时的事件 revision（乐观并发）；拿不到时传 0 由 Bun 侧拒绝。 */
	expectedRevision: number;
};

/** 账号登录态变化（chat 可用性 = 已登录 DataCenter 账号）。 */
export type PetChatAvailabilityMessage = {
	available: boolean;
};

/** 转发给桌宠的对话运行事件（仅桌宠自己发起的 turn）。 */
export type PetChatEventMessage = {
	requestId: string;
	envelope: AgentRunEventEnvelope;
};

/** 发起即被拒（未登录、会话冲突、参数无效等）。 */
export type PetChatTurnRejectedMessage = {
	requestId: string;
	message: string;
};

/** 渲染器状态面包屑：面板每次状态迁移上报一次，Bun 侧落 diag.log。 */
export type PetChatStateReportMessage = {
	kind: string;
	requestId: string | null;
	detail: string;
};

/** 大肥鱼主动搭话：心跳观察经 conversation agent 生成开场白，流入同一面板。 */
export type PetChatProactiveTurnMessage = {
	requestId: string;
	generatedAtMs: number;
};

/**
 * 主动搭话轮次的用户侧输入：以大肥鱼的观察为上下文，要求 conversation agent
 * 以大肥鱼身份主动开启一轮自然对话（可调用云检索工具）。
 */
export function buildPetProactivePrompt(observation: string): string {
	const trimmed = observation.trim().slice(0, 4000);
	return `【本鱼的观察】${trimmed}\n\n（这是大肥鱼自己刚生成的观察记录。请以本鱼的身份，基于它主动向用户开启一轮自然的对话——可以吐槽、可以关心，但别端着；需要补充资料时可以先检索家庭知识库。）`;
}

export type PetChatRPC = {
	bun: RPCSchema<{
		requests: PetActivityFeedbackRPC["bun"]["requests"];
		messages: PetActivityFeedbackRPC["bun"]["messages"] & {
			startPetChatTurn: PetChatStartMessage;
			cancelPetChat: PetChatCancelMessage;
			petChatStateReport: PetChatStateReportMessage;
		};
	}>;
	webview: RPCSchema<{
		requests: PetActivityFeedbackRPC["webview"]["requests"];
		messages: PetActivityFeedbackRPC["webview"]["messages"] & {
			petChatAvailability: PetChatAvailabilityMessage;
			petChatEvent: PetChatEventMessage;
			petChatTurnRejected: PetChatTurnRejectedMessage;
			petChatProactiveTurn: PetChatProactiveTurnMessage;
		};
	}>;
};
