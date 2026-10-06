import type { SyntheticEvent } from "react";
import { PlanCheckinRow } from "./PlanCheckinRow";
import { PlanStateBadge } from "./PlanStateBadge";
import {
	type PetPlanView,
	type PlanCheckinOutcome,
	planCueText,
} from "./plan-lifecycle";

export interface PetPlanPanelProps {
	/** Null until the RTW task-domain endpoints land (see MOCK_PET_PLAN). */
	plan: PetPlanView | null;
	/** Check-ins are user-triggered; the note goes to memory only. */
	onCheckin?: (
		itemId: string,
		outcome: PlanCheckinOutcome,
		note?: string,
	) => void;
}

/**
 * Mock plan payload for wiring and tests only. 待 RTW task 域端点：真实
 * 计划数据属于 RTW `service/task` 域的 Plan/CheckinEvent（方案 §4 工程落点），
 * 通过 Bun 注入的 port 到达；在该端点可用之前，生产环境传入 null。
 */
export const MOCK_PET_PLAN: PetPlanView = {
	id: "plan-mock-1",
	goal: "养成晨间阅读习惯",
	status: "active",
	items: [
		{
			id: "item-1",
			cue: { when: "每天 08:00", where: "书桌", trigger: "早餐放下筷子后" },
			action: "读《深海生物学》第一章",
			microAction: "翻开书读两分钟",
		},
		{
			id: "item-2",
			cue: { when: "每天 21:30", where: "床头", trigger: "洗漱完坐下后" },
			action: "整理一条阅读笔记",
			microAction: "写一句“今天最有意思的点”",
			status: "confirmed",
		},
	],
};

function stopPetInteraction(event: SyntheticEvent): void {
	event.stopPropagation();
}

/**
 * Pet plan panel skeleton: plan goal + lifecycle badge, then one row per
 * plan item showing its if-then cue, action, two-minute micro step, state
 * badge, and a check-in three-key row while the item is active. Props
 * driven; no backend wiring yet. Visual language follows the pet
 * cloud-search panel (surface bubble, rounded, muted text).
 */
export function PetPlanPanel({ plan, onCheckin }: PetPlanPanelProps) {
	return (
		<section
			className="pet-plan-panel"
			aria-label="桌宠计划面板"
			onClick={stopPetInteraction}
			onKeyDown={stopPetInteraction}
			onPointerDown={stopPetInteraction}
			onPointerUp={stopPetInteraction}
		>
			{!plan ? (
				<div className="pet-plan-panel__empty" role="status">
					还没有进行中的计划。和小鲸聊聊，先出一份草稿。
				</div>
			) : (
				<>
					<header className="pet-plan-panel__header">
						<strong className="pet-plan-panel__goal">{plan.goal}</strong>
						<PlanStateBadge status={plan.status} />
					</header>
					<ul className="pet-plan-panel__items">
						{plan.items.map((item) => {
							const status = item.status ?? plan.status;
							return (
								<li key={item.id} className="pet-plan-panel__item">
									<div className="pet-plan-panel__item-head">
										<span className="pet-plan-panel__cue">
											{planCueText(item.cue)}
										</span>
										<PlanStateBadge status={status} />
									</div>
									<p className="pet-plan-panel__action">{item.action}</p>
									<p className="pet-plan-panel__micro">
										微步骤：{item.microAction}
									</p>
									{status === "active" && (
										<PlanCheckinRow
											itemId={item.id}
											onCheckin={(itemId, outcome, note) =>
												onCheckin?.(itemId, outcome, note)
											}
										/>
									)}
								</li>
							);
						})}
					</ul>
				</>
			)}
		</section>
	);
}
