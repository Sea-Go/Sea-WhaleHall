import type { ProactiveFeedbackItem } from "../../../../shared/proactive-feedback";

export interface ProactiveFeedbackDayGroup {
	key: string;
	label: string;
	items: readonly ProactiveFeedbackItem[];
}

export function groupProactiveFeedbackByLocalDay(
	items: readonly ProactiveFeedbackItem[],
	options: { locale?: string; timeZone?: string } = {},
): readonly ProactiveFeedbackDayGroup[] {
	const locale = options.locale ?? "zh-CN";
	const keyFormatter = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		...(options.timeZone ? { timeZone: options.timeZone } : {}),
	});
	const labelFormatter = new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "long",
		day: "numeric",
		weekday: "long",
		...(options.timeZone ? { timeZone: options.timeZone } : {}),
	});
	const groups = new Map<string, ProactiveFeedbackDayGroup>();
	for (const item of items) {
		const generatedAt = new Date(item.generatedAtMs);
		const key = keyFormatter.format(generatedAt);
		const existing = groups.get(key);
		if (existing) {
			groups.set(key, { ...existing, items: [...existing.items, item] });
			continue;
		}
		groups.set(key, {
			key,
			label: labelFormatter.format(generatedAt),
			items: [item],
		});
	}
	return [...groups.values()];
}

export function formatProactiveFeedbackTime(
	generatedAtMs: number,
	options: { locale?: string; timeZone?: string } = {},
): string {
	return new Intl.DateTimeFormat(options.locale ?? "zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		...(options.timeZone ? { timeZone: options.timeZone } : {}),
	}).format(generatedAtMs);
}
