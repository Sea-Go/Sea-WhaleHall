import { useEffect, useRef, useSyncExternalStore } from "react";
import type { PetChatState } from "./chat";
import { PetChatController } from "./chat";
import { SafePetMarkdown } from "./SafePetMarkdown";

export interface PetChatPanelProps {
	controller: PetChatController | null;
}

/**
 * 桌宠唯一输入框：与大肥鱼对话（云端 chat agent，云检索是 agent 的内部工具，
 * 不在此直接暴露）。事件不落画布，输入/滚动不触发桌宠交互。
 */
export function PetChatPanel({ controller }: PetChatPanelProps) {
	const state = useSyncExternalStore(
		controller ? controller.subscribe.bind(controller) : subscribeNoop,
		() => controller?.getState() ?? null,
	);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	// 流式期间滚动区贴底跟随（终端式），面板本身不越限长高。
	useEffect(() => {
		const node = scrollRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [state]);
	const stopPropagation = (event: React.SyntheticEvent): void => {
		event.stopPropagation();
	};
	return (
		<section
			className="pet-chat"
			aria-label="大肥鱼对话"
			onPointerDown={stopPropagation}
			onPointerMove={stopPropagation}
			onPointerUp={stopPropagation}
			onClick={stopPropagation}
			onKeyDown={stopPropagation}
			onKeyUp={stopPropagation}
		>
			<div className="pet-chat__scroll" ref={scrollRef}>
			<div className="pet-chat__status" role="status">
				{renderStatus(state)}
			</div>
			{state &&
			((state.kind === "running" && state.reasoning) ||
				(state.kind === "done" && state.reasoning)) ? (
				<div className="pet-chat__reasoning" aria-live="polite">
					{state.reasoning.slice(-600)}
				</div>
			) : null}
			{state?.kind === "running" || state?.kind === "done" ? (
				<div className="pet-chat__answer" aria-live="polite">
					{state.kind === "done" && state.answer === "" ? (
						<p className="pet-chat__muted">（这轮没有生成回答。）</p>
					) : (
						<SafePetMarkdown
							fallbackText={
								state.kind === "done" ? state.answer : state.streaming
							}
						/>
					)}
				</div>
			) : null}
			</div>
			<form
				className="pet-chat__form"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					const input = event.currentTarget.elements.namedItem("pet-chat-input");
					if (input instanceof HTMLInputElement) submitInput(input);
				}}
			>
				<input
					name="pet-chat-input"
					aria-label="问点什么，回车发送"
					placeholder={
						state?.kind === "unavailable" ? "登录后可与大肥鱼对话" : "问点什么，回车发送"
					}
					disabled={controller === null || state?.kind === "unavailable"}
					maxLength={2048}
					autoComplete="off"
					onKeyDown={(event) => {
						stopPropagation(event);
						// 回车即发送：无提交按钮的表单在部分引擎里 Enter 不触发
						//隐式提交，这里显式驱动同一提交路径。
						if (event.key === "Enter") {
							event.preventDefault();
							submitInput(event.currentTarget);
						}
					}}
					onKeyUp={stopPropagation}
					onPointerDown={stopPropagation}
				/>
				{state?.kind === "running" ? (
					<button type="button" onClick={() => controller?.cancelTurn()}>
						停止
					</button>
				) : null}
			</form>
		</section>
	);

	function submitInput(input: HTMLInputElement): void {
		const value = input.value;
		if (state?.kind === "running") return;
		if (value.trim().length === 0) return;
		input.value = "";
		controller?.startTurn(value);
	}
}

function renderStatus(state: PetChatState | null): React.ReactNode {
	if (state === null) return "对话尚未就绪。";
	if (state.kind === "unavailable") return state.message;
	if (state.kind === "idle") return "与大肥鱼对话。";
	if (state.kind === "failed") return state.message;
	if (state.kind === "done") {
		if (state.origin === "proactive") {
			return state.toolsUsed
				? "大肥鱼主动发起了对话（已结合知识库检索）。"
				: "大肥鱼刚才主动说：";
		}
		return state.toolsUsed ? "已结合知识库检索回答。" : "大肥鱼的回答。";
	}
	const active = state.tools.filter((tool) => tool.status === "running");
	const latestActive = active[active.length - 1];
	if (state.origin === "proactive" && !latestActive) return "大肥鱼正在主动发起对话…";
	if (latestActive) {
		return `${latestActive.label}中…`;
	}
	return "大肥鱼思考中…";
}

function subscribeNoop(): () => void {
	return () => undefined;
}
