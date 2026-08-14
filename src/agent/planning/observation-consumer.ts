import type { PlanningObservationSummary, PlanningPlan } from "./types";

export interface TimelinePlanningSegment {
	startedAtMs: number;
	endedAtMs: number;
	goalRelevance: "direct" | "supporting" | "unrelated" | "uncertain" | null;
	confidence: number;
}

export interface TimelinePlanningInput {
	id: string;
	period: { startedAtMs: number; endedAtMs: number };
	segments: readonly TimelinePlanningSegment[];
	coverage: readonly (
		| "content"
		| "metadata"
		| "redacted"
		| "denied"
		| "unavailable"
	)[];
}

export interface ScheduledTaskInterval {
	planId: string;
	taskId: string;
	start: string;
	end: string;
}

/**
 * Converts an authorized Timeline v2 summary into a content-free planning
 * observation. Attribution is derived only from explicit plan-task calendar
 * intervals. No activity label or raw text crosses this boundary.
 */
export function projectTimelinePlanningObservation(
	input: TimelinePlanningInput,
	intervals: readonly ScheduledTaskInterval[],
): PlanningObservationSummary {
	const coverage = classifyCoverage(input.coverage);
	const candidates = new Map<
		string,
		{ planId: string; taskId: string; weighted: number; minutes: number }
	>();
	let relevantMinutes = 0;
	for (const segment of input.segments) {
		if (
			segment.goalRelevance !== "direct" &&
			segment.goalRelevance !== "supporting"
		) {
			continue;
		}
		const startedAtMs = Math.max(segment.startedAtMs, input.period.startedAtMs);
		const endedAtMs = Math.min(segment.endedAtMs, input.period.endedAtMs);
		if (endedAtMs <= startedAtMs) continue;
		const minutes = (endedAtMs - startedAtMs) / 60_000;
		relevantMinutes += minutes;
		for (const interval of intervals) {
			const overlapMs = overlapDurationMs(
				startedAtMs,
				endedAtMs,
				Date.parse(interval.start),
				Date.parse(interval.end),
			);
			if (overlapMs <= 0) continue;
			const overlapMinutes = overlapMs / 60_000;
			const key = `${interval.planId}\u0000${interval.taskId}`;
			const current = candidates.get(key) ?? {
				planId: interval.planId,
				taskId: interval.taskId,
				weighted: 0,
				minutes: 0,
			};
			current.minutes += overlapMinutes;
			current.weighted += overlapMinutes * segment.confidence;
			candidates.set(key, current);
		}
	}
	return {
		id: input.id,
		startedAt: new Date(input.period.startedAtMs).toISOString(),
		endedAt: new Date(input.period.endedAtMs).toISOString(),
		relevantMinutes: Math.round(relevantMinutes * 10) / 10,
		coverage,
		authorized: coverage !== "missing",
		candidates: [...candidates.values()]
			.map((candidate) => ({
				planId: candidate.planId,
				taskId: candidate.taskId,
				confidence:
					candidate.minutes === 0
						? 0
						: Math.max(0, Math.min(1, candidate.weighted / candidate.minutes)),
			}))
			.sort((left, right) =>
				left.planId === right.planId
					? left.taskId.localeCompare(right.taskId)
					: left.planId.localeCompare(right.planId),
			),
	};
}

export function scheduledTaskIntervals(
	plans: readonly PlanningPlan[],
): ScheduledTaskInterval[] {
	return plans.flatMap((plan) => {
		const active = plan.revisions.find(
			(revision) => revision.id === plan.activeRevisionId,
		);
		if (!active) return [];
		return active.schedule.map((item) => ({
			planId: plan.id,
			taskId: item.taskId,
			start: item.start,
			end: item.end,
		}));
	});
}

function classifyCoverage(
	coverage: TimelinePlanningInput["coverage"],
): "complete" | "partial" | "missing" {
	if (
		coverage.length === 0 ||
		coverage.includes("denied") ||
		coverage.includes("unavailable")
	) {
		return "missing";
	}
	return coverage.includes("redacted") ? "partial" : "complete";
}

function overlapDurationMs(
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
): number {
	if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite))
		return 0;
	return Math.max(
		0,
		Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart),
	);
}
