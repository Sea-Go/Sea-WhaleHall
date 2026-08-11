import { Cloud, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import type { DataCenterSyncState } from "../../../../shared/contracts";
import type { CloudSyncController } from "./CloudSyncController";
import "./CloudSyncStatusControl.css";

export interface CloudSyncStatusControlProps {
	controller: CloudSyncController;
}

const STATE_LABELS: Record<DataCenterSyncState, string> = {
	disabled: "未开启",
	needs_session: "需要登录 DataCenter",
	needs_agent: "需要注册 Agent",
	ready: "已就绪",
	sending: "正在同步",
	committing: "正在提交",
	retry_wait: "等待重试",
	blocked_content: "已暂停（含敏感内容）",
	blocked_reconcile: "已暂停（需要处理）",
};

export function CloudSyncStatusControl({
	controller,
}: CloudSyncStatusControlProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);

	useEffect(() => {
		controller.start();
		return () => controller.stop();
	}, [controller]);

	if (state.status === "idle" || state.status === "loading") {
		return (
			<section className="cloud-sync cloud-sync--loading" aria-busy="true">
				<Cloud size={17} aria-hidden="true" />
				<div>
					<strong>正在读取云同步状态</strong>
					<span>DataCenter 连接信息</span>
				</div>
			</section>
		);
	}

	if (state.status === "error" && state.snapshot === null) {
		return (
			<section className="cloud-sync cloud-sync--error" role="alert">
				<ShieldAlert size={17} aria-hidden="true" />
				<div>
					<strong>云同步状态暂不可用</strong>
					<span>{state.message}</span>
				</div>
				<button type="button" onClick={() => void controller.load()}>
					重试
				</button>
			</section>
		);
	}

	const snapshot = state.snapshot;
	if (snapshot === null) return null;
	const updating = state.status === "updating";
	const busy = updating;
	const stateLabel = STATE_LABELS[snapshot.state] ?? snapshot.state;
	const errorDetail =
		snapshot.blockedReason ??
		snapshot.lastErrorMessage ??
		(snapshot.state === "needs_session" ? "登录后即可开启云同步" : null);

	return (
		<section className="cloud-sync" aria-busy={busy}>
			<div className="cloud-sync__header">
				<Cloud size={17} aria-hidden="true" />
				<div>
					<strong>DataCenter 云同步</strong>
					<span className="cloud-sync__endpoint">{snapshot.baseUrl}</span>
				</div>
				<label className="cloud-sync__switch">
					<span className="sr-only">启用 DataCenter 云同步</span>
					<input
						type="checkbox"
						checked={snapshot.enabled}
						disabled={busy}
						onChange={(event) =>
							void controller.setEnabled(event.currentTarget.checked)
						}
					/>
					<span aria-hidden="true" />
				</label>
			</div>
			<div className="cloud-sync__body">
				<span className={`cloud-sync__badge cloud-sync__badge--${snapshot.state}`}>
					{stateLabel}
				</span>
				{snapshot.lastSyncAtMs !== null ? (
					<span className="cloud-sync__meta">
						上次同步：{formatTime(snapshot.lastSyncAtMs)}
					</span>
				) : (
					<span className="cloud-sync__meta">尚未同步</span>
				)}
				{snapshot.enabled && (
					<button
						type="button"
						className="cloud-sync__action"
						disabled={busy}
						onClick={() => void controller.refreshConsents()}
					>
						<RefreshCw size={13} aria-hidden="true" />
						刷新授权
					</button>
				)}
			</div>
			{errorDetail !== null ? (
				<p className="cloud-sync__detail" role="status">
					{errorDetail}
				</p>
			) : null}
		</section>
	);
}

function formatTime(ms: number): string {
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return "未知";
	return date.toLocaleString("zh-CN", {
		hour12: false,
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}
