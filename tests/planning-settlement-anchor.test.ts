import { describe, expect, test } from "bun:test";
import {
	assertLocalMinute,
	dailySettlementDue,
	localTimeAt,
} from "../src/agent/planning/time";

/**
 * 结算钟点锚点（W1）纯函数契约。时区一律用命名 IANA 区并覆盖 DST 边界
 * （CALENDAR_STANDARD 要求）；锚点比较依赖两侧都是零填充 24 小时 HH:mm。
 */

describe("localTimeAt", () => {
	test("formats zero-padded HH:mm in UTC", () => {
		expect(localTimeAt(Date.UTC(2026, 0, 1, 8, 5), "UTC")).toBe("08:05");
	});

	test("converts across zones: 23:30 UTC is 07:30 next day in Shanghai", () => {
		const nowMs = Date.UTC(2026, 0, 1, 23, 30);
		expect(localTimeAt(nowMs, "Asia/Shanghai")).toBe("07:30");
		expect(localTimeAt(nowMs, "Asia/Shanghai")).not.toBe(
			localTimeAt(nowMs, "UTC"),
		);
	});

	test("handles half-hour offsets (Kolkata)", () => {
		expect(localTimeAt(Date.UTC(2026, 5, 1, 10, 0), "Asia/Kolkata")).toBe(
			"15:30",
		);
	});

	test("straddles an America/New_York spring-forward DST boundary", () => {
		// 2026-03-08 02:00 EST -> 03:00 EDT；02:30 本地不存在。
		expect(localTimeAt(Date.UTC(2026, 2, 8, 6, 30), "America/New_York")).toBe(
			"01:30",
		);
		expect(localTimeAt(Date.UTC(2026, 2, 8, 7, 30), "America/New_York")).toBe(
			"03:30",
		);
	});
});

describe("dailySettlementDue", () => {
	const nowMs = Date.UTC(2026, 5, 1, 13, 0);

	test("null anchor always allows (current midnight-roll behavior)", () => {
		expect(dailySettlementDue(nowMs, "UTC", null)).toBe(true);
	});

	test("before the anchor the settlement is deferred", () => {
		expect(
			dailySettlementDue(Date.UTC(2026, 5, 1, 20, 59), "UTC", "21:30"),
		).toBe(false);
	});

	test("at or after the anchor the settlement is due", () => {
		expect(
			dailySettlementDue(Date.UTC(2026, 5, 1, 21, 30), "UTC", "21:30"),
		).toBe(true);
		expect(
			dailySettlementDue(Date.UTC(2026, 5, 1, 23, 45), "UTC", "21:30"),
		).toBe(true);
	});

	test("anchor is interpreted in the plan's own time zone", () => {
		// 13:00 UTC = 21:00 上海 = 09:00 纽约：同一时刻，上海已过锚点、纽约未到。
		expect(dailySettlementDue(nowMs, "Asia/Shanghai", "21:30")).toBe(false);
		expect(dailySettlementDue(nowMs, "America/New_York", "21:30")).toBe(false);
		expect(dailySettlementDue(nowMs, "Asia/Shanghai", "20:00")).toBe(true);
	});

	test("rejects anchors that are not zero-padded 24h HH:mm", () => {
		expect(() => dailySettlementDue(nowMs, "UTC", "9:30")).toThrow();
		expect(() => dailySettlementDue(nowMs, "UTC", "21:5")).toThrow();
		expect(() => dailySettlementDue(nowMs, "UTC", "24:00")).toThrow();
	});
});

describe("assertLocalMinute (shared with env validation)", () => {
	test("accepts canonical HH:mm only", () => {
		expect(() => assertLocalMinute("00:00", "t")).not.toThrow();
		expect(() => assertLocalMinute("23:59", "t")).not.toThrow();
		expect(() => assertLocalMinute("21:30", "t")).not.toThrow();
	});
});
