import type {
	PlanningAuthorityGateway,
} from "../../features/planning/planning-service";
import type {
	GeneratedPlanDraft,
	PlanInput,
} from "../../features/planning/domain";
import type {
	PlanningAuthorityDraft,
	PlanningAuthorityInput,
	PlanningAuthorityRpcResult,
	PlanningAuthoritySnapshot,
	PlanningCommitResult,
} from "../../../../shared/planning-authority";

export class ElectrobunPlanningAuthorityGateway implements PlanningAuthorityGateway {
	async load(): Promise<PlanningAuthoritySnapshot | null> {
		const { clientApi } = await import("../../rpc");
		return unwrap(await clientApi.loadPlanningAuthority());
	}

	async saveDraft(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		expectedRevision: number | null,
	): Promise<PlanningAuthoritySnapshot> {
		const planType = draft.plan.type;
		if (planType === "fuzzy") {
			throw new Error("模糊计划不能写入旧版 PlanningAuthority。");
		}
		const authorityDraft: PlanningAuthorityDraft = {
			...structuredClone(draft),
			plan: { ...structuredClone(draft.plan), type: planType },
		};
		const { clientApi } = await import("../../rpc");
		return unwrap(await clientApi.savePlanningDraft({
			requestId: crypto.randomUUID(),
			expectedRevision,
			input: authorityInput(input),
			draft: authorityDraft,
		}));
	}

	async commitDraft(
		commitId: string,
		expectedRevision: number,
		expectedCalendarRevision: number,
	): Promise<PlanningCommitResult> {
		const { clientApi } = await import("../../rpc");
		return unwrap(await clientApi.commitPlanningDraft({
			requestId: crypto.randomUUID(),
			commitId,
			expectedRevision,
			expectedCalendarRevision,
		}));
	}
}

function authorityInput(input: PlanInput): PlanningAuthorityInput {
	if (!input.type) throw new Error("计划类型尚未确认，无法保存本地草案。");
	if (input.type === "fuzzy") {
		throw new Error("模糊计划不能写入旧版 PlanningAuthority。");
	}
	return { ...structuredClone(input), type: input.type };
}

function unwrap<T>(result: PlanningAuthorityRpcResult<T>): T {
	if (result.kind === "success") return result.data;
	throw new PlanningAuthorityGatewayError(result.kind, result.message);
}

export class PlanningAuthorityGatewayError extends Error {
	constructor(
		readonly kind: Exclude<PlanningAuthorityRpcResult<never>["kind"], "success">,
		message: string,
	) {
		super(message);
		this.name = "PlanningAuthorityGatewayError";
	}
}
