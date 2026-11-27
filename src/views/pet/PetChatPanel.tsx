import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PetChatController, PetChatState } from "./chat";
import { SafePetMarkdown } from "./SafePetMarkdown";

export interface PetChatPanelProps {
	controller: PetChatController | null;
	/**
	 * 兼容模式显隐信号：指针是否悬停在桌宠精灵上（CanvasPetRenderer 的
	 * hover/dragStart 事件）。缺省 false——气泡默认隐藏。
	 */
	petHovered?: boolean;
	/** 主动心跳内容保持窗口毫秒数，默认 15000；测试注入短窗口。 */
	proactiveHoldMs?: number;
	/**
	 * 显隐状态回调：气泡可见性变化时上报（PetApp 据此让 dev 对话区调试框
	 * 与气泡同隐同显）。
	 */
	onVisibleChange?: (visible: boolean) => void;
}

const DEFAULT_PROACTIVE_HOLD_MS = 15_000;

// 保持窗口定时器在模块加载期绑定宿主实现：bun test 单进程并行装载测试
// 文件，happy-dom 全局会被其他文件换装并在其 afterAll 注销——运行时动态
// 取 window.setTimeout 会把定时器挂进已注销实例的队列（永不触发，气泡
// 卡显）。生产（WKWebView）语义不变。
const scheduleTimeout: (handler: () => void, timeout: number) => number =
	globalThis.setTimeout;
const cancelTimeout: (handle: number) => void = globalThis.clearTimeout;

/**
 * 桌宠唯一输入框：与大肥鱼对话（云端 chat agent，云检索是 agent 的内部工具，
 * 不在此直接暴露）。事件不落画布，输入/滚动不触发桌宠交互。
 *
 * 兼容模式显隐：气泡默认隐藏，以下任一成立即显示——
 * 1. 指针悬停在桌宠精灵上（petHovered）；
 * 2. 指针在气泡内（否则无法移动过去输入）；
 * 3. 输入框聚焦（打字时鼠标移开不打断）；
 * 4. 对话轮次进行中（自己的回答不会流式到一半消失）；
 * 5. 主动心跳出了内容：从最后一次内容更新起保持 15s 后消失
 *    （无悬停时；悬停态由 1/2 接管，不受窗口约束）。
 */
export function PetChatPanel({
	controller,
	petHovered = false,
	proactiveHoldMs = DEFAULT_PROACTIVE_HOLD_MS,
	onVisibleChange,
}: PetChatPanelProps) {
	const state = useSyncExternalStore(
		controller ? controller.subscribe.bind(controller) : subscribeNoop,
		() => controller?.getState() ?? null,
	);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [pointerInside, setPointerInside] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);
	const [proactiveHold, setProactiveHold] = useState(false);

	// 流式期间滚动区贴底跟随（终端式），面板本身不越限长高。
	// biome-ignore lint/correctness/useExhaustiveDependencies: state 流式更新即触发贴底滚动，语义依赖其变化而非引用其值
	useEffect(() => {
		const node = scrollRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [state]);

	// 主动心跳保持窗口：主动轮次存在即保持（流式每个增量重置计时），
	// 完成但无内容则不保持。非主动轮次到来时立即撤销保持。
	useEffect(() => {
		const proactive =
			state !== null &&
			(state.kind === "running" || state.kind === "done") &&
			state.origin === "proactive";
		const hasContent =
			state !== null && state.kind === "done"
				? state.answer.trim().length > 0
				: true;
		if (!proactive || !hasContent) {
			setProactiveHold(false);
			return;
		}
		setProactiveHold(true);
		const timer = scheduleTimeout(
			() => setProactiveHold(false),
			proactiveHoldMs,
		);
		return () => cancelTimeout(timer);
	}, [state, proactiveHoldMs]);

	const visible =
		petHovered ||
		pointerInside ||
		inputFocused ||
		state?.kind === "running" ||
		proactiveHold;

	// 显隐状态上报：PetApp 据此让 dev 对话区调试框与气泡同隐同显。
	useEffect(() => {
		onVisibleChange?.(visible);
	}, [visible, onVisibleChange]);
	const stopPropagation = (event: React.SyntheticEvent): void => {
		event.stopPropagation();
	};
	return (
		<section
			className="pet-chat"
			aria-label="大肥鱼对话"
			data-visible={visible ? "true" : "false"}
			onPointerEnter={() => setPointerInside(true)}
			onPointerLeave={() => setPointerInside(false)}
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
					const input =
						event.currentTarget.elements.namedItem("pet-chat-input");
					if (input instanceof HTMLInputElement) submitInput(input);
				}}
			>
				<input
					name="pet-chat-input"
					aria-label="问点什么，回车发送"
					placeholder={
						state?.kind === "unavailable"
							? "登录后可与大肥鱼对话"
							: "问点什么，回车发送"
					}
					disabled={controller === null || state?.kind === "unavailable"}
					maxLength={2048}
					autoComplete="off"
					onFocus={() => setInputFocused(true)}
					onBlur={() => setInputFocused(false)}
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
	if (state.origin === "proactive" && !latestActive)
		return "大肥鱼正在主动发起对话…";
	if (latestActive) {
		return `${latestActive.label}中…`;
	}
	return "大肥鱼思考中…";
}

function subscribeNoop(): () => void {
	return () => undefined;
}
