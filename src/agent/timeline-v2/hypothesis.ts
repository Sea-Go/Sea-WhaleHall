import type { ActiveGoalContextV1 } from "../reflection/types";
import type {
	ActivityEpisodeV2,
	EpisodeHypothesisV2,
	EvidenceFactV2,
} from "./types";

const DETERMINISTIC_HYPOTHESIS_FACT_LIMIT = 4;

export interface TimelineHypothesisGenerator {
	generate(
		episodes: readonly ActivityEpisodeV2[],
		facts: readonly EvidenceFactV2[],
		goal: ActiveGoalContextV1 | null,
		signal?: AbortSignal,
	): Promise<Map<string, EpisodeHypothesisV2>>;
}

/**
 * Grounded production generator. It never performs inference or network I/O;
 * it derives a conservative template and cites only facts already attached to
 * the deterministic episode.
 */
export class DeterministicTimelineHypothesisGenerator
	implements TimelineHypothesisGenerator
{
	async generate(
		episodes: readonly ActivityEpisodeV2[],
		facts: readonly EvidenceFactV2[],
		_goal: ActiveGoalContextV1 | null,
		signal?: AbortSignal,
	): Promise<Map<string, EpisodeHypothesisV2>> {
		throwIfAborted(signal);
		const factIds = new Set(facts.map((fact) => fact.factId));
		return new Map(
			episodes.map((episode) => {
				const citedFactIds = [
					...episode.evidenceFactIds,
					...episode.supportingFactIds,
				]
					.filter((id) => factIds.has(id))
					.slice(0, DETERMINISTIC_HYPOTHESIS_FACT_LIMIT);
				return [
					episode.episodeId,
					{
						text: episode.classification.abstain
							? "可能在进行当前可见操作（活动类型暂不确定）"
							: hypothesisTemplate(episode.classification.activity),
						citedFactIds,
						generator: "deterministic-template.v2" as const,
					},
				];
			}),
		);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("Timeline analysis was cancelled.", "AbortError");
}

function hypothesisTemplate(
	activity: ActivityEpisodeV2["classification"]["activity"],
): string {
	switch (activity) {
		case "development":
			return "可能在进行软件开发或排查技术问题";
		case "writing":
			return "可能在编辑或整理文字内容";
		case "research":
			return "可能在查阅和研究资料";
		case "communication":
			return "可能在处理沟通消息";
		case "planning":
			return "可能在规划或安排接下来的工作";
		case "data_work":
			return "可能在查看或处理数据";
		case "media":
			return "可能在查看或播放媒体内容";
		case "gaming":
			return "可能在进行游戏活动";
		case "system_file_ops":
			return "可能在管理系统或文件";
		case "commerce":
			return "可能在浏览商品或处理交易相关页面";
		case "idle_transition":
			return "可能在暂离、锁屏或恢复电脑活动";
		case "other_unknown":
			return "可能在进行当前可见操作";
	}
}
