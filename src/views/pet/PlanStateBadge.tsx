import {
	PLAN_LIFECYCLE_META,
	type PlanLifecycleStatus,
} from "./plan-lifecycle";

export interface PlanStateBadgeProps {
	status: PlanLifecycleStatus;
}

/**
 * Pet-view badge for a plan lifecycle state (draft/confirmed/active/review/
 * adjusting/archived). Colors come from the semantic `--pet-plan-status-*`
 * constants documented against the state machine in plan-lifecycle.ts. The
 * visible label is the accessible name; the state-machine meaning rides in
 * the title tooltip.
 */
export function PlanStateBadge({ status }: PlanStateBadgeProps) {
	const meta = PLAN_LIFECYCLE_META[status];
	return (
		<span
			className={`pet-plan-badge pet-plan-badge--${status}`}
			data-status={status}
			title={meta.description}
		>
			{meta.label}
		</span>
	);
}
