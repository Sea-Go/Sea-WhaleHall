import {
	emptyPlanCreateInput,
	isPlanRevisionConfirmable,
	type PlanCreateInput,
	type PlanCreateIssue,
	type PlanStatus,
	type PlanSummaryView,
	type PlanTaskStatus,
	type PlanView,
	validatePlanCreateInput,
} from "./domain";
import {
	type PlanningService,
	PlanningServiceError,
	type PlanningServiceErrorCode,
} from "./planning-service";

export interface PlanningContent {
	plans: readonly PlanSummaryView[];
	plan: PlanView;
}

export type PlanningOperation =
	| "create"
	| "send-message"
	| "confirm-revision"
	| "set-task-status"
	| "confirm-observation"
	| "pause"
	| "resume"
	| "complete"
	| "archive"
	| "undo-adjustment"
	| "retry-analysis";

export type PlanningState =
	| { status: "idle" }
	| { status: "loading"; cached: PlanningContent | null }
	| {
			status: "empty";
			input: PlanCreateInput;
			issue: PlanCreateIssue | null;
	  }
	| {
			status: "create";
			input: PlanCreateInput;
			issue: PlanCreateIssue | null;
			existingPlans: readonly PlanSummaryView[];
	  }
	| {
			status: "creating";
			input: PlanCreateInput;
			existingPlans: readonly PlanSummaryView[];
	  }
	| {
			status: PlanStatus;
			content: PlanningContent;
	  }
	| {
			status: "updating";
			content: PlanningContent;
			operation: Exclude<PlanningOperation, "create">;
	  }
	| {
			status: "model-unavailable";
			content: PlanningContent | null;
			message: string;
			retryable: boolean;
	  }
	| {
			status: "stale";
			content: PlanningContent;
			message: string;
	  }
	| {
			status: "offline";
			cached: PlanningContent | null;
			message: string;
			retryable: boolean;
	  }
	| {
			status: "error";
			cached: PlanningContent | null;
			message: string;
			retryable: boolean;
	  };

function productErrorMessage(code: PlanningServiceErrorCode): string {
	switch (code) {
		case "model-unavailable":
			return "计划分析服务暂时不可用。你的消息已保留，可在服务恢复后继续分析。";
		case "stale-version":
			return "计划已在别处更新。请载入最新版本后再操作。";
		case "offline":
			return "本地计划服务暂时离线，已保留最近一次可用内容。";
		case "conflict":
			return "这次调整与已确认安排冲突，原计划没有被覆盖。";
		case "validation":
			return "请求内容不完整，请检查后重试。";
		case "not-found":
			return "没有找到这个计划，它可能已被归档。";
		case "unknown":
			return "计划服务暂时无法完成操作，请稍后重试。";
	}
}

export class PlanningController {
	private state: PlanningState = { status: "idle" };
	private readonly listeners = new Set<() => void>();
	private stopServiceSubscription: (() => void) | null = null;
	private requestSequence = 0;
	private operationSequence = 0;
	private selectedPlanId: string | null = null;
	private returnContent: PlanningContent | null = null;
	private pendingCreate: {
		input: PlanCreateInput;
		existingPlans: readonly PlanSummaryView[];
		operationId: string;
	} | null = null;

	constructor(
		private readonly service: PlanningService,
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	getSnapshot = (): PlanningState => this.state;
	getServerSnapshot = (): PlanningState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	async initialize(preferredPlanId?: string): Promise<void> {
		if (!this.stopServiceSubscription) {
			this.stopServiceSubscription = this.service.subscribe((event) => {
				const content = this.currentContent();
				if (
					this.state.status === "updating" ||
					this.state.status === "creating"
				) {
					return;
				}
				if (
					event.planId === null ||
					content === null ||
					event.planId === content.plan.id
				) {
					void this.load(content?.plan.id);
				}
			});
		}
		await this.load(preferredPlanId);
	}

	dispose(): void {
		this.stopServiceSubscription?.();
		this.stopServiceSubscription = null;
		this.requestSequence += 1;
		this.operationSequence += 1;
	}

	async load(preferredPlanId?: string): Promise<void> {
		const sequence = ++this.requestSequence;
		const cached = this.currentContent();
		this.setState({ status: "loading", cached });
		try {
			const plans = await this.service.listPlans();
			if (sequence !== this.requestSequence) return;
			if (plans.length === 0) {
				this.selectedPlanId = null;
				this.returnContent = null;
				this.setState({
					status: "empty",
					input: emptyPlanCreateInput(),
					issue: null,
				});
				return;
			}

			const selectedId = this.choosePlanId(plans, preferredPlanId);
			const plan = await this.service.getPlan(selectedId);
			if (sequence !== this.requestSequence) return;
			this.selectedPlanId = plan.id;
			const content = { plans, plan };
			this.returnContent = content;
			this.setLoaded(content);
		} catch (reason) {
			if (sequence !== this.requestSequence) return;
			this.setFailure(reason, cached);
		}
	}

	beginCreate(): void {
		if (this.state.status === "updating" || this.state.status === "creating") {
			return;
		}
		const content = this.currentContent();
		this.returnContent = content;
		this.pendingCreate = null;
		this.setState({
			status: "create",
			input: emptyPlanCreateInput(),
			issue: null,
			existingPlans: content?.plans ?? [],
		});
	}

	updateCreateInput(patch: Partial<PlanCreateInput>): void {
		if (this.state.status !== "empty" && this.state.status !== "create") return;
		this.pendingCreate = null;
		this.setState({
			...this.state,
			input: { ...this.state.input, ...patch },
			issue: patch.goal === undefined ? this.state.issue : null,
		});
	}

	cancelCreate(): void {
		if (this.state.status !== "create") return;
		this.pendingCreate = null;
		if (this.returnContent) {
			this.setLoaded(this.returnContent);
			return;
		}
		this.setState({
			status: "empty",
			input: emptyPlanCreateInput(),
			issue: null,
		});
	}

	async createPlanDraft(): Promise<void> {
		if (this.state.status !== "empty" && this.state.status !== "create") return;
		const issue = validatePlanCreateInput(this.state.input)[0] ?? null;
		if (issue) {
			this.setState({ ...this.state, issue });
			return;
		}
		const input = {
			...this.state.input,
			goal: this.state.input.goal.trim(),
		};
		const existingPlans =
			this.state.status === "create" ? this.state.existingPlans : [];
		const pending = { input, existingPlans, operationId: this.createId() };
		this.pendingCreate = pending;
		await this.performCreate(pending);
	}

	async selectPlan(planId: string): Promise<void> {
		if (!planId.trim() || planId === this.selectedPlanId) return;
		await this.load(planId);
	}

	async sendMessage(content: string): Promise<void> {
		const text = content.trim();
		if (!text) return;
		await this.mutate("send-message", (plan) =>
			this.service.sendPlanMessage({
				planId: plan.id,
				content: text,
				operationId: this.createId(),
				expectedVersion: plan.version,
			}),
		);
	}

	async confirmLatestRevision(): Promise<void> {
		const content = this.currentContent();
		if (!content || !isPlanRevisionConfirmable(content.plan)) return;
		const revision = content.plan.revision;
		if (!revision) return;
		await this.mutate("confirm-revision", (plan) =>
			this.service.confirmPlanRevision({
				planId: plan.id,
				revisionId: revision.revisionId,
				operationId: this.createId(),
				expectedVersion: plan.version,
			}),
		);
	}

	async setTaskStatus(taskId: string, status: PlanTaskStatus): Promise<void> {
		if (!taskId.trim()) return;
		await this.mutate("set-task-status", (plan) =>
			this.service.setTaskStatus({
				planId: plan.id,
				taskId,
				status,
				operationId: this.createId(),
				expectedVersion: plan.version,
			}),
		);
	}

	async confirmObservationAttribution(
		observationId: string,
		taskId: string | null,
	): Promise<void> {
		if (!observationId.trim()) return;
		await this.mutate("confirm-observation", (plan) =>
			this.service.confirmObservationAttribution({
				planId: plan.id,
				observationId,
				taskId,
				operationId: this.createId(),
				expectedVersion: plan.version,
			}),
		);
	}

	pausePlan(): Promise<void> {
		return this.changeStatus("pause", (plan) =>
			this.service.pausePlan(this.writeContext(plan)),
		);
	}

	resumePlan(): Promise<void> {
		return this.changeStatus("resume", (plan) =>
			this.service.resumePlan(this.writeContext(plan)),
		);
	}

	completePlan(): Promise<void> {
		return this.changeStatus("complete", (plan) =>
			this.service.completePlan(this.writeContext(plan)),
		);
	}

	archivePlan(): Promise<void> {
		return this.changeStatus("archive", (plan) =>
			this.service.archivePlan(this.writeContext(plan)),
		);
	}

	async undoAdjustment(adjustmentId: string): Promise<void> {
		const adjustment = this.currentContent()?.plan.adjustments.find(
			(item) => item.id === adjustmentId,
		);
		if (!adjustment?.canUndo) return;
		await this.mutate("undo-adjustment", (plan) =>
			this.service.undoPlanAdjustment({
				planId: plan.id,
				adjustmentId,
				adjustmentVersion: adjustment.version,
				operationId: this.createId(),
				expectedVersion: plan.version,
			}),
		);
	}

	retryPendingAnalysis(): Promise<void> {
		return this.changeStatus("retry-analysis", (plan) =>
			this.service.retryPendingAnalysis(this.writeContext(plan)),
		);
	}

	async retry(): Promise<void> {
		const content = this.currentContent();
		if (!content && this.pendingCreate) {
			await this.performCreate(this.pendingCreate);
			return;
		}
		if (this.state.status === "model-unavailable" && content) {
			await this.retryPendingAnalysis();
			return;
		}
		await this.load(content?.plan.id);
	}

	private async performCreate(pending: {
		input: PlanCreateInput;
		existingPlans: readonly PlanSummaryView[];
		operationId: string;
	}): Promise<void> {
		const sequence = ++this.operationSequence;
		this.setState({
			status: "creating",
			input: pending.input,
			existingPlans: pending.existingPlans,
		});
		try {
			const result = await this.service.createPlanDraft({
				input: pending.input,
				operationId: pending.operationId,
			});
			if (sequence !== this.operationSequence) return;
			this.pendingCreate = null;
			await this.load(result.planId);
		} catch (reason) {
			if (sequence !== this.operationSequence) return;
			this.setFailure(reason, this.returnContent);
		}
	}

	private changeStatus(
		operation: Extract<
			PlanningOperation,
			"pause" | "resume" | "complete" | "archive" | "retry-analysis"
		>,
		action: (plan: PlanView) => Promise<void>,
	): Promise<void> {
		return this.mutate(operation, action);
	}

	private writeContext(plan: PlanView) {
		return {
			planId: plan.id,
			operationId: this.createId(),
			expectedVersion: plan.version,
		};
	}

	private async mutate(
		operation: Exclude<PlanningOperation, "create">,
		action: (plan: PlanView) => Promise<void>,
	): Promise<void> {
		if (this.state.status === "updating" || this.state.status === "creating") {
			return;
		}
		const content = this.currentContent();
		if (!content) return;
		const sequence = ++this.operationSequence;
		this.setState({ status: "updating", content, operation });
		try {
			await action(content.plan);
			if (sequence !== this.operationSequence) return;
			await this.load(content.plan.id);
		} catch (reason) {
			if (sequence !== this.operationSequence) return;
			let latest = content;
			if (
				reason instanceof PlanningServiceError &&
				reason.code === "model-unavailable"
			) {
				latest = (await this.readContent(content.plan.id)) ?? content;
			}
			this.setFailure(reason, latest);
		}
	}

	private async readContent(planId: string): Promise<PlanningContent | null> {
		try {
			const [plans, plan] = await Promise.all([
				this.service.listPlans(),
				this.service.getPlan(planId),
			]);
			return { plans, plan };
		} catch {
			return null;
		}
	}

	private choosePlanId(
		plans: readonly PlanSummaryView[],
		preferredPlanId?: string,
	): string {
		const preferred = preferredPlanId ?? this.selectedPlanId;
		if (preferred && plans.some((plan) => plan.id === preferred))
			return preferred;
		const first = plans[0];
		if (!first) throw new Error("Expected at least one plan summary.");
		return (
			plans.find((plan) => plan.status === "active") ??
			plans.find((plan) => plan.status === "awaiting-confirmation") ??
			plans.find((plan) => plan.status === "draft") ??
			first
		).id;
	}

	private currentContent(): PlanningContent | null {
		if ("content" in this.state && this.state.content !== null) {
			return this.state.content;
		}
		if (
			(this.state.status === "loading" ||
				this.state.status === "offline" ||
				this.state.status === "error") &&
			this.state.cached
		) {
			return this.state.cached;
		}
		return null;
	}

	private setLoaded(content: PlanningContent): void {
		this.setState({ status: content.plan.status, content });
	}

	private setFailure(reason: unknown, cached: PlanningContent | null): void {
		const error =
			reason instanceof PlanningServiceError
				? reason
				: new PlanningServiceError("unknown", "Unknown planning failure", {
						cause: reason,
					});
		const message = productErrorMessage(error.code);
		if (error.code === "model-unavailable") {
			this.setState({
				status: "model-unavailable",
				content: cached,
				message,
				retryable: error.retryable,
			});
			return;
		}
		if (error.code === "stale-version" && cached) {
			this.setState({ status: "stale", content: cached, message });
			return;
		}
		if (error.code === "offline") {
			this.setState({
				status: "offline",
				cached,
				message,
				retryable: error.retryable,
			});
			return;
		}
		this.setState({
			status: "error",
			cached,
			message,
			retryable: error.retryable,
		});
	}

	private setState(state: PlanningState): void {
		this.state = state;
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
