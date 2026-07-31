import {
	Pause,
	Play,
	ShieldAlert,
	ShieldCheck,
} from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import {
	monitoringSetupStatus,
	monitoringStatusLabel,
} from "./domain";
import type { MonitoringController } from "./MonitoringController";
import "./MonitoringStatusControl.css";

export interface MonitoringStatusControlProps {
	controller: MonitoringController;
	onOpenPrivacy: () => void;
}

export function MonitoringStatusControl({
	controller,
	onOpenPrivacy,
}: MonitoringStatusControlProps) {
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
			<section className="monitoring-control monitoring-control--loading" aria-busy="true">
				<span className="monitoring-control__pulse" aria-hidden="true" />
				<div>
					<strong>正在连接观察器</strong>
					<span>正在读取本机采集状态</span>
				</div>
			</section>
		);
	}

	if (state.status === "error" && state.snapshot === null) {
		return (
			<section className="monitoring-control monitoring-control--error" role="alert">
				<ShieldAlert size={17} aria-hidden="true" />
				<div>
					<strong>观察器暂不可用</strong>
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
	const setup = monitoringSetupStatus(snapshot);
	const setupReady = setup.phase === "ready";
	const setupActionable =
		setup.phase === "not_started" ||
		setup.phase === "needs_permissions" ||
		setup.phase === "needs_legacy_vault_migration";
	const updating = state.status === "updating";
	const stateClass =
		snapshot.state === "running"
			? "running"
			: snapshot.state === "paused"
				? "paused"
				: "limited";
	const StatusIcon =
		snapshot.state === "running" ? ShieldCheck : ShieldAlert;

	return (
		<section
			className={`monitoring-control monitoring-control--${stateClass}`}
			aria-label="本机行为观察状态"
		>
			<header>
				<StatusIcon size={17} aria-hidden="true" />
				<div>
					<strong>{monitoringStatusLabel(snapshot)}</strong>
					<span>
						{setup.phase === "not_started"
							? "尚未完成一次性监测设置"
							: setup.phase === "needs_permissions"
								? `还有 ${setup.missingPermissions.length} 项系统权限待完成`
								: setup.phase === "needs_legacy_vault_migration"
									? "旧版本本地加密需要一次迁移"
									: setup.phase === "unavailable"
										? "本机监测设置当前不可用"
							: snapshot.state === "running"
								? "前台可见内容 · 本地加密"
								: snapshot.state === "starting"
									? "正在连接内置 macOS 观察器"
									: snapshot.state === "degraded"
										? "仅采集当前可用的本地信号"
										: "不会采集新的内容"}
					</span>
				</div>
			</header>
			{state.status === "error" ? (
				<p className="monitoring-control__error" role="alert">
					{state.message}
				</p>
			) : null}
			<div className="monitoring-control__actions">
				{setupActionable ? (
					<button
						type="button"
						onClick={onOpenPrivacy}
						disabled={updating}
					>
						<ShieldCheck size={14} aria-hidden="true" />
						{setup.phase === "not_started"
							? "设置本机监测"
							: "修复监测设置"}
					</button>
				) : null}
				{setupReady ? (
					<button
						type="button"
						onClick={() =>
							void (snapshot.paused
								? controller.resume()
								: controller.pause())
						}
						disabled={updating || snapshot.state === "unavailable"}
					>
						{snapshot.paused ? (
							<Play size={14} aria-hidden="true" />
						) : (
							<Pause size={14} aria-hidden="true" />
						)}
						{snapshot.paused ? "恢复观察" : "暂停观察"}
					</button>
				) : null}
			</div>
		</section>
	);
}
