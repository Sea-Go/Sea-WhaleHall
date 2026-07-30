import type {
	FiveMinuteAuditFileExportRequest,
	FiveMinuteAuditFileExportResult,
} from "../../../../shared/contracts";
import type { AuditExportService } from "../../features/audit-export/public";

export interface AuditExportTransport {
	exportFiveMinuteAuditToFile(
		request: FiveMinuteAuditFileExportRequest,
	): Promise<FiveMinuteAuditFileExportResult>;
}

export type ElectrobunAuditExportServiceOptions = {
	loadTransport?: () => Promise<AuditExportTransport>;
	runtimeAvailable?: () => boolean;
};

export class ElectrobunAuditExportService implements AuditExportService {
	private readonly loadTransport: () => Promise<AuditExportTransport>;
	private readonly runtimeAvailable: () => boolean;

	constructor(options: ElectrobunAuditExportServiceOptions = {}) {
		this.loadTransport = options.loadTransport ?? loadClientTransport;
		this.runtimeAvailable = options.runtimeAvailable ?? hasElectrobunRuntime;
	}

	async exportFiveMinutes(
		request: FiveMinuteAuditFileExportRequest,
	): Promise<FiveMinuteAuditFileExportResult> {
		if (!this.runtimeAvailable()) {
			return { status: "not_ready", basename: null };
		}
		const transport = await this.loadTransport();
		return transport.exportFiveMinuteAuditToFile(request);
	}
}

async function loadClientTransport(): Promise<AuditExportTransport> {
	const { clientApi } = await import("../../rpc");
	return {
		exportFiveMinuteAuditToFile: (request) =>
			clientApi.exportFiveMinuteAuditToFile(request),
	};
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}
