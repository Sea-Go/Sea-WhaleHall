/**
 * Plan lifecycle domain for the pet plan panel.
 *
 * Source of truth: Sea-Docs 文档/技术/客户端计划制定与执行引导方案.md §1
 * "计划生命周期状态机（提交权在人）"：
 *
 *   [*] ──用户发起（系统仅提问澄清）──► draft
 *   draft ──用户确认（唯一入库关口）──► confirmed ──开始执行──► active
 *   active ──周期复盘（系统可发起·结论只入记忆）──► review
 *   review ──用户发起调整──► adjusting ──用户确认 diff──► active
 *   active ──完成/归档（终态·不删除）──► archived
 *
 * 红线 C14/D11：用户建模不得自动创建/修改计划；planner 输出永远是"草稿"
 * 态，re-plan 的提交按钮永远在人这边。此类型只描述展示用状态，不承载
 * 状态迁移逻辑——迁移由 RTW task 域（service/task）权威裁决。
 */

/** Six states of the plan lifecycle state machine (see file header). */
export type PlanLifecycleStatus =
	| "draft"
	| "confirmed"
	| "active"
	| "review"
	| "adjusting"
	| "archived";

export type PlanCheckinOutcome = "done" | "postponed" | "skipped";

/** Check-in "为什么" note goes to memory only, never back into the plan. */
export interface PlanCheckinEvent {
	itemId: string;
	outcome: PlanCheckinOutcome;
	/** Optional user-typed reason; 只入记忆，不写计划（方案 §3-3）. */
	note?: string;
}

/** if-then cue per implementation intentions (方案 §2 数据模型). */
export interface PlanCueView {
	when: string;
	where?: string;
	trigger?: string;
}

export interface PlanItemView {
	id: string;
	cue: PlanCueView;
	action: string;
	/** Two-minute starter version of the action (Tiny Habits 锚定). */
	microAction: string;
	/** Falls back to the owning plan's status when omitted. */
	status?: PlanLifecycleStatus;
}

export interface PetPlanView {
	id: string;
	goal: string;
	status: PlanLifecycleStatus;
	items: PlanItemView[];
}

export interface PlanStatusMeta {
	label: string;
	/** One-line state meaning for aria labels and tooltips. */
	description: string;
	/** Semantic color variable name, defined in pet styles.css. */
	colorVar: string;
}

/**
 * Semantic status-color constants, one per state-machine state. Values are
 * CSS custom property names resolved in src/views/pet/styles.css
 * (`--pet-plan-status-*`); keep the two lists in sync. Colors are keyed to
 * the state machine semantics documented in the file header:
 * draft=草稿未确认, confirmed=已确认待执行, active=执行中, review=复盘,
 * adjusting=调整中, archived=已归档（终态）.
 */
export const PLAN_LIFECYCLE_META: Record<PlanLifecycleStatus, PlanStatusMeta> =
	{
		draft: {
			label: "草稿",
			description: "计划草稿，等你确认后才落库",
			colorVar: "--pet-plan-status-draft",
		},
		confirmed: {
			label: "已确认",
			description: "已确认，尚未开始执行",
			colorVar: "--pet-plan-status-confirmed",
		},
		active: {
			label: "执行中",
			description: "正在执行，可打卡",
			colorVar: "--pet-plan-status-active",
		},
		review: {
			label: "复盘",
			description: "周期复盘中，结论只入记忆",
			colorVar: "--pet-plan-status-review",
		},
		adjusting: {
			label: "调整中",
			description: "调整提案待你逐项确认",
			colorVar: "--pet-plan-status-adjusting",
		},
		archived: {
			label: "已归档",
			description: "已完成归档，不删除",
			colorVar: "--pet-plan-status-archived",
		},
	};

export const PLAN_LIFECYCLE_STATUSES: readonly PlanLifecycleStatus[] = [
	"draft",
	"confirmed",
	"active",
	"review",
	"adjusting",
	"archived",
];

/** Breadcrumb crumb for a cue, e.g. "周一 08:00 · 工位 · 早餐后". */
export function planCueText(cue: PlanCueView): string {
	return [cue.when, cue.where, cue.trigger].filter(Boolean).join(" · ");
}
