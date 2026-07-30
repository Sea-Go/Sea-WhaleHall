import type {
	FiveMinuteAuditCaptureStatus,
	FiveMinuteAuditFileExportRequest,
	FiveMinuteAuditFileExportResult,
} from "../../../../shared/contracts";
import type { AuditExportService } from "../../features/audit-export/public";

export interface AuditExportTransport {
	exportFiveMinuteAuditToFile(
		request: FiveMinuteAuditFileExportRequest,
	): Promise<FiveMinuteAuditFileExportResult>;
	startFiveMinuteAuditCapture(): Promise<FiveMinuteAuditCaptureStatus>;
	getFiveMinuteAuditCaptureStatus(): Promise<{
		capture: FiveMinuteAuditCaptureStatus | null;
	}>;
	cancelFiveMinuteAuditCapture(captureId: string): Promise<{
		capture: FiveMinuteAuditCaptureStatus | null;
	}>;
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

	async startCapture(): Promise<FiveMinuteAuditCaptureStatus> {
		if (!this.runtimeAvailable()) {
			throw new Error("Electrobun runtime is not ready.");
		}
		const transport = await this.loadTransport();
		return transport.startFiveMinuteAuditCapture();
	}

	async getCaptureStatus(): Promise<FiveMinuteAuditCaptureStatus | null> {
		if (!this.runtimeAvailable()) return null;
		const transport = await this.loadTransport();
		return (await transport.getFiveMinuteAuditCaptureStatus()).capture;
	}

	async cancelCapture(
		captureId: string,
	): Promise<FiveMinuteAuditCaptureStatus | null> {
		if (!this.runtimeAvailable()) return null;
		const transport = await this.loadTransport();
		return (await transport.cancelFiveMinuteAuditCapture(captureId)).capture;
	}
}

async function loadClientTransport(): Promise<AuditExportTransport> {
	const { clientApi } = await import("../../rpc");
	return {
		exportFiveMinuteAuditToFile: (request) =>
			clientApi.exportFiveMinuteAuditToFile(request),
		startFiveMinuteAuditCapture: () =>
			clientApi.startFiveMinuteAuditCapture(),
		getFiveMinuteAuditCaptureStatus: () =>
			clientApi.getFiveMinuteAuditCaptureStatus(),
		cancelFiveMinuteAuditCapture: (captureId) =>
			clientApi.cancelFiveMinuteAuditCapture(captureId),
	};
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}
