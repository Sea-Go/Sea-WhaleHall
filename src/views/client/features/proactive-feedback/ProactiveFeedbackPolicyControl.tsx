import { ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ProactiveFeedbackRetention } from "../../../../shared/proactive-feedback";
import { Button } from "../../shared/ui/Button";
import { ConfirmationDialog } from "../../shared/ui/ConfirmationDialog";
import type { ProactiveFeedbackPolicyController } from "./ProactiveFeedbackPolicyController";
import "./ProactiveFeedbackPolicyControl.css";

export interface ProactiveFeedbackPolicyControlProps {
	controller?: ProactiveFeedbackPolicyController;
	disabled?: boolean;
	onCleared?: () => void;
}

export function ProactiveFeedbackPolicyControl({
	controller,
	disabled = false,
	onCleared,
}: ProactiveFeedbackPolicyControlProps) {
	if (!controller) return <UnavailablePolicyControl />;
	return (
		<ConnectedPolicyControl
			controller={controller}
			disabled={disabled}
			onCleared={onCleared}
		/>
	);
}

function ConnectedPolicyControl({
	controller,
	disabled,
	onCleared,
}: {
	controller: ProactiveFeedbackPolicyController;
	disabled: boolean;
	onCleared?: () => void;
}) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const [clearDialogOpen, setClearDialogOpen] = useState(false);
	const clearButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (state.status === "idle") void controller.load();
	}, [controller, state.status]);

	const snapshot = "snapshot" in state ? state.snapshot : null;
	const busy =
		state.status === "idle" ||
		state.status === "loading" ||
		state.status === "saving" ||
		state.status === "clearing";
	const unavailable = state.status === "error" && state.stage === "load";

	return (
		<div className="proactive-policy" aria-busy={busy}>
			<div className="proactive-policy__row">
				<div>
					<strong>启用主动反馈</strong>
					<p>
						触发窗口会将当前系统权限允许采集的活动信息、活动发生时的目标和当时最多两种近期关怀方式发送到
						DataCenter，由关怀 Agent
						团队判断情境并生成反馈；近期反馈原文不会再次发送。
					</p>
				</div>
				<button
					className="proactive-policy__switch"
					type="button"
					role="switch"
					aria-label="启用主动反馈"
					aria-checked={snapshot?.policy.enabled ?? false}
					disabled={disabled || busy || unavailable || !snapshot}
					onClick={() => {
						if (snapshot) void controller.setEnabled(!snapshot.policy.enabled);
					}}
				>
					<span aria-hidden="true" />
				</button>
			</div>

			<div className="proactive-policy__row">
				<div>
					<strong>本地反馈保留周期</strong>
					<p>
						适用于已完成的事件流档案和最终反馈；尚未消费的事件流不按时间自动删除。
					</p>
				</div>
				<label className="proactive-policy__select">
					<span className="sr-only">本地反馈保留周期</span>
					<select
						value={snapshot?.policy.retention ?? 30}
						disabled={disabled || busy || unavailable || !snapshot}
						onChange={(event) =>
							void controller.setRetention(
								parseRetention(event.currentTarget.value),
							)
						}
					>
						<option value="7">7 天</option>
						<option value="30">30 天</option>
						<option value="90">90 天</option>
						<option value="forever">永久</option>
					</select>
				</label>
			</div>

			<PolicyStatus state={state} onRetry={() => void controller.load()} />

			<div className="proactive-policy__disclosure">
				<ShieldCheck size={17} aria-hidden="true" />
				<div>
					<strong>发送内容与保留边界</strong>
					<p>
						第一阶段会处理系统权限允许采集的窗口标题、URL、文件路径、文本、浏览器或辅助功能内容；关怀团队只接收代码白名单活动信号、当前目标和近期关怀方式。登录凭据和
						token
						不会进入模型正文，原始活动文本、近期反馈原文和内部评分也不会进入给用户生成文案的
						Agent。
					</p>
					<p>
						此授权独立于 CloudSync。DataCenter 的模型请求与响应审计约保留 30
						天，本地保留周期不会删除已经产生的远端审计记录。
					</p>
				</div>
			</div>

			<div className="proactive-policy__clear">
				<div>
					<strong>清除本机主动反馈数据</strong>
					<p>
						清除未消费队列、事件流档案和历史记录；不会删除 DataCenter 审计。
					</p>
				</div>
				<Button
					ref={clearButtonRef}
					variant="danger"
					icon={<Trash2 size={15} aria-hidden="true" />}
					disabled={disabled || busy || unavailable || !snapshot}
					onClick={() => setClearDialogOpen(true)}
				>
					清除数据
				</Button>
			</div>

			{clearDialogOpen ? (
				<ConfirmationDialog
					title="清除本机主动反馈数据？"
					description="未消费队列、事件流档案和历史记录会从当前账号的本机存储中删除，且无法恢复。DataCenter 已产生的模型审计不会随之删除。"
					confirmLabel="确认清除"
					busy={state.status === "clearing"}
					onCancel={() => setClearDialogOpen(false)}
					onConfirm={() => {
						void controller.clear().then((cleared) => {
							if (!cleared) return;
							setClearDialogOpen(false);
							onCleared?.();
						});
					}}
					returnFocusRef={clearButtonRef}
				/>
			) : null}
		</div>
	);
}

function PolicyStatus({
	state,
	onRetry,
}: {
	state: ReturnType<ProactiveFeedbackPolicyController["getSnapshot"]>;
	onRetry: () => void;
}) {
	if (state.status === "idle" || state.status === "loading") {
		return (
			<div className="proactive-policy__status" role="status">
				正在读取主动反馈设置…
			</div>
		);
	}
	if (state.status === "saving") {
		return (
			<div className="proactive-policy__status" role="status">
				正在保存主动反馈设置…
			</div>
		);
	}
	if (state.status === "clearing") {
		return (
			<div className="proactive-policy__status" role="status">
				正在清除本机主动反馈数据…
			</div>
		);
	}
	if (state.status === "success") {
		return (
			<div
				className="proactive-policy__status proactive-policy__status--success"
				role="status"
			>
				{state.message}
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div
				className="proactive-policy__status proactive-policy__status--error"
				role="alert"
			>
				<span>{state.message}</span>
				{state.stage === "load" || state.stage === "save" ? (
					<Button size="small" variant="ghost" onClick={onRetry}>
						重新读取
					</Button>
				) : null}
			</div>
		);
	}
	return null;
}

function UnavailablePolicyControl() {
	return (
		<div className="proactive-policy">
			<div className="proactive-policy__row">
				<div>
					<strong>启用主动反馈</strong>
					<p>桌面策略服务尚未连接，无法读取或更改当前账号的授权。</p>
				</div>
				<button
					className="proactive-policy__switch"
					type="button"
					role="switch"
					aria-label="启用主动反馈"
					aria-checked="false"
					disabled
				>
					<span aria-hidden="true" />
				</button>
			</div>
			<div className="proactive-policy__status" role="status">
				主动反馈服务不可用；当前页面不会用浏览器存储模拟授权。
			</div>
		</div>
	);
}

function parseRetention(value: string): ProactiveFeedbackRetention {
	if (value === "7") return 7;
	if (value === "90") return 90;
	if (value === "forever") return "forever";
	return 30;
}
