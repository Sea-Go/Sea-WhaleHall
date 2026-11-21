import { useEffect, useRef, useState } from "react";

export interface PetDevDebugOverlayProps {
	/**
	 * 来自 PetState.debugOverlays（Bun 按 runtimeChannel==="dev" 盖章）。
	 * false 时完全不渲染任何 DOM——生产窗口与 dev 关闭态零开销。
	 */
	active: boolean;
}

type ZoneRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/**
 * dev 专属调试覆盖层（DOM 侧）：只画对话区虚线框——.pet-chat 面板的实时
 * 矩形，随内容增删经 ResizeObserver 更新。活动区框由 CanvasPetRenderer
 * 直接画进 canvas（下缘=立足线，与动画同帧、桌宠踩线），不在此处。
 *
 * 框外区域不属于桌宠接触范围。纯展示层：pointer-events:none +
 * aria-hidden，不拦截指针事件，不影响 canvas 渲染与面板交互。
 */
export function PetDevDebugOverlay({ active }: PetDevDebugOverlayProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [chat, setChat] = useState<ZoneRect | null>(null);

	useEffect(() => {
		if (!active) {
			setChat(null);
			return;
		}
		const container = containerRef.current;
		if (!container) return;
		const stage = container.parentElement;
		if (!stage) return;

		const readRects = () => {
			const stageRect = stage.getBoundingClientRect();
			const panel = stage.querySelector<HTMLElement>(".pet-chat");
			const rect = panel?.getBoundingClientRect();
			setChat(
				rect
					? {
							left: Math.max(0, rect.left - stageRect.left),
							top: Math.max(0, rect.top - stageRect.top),
							width: Math.max(0, rect.width),
							height: Math.max(0, rect.height),
						}
					: null,
			);
		};

		readRects();
		// 面板内容增删（流式回答、占位行）与窗口缩放都会改变几何，
		// ResizeObserver 是唯一需要的信号源；测试环境缺失时退化为首帧测量。
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(readRects);
		observer.observe(stage);
		const panel = stage.querySelector<HTMLElement>(".pet-chat");
		if (panel) observer.observe(panel);
		return () => observer.disconnect();
	}, [active]);

	// active 即挂容器（哪怕测量未就绪）：effect 依赖 containerRef 找到
	// .pet-stage 完成测量；先有容器才有测量，测量完成后再填虚线框。
	if (!active) {
		return null;
	}

	return (
		<div className="pet-dev-zone" ref={containerRef} aria-hidden="true">
			{chat ? (
				<div
					className="pet-dev-zone__box pet-dev-zone__box--chat"
					style={{
						left: chat.left,
						top: chat.top,
						width: chat.width,
						height: chat.height,
					}}
				>
					<span className="pet-dev-zone__tag">
						对话区 {Math.round(chat.width)}×{Math.round(chat.height)}
					</span>
				</div>
			) : null}
		</div>
	);
}
