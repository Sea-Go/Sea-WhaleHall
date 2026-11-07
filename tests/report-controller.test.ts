import { describe, expect, test } from "bun:test";
import { ReportController } from "../src/views/client/features/reports/ReportController";
import type {
	ReportLoadResult,
	ReportService,
} from "../src/views/client/features/reports/report-service";
import { MockReportService } from "../src/views/client/infrastructure/reports/MockReportService";

describe("ReportController periods and states", () => {
	test("loads current week as honest partial data and switches all periods", async () => {
		const controller = createController();
		await controller.load();
		expect(controller.getSnapshot()).toMatchObject({
			status: "partial",
			period: "week",
			range: { startDate: "2026-07-27", endDateExclusive: "2026-08-03" },
		});
		await controller.switchPeriod("day");
		expect(controller.getSnapshot()).toMatchObject({
			status: "populated",
			period: "day",
			range: { label: "2026年7月29日" },
		});
		await controller.switchPeriod("month");
		expect(controller.getSnapshot()).toMatchObject({
			status: "partial",
			period: "month",
			range: { label: "2026年7月" },
		});
	});

	test("moves to previous reports, enables return, then exposes an empty period", async () => {
		const controller = createController();
		await controller.load();
		expect(controller.getSnapshot().canGoNext).toBe(false);
		await controller.previous();
		expect(controller.getSnapshot()).toMatchObject({
			status: "populated",
			range: { startDate: "2026-07-20" },
			canGoNext: true,
		});
		await controller.previous();
		expect(controller.getSnapshot()).toMatchObject({
			status: "empty",
			range: { startDate: "2026-07-13" },
		});
		await controller.next();
		expect(controller.getSnapshot().status).toBe("populated");
	});
});

class CountingService implements ReportService {
	calls = 0;

	async load(
		period: Parameters<ReportService["load"]>[0],
		anchorDate: string,
	): Promise<ReportLoadResult> {
		this.calls += 1;
		return {
			kind: "empty",
			period,
			range: {
				startDate: anchorDate,
				endDateExclusive: "2026-08-03",
				anchorDate,
				label: "本周",
				contextLabel: "周一至周日",
			},
			message: "空",
		};
	}
}

function createController() {
	return new ReportController(
		new MockReportService({ latencyMs: 0 }),
		() => "2026-07-29",
	);
}
