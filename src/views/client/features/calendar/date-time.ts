import { Temporal } from "temporal-polyfill";

export type LocalTimeResolution =
	| { status: "valid"; instant: string }
	| { status: "nonexistent"; earlier: string; later: string }
	| { status: "ambiguous"; earlier: string; later: string };

export interface LocalDateTimeParts {
	date: string;
	time: string;
}

export interface MiniCalendarDay {
	date: string;
	day: number;
	inMonth: boolean;
}

export function systemTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

export function compareInstants(left: string, right: string): number {
	return Temporal.Instant.compare(
		Temporal.Instant.from(left),
		Temporal.Instant.from(right),
	);
}

export function durationMinutes(start: string, end: string): number {
	return Number(
		Temporal.Instant.from(start)
			.until(Temporal.Instant.from(end), { largestUnit: "minute" })
			.total({ unit: "minute" }),
	);
}

export function addMinutes(instant: string, minutes: number): string {
	return Temporal.Instant.from(instant).add({ minutes }).toString();
}

export function rangesOverlap(
	leftStart: string,
	leftEnd: string,
	rightStart: string,
	rightEnd: string,
): boolean {
	return (
		compareInstants(leftStart, rightEnd) < 0 &&
		compareInstants(rightStart, leftEnd) < 0
	);
}

export function instantToDateInZone(instant: string, timeZone: string): string {
	return Temporal.Instant.from(instant)
		.toZonedDateTimeISO(timeZone)
		.toPlainDate()
		.toString();
}

export function instantToLocalParts(
	instant: string,
	timeZone: string,
): LocalDateTimeParts {
	const dateTime = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
	return {
		date: dateTime.toPlainDate().toString(),
		time: dateTime.toPlainTime().toString({ smallestUnit: "minute" }),
	};
}

export function localDateTimeToInstant(
	date: string,
	time: string,
	timeZone: string,
	disambiguation: "earlier" | "later" | "compatible" | "reject" = "reject",
): string {
	return Temporal.PlainDateTime.from(`${date}T${time}`)
		.toZonedDateTime(timeZone, { disambiguation })
		.toInstant()
		.toString();
}

export function resolveLocalDateTime(
	date: string,
	time: string,
	timeZone: string,
): LocalTimeResolution {
	try {
		return {
			status: "valid",
			instant: localDateTimeToInstant(date, time, timeZone, "reject"),
		};
	} catch {
		const source = Temporal.PlainDateTime.from(`${date}T${time}`);
		const earlierZoned = source.toZonedDateTime(timeZone, {
			disambiguation: "earlier",
		});
		const laterZoned = source.toZonedDateTime(timeZone, {
			disambiguation: "later",
		});
		const resolution =
			earlierZoned.toPlainDateTime().equals(source) &&
			laterZoned.toPlainDateTime().equals(source)
				? "ambiguous"
				: "nonexistent";
		return {
			status: resolution,
			earlier: earlierZoned.toInstant().toString(),
			later: laterZoned.toInstant().toString(),
		};
	}
}

export function formatInstant(
	instant: string,
	timeZone: string,
	options: Intl.DateTimeFormatOptions,
): string {
	return new Intl.DateTimeFormat("zh-CN", {
		...options,
		timeZone,
	}).format(Temporal.Instant.from(instant).epochMilliseconds);
}

export function todayInZone(timeZone: string): string {
	return Temporal.Now.zonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function addDaysToDate(date: string, days: number): string {
	return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function dateDurationDays(
	startDate: string,
	endDateExclusive: string,
): number {
	return Temporal.PlainDate.from(startDate)
		.until(Temporal.PlainDate.from(endDateExclusive), { largestUnit: "day" })
		.total({ unit: "day" });
}

export function addMinutesToLocalDateTime(
	date: string,
	time: string,
	minutes: number,
): LocalDateTimeParts {
	const next = Temporal.PlainDateTime.from(`${date}T${time}`).add({ minutes });
	return {
		date: next.toPlainDate().toString(),
		time: next.toPlainTime().toString({ smallestUnit: "minute" }),
	};
}

export function miniCalendarDays(anchorDate: string): MiniCalendarDay[] {
	const anchor = Temporal.PlainDate.from(anchorDate);
	const first = anchor.with({ day: 1 });
	const sundayOffset = first.dayOfWeek % 7;
	const gridStart = first.subtract({ days: sundayOffset });
	return Array.from({ length: 42 }, (_, index) => {
		const date = gridStart.add({ days: index });
		return {
			date: date.toString(),
			day: date.day,
			inMonth: date.month === anchor.month && date.year === anchor.year,
		};
	});
}

export function monthLabel(date: string): string {
	const value = Temporal.PlainDate.from(date);
	return `${value.year}年${value.month}月`;
}

export function moveMonth(date: string, months: number): string {
	return Temporal.PlainDate.from(date)
		.with({ day: 1 })
		.add({ months })
		.toString();
}

export function calendarRangeLabel(
	startDate: string,
	endDateExclusive: string,
	view: "day" | "week" | "month",
): string {
	const start = Temporal.PlainDate.from(startDate.slice(0, 10));
	if (view === "day") {
		const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
		return `${start.year}年${start.month}月${start.day}日 周${weekdays[start.dayOfWeek - 1]}`;
	}
	if (view === "month") return `${start.year}年${start.month}月`;
	const end = Temporal.PlainDate.from(endDateExclusive.slice(0, 10)).subtract({
		days: 1,
	});
	return start.year === end.year && start.month === end.month
		? `${start.year}年${start.month}月${start.day}日 — ${end.day}日`
		: start.year === end.year
			? `${start.year}年${start.month}月${start.day}日 — ${end.month}月${end.day}日`
			: `${start.year}年${start.month}月${start.day}日 — ${end.year}年${end.month}月${end.day}日`;
}

export function timeZoneOffsetLabel(timeZone: string, date: string): string {
	const offset = Temporal.PlainDate.from(date)
		.toZonedDateTime({ timeZone, plainTime: "12:00" })
		.offset;
	const [hours, minutes] = offset.split(":");
	const hour = Number(hours);
	return minutes === "00" ? `GMT${hour >= 0 ? "+" : ""}${hour}` : `GMT${offset}`;
}
