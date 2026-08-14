import {
	createDefaultProactiveFeedbackPolicy,
	type ProactiveFeedbackAvailable,
	type ProactiveFeedbackHistoryCursor,
	type ProactiveFeedbackItem,
	type ProactiveFeedbackPage,
	type ProactiveFeedbackPolicy,
	type ProactiveFeedbackPolicySnapshot,
} from "../../../../shared/proactive-feedback";
import type { ProactiveFeedbackService } from "../../features/proactive-feedback/proactive-feedback-service";

/** Deterministic browser-QA adapter. It never writes localStorage. */
export class InMemoryProactiveFeedbackService
	implements ProactiveFeedbackService
{
	private policy: ProactiveFeedbackPolicySnapshot = {
		policy: createDefaultProactiveFeedbackPolicy(),
		revision: 0,
		updatedAtMs: null,
	};
	private items: ProactiveFeedbackItem[] = [];
	private readonly listeners = new Set<
		(event: ProactiveFeedbackAvailable) => void
	>();

	async loadPolicy(): Promise<ProactiveFeedbackPolicySnapshot> {
		return clonePolicySnapshot(this.policy);
	}

	async setPolicy(
		policy: ProactiveFeedbackPolicy,
		expectedRevision: number,
	): Promise<ProactiveFeedbackPolicySnapshot> {
		if (expectedRevision !== this.policy.revision)
			throw new Error("version conflict");
		this.policy = {
			policy: { ...policy },
			revision: this.policy.revision + 1,
			updatedAtMs: Date.now(),
		};
		return clonePolicySnapshot(this.policy);
	}

	async listHistory(input: {
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}): Promise<ProactiveFeedbackPage> {
		const cursor = input.cursor;
		const start = cursor
			? this.items.findIndex((item) => isAfterCursor(item, cursor))
			: 0;
		const resolvedStart = start < 0 ? this.items.length : start;
		const items = this.items.slice(resolvedStart, resolvedStart + input.limit);
		const hasMore = resolvedStart + items.length < this.items.length;
		const last = items.at(-1);
		return {
			items: items.map((item) => ({ ...item })),
			nextCursor:
				hasMore && last
					? { generatedAtMs: last.generatedAtMs, id: last.id }
					: null,
		};
	}

	async clear(): Promise<{ clearedAtMs: number }> {
		this.items = [];
		return { clearedAtMs: Date.now() };
	}

	onAvailable(
		listener: (event: ProactiveFeedbackAvailable) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

function isAfterCursor(
	item: ProactiveFeedbackItem,
	cursor: ProactiveFeedbackHistoryCursor,
): boolean {
	return (
		item.generatedAtMs < cursor.generatedAtMs ||
		(item.generatedAtMs === cursor.generatedAtMs && item.id < cursor.id)
	);
}

function clonePolicySnapshot(
	snapshot: ProactiveFeedbackPolicySnapshot,
): ProactiveFeedbackPolicySnapshot {
	return { ...snapshot, policy: { ...snapshot.policy } };
}
