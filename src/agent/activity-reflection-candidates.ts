import type { ActivityReflectionActivity } from "./activity-reflection-prompt";

export type ActivityReflectionSignalFamily =
	| "development"
	| "writing"
	| "editing"
	| "research"
	| "gaming"
	| "media"
	| "commerce"
	| "system_file_ops"
	| "communication"
	| "planning"
	| "data"
	| "other"
	| "auxiliary"
	| "boundary";

/** A family that can open an index segment and carry candidate activities. */
export type ActivityReflectionSegmentFamily = Exclude<
	ActivityReflectionSignalFamily,
	"auxiliary" | "boundary"
>;

export function activityReflectionCandidatesFor(
	family: ActivityReflectionSegmentFamily,
): {
	candidate_activities: ActivityReflectionActivity[];
	recommended_action: string;
} {
	switch (family) {
		case "development":
			return {
				candidate_activities: ["development"],
				recommended_action: "推测：正在编写代码",
			};
		case "writing":
			return {
				candidate_activities: ["writing"],
				recommended_action: "推测：正在撰写或修改文本",
			};
		case "editing":
			return {
				candidate_activities: [
					"writing",
					"development",
					"data_work",
					"communication",
					"other_unknown",
				],
				recommended_action: "推测：正在撰写或修改文本",
			};
		case "research":
			return {
				candidate_activities: ["research", "other_unknown"],
				recommended_action: "推测：正在查阅技术资料",
			};
		case "communication":
			return {
				candidate_activities: ["communication", "other_unknown"],
				recommended_action: "推测：正在进行沟通",
			};
		case "planning":
			return {
				candidate_activities: ["planning", "other_unknown"],
				recommended_action: "推测：正在规划安排",
			};
		case "data":
			return {
				candidate_activities: ["data_work", "other_unknown"],
				recommended_action: "推测：正在处理数据",
			};
		case "gaming":
			return {
				candidate_activities: ["gaming", "other_unknown"],
				recommended_action: "推测：正在进行游戏",
			};
		case "media":
			return {
				candidate_activities: ["media", "other_unknown"],
				recommended_action: "推测：正在观看或收听媒体内容",
			};
		case "commerce":
			return {
				candidate_activities: ["commerce", "other_unknown"],
				recommended_action: "不确定：正在处理敏感页面，具体活动无法判断",
			};
		case "system_file_ops":
			return {
				candidate_activities: ["system_file_ops", "other_unknown"],
				recommended_action: "推测：正在整理文件或调整系统设置",
			};
		case "other":
			return {
				candidate_activities: ["other_unknown"],
				recommended_action: "不确定：当前活动无法判断",
			};
	}
}
