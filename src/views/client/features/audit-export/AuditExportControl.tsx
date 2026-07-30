import { Download, FileLock2 } from "lucide-react";
import { useState } from "react";
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

	async function exportRecentFiveMinutes() {
		if (state.status === "exporting") return;
		setState({ status: "exporting" });
		try {
			const result = await service.exportFiveMinutes({
				fromMs: recentCompleteFiveMinuteStart(nowMs()),
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
					<strong id="audit-export-title">最近五分钟审计包</strong>
					<p>
						主动选择本机文件夹后，导出 raw→event→fact→episode slice→timeline
						slice 血缘。范围对齐到完整 5 秒活动桶，默认隐藏可见文本与网址。
					</p>
				</div>
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
					onClick={() => void exportRecentFiveMinutes()}
				>
					{state.status === "exporting" ? "正在准备…" : "选择文件夹并导出"}
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

export function recentCompleteFiveMinuteStart(nowMs: number): number {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
		throw new Error("nowMs must be a non-negative safe integer.");
	}
	const completedBucketEndMs =
		Math.floor(nowMs / INPUT_BUCKET_MS) * INPUT_BUCKET_MS;
	return Math.max(0, completedBucketEndMs - FIVE_MINUTES_MS);
}
