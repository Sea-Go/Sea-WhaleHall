import {
	CircleAlert,
	CloudDownload,
	RefreshCw,
	Rocket,
	ShieldCheck,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import type { AppUpdateSnapshot } from "../../../../shared/app-update";
import { Button } from "../../shared/ui/Button";
import type { AppUpdateController } from "./AppUpdateController";
import {
	appUpdateNeedsAttention,
	appUpdateRelease,
	formatUpdateSize,
} from "./domain";
import { releaseNotesToPlainText } from "./release-notes";
import "./UpdateStatusControl.css";

export interface UpdateStatusControlProps {
	controller: AppUpdateController;
	variant?: "banner" | "settings";
}

export function UpdateStatusControl({
	controller,
	variant = "banner",
}: UpdateStatusControlProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const snapshot = "snapshot" in state ? state.snapshot : null;

	if (variant === "banner") {
		if (!shouldRenderBanner(state.status, snapshot)) return null;
		return (
			<UpdateBanner controller={controller} state={state} snapshot={snapshot} />
		);
	}

	return (
		<UpdateSettingsStatus
			controller={controller}
			state={state}
			snapshot={snapshot}
		/>
	);
}

export function AppUpdateAttentionMark({
	controller,
	label,
}: {
	controller: AppUpdateController;
	label?: string;
}) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const snapshot = "snapshot" in state ? state.snapshot : null;
	if (snapshot === null || !appUpdateNeedsAttention(snapshot)) return null;
	return (
		<span className="app-update-mark">
			<span className="app-update-mark__dot" aria-hidden="true" />
			{label ? <span aria-hidden="true">{label}</span> : null}
			<span className="sr-only">有客户端更新</span>
		</span>
	);
}

type ControllerState = ReturnType<AppUpdateController["getSnapshot"]>;

function UpdateBanner({
	controller,
	state,
	snapshot,
}: {
	controller: AppUpdateController;
	state: ControllerState;
	snapshot: AppUpdateSnapshot | null;
}) {
	const presentation = updatePresentation(state, snapshot);
	const mandatory = snapshot
		? (appUpdateRelease(snapshot)?.mandatory ?? false)
		: false;
	return (
		<section
			className={`app-update-banner${mandatory ? " app-update-banner--mandatory" : ""}`}
			role={mandatory || presentation.failure ? "alert" : "status"}
			aria-live={mandatory ? "assertive" : "polite"}
			aria-atomic="true"
		>
			<span className="app-update-banner__icon" aria-hidden="true">
				{presentation.failure ? (
					<CircleAlert size={19} />
				) : (
					<CloudDownload size={19} />
				)}
			</span>
			<div className="app-update-banner__copy">
				<strong>{presentation.title}</strong>
				<span>{presentation.description}</span>
				{presentation.percent !== null ? (
					<ProgressBar percent={presentation.percent} />
				) : null}
			</div>
			<div className="app-update-banner__actions">
				<UpdateAction
					controller={controller}
					state={state}
					snapshot={snapshot}
					compact
				/>
			</div>
		</section>
	);
}

function UpdateSettingsStatus({
	controller,
	state,
	snapshot,
}: {
	controller: AppUpdateController;
	state: ControllerState;
	snapshot: AppUpdateSnapshot | null;
}) {
	const presentation = updatePresentation(state, snapshot);
	const release = snapshot ? appUpdateRelease(snapshot) : null;
	const currentVersion = snapshot?.currentVersion;
	const releaseNotes = release
		? releaseNotesToPlainText(release.releaseNotes)
		: "";
	return (
		<section className="app-update-settings" aria-label="客户端更新">
			<div className="app-update-settings__heading">
				<span className="app-update-settings__icon" aria-hidden="true">
					{presentation.failure ? (
						<CircleAlert size={18} />
					) : release ? (
						<Rocket size={18} />
					) : (
						<ShieldCheck size={18} />
					)}
				</span>
				<div>
					<strong>{presentation.title}</strong>
					<p>{presentation.description}</p>
				</div>
				<UpdateAction
					controller={controller}
					state={state}
					snapshot={snapshot}
				/>
			</div>

			<dl className="app-update-settings__versions">
				<div>
					<dt>当前版本</dt>
					<dd>{currentVersion ? `v${currentVersion}` : "正在读取…"}</dd>
				</div>
				<div>
					<dt>更新渠道</dt>
					<dd>Stable</dd>
				</div>
				{release ? (
					<div>
						<dt>可用版本</dt>
						<dd>
							v{release.version}
							{release.mandatory ? (
								<span className="app-update-settings__mandatory">必须更新</span>
							) : null}
						</dd>
					</div>
				) : null}
			</dl>

			{snapshot?.state === "downloading" ? (
				<div className="app-update-settings__progress">
					<ProgressBar percent={snapshot.progress.percent} />
					<span>
						{formatUpdateSize(snapshot.progress.receivedBytes)} /{" "}
						{formatUpdateSize(snapshot.progress.totalBytes)}
					</span>
				</div>
			) : null}

			{releaseNotes ? (
				<div className="app-update-settings__notes">
					<strong>本次更新</strong>
					<p>{releaseNotes}</p>
				</div>
			) : null}
		</section>
	);
}

function UpdateAction({
	controller,
	state,
	snapshot,
	compact = false,
}: {
	controller: AppUpdateController;
	state: ControllerState;
	snapshot: AppUpdateSnapshot | null;
	compact?: boolean;
}) {
	const size = compact ? "small" : "medium";
	if (state.status === "error") {
		return (
			<Button
				size={size}
				variant={compact ? "secondary" : "primary"}
				icon={<RefreshCw size={14} aria-hidden="true" />}
				onClick={() => void controller.retry()}
			>
				重试
			</Button>
		);
	}
	if (snapshot?.state === "failed") {
		return (
			<Button
				size={size}
				variant={compact ? "secondary" : "primary"}
				icon={<RefreshCw size={14} aria-hidden="true" />}
				onClick={() => void retrySnapshotFailure(controller, snapshot)}
			>
				重试
			</Button>
		);
	}
	if (snapshot?.state === "available") {
		return (
			<Button
				size={size}
				variant="primary"
				icon={<CloudDownload size={14} aria-hidden="true" />}
				disabled={state.status === "ready" && state.operation !== null}
				onClick={() => void controller.download()}
			>
				{snapshot.release.mandatory ? "立即下载" : "下载更新"}
			</Button>
		);
	}
	if (snapshot?.state === "ready") {
		return (
			<Button
				size={size}
				variant="primary"
				icon={<Rocket size={14} aria-hidden="true" />}
				disabled={state.status === "ready" && state.operation !== null}
				onClick={() => void controller.installAndRestart()}
			>
				{snapshot.release.mandatory ? "立即重启安装" : "重启并安装"}
			</Button>
		);
	}
	if (
		snapshot?.state === "downloading" ||
		snapshot?.state === "verifying" ||
		snapshot?.state === "preparing_install" ||
		snapshot?.state === "installing"
	) {
		return (
			<Button size={size} variant="secondary" disabled>
				{snapshot.state === "downloading"
					? `下载 ${Math.round(snapshot.progress.percent)}%`
					: snapshot.state === "verifying"
						? "正在校验…"
						: snapshot.state === "preparing_install"
							? "正在安全收尾…"
							: "正在安装…"}
			</Button>
		);
	}
	return (
		<Button
			size={size}
			variant="secondary"
			icon={<RefreshCw size={14} aria-hidden="true" />}
			disabled={
				state.status === "idle" ||
				state.status === "loading" ||
				snapshot?.state === "checking" ||
				snapshot?.state === "disabled"
			}
			onClick={() => void controller.check()}
		>
			{snapshot?.state === "checking" ? "正在检查…" : "检查更新"}
		</Button>
	);
}

function ProgressBar({ percent }: { percent: number }) {
	const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
	return (
		<div
			className="app-update-progress"
			role="progressbar"
			aria-label="更新下载进度"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={boundedPercent}
		>
			<span style={{ width: `${boundedPercent}%` }} />
		</div>
	);
}

function updatePresentation(
	state: ControllerState,
	snapshot: AppUpdateSnapshot | null,
): {
	title: string;
	description: string;
	failure: boolean;
	percent: number | null;
} {
	if (state.status === "error") {
		return {
			title: "客户端更新暂未完成",
			description: state.message,
			failure: true,
			percent: null,
		};
	}
	if (snapshot === null || snapshot.state === "idle") {
		return {
			title: "正在读取版本信息",
			description: "正在连接 Stable 更新服务。",
			failure: false,
			percent: null,
		};
	}
	switch (snapshot.state) {
		case "checking":
			return presentation("正在检查更新", "正在查询最新 Stable 版本。");
		case "disabled":
			return presentation(
				"此构建不接收自动更新",
				snapshot.reason === "non_stable_channel"
					? "当前不是 Stable 构建，自动更新已关闭。"
					: "当前平台暂不支持客户端内更新。",
			);
		case "up_to_date":
			return presentation("已是最新版本", "当前已安装最新 Stable 版本。");
		case "available":
			return presentation(
				snapshot.release.mandatory
					? `WhaleHall v${snapshot.release.version} 必须更新`
					: `WhaleHall v${snapshot.release.version} 可以下载`,
				snapshot.release.mandatory
					? "为保证兼容与安全，客户端将自动下载并在安全收尾后重启。"
					: "可以继续使用当前版本，下载完成后由你决定何时重启。",
			);
		case "downloading":
			return {
				...presentation(
					`正在下载 WhaleHall v${snapshot.release.version}`,
					"下载期间可以继续使用客户端。",
				),
				percent: snapshot.progress.percent,
			};
		case "verifying":
			return presentation("正在校验更新", "正在核对签名、版本和安装包完整性。");
		case "ready":
			return presentation(
				snapshot.release.mandatory
					? "更新已就绪，正在准备重启"
					: "更新已下载，可以安装",
				snapshot.release.mandatory
					? "客户端将停止新任务，安全收尾后自动安装并重启。"
					: "点击“重启并安装”后，客户端会安全结束当前工作并重新打开。",
			);
		case "preparing_install":
			return presentation(
				"正在为更新安全收尾",
				"已停止启动新任务，正在等待关键写入完成。",
			);
		case "installing":
			return presentation(
				"正在安装更新",
				"WhaleHall 即将关闭并自动重新打开，请勿手动结束进程。",
			);
		case "failed":
			return {
				title: "客户端更新暂未完成",
				description: snapshot.failure.message,
				failure: true,
				percent: null,
			};
	}
}

function presentation(title: string, description: string) {
	return { title, description, failure: false, percent: null };
}

function shouldRenderBanner(
	status: ControllerState["status"],
	snapshot: AppUpdateSnapshot | null,
): boolean {
	if (snapshot && appUpdateNeedsAttention(snapshot)) return true;
	if (snapshot?.state === "failed" && snapshot.release !== null) return true;
	return (
		status === "error" && snapshot !== null && appUpdateNeedsAttention(snapshot)
	);
}

function retrySnapshotFailure(
	controller: AppUpdateController,
	snapshot: Extract<AppUpdateSnapshot, { state: "failed" }>,
): Promise<AppUpdateSnapshot | null> {
	switch (snapshot.failure.operation) {
		case "check":
			return controller.check();
		case "download":
			return controller.download();
		case "install":
			return controller.installAndRestart();
	}
}
