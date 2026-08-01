import {
	ExternalLink,
	ShieldAlert,
	ShieldCheck,
	type LucideIcon,
} from "lucide-react";
import {
	useEffect,
	useSyncExternalStore,
} from "react";
import {
	monitoringSetupStatus,
	type MonitoringPermissionId,
	type MonitoringPermissionState,
	type MonitoringPermissionStatus,
	type MonitoringSetupStatus,
} from "./domain";
import type { MonitoringController } from "./MonitoringController";
import "./MonitoringPermissionsControl.css";

const permissionCopy: Record<
	Exclude<MonitoringPermissionId, "browserAutomation">,
	{ label: string; description: string }
> = {
	accessibility: {
		label: "辅助功能",
		description: "读取前台应用的控件、焦点和最终显示的可见文本。",
	},
	screenRecording: {
		label: "屏幕录制",
		description: "仅为前台窗口做内存 OCR，不保存截图或视频。",
	},
	inputMonitoring: {
		label: "输入监控",
		description: "兼容字段，不属于必需设置，也不会单独请求授权。",
	},
};

const permissionStateCopy: Record<
	MonitoringPermissionState,
	{ label: string; Icon: LucideIcon }
> = {
	granted: { label: "已完成", Icon: ShieldCheck },
	denied: { label: "等待在系统设置中开启", Icon: ShieldAlert },
	notDetermined: { label: "等待系统确认", Icon: ShieldAlert },
	unknown: { label: "正在读取状态", Icon: ShieldAlert },
	unavailable: { label: "当前不可用", Icon: ShieldAlert },
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
	const setup = snapshot ? monitoringSetupStatus(snapshot) : null;

	// Returning from System Settings performs one silent preflight. This path
	// never requests consent and exists only while this mounted guide has
	// explicitly started setup.
	useEffect(() => {
		if (
			!snapshot?.permissionSetupAttempted ||
			setup?.phase !== "needs_permissions" ||
			typeof window === "undefined"
		) {
			return;
		}
		const refresh = () => {
			void controller.refreshPermissions();
		};
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [controller, setup?.phase, snapshot?.permissionSetupAttempted]);

	if (snapshot === null || setup === null) {
		return (
			<section
				className="monitoring-permissions monitoring-permissions--loading"
				aria-busy="true"
				aria-label="一次性监测设置"
			>
				<strong>正在读取一次性监测设置</strong>
				<p>不会触发任何 macOS 授权请求。</p>
			</section>
		);
	}

	const updating = state.status === "updating";
	const beginning = updating && state.operation === "beginSetup";
	const migrating = updating && state.operation === "migrateContentVault";
	const ready = setup.phase === "ready";
	const currentPermission = setup.firstMissingPermission;
	const automation = snapshot.permissions.find(
		(permission) => permission.id === "browserAutomation",
	);

	return (
		<section
			className={`monitoring-permissions monitoring-permissions--${setup.phase}`}
			aria-labelledby="monitoring-permissions-title"
		>
			<header className="monitoring-permissions__heading">
				<div>
					<span className="monitoring-permissions__eyebrow">
						{ready ? "设置已完成" : "首次使用"}
					</span>
					<strong id="monitoring-permissions-title">
						{ready ? "本机监测已设置" : "一次性监测设置"}
					</strong>
					<p>
						{ready
							? "两项必需权限和本地加密均已就绪。日常运行只会静默读取状态，不会再次弹出授权。"
							: snapshot.permissionSetupAttempted
								? "这台安装已执行过一次系统授权请求，WhaleHall 不会再次弹出。未完成的项目请直接在系统设置中开启。"
								: snapshot.permissionSetupAvailable
									? "WhaleHall 只有这一个显式设置入口。完成首次请求后，后续只会静默检查状态。"
									: "当前安装身份不能安全执行系统授权请求。请直接在系统设置中开启权限；WhaleHall 不会后台弹窗。"}
					</p>
					<p>
						键鼠活动量由辅助功能授权覆盖，不再单独请求输入监控权限；WhaleHall
						仍不会读取键值、拼音或候选词。
					</p>
				</div>
				<div
					className="monitoring-permissions__summary"
					role="status"
					aria-live="polite"
				>
					{ready ? (
						<ShieldCheck size={17} aria-hidden="true" />
					) : (
						<ShieldAlert size={17} aria-hidden="true" />
					)}
					<span>
						{setup.grantedPermissionCount}/{setup.requiredPermissionCount} 项完成
					</span>
				</div>
			</header>

			{!ready ? (
				<>
					<ol className="monitoring-permissions__steps">
						{setup.permissions.map((permission, index) => (
							<PermissionStep
								key={permission.id}
								index={index + 1}
								permission={permission}
							/>
						))}
					</ol>

					<div
						className={`monitoring-permissions__vault monitoring-permissions__vault--${snapshot.contentVault.availability}`}
					>
						{snapshot.contentVault.availability === "available" ? (
							<ShieldCheck size={16} aria-hidden="true" />
						) : (
							<ShieldAlert size={16} aria-hidden="true" />
						)}
						<div>
							<strong>本地内容加密</strong>
							<p>
								{contentVaultDescription(
									snapshot.contentVault.availability,
								)}
							</p>
						</div>
					</div>
				</>
			) : null}

			{!snapshot.permissionSetupAttempted &&
			snapshot.permissionSetupAvailable ? (
				<button
					className="monitoring-permissions__primary"
					type="button"
					disabled={updating}
					onClick={() => {
						void controller.beginSetup();
					}}
				>
					<ShieldCheck size={14} aria-hidden="true" />
					{beginning
						? "正在启动一次性设置…"
						: "开始一次性设置"}
				</button>
			) : (setup.phase === "needs_permissions" ||
					setup.phase === "not_started") &&
				currentPermission !== null ? (
					<button
						className="monitoring-permissions__primary"
						type="button"
						disabled={updating}
						onClick={() =>
							void controller.openPermissionSettings(
								currentPermission.id,
							)
						}
					>
						<ExternalLink size={14} aria-hidden="true" />
						打开{requiredPermissionLabel(currentPermission.id)}设置
					</button>
				) : setup.phase === "needs_legacy_vault_migration" ? (
					<button
						className="monitoring-permissions__primary"
						type="button"
						disabled={updating}
						onClick={() => void controller.migrateContentVault()}
					>
						<ShieldCheck size={14} aria-hidden="true" />
						{migrating
							? "正在等待一次性确认…"
							: "完成旧版本加密迁移"}
					</button>
				) : null}

			{setup.phase === "unavailable" ? (
				<p className="monitoring-permissions__notice" role="status">
					{snapshot.contentVault.availability === "migration_required"
						? "当前应用没有稳定签名，不能安全迁移旧密钥；现阶段只记录不含文本的元数据。"
						: "本机观察器或内容加密当前不可用。WhaleHall 不会反复请求权限，也不会退化为明文保存。"}
				</p>
			) : null}
			{!ready &&
			snapshot.permissionSetupAttempted &&
			setup.phase !== "unavailable" ? (
				<p className="monitoring-permissions__notice" role="status">
					系统授权已经请求过一次。为避免重复打扰，WhaleHall
					现在只会被动检查；请使用上方按钮打开系统设置完成剩余项目。
				</p>
			) : null}

			<details className="monitoring-permissions__optional">
				<summary>浏览器精确 URL（可选）</summary>
				<p>
					浏览器自动化不属于必需设置，也不影响上方完成状态。WhaleHall
					不会为每个浏览器反复弹出授权；没有既有授权时，浏览器深度内容按
					fail-closed 关闭，只保留基础前台应用状态。当前状态：
					{automationStateLabel(automation?.state)}。
				</p>
			</details>

			{state.status === "error" ? (
				<p className="monitoring-permissions__error" role="alert">
					{state.message}
				</p>
			) : null}
		</section>
	);
}

function PermissionStep({
	index,
	permission,
}: {
	index: number;
	permission: MonitoringSetupStatus["permissions"][number];
}) {
	if (permission.id === "browserAutomation") return null;
	const copy = permissionCopy[permission.id];
	const status = permissionStateCopy[permission.state];
	const StatusIcon = status.Icon;
	return (
		<li
			className={`monitoring-permissions__step monitoring-permissions__step--${permission.state}`}
		>
			<span className="monitoring-permissions__step-number" aria-hidden="true">
				{index}
			</span>
			<div>
				<strong>{copy.label}</strong>
				<p>{permission.detail ?? copy.description}</p>
			</div>
			<span className="monitoring-permissions__step-state">
				<StatusIcon size={14} aria-hidden="true" />
				{status.label}
			</span>
		</li>
	);
}

function requiredPermissionLabel(
	id: MonitoringPermissionStatus["id"],
): string {
	if (id === "browserAutomation") return "浏览器自动化";
	return permissionCopy[id].label;
}

function contentVaultDescription(
	availability: "available" | "migration_required" | "unavailable",
): string {
	switch (availability) {
		case "available":
			return "可见文本会先在本机加密，再写入 SQLite。";
		case "migration_required":
			return "只在旧开发安装上需要一次显式迁移；不会自动执行或删除旧密钥。";
		case "unavailable":
			return "加密不可用时只保存不含文本和网址的元数据。";
	}
}

function automationStateLabel(
	state: MonitoringPermissionState | undefined,
): string {
	if (state === "granted") return "已授权";
	if (state === "denied" || state === "notDetermined") return "未授权";
	return "未启用";
}
