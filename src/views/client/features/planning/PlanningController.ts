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
	PlanningAuthorityGateway,
	PlanningCalendarGateway,
	PlanningGenerationResult,
	PlanningGenerationService,
} from "./planning-service";
import type {
	TaskPlanningAnswer,
	TaskPlanningQuestion,
} from "../../../../shared/task-planning";
import type { PlanningAuthoritySnapshot } from "../../../../shared/planning-authority";

export type PlanningWizardStep =
	| "describe"
	| "type"
	| "constraints"
	| "clarify"
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
			status: "clarifying";
			step: "clarify";
			input: PlanInput;
			sessionId: string;
			questions: readonly TaskPlanningQuestion[];
			availability: readonly import("./domain").PlanningBusyWindow[];
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
			status: "restore-error";
			step: "generate";
			message: string;
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
			effectWarning: string | null;
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
	private authorityRevision: number | null = null;
	private draftMutationRevision = 0;
	private draftSaveTail: Promise<void> = Promise.resolve();
	private latestDraftSave: Promise<boolean> = Promise.resolve(true);

	constructor(
		private readonly generator: PlanningGenerationService,
		private readonly calendar: PlanningCalendarGateway,
		private readonly today: () => string,
		private readonly timeZone: () => string,
		private readonly createId: () => string = () => crypto.randomUUID(),
		private readonly nowMs: () => number = () => Date.now(),
		private readonly authority?: PlanningAuthorityGateway,
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

	async restore(): Promise<void> {
		if (this.state.status !== "initial") return;
		const initialOperation = this.operationSequence;
		if (this.authority) {
			try {
				const saved = await this.authority.load();
				if (this.operationSequence !== initialOperation || this.state.status !== "initial") return;
				if (saved) {
					this.restoreAuthority(saved);
					return;
				}
			} catch (reason) {
				if (this.operationSequence !== initialOperation || this.state.status !== "initial") return;
				this.setState({
					status: "restore-error",
					step: "generate",
					message: serviceMessage(reason, "本地计划草案暂时无法恢复，请重试。"),
				});
				return;
			}
		}
		if (!this.generator.findRestorable || !this.generator.restore) return;
		let sequence: number | null = null;
		let recoveryInput: PlanInput | null = null;
		let recoveryRevision = 0;
		try {
			const restorable = await this.generator.findRestorable();
			if (!restorable || this.state.status !== "initial") return;
			sequence = ++this.operationSequence;
			const revision = ++this.generationRevision;
			const input = restorable.input;
			recoveryInput = input;
			recoveryRevision = revision;
			this.setState({
				status: "generating",
				step: "generate",
				input,
				completedStatuses: [],
				activeStatus: "understood",
				revision,
			});
			const availability = await this.calendar.loadAvailability({
				startDate: this.today(),
				endDateExclusive: this.addDay(input.deadline),
				timeZone: this.timeZone(),
			});
			if (sequence !== this.operationSequence) return;
			const result = await this.generator.restore(restorable, availability, {
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
						input,
						completedStatuses: generationStatuses.slice(0, index),
						activeStatus: status,
						revision,
					});
				},
			});
			if (sequence !== this.operationSequence) return;
			await this.applyGenerationResult(input, availability, result, revision, sequence);
		} catch (reason) {
			if (sequence === null || sequence !== this.operationSequence || !recoveryInput) return;
			this.setState({
				status: "generation-error",
				step: "generate",
				input: recoveryInput,
				message: reason instanceof Error ? reason.message : "未能恢复计划生成。",
				revision: recoveryRevision,
			});
		}
	}

	async retryRestore(): Promise<void> {
		if (this.state.status !== "restore-error") return;
		this.setState({ status: "initial" });
		await this.restore();
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
			await this.applyGenerationResult(source, availability, generated, revision, sequence);
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

	async submitClarificationAnswers(answers: readonly TaskPlanningAnswer[]): Promise<void> {
		if (this.state.status !== "clarifying") return;
		const { input, sessionId, availability, revision } = this.state;
		const sequence = ++this.operationSequence;
		this.setState({
			status: "generating", step: "generate", input,
			completedStatuses: [], activeStatus: "understood", revision,
		});
		try {
			const result = await this.generator.continueAfterClarification(
				input, sessionId, answers, availability,
				{
					today: this.today(), timeZone: this.timeZone(), revision,
					isCancelled: () => sequence !== this.operationSequence,
					onStatus: (status) => {
						if (sequence !== this.operationSequence) return;
						const index = generationStatuses.indexOf(status);
						this.setState({ status: "generating", step: "generate", input, completedStatuses: generationStatuses.slice(0, index), activeStatus: status, revision });
					},
				},
			);
			if (sequence !== this.operationSequence) return;
			await this.applyGenerationResult(input, availability, result, revision, sequence);
		} catch (reason) {
			if (sequence !== this.operationSequence) return;
			this.setState({ status: "generation-error", step: "generate", input, message: reason instanceof Error ? reason.message : "计划生成失败，请稍后重试。", revision });
		}
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
		const input = this.state.input;
		this.setState({ ...this.state, draft, message: this.authority ? "正在安全保存本地草案…" : "草案已更新，尚未写入日历。" });
		this.queueDraftSave(input, draft);
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
			message: this.authority
				? "已从草案移除，正在安全保存…"
				: "已从草案移除，正式日历没有变化。",
		});
		this.queueDraftSave(this.state.input, draft);
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
		this.setState({ ...this.state, draft });
		const applyId = this.createId();
		const input = this.state.input;
		const request = this.prepareAndPerformApply(input, draft, applyId);
		this.applyPromise = request;
		void request.finally(() => {
			if (this.applyPromise === request) this.applyPromise = null;
		});
		return request;
	}

	retryApply(): Promise<PlanApplyResult | null> {
		if (this.state.status !== "partial-failure") return Promise.resolve(null);
		if (this.applyPromise) return this.applyPromise;
		const { input, draft, result } = this.state;
		const applyId = this.authority ? result.applyId : this.createId();
		const request = this.prepareAndPerformApply(
			input,
			draft,
			applyId,
			result.committedCount,
			true,
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
		void this.generator.cancel?.();
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

	private async prepareAndPerformApply(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		applyId: string,
		previouslyCommittedCount = 0,
		authorityRetry = false,
	): Promise<PlanApplyResult | null> {
		if (this.authority && !authorityRetry) {
			let saved = await this.latestDraftSave;
			if (!saved) {
				const mutationRevision = ++this.draftMutationRevision;
				saved = await this.scheduleDraftSave(input, draft, mutationRevision);
			}
			if (!saved) {
				if (this.state.status === "review") {
					this.setState({
						...this.state,
						message: "本地草案保存失败，已阻止写入日历。请检查本地存储后重试。",
					});
				}
				return null;
			}
			if (
				this.state.status !== "review" ||
				this.state.step !== "confirm" ||
				this.state.draft !== draft
			) {
				return null;
			}
		}
		if (this.authority && authorityRetry) {
			if (
				this.state.status !== "partial-failure" ||
				this.state.result.applyId !== applyId ||
				this.state.draft !== draft
			) {
				return null;
			}
		}
		this.setState({
			status: "applying",
			step: "confirm",
			input,
			draft,
			applyId,
		});
		return this.performApply(input, draft, applyId, previouslyCommittedCount);
	}

	private async performApply(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		applyId: string,
		previouslyCommittedCount = 0,
	): Promise<PlanApplyResult> {
		try {
			if (this.authority) {
				if (this.authorityRevision === null || draft.plan.calendarRevision === undefined) {
					throw new Error("本地计划版本缺失，无法安全确认。请重新生成计划。");
				}
				const committed = await this.authority.commitDraft(
					applyId,
					this.authorityRevision,
					draft.plan.calendarRevision,
				);
				this.authorityRevision = committed.snapshot.revision;
				this.activeGoal = cloneActiveGoalContext(committed.snapshot.activeGoal);
				this.goalVersion = this.activeGoal?.version ?? this.goalVersion;
				const commit = committed.snapshot.commit;
				if (!commit) throw new Error("本地计划提交记录不完整。");
				const result: PlanApplyResult = {
					ok: true,
					kind: "success",
					applyId,
					committedCount: commit.committedCount,
					warnings: commit.warnings,
				};
				this.setState({
					status: "success",
					planTitle: committed.snapshot.confirmedPlan?.title ?? draft.plan.title,
					committedCount: result.committedCount,
					warnings: result.warnings,
					effectWarning: committed.effectsApplied
						? null
						: commit.effect.lastError ?? "日历已写入，目标与本地事件日志将在恢复后继续同步。",
				});
				return result;
			}
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
					effectWarning: null,
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
		} catch (reason) {
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
							message: this.authority
								? `${serviceMessage(reason, "未能确认本地提交结果。")} 草案与提交状态已保留；重试不会重复创建日程。`
								: "写入失败，没有任何草案进入正式日历。请重试。",
							calendarState: this.authority ? "unknown" : "unchanged",
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

	private async applyGenerationResult(
		input: PlanInput,
		availability: readonly import("./domain").PlanningBusyWindow[],
		result: PlanningGenerationResult,
		revision: number,
		operationSequence: number,
	): Promise<void> {
		if (
			operationSequence !== this.operationSequence ||
			revision !== this.generationRevision
		) return;
		if (result.kind === "clarification") {
			this.setState({ status: "clarifying", step: "clarify", input, sessionId: result.sessionId, questions: result.questions, availability, revision });
			return;
		}
		const draft = this.refreshConflicts(result.draft);
		if (this.authority) {
			const mutationRevision = ++this.draftMutationRevision;
			const saved = await this.scheduleDraftSave(input, draft, mutationRevision);
			if (
				operationSequence !== this.operationSequence ||
				revision !== this.generationRevision
			) return;
			if (!saved) {
				this.setState({
					status: "generation-error",
					step: "generate",
					input,
					message: "计划已经生成，但无法安全保存到本机；草案未开放编辑，也没有写入日历。请重试。",
					revision,
				});
				return;
			}
		}
		if (draft.proposals.length === 0) {
			this.setState({ status: "empty-draft", step: "schedule", input, message: "当前约束下没有可安排的时间。", suggestions: draft.suggestions.length > 0 ? draft.suggestions : ["延后截止日期", "缩小目标范围", "增加每周可投入时间"], revision });
			return;
		}
		this.setState({ status: "review", step: "structure", input, draft, message: null });
	}

	private queueDraftSave(input: PlanInput, draft: GeneratedPlanDraft): void {
		if (!this.authority) return;
		const mutationRevision = ++this.draftMutationRevision;
		void this.scheduleDraftSave(input, draft, mutationRevision);
	}

	private scheduleDraftSave(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		mutationRevision: number,
	): Promise<boolean> {
		const operation = this.draftSaveTail.then(() =>
			this.persistDraft(input, draft, mutationRevision),
		);
		this.latestDraftSave = operation;
		this.draftSaveTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async persistDraft(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		mutationRevision: number,
	): Promise<boolean> {
		if (!this.authority) return true;
		try {
			const saved = await this.authority.saveDraft(
				input,
				draft,
				this.authorityRevision,
			);
			this.authorityRevision = saved.revision;
			this.activeGoal = cloneActiveGoalContext(saved.activeGoal);
			this.goalVersion = this.activeGoal?.version ?? this.goalVersion;
			if (mutationRevision === this.draftMutationRevision && this.state.status === "review") {
				this.setState({
					...this.state,
					message: "草案已安全保存在本机，正式日历尚未改变。",
				});
			}
			return true;
		} catch (reason) {
			if (mutationRevision === this.draftMutationRevision && this.state.status === "review") {
				this.setState({
					...this.state,
					message: `${serviceMessage(reason, "本地草案保存失败。")} 已阻止确认写入，请重试保存。`,
				});
			}
			return false;
		}
	}

	private restoreAuthority(snapshot: PlanningAuthoritySnapshot): void {
		this.authorityRevision = snapshot.revision;
		this.activeGoal = cloneActiveGoalContext(snapshot.activeGoal);
		this.goalVersion = this.activeGoal?.version ?? this.goalVersion;
		const input: PlanInput = structuredClone(snapshot.input);
		const draft = cloneGeneratedDraft(snapshot.draft);
		if (snapshot.status === "draft") {
			if (draft.proposals.length === 0) {
				this.setState({
					status: "empty-draft",
					step: "schedule",
					input,
					message: "已恢复本机保存的计划草案，但当前没有可安排的时间。",
					suggestions: draft.suggestions,
					revision: snapshot.revision,
				});
				return;
			}
			this.setState({
				status: "review",
				step: "structure",
				input,
				draft,
				message: "已恢复本机安全保存的计划草案。",
			});
			return;
		}
		const commit = snapshot.commit;
		this.setState({
			status: "success",
			planTitle: snapshot.confirmedPlan?.title ?? draft.plan.title,
			committedCount: commit?.committedCount ?? 0,
			warnings: commit?.warnings ?? [],
			effectWarning: commit?.effect.status === "pending"
				? commit.effect.lastError ?? "日历已写入，目标与本地事件日志将在恢复后继续同步。"
				: null,
		});
	}
	private validate(input = this.inputFromState()): readonly PlanInputIssue[] {
		if (!input) return [];
		return validatePlanInput(input, this.today());
	}

	private inputFromState(): PlanInput | null {
		if (
			this.state.status === "drafting" ||
			this.state.status === "generating" ||
			this.state.status === "clarifying" ||
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

function serviceMessage(reason: unknown, fallback: string): string {
	if (!(reason instanceof Error)) return fallback;
	const message = reason.message.trim();
	if (
		message.length < 1 ||
		message.length > 300 ||
		/[A-Za-z]:[\\/]|file:|https?:\/\//u.test(message)
	) {
		return fallback;
	}
	return message;
}
