export const PAGE_IDS = [
	"conversation",
	"planning",
	"calendar",
	"history",
	"reports",
	"settings",
] as const;

export type PageId = (typeof PAGE_IDS)[number];

export const PAGE_LABELS: Record<PageId, string> = {
	conversation: "对话",
	planning: "计划",
	calendar: "日程",
	history: "历史记录",
	reports: "成长报告",
	settings: "设置",
};

export function isPageId(value: string): value is PageId {
	return PAGE_IDS.some((page) => page === value);
}
