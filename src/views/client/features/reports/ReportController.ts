import {
	canMoveToNextReport,
	cloneGrowthReport,
	moveReportAnchor,
	reportRangeFor,
	type GrowthReport,
	type ReportPeriod,
	type ReportRange,
} from "./domain";
import {
	ReportServiceError,
	type ReportService,
} from "./report-service";

interface ReportStateBase {
	period: ReportPeriod;
	anchorDate: string;
	range: ReportRange;
	canGoNext: boolean;
}

export type ReportState =
	| (ReportStateBase & { status: "idle" })
	| (ReportStateBase & {
			status: "loading";
			previousReport: GrowthReport | null;
	  })
	| (ReportStateBase & { status: "populated"; report: GrowthReport })
	| (ReportStateBase & { status: "partial"; report: GrowthReport })
	| (ReportStateBase & { status: "empty"; message: string })
	| (ReportStateBase & {
			status: "error";
			message: string;
			retryable: boolean;
	  })
	| (ReportStateBase & {
			status: "offline";
			message: string;
			cachedReport: GrowthReport | null;
	  })
	| (ReportStateBase & { status: "period-unavailable"; message: string });

export class ReportController {
	private state: ReportState;
	private readonly listeners = new Set<() => void>();
	private loadSequence = 0;

	constructor(
		private readonly service: ReportService,
		private readonly today: () => string,
		initialPeriod: ReportPeriod = "week",
	) {
		const anchorDate = this.today();
		this.state = {
			status: "idle",
			period: initialPeriod,
			anchorDate,
			range: reportRangeFor(initialPeriod, anchorDate),
			canGoNext: false,
		};
	}

	getSnapshot = (): ReportState => this.state;
	getServerSnapshot = (): ReportState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	load(
		period = this.state.period,
		anchorDate = this.state.anchorDate,
	): Promise<void> {
		const sequence = ++this.loadSequence;
		const range = reportRangeFor(period, anchorDate);
		const sameRange =
			this.state.period === period && this.state.anchorDate === anchorDate;
		const previousReport =
			sameRange &&
			(this.state.status === "populated" || this.state.status === "partial")
				? cloneGrowthReport(this.state.report)
				: sameRange && this.state.status === "offline"
					? this.state.cachedReport
						? cloneGrowthReport(this.state.cachedReport)
						: null
					: sameRange && this.state.status === "loading"
						? this.state.previousReport
						: null;
		const base = this.base(period, anchorDate, range);
		this.setState({ ...base, status: "loading", previousReport });
		return this.performLoad(sequence, base);
	}

	switchPeriod(period: ReportPeriod): Promise<void> {
		return this.load(period, this.today());
	}

	previous(): Promise<void> {
		return this.load(
			this.state.period,
			moveReportAnchor(this.state.period, this.state.anchorDate, -1),
		);
	}

	next(): Promise<void> {
		if (!this.state.canGoNext) return Promise.resolve();
		return this.load(
			this.state.period,
			moveReportAnchor(this.state.period, this.state.anchorDate, 1),
		);
	}

	retry(): Promise<void> {
		return this.load(this.state.period, this.state.anchorDate);
	}

	private async performLoad(
		sequence: number,
		base: ReportStateBase,
	): Promise<void> {
		try {
			const result = await this.service.load(base.period, base.anchorDate);
			if (sequence !== this.loadSequence) return;
			if (result.kind === "empty") {
				this.setState({ ...base, status: "empty", message: result.message });
				return;
			}
			if (result.kind === "period-unavailable") {
				this.setState({
					...base,
					status: "period-unavailable",
					message: result.message,
				});
				return;
			}
			const report = cloneGrowthReport(result.report);
			this.setState({
				...base,
				status:
					report.dataQuality.kind === "partial" ? "partial" : "populated",
				report,
			});
		} catch (reason) {
			if (sequence !== this.loadSequence) return;
			if (reason instanceof ReportServiceError && reason.kind === "offline") {
				this.setState({
					...base,
					status: "offline",
					message: "当前离线，无法读取这一周期的最新报告。",
					cachedReport:
						this.state.status === "loading"
							? this.state.previousReport
							: null,
				});
				return;
			}
			this.setState({
				...base,
				status: "error",
				message: "报告加载失败，请稍后重试。",
				retryable: true,
			});
		}
	}

	private base(
		period: ReportPeriod,
		anchorDate: string,
		range = reportRangeFor(period, anchorDate),
	): ReportStateBase {
		return {
			period,
			anchorDate,
			range,
			canGoNext: canMoveToNextReport(
				period,
				anchorDate,
				this.today(),
			),
		};
	}

	private setState(state: ReportState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}
