import {
	CircleHelp,
	ExternalLink,
	RefreshCw,
	ShieldAlert,
	ShieldCheck,
	type LucideIcon,
} from "lucide-react";
import {
	useEffect,
	useSyncExternalStore,
} from "react";
import {
	MONITORING_PERMISSION_IDS,
	type MonitoringPermissionId,
	type MonitoringPermissionState,
	type MonitoringPermissionStatus,
} from "./domain";
import type { MonitoringController } from "./MonitoringController";
import "./MonitoringPermissionsControl.css";

const permissionCopy: Record<
	MonitoringPermissionId,
	{ label: string; description: string }
> = {
	accessibility: {
		label: "辅助功能",
		description: "读取前台应用的控件结构、焦点与已完成的可见文本。",
	},
	screenRecording: {
		label: "屏幕录制",
		description: "仅截取前台窗口供内存 OCR 使用，不保存屏幕图像。",
	},
	inputMonitoring: {
		label: "输入监控",
		description: "只统计按键、点击、滚动与相对移动量，不读取键值。",
	},
	browserAutomation: {
		label: "自动化",
		description: "向受支持的前台浏览器读取经过隐私过滤的标签页元数据。",
	},
};

const permissionStateCopy: Record<
	MonitoringPermissionState,
	{ label: string; Icon: LucideIcon }
> = {
	granted: { label: "已授权", Icon: ShieldCheck },
	denied: { label: "未授权", Icon: ShieldAlert },
	notDetermined: { label: "尚未决定", Icon: ShieldAlert },
	unknown: { label: "尚未检查", Icon: CircleHelp },
	unavailable: { label: "当前不可用", Icon: CircleHelp },
};

export interface MonitoringPermissionsControlProps {
	controller: MonitoringController;
}

export function MonitoringPermissionsControl({
	controller,
}: MonitoringPermissionsControlProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);

	useEffect(() => {
		if (state.status === "idle") void controller.load();
	}, [controller, state.status]);

	const snapshot = "snapshot" in state ? state.snapshot : null;
	const updating = state.status === "updating";
	const checking =
		snapshot?.permissionCheckState === "checking" ||
		(updating && state.operation === "refreshPermissions");

	return (
		<section
			className="monitoring-permissions"
			aria-labelledby="monitoring-permissions-title"
		>
			<header className="monitoring-permissions__heading">
				<div>
					<strong id="monitoring-permissions-title">macOS 系统权限</strong>
					<p>
						系统授权与 WhaleHall 的采集开关相互独立；点击下方按钮会打开对应的系统设置页面。
					</p>
				</div>
				<div className="monitoring-permissions__check">
					<span role="status">{permissionCheckLabel(snapshot)}</span>
					<button
						type="button"
						disabled={snapshot === null || updating}
						onClick={() => void controller.refreshPermissions()}
					>
						<RefreshCw
							size={14}
							aria-hidden="true"
							className={checking ? "monitoring-permissions__refreshing" : undefined}
						/>
						{checking ? "正在检查…" : "重新检查"}
					</button>
				</div>
			</header>
			<div className="monitoring-permissions__grid">
				{MONITORING_PERMISSION_IDS.map((id) => {
					const permission =
						snapshot?.permissions.find((item) => item.id === id) ??
						unknownPermission(id);
					const copy = permissionCopy[id];
					const statusCopy = permissionStateCopy[permission.state];
					const StatusIcon = statusCopy.Icon;
					return (
						<article
							className={`monitoring-permission-card monitoring-permission-card--${permission.state}`}
							key={id}
						>
							<div className="monitoring-permission-card__title">
								<div>
									<strong>{copy.label}</strong>
									{permission.required ? <span>当前配置需要</span> : null}
								</div>
								<span className="monitoring-permission-card__state">
									<StatusIcon size={14} aria-hidden="true" />
									{statusCopy.label}
								</span>
							</div>
							<p>{permission.detail ?? copy.description}</p>
							<button
								type="button"
								disabled={snapshot === null || updating}
								onClick={() =>
									void controller.openPermissionSettings(permission.id)
								}
								aria-label={`在 macOS 系统设置中查看${copy.label}权限`}
							>
								<ExternalLink size={14} aria-hidden="true" />
								在系统设置中查看
							</button>
						</article>
					);
				})}
			</div>
			{state.status === "error" ? (
				<p className="monitoring-permissions__error" role="alert">
					{state.message}
				</p>
			) : null}
		</section>
	);
}

function permissionCheckLabel(
	snapshot:
		| {
				permissionCheckState: "unchecked" | "checking" | "current" | "failed";
				permissionsCheckedAtMs: number | null;
		  }
		| null,
): string {
	if (snapshot === null) return "正在读取权限状态";
	switch (snapshot.permissionCheckState) {
		case "unchecked":
			return "尚未检查系统权限";
		case "checking":
			return "正在检查系统权限";
		case "failed":
			return snapshot.permissionsCheckedAtMs === null
				? "权限检查失败"
				: `检查失败 · 上次成功于 ${formatCheckTime(
						snapshot.permissionsCheckedAtMs,
					)}`;
		case "current":
			return `已检查 · ${formatCheckTime(snapshot.permissionsCheckedAtMs)}`;
	}
}

function formatCheckTime(value: number | null): string {
	if (value === null) return "时间未知";
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(value);
}

function unknownPermission(
	id: MonitoringPermissionId,
): MonitoringPermissionStatus {
	return {
		id,
		state: "unknown",
		required: false,
		detail: null,
	};
}
