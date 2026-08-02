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

	test("renders a future range as period unavailable", async () => {
		const controller = createController();
		await controller.load("day", "2026-07-30");
		expect(controller.getSnapshot()).toMatchObject({
			status: "period-unavailable",
			range: { startDate: "2026-07-30" },
		});
	});

	test("distinguishes error and offline while retaining a cached report", async () => {
		const service = new MockReportService({ latencyMs: 0 });
		const controller = new ReportController(service, () => "2026-07-29");
		await controller.switchPeriod("day");
		expect(controller.getSnapshot().status).toBe("populated");

		service.setMode("offline");
		await controller.retry();
		const offline = controller.getSnapshot();
		expect(offline.status).toBe("offline");
		if (offline.status === "offline") {
			expect(offline.cachedReport?.period).toBe("day");
		}
		await controller.retry();
		const stillOffline = controller.getSnapshot();
		expect(stillOffline.status).toBe("offline");
		if (stillOffline.status === "offline") {
			expect(stillOffline.cachedReport?.period).toBe("day");
		}

		service.setMode("error");
		await controller.retry();
		expect(controller.getSnapshot()).toMatchObject({
			status: "error",
			retryable: true,
		});
	});

	test("exposes loading until the service settles", async () => {
		let resolveLoad: (result: ReportLoadResult) => void = () => {};
		const service: ReportService = {
			load: () =>
				new Promise((resolve) => {
					resolveLoad = resolve;
				}),
		};
		const controller = new ReportController(service, () => "2026-07-29");
		const request = controller.load();
		expect(controller.getSnapshot().status).toBe("loading");
		resolveLoad({
			kind: "empty",
			period: "week",
			range: controller.getSnapshot().range,
			message: "没有记录",
		});
		await request;
		expect(controller.getSnapshot().status).toBe("empty");
	});

	test("guards next navigation when the current period is already active", async () => {
		const service = new CountingService();
		const controller = new ReportController(service, () => "2026-07-29");
		await controller.load();
		await controller.next();
		expect(service.calls).toBe(1);
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
