import {
	Clock3,
	Download,
	FileLock2,
	RefreshCw,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FiveMinuteAuditCaptureStatus } from "../../../../shared/contracts";
import { Button } from "../../shared/ui/Button";
import {
	auditExportStatusMessage,
	type AuditExportService,
} from "./audit-export-service";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const INPUT_BUCKET_MS = 5 * 1000;

export type AuditExportControlProps = {
	service: AuditExportService;
	nowMs?: () => number;
};

type ExportState =
	| { status: "idle" }
	| { status: "exporting" }
	| { status: "success" | "cancelled" | "error"; message: string };

export function AuditExportControl({
	service,
	nowMs = Date.now,
}: AuditExportControlProps) {
	const [includeDecryptedContent, setIncludeDecryptedContent] = useState(false);
	const [state, setState] = useState<ExportState>({ status: "idle" });
	const [capture, setCapture] =
		useState<FiveMinuteAuditCaptureStatus | null>(null);
	const [captureBusy, setCaptureBusy] = useState(false);
	const [captureMessage, setCaptureMessage] = useState<string | null>(null);

	useEffect(() => {
		let mounted = true;
		void service
			.getCaptureStatus()
			.then((status) => {
				if (mounted) setCapture(status);
			})
			.catch(() => {
				if (mounted) {
					setCaptureMessage("无法读取五分钟采集状态，请稍后刷新。");
				}
			});
		return () => {
			mounted = false;
		};
	}, [service]);

	async function exportFiveMinutes(fromMs: number) {
		if (state.status === "exporting") return;
		setState({ status: "exporting" });
		try {
			const result = await service.exportFiveMinutes({
				fromMs,
				includeDecryptedContent,
			});
			setState({
				status:
					result.status === "exported"
						? "success"
						: result.status === "cancelled"
							? "cancelled"
							: "error",
				message: auditExportStatusMessage(result),
			});
		} catch {
			setState({
				status: "error",
				message: "审计包导出失败，没有向界面返回内容或文件路径。",
			});
		}
	}

	async function refreshCapture() {
		if (captureBusy) return;
		setCaptureBusy(true);
		try {
			setCapture(await service.getCaptureStatus());
			setCaptureMessage(null);
		} catch {
			setCaptureMessage("无法读取五分钟采集状态，请稍后刷新。");
		} finally {
			setCaptureBusy(false);
		}
	}

	async function startCapture() {
		if (captureBusy) return;
		setCaptureBusy(true);
		try {
			const started = await service.startCapture();
			setCapture(started);
			setCaptureMessage("已开始记录一个新的完整五分钟范围。");
		} catch {
			setCaptureMessage("无法开始五分钟采集，本地时间线可能尚未就绪。");
		} finally {
			setCaptureBusy(false);
		}
	}

	async function cancelCapture() {
		if (captureBusy || capture === null) return;
		setCaptureBusy(true);
		try {
			const cancelled = await service.cancelCapture(capture.captureId);
			setCapture(cancelled);
			setCaptureMessage("已取消当前五分钟采集。");
		} catch {
			setCaptureMessage("无法取消五分钟采集，请刷新状态后重试。");
		} finally {
			setCaptureBusy(false);
		}
	}

	const captureActive =
		capture?.state === "collecting" || capture?.state === "settling";

	return (
		<section
			className="audit-export-control"
			aria-labelledby="audit-export-title"
		>
			<div className="audit-export-control__heading">
				<span aria-hidden="true">
					<FileLock2 size={17} />
				</span>
				<div>
					<strong id="audit-export-title">五分钟审计包</strong>
					<p>
						主动选择本机文件夹后，导出 raw→event→fact→episode slice→timeline
						slice 血缘。范围对齐到完整 5 秒活动桶，默认隐藏可见文本与网址。
					</p>
				</div>
			</div>
			<div className="audit-export-control__capture">
				<div className="audit-export-control__capture-status">
					<Clock3 size={15} aria-hidden="true" />
					<div>
						<strong>{captureStatusLabel(capture)}</strong>
						<small>
							{capture
								? `${formatCaptureTime(capture.fromMs)}–${formatCaptureTime(capture.toMs)}`
								: "从现在或下一个完整 5 秒桶开始"}
						</small>
					</div>
				</div>
				<p>
					分析完整性：仅包含期间按 64 条/5 分钟或边界自然封窗的生产窗口；
					采集不会为审计强制封窗，也不保证此时已有完整 Timeline。
				</p>
				<div className="audit-export-control__capture-actions">
					<Button
						size="small"
						variant="secondary"
						disabled={captureBusy || captureActive}
						onClick={() => void startCapture()}
					>
						开始采满五分钟
					</Button>
					<Button
						size="small"
						variant="ghost"
						icon={<X size={14} aria-hidden="true" />}
						disabled={captureBusy || !captureActive}
						onClick={() => void cancelCapture()}
					>
						取消
					</Button>
					<Button
						size="small"
						variant="ghost"
						icon={<RefreshCw size={14} aria-hidden="true" />}
						disabled={captureBusy}
						onClick={() => void refreshCapture()}
					>
						刷新
					</Button>
					<Button
						size="small"
						variant="ghost"
						icon={<Download size={14} aria-hidden="true" />}
						disabled={
							captureBusy ||
							state.status === "exporting" ||
							capture?.state !== "ready"
						}
						onClick={() => {
							if (capture?.state === "ready") {
								void exportFiveMinutes(capture.fromMs);
							}
						}}
					>
						导出本次范围
					</Button>
				</div>
				{captureMessage ? (
					<p className="audit-export-control__capture-message" role="status">
						{captureMessage}
					</p>
				) : null}
			</div>
			<label className="audit-export-control__decrypted">
				<input
					type="checkbox"
					checked={includeDecryptedContent}
					disabled={state.status === "exporting"}
					onChange={(event) =>
						setIncludeDecryptedContent(event.currentTarget.checked)
					}
				/>
				<span>
					包含可解密的文本内容
					<small>选择后仍需在原生确认框中再次确认。</small>
				</span>
			</label>
			<div className="audit-export-control__actions">
				<Button
					variant="ghost"
					icon={<Download size={15} aria-hidden="true" />}
					disabled={state.status === "exporting"}
					onClick={() =>
						void exportFiveMinutes(recentCompleteFiveMinuteStart(nowMs()))
					}
				>
					{state.status === "exporting"
						? "正在准备…"
						: "导出过去五分钟"}
				</Button>
			</div>
			{state.status !== "idle" && state.status !== "exporting" ? (
				<p
					className={`audit-export-control__result audit-export-control__result--${state.status}`}
					role={state.status === "error" ? "alert" : "status"}
				>
					{state.message}
				</p>
			) : null}
		</section>
	);
}

function captureStatusLabel(
	capture: FiveMinuteAuditCaptureStatus | null,
): string {
	switch (capture?.state) {
		case "collecting":
			return "正在采集";
		case "settling":
			return "正在等待自然窗口收口";
		case "ready":
			return "本次范围可导出";
		case "failed":
			return "本次范围处理失败";
		case "cancelled":
			return "本次采集已取消";
		default:
			return "尚未开始";
	}
}

function formatCaptureTime(timestampMs: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(timestampMs));
}

export function recentCompleteFiveMinuteStart(nowMs: number): number {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
		throw new Error("nowMs must be a non-negative safe integer.");
	}
	const completedBucketEndMs =
		Math.floor(nowMs / INPUT_BUCKET_MS) * INPUT_BUCKET_MS;
	return Math.max(0, completedBucketEndMs - FIVE_MINUTES_MS);
}
