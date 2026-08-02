import {
	cloneGeneratedDraft,
	detectPlanningConflicts,
	emptyPlanInput,
	planHasBlockingConflicts,
	validatePlanInput,
	type GeneratedPlanDraft,
	type GenerationStatus,
	type PlanInput,
	type PlanInputIssue,
	type PlanningConflict,
	type ProposedScheduleItem,
} from "./domain";
import { Temporal } from "temporal-polyfill";
import {
	cloneActiveGoalContext,
	type ActiveGoalContextV1,
} from "../../../../shared/goal-context";
import type {
	PlanApplyResult,
	PlanningCalendarGateway,
	PlanningGenerationService,
} from "./planning-service";

export type PlanningWizardStep =
	| "describe"
	| "type"
	| "constraints"
	| "generate"
	| "structure"
	| "schedule"
	| "confirm";

export type PlanningState =
	| { status: "initial" }
	| {
			status: "drafting";
			step: "describe" | "type" | "constraints";
			input: PlanInput;
			issues: readonly PlanInputIssue[];
	  }
	| {
			status: "generating";
			step: "generate";
			input: PlanInput;
			completedStatuses: readonly GenerationStatus[];
			activeStatus: GenerationStatus;
			revision: number;
	  }
	| {
			status: "generation-error";
			step: "generate";
			input: PlanInput;
			message: string;
			revision: number;
	  }
	| {
			status: "empty-draft";
			step: "schedule";
			input: PlanInput;
			message: string;
			suggestions: readonly string[];
			revision: number;
	  }
	| {
			status: "review";
			step: "structure" | "schedule" | "confirm";
			input: PlanInput;
			draft: GeneratedPlanDraft;
			message: string | null;
	  }
	| {
			status: "applying";
			step: "confirm";
			input: PlanInput;
			draft: GeneratedPlanDraft;
			applyId: string;
	  }
	| {
			status: "success";
			planTitle: string;
			committedCount: number;
			warnings: readonly PlanningConflict[];
	  }
	| {
			status: "partial-failure";
			step: "confirm";
			input: PlanInput;
			draft: GeneratedPlanDraft;
			result: Extract<PlanApplyResult, { kind: "partial" | "failure" }>;
	  }
	| { status: "cancelled"; message: string };

const generationStatuses: readonly GenerationStatus[] = [
	"understood",
	"split-phases",
	"checking-calendar",
	"arranging",
	"ready",
];

function isDrafting(state: PlanningState): state is Extract<
	PlanningState,
	{ status: "drafting" }
> {
	return state.status === "drafting";
}

function validationFieldsForStep(
	step: "describe" | "type" | "constraints",
): readonly PlanInputIssue["field"][] {
	if (step === "describe") return ["goal"];
	if (step === "type") return ["type"];
	return ["deadline", "weeklyCapacityHours"];
}

export class PlanningController {
	private state: PlanningState = { status: "initial" };
	private readonly listeners = new Set<() => void>();
	private operationSequence = 0;
	private generationRevision = 0;
	private goalVersion = 0;
	private activeGoal: ActiveGoalContextV1 | null = null;
	private applyPromise: Promise<PlanApplyResult | null> | null = null;

	constructor(
		private readonly generator: PlanningGenerationService,
		private readonly calendar: PlanningCalendarGateway,
		private readonly today: () => string,
		private readonly timeZone: () => string,
		private readonly createId: () => string = () => crypto.randomUUID(),
		private readonly nowMs: () => number = () => Date.now(),
	) {}

	getSnapshot = (): PlanningState => this.state;
	getServerSnapshot = (): PlanningState => this.state;
	getActiveGoalContext = (): ActiveGoalContextV1 | null =>
		cloneActiveGoalContext(this.activeGoal);

	clearActiveGoalContext(): boolean {
		if (this.activeGoal === null) return false;
		this.activeGoal = null;
		this.notify();
		return true;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start(): void {
		this.operationSequence += 1;
		this.applyPromise = null;
		this.setState({
			status: "drafting",
			step: "describe",
			input: emptyPlanInput(),
			issues: [],
		});
	}

	updateInput(patch: Partial<PlanInput>): void {
		if (!isDrafting(this.state)) return;
		this.setState({
			...this.state,
			input: { ...this.state.input, ...patch },
			issues: this.state.issues.filter(
				(issue) => !(issue.field in patch),
			),
		});
	}

	next(): void {
		if (!isDrafting(this.state)) return;
		const fields = validationFieldsForStep(this.state.step);
		const issues = this.validate().filter((issue) => fields.includes(issue.field));
		if (issues.length > 0) {
			this.setState({ ...this.state, issues });
			return;
		}
		if (this.state.step === "describe") {
			this.setState({ ...this.state, step: "type", issues: [] });
			return;
		}
		if (this.state.step === "type") {
			this.setState({
				...this.state,
				step: "constraints",
				input: {
					...this.state.input,
					deadline:
						this.state.input.deadline ||
						this.suggestDeadline(
							this.state.input.goal,
							this.state.input.type,
						),
				},
				issues: [],
			});
			return;
		}
		void this.generate();
	}

	back(): void {
		if (isDrafting(this.state)) {
			const step =
				this.state.step === "constraints"
					? "type"
					: this.state.step === "type"
						? "describe"
						: "describe";
			this.setState({ ...this.state, step, issues: [] });
			return;
		}
		if (this.state.status === "review") {
			if (this.state.step === "confirm") {
				this.setState({ ...this.state, step: "schedule", message: null });
			} else if (this.state.step === "schedule") {
				this.setState({ ...this.state, step: "structure", message: null });
			}
		}
	}

	async generate(): Promise<void> {
		const source = this.inputFromState();
		if (!source) return;
		const issues = this.validate(source);
		if (issues.length > 0) {
			this.setState({
				status: "drafting",
				step:
					issues.some((issue) => issue.field === "goal")
						? "describe"
						: issues.some((issue) => issue.field === "type")
							? "type"
							: "constraints",
				input: source,
				issues,
			});
			return;
		}

		const sequence = ++this.operationSequence;
		const revision = ++this.generationRevision;
		this.setState({
			status: "generating",
			step: "generate",
			input: source,
			completedStatuses: [],
			activeStatus: "understood",
			revision,
		});
		try {
			const endDateExclusive = this.addDay(source.deadline);
			const availability = await this.calendar.loadAvailability({
				startDate: this.today(),
				endDateExclusive,
				timeZone: this.timeZone(),
			});
			if (sequence !== this.operationSequence) return;

			const generated = await this.generator.generate(source, availability, {
				today: this.today(),
				timeZone: this.timeZone(),
				revision,
				isCancelled: () => sequence !== this.operationSequence,
				onStatus: (status) => {
					if (sequence !== this.operationSequence) return;
					const index = generationStatuses.indexOf(status);
					this.setState({
						status: "generating",
						step: "generate",
						input: source,
						completedStatuses: generationStatuses.slice(0, index),
						activeStatus: status,
						revision,
					});
				},
			});
			if (sequence !== this.operationSequence) return;
			const draft = this.refreshConflicts(generated);
			if (draft.proposals.length === 0) {
				this.setState({
					status: "empty-draft",
					step: "schedule",
					input: source,
					message: "当前约束下没有可安排的时间。",
					suggestions:
						draft.suggestions.length > 0
							? draft.suggestions
							: ["延后截止日期", "缩小目标范围", "增加每周可投入时间"],
					revision,
				});
				return;
			}
			this.setState({
				status: "review",
				step: "structure",
				input: source,
				draft,
				message: null,
			});
		} catch (reason) {
			if (sequence !== this.operationSequence) return;
			this.setState({
				status: "generation-error",
				step: "generate",
				input: source,
				message:
					reason instanceof Error
						? reason.message
						: "计划生成失败，请稍后重试。",
				revision,
			});
		}
	}

	retryGeneration(): Promise<void> {
		return this.generate();
	}

	editConstraints(): void {
		const input = this.inputFromState();
		if (!input || this.state.status === "applying") return;
		this.operationSequence += 1;
		this.setState({
			status: "drafting",
			step: "constraints",
			input,
			issues: [],
		});
	}

	openSchedule(): void {
		if (this.state.status !== "review") return;
		this.setState({ ...this.state, step: "schedule", message: null });
	}

	openConfirm(): void {
		if (this.state.status !== "review") return;
		const draft = this.refreshConflicts(this.state.draft);
		if (planHasBlockingConflicts(draft.conflicts)) {
			this.setState({
				...this.state,
				step: "schedule",
				draft,
				message: "仍有不可用时间冲突，请先移动或删除对应安排。",
			});
			return;
		}
		this.setState({ ...this.state, step: "confirm", draft, message: null });
	}

	updateProposal(
		proposalId: string,
		patch: Pick<ProposedScheduleItem, "title" | "start" | "end">,
	): void {
		if (this.state.status !== "review") return;
		const proposals = this.state.draft.proposals.map((item) =>
			item.id === proposalId ? { ...item, ...patch, version: item.version + 1 } : item,
		);
		const draft = this.refreshConflicts({ ...this.state.draft, proposals });
		this.setState({ ...this.state, draft, message: "草案已更新，尚未写入日历。" });
	}

	deleteProposal(proposalId: string): void {
		if (this.state.status !== "review") return;
		const draft = this.refreshConflicts({
			...this.state.draft,
			proposals: this.state.draft.proposals.filter(
				(item) => item.id !== proposalId,
			),
		});
		this.setState({
			...this.state,
			draft,
			message: "已从草案移除，正式日历没有变化。",
		});
	}

	async apply(): Promise<PlanApplyResult | null> {
		if (this.applyPromise) return this.applyPromise;
		if (this.state.status !== "review" || this.state.step !== "confirm") {
			return null;
		}
		const draft = this.refreshConflicts(this.state.draft);
		if (
			draft.proposals.length === 0 ||
			planHasBlockingConflicts(draft.conflicts)
		) {
			this.setState({
				...this.state,
				step: "schedule",
				draft,
				message:
					draft.proposals.length === 0
						? "草案中没有可写入的安排。"
						: "请先处理所有不可用时间冲突。",
			});
			return null;
		}
		const applyId = this.createId();
		const input = this.state.input;
		this.setState({
			status: "applying",
			step: "confirm",
			input,
			draft,
			applyId,
		});
		const request = this.performApply(input, draft, applyId);
		this.applyPromise = request;
		void request.finally(() => {
			if (this.applyPromise === request) this.applyPromise = null;
		});
		return request;
	}

	retryApply(): Promise<PlanApplyResult | null> {
		if (this.state.status !== "partial-failure") return Promise.resolve(null);
		if (this.applyPromise) return this.applyPromise;
		const applyId = this.createId();
		const { input, draft, result } = this.state;
		this.setState({
			status: "applying",
			step: "confirm",
			input,
			draft,
			applyId,
		});
		const request = this.performApply(
			input,
			draft,
			applyId,
			result.committedCount,
		);
		this.applyPromise = request;
		void request.finally(() => {
			if (this.applyPromise === request) this.applyPromise = null;
		});
		return request;
	}

	returnToSchedule(): void {
		if (this.state.status !== "partial-failure") return;
		this.setState({
			status: "review",
			step: "schedule",
			input: this.state.input,
			draft: this.state.draft,
			message: this.state.result.message,
		});
	}

	cancel(): void {
		if (this.state.status === "applying") return;
		this.operationSequence += 1;
		this.applyPromise = null;
		this.setState({
			status: "cancelled",
			message: "已取消制定计划；草案没有写入正式日历。",
		});
	}

	reset(): void {
		this.operationSequence += 1;
		this.applyPromise = null;
		this.setState({ status: "initial" });
	}

	private async performApply(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		applyId: string,
		previouslyCommittedCount = 0,
	): Promise<PlanApplyResult> {
		try {
			const attempt = await this.calendar.applyPlan(
				draft.plan,
				draft.proposals,
				applyId,
			);
			if (attempt.ok) {
				const result: PlanApplyResult = {
					...attempt,
					committedCount:
						previouslyCommittedCount + attempt.committedCount,
				};
				this.goalVersion += 1;
				this.activeGoal = {
					schemaVersion: "active-goal.v1",
					goalId: draft.plan.id,
					planId: draft.plan.id,
					version: this.goalVersion,
					text: input.goal.trim(),
					activatedAtMs: this.nowMs(),
				};
				this.setState({
					status: "success",
					planTitle: draft.plan.title,
					committedCount: result.committedCount,
					warnings: result.warnings,
				});
				return result;
			}

			const result: Extract<
				PlanApplyResult,
				{ kind: "partial" | "failure" }
			> =
				attempt.kind === "failure" && previouslyCommittedCount > 0
					? {
							ok: false,
							kind: "partial",
							applyId: attempt.applyId,
							committedCount: previouslyCommittedCount,
							failedProposalIds: attempt.failedProposalIds,
							message: `先前已有 ${previouslyCommittedCount} 项写入成功；本次重试失败。${attempt.message}`,
						}
					: attempt.kind === "partial"
						? {
								...attempt,
								committedCount:
									previouslyCommittedCount + attempt.committedCount,
							}
						: attempt;
			const retryDraft =
				result.kind === "partial"
					? {
							...draft,
							proposals: draft.proposals.filter((proposal) =>
								result.failedProposalIds.includes(proposal.id),
							),
						}
					: draft;
			this.setState({
				status: "partial-failure",
				step: "confirm",
				input,
				draft: retryDraft,
				result,
			});
			return result;
		} catch {
			const result: Extract<
				PlanApplyResult,
				{ kind: "partial" | "failure" }
			> =
				previouslyCommittedCount > 0
					? {
							ok: false,
							kind: "partial",
							applyId,
							committedCount: previouslyCommittedCount,
							failedProposalIds: draft.proposals.map((item) => item.id),
							message: `先前已有 ${previouslyCommittedCount} 项写入成功；本次重试失败。`,
						}
					: {
							ok: false,
							kind: "failure",
							applyId,
							committedCount: 0,
							failedProposalIds: draft.proposals.map((item) => item.id),
							message: "写入失败，没有任何草案进入正式日历。请重试。",
						};
			this.setState({
				status: "partial-failure",
				step: "confirm",
				input,
				draft,
				result,
			});
			return result;
		}
	}

	private refreshConflicts(draft: GeneratedPlanDraft): GeneratedPlanDraft {
		const cloned = cloneGeneratedDraft(draft);
		return {
			...cloned,
			conflicts: detectPlanningConflicts(
				cloned.proposals,
				cloned.busyWindows,
			),
		};
	}

	private validate(input = this.inputFromState()): readonly PlanInputIssue[] {
		if (!input) return [];
		return validatePlanInput(input, this.today());
	}

	private inputFromState(): PlanInput | null {
		if (
			this.state.status === "drafting" ||
			this.state.status === "generating" ||
			this.state.status === "generation-error" ||
			this.state.status === "empty-draft" ||
			this.state.status === "review" ||
			this.state.status === "applying" ||
			this.state.status === "partial-failure"
		) {
			return this.state.input;
		}
		return null;
	}

	private addDay(date: string): string {
		return Temporal.PlainDate.from(date).add({ days: 1 }).toString();
	}

	private suggestDeadline(goal: string, type: PlanInput["type"]): string {
		const today = Temporal.PlainDate.from(this.today());
		const beforeMonth = goal.match(/(\d{1,2})\s*月前/u);
		const byMonthEnd = goal.match(/(\d{1,2})\s*月底前/u);
		const matchedMonth = Number(beforeMonth?.[1] ?? byMonthEnd?.[1] ?? 0);
		if (matchedMonth >= 1 && matchedMonth <= 12) {
			const year = matchedMonth < today.month ? today.year + 1 : today.year;
			if (beforeMonth) {
				return Temporal.PlainDate.from({
					year,
					month: matchedMonth,
					day: 1,
				})
					.subtract({ days: 1 })
					.toString();
			}
			return Temporal.PlainDate.from({
				year,
				month: matchedMonth,
				day: 1,
			})
				.add({ months: 1 })
				.subtract({ days: 1 })
				.toString();
		}
		return today
			.add({ days: type === "long-term" ? 90 : 14 })
			.toString();
	}

	private setState(state: PlanningState): void {
		this.state = state;
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
