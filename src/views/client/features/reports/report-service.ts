import type {
	GrowthReport,
	ReportPeriod,
	ReportRange,
} from "./domain";

export type ReportServiceFailureKind = "offline" | "unavailable";

export class ReportServiceError extends Error {
	constructor(
		public readonly kind: ReportServiceFailureKind,
		message: string,
	) {
		super(message);
		this.name = "ReportServiceError";
	}
}

export type ReportLoadResult =
	| { kind: "data"; report: GrowthReport }
	| {
			kind: "empty";
			period: ReportPeriod;
			range: ReportRange;
			message: string;
	  }
	| {
			kind: "period-unavailable";
			period: ReportPeriod;
			range: ReportRange;
			message: string;
	  };

export interface ReportService {
	load(period: ReportPeriod, anchorDate: string): Promise<ReportLoadResult>;
}
