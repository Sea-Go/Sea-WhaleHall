import { canonicalJson, type ReflectionHasher } from "../reflection/hash";
import type { ActiveGoalContextV1 } from "../reflection/types";
import { mergeCoverage } from "./evidence";
import type { TimelineHypothesisGenerator } from "./hypothesis";
import {
	ACTIVITY_EPISODE_SCHEMA_VERSION,
	type ActivityEpisodeV2,
	type EpisodeClassificationV2,
	type EvidenceAnchorV2,
	type EvidenceFactV2,
	type TimelineWindowV2,
} from "./types";

export const EPISODE_INACTIVITY_BOUNDARY_MS = 30_000;
export const EPISODE_BRIEF_DETOUR_MS = 10_000;
export const EPISODE_CROSS_WINDOW_GAP_MS = 90_000;
export const EPISODE_CROSS_WINDOW_SIMILARITY = 0.8;
export const EPISODE_MAX_PRIMARY_SEGMENTS = 8;

export interface TimelineEpisodeClassifier {
	classify(
		facts: readonly EvidenceFactV2[],
		goal: ActiveGoalContextV1 | null,
	): Promise<EpisodeClassificationV2>;
}

export interface EpisodeSemanticSimilarity {
	compare(
		previous: ActivityEpisodeV2,
		currentFacts: readonly EvidenceFactV2[],
	): Promise<number>;
}

export type EpisodeAssemblerOptions = {
	hasher: ReflectionHasher;
	classifier?: TimelineEpisodeClassifier;
	hypotheses: TimelineHypothesisGenerator;
	similarity?: EpisodeSemanticSimilarity;
};

type FactSegment = {
	facts: EvidenceFactV2[];
	supportingFactIds: Set<string>;
};

export class DeterministicEpisodeAssembler {
	private readonly hasher: ReflectionHasher;
	private readonly classifier: TimelineEpisodeClassifier;
	private readonly hypotheses: TimelineHypothesisGenerator;
	private readonly similarity: EpisodeSemanticSimilarity | null;

	constructor(options: EpisodeAssemblerOptions) {
		this.hasher = options.hasher;
		this.classifier =
			options.classifier ?? new HeuristicTimelineEpisodeClassifier();
		this.hypotheses = options.hypotheses;
		this.similarity = options.similarity ?? null;
	}

	async assemble(
		window: TimelineWindowV2,
		facts: readonly EvidenceFactV2[],
		previousEpisode: ActivityEpisodeV2 | null,
	): Promise<ActivityEpisodeV2[]> {
		const segments = segmentFacts(facts);
		const episodes: ActivityEpisodeV2[] = [];
		for (let index = 0; index < segments.length; index += 1) {
			const segment = segments[index];
			if (!segment) continue;
			const classificationFacts = segment.facts.filter(
				(fact) => !segment.supportingFactIds.has(fact.factId),
			);
			const classification = await this.classifier.classify(
				classificationFacts.length > 0
					? classificationFacts
					: segment.facts,
				window.goal,
			);
			const anchor = segmentAnchor(segment.facts);
			const evidenceFactIds = segment.facts
				.filter(
					(fact) =>
						fact.role === "primary" &&
						!segment.supportingFactIds.has(fact.factId),
				)
				.map((fact) => fact.factId);
			const supportingFactIds = segment.facts
				.filter(
					(fact) =>
						fact.role !== "primary" ||
						segment.supportingFactIds.has(fact.factId),
				)
				.map((fact) => fact.factId);
			if (evidenceFactIds.length === 0 && supportingFactIds.length > 0) {
				const promoted = supportingFactIds.shift();
				if (promoted) evidenceFactIds.push(promoted);
			}
			const startedAtMs = Math.min(
				...segment.facts.map((fact) => fact.startedAtMs),
			);
			const endedAtMs = Math.max(
				...segment.facts.map((fact) => fact.endedAtMs),
			);
			const canContinue =
				index === 0 &&
				previousEpisode !== null &&
				(await this.shouldContinue(
					previousEpisode,
					segment.facts,
					anchor,
					window.goalVersion,
					startedAtMs,
				));
			const episodeId = canContinue
				? previousEpisode.episodeId
				: `episode_${await this.hasher.sha256(
						canonicalJson({
							deviceId: window.deviceId,
							sessionId: window.sessionId,
							goalVersion: window.goalVersion,
							firstFactId:
								evidenceFactIds[0] ??
								supportingFactIds[0],
						}),
					)}`;
			const revision = canContinue
				? previousEpisode.revision + 1
				: 1;
			const revisionId = `episode_revision_${await this.hasher.sha256(
				canonicalJson({
					episodeId,
					revision,
					windowId: window.windowId,
					evidenceFactIds,
					supportingFactIds,
				}),
			)}`;
			episodes.push({
				schemaVersion: ACTIVITY_EPISODE_SCHEMA_VERSION,
				episodeId,
				revisionId,
				revision,
				supersedesRevisionId: canContinue
					? previousEpisode.revisionId
					: null,
				sourceWindowIds: canContinue
					? unique([
							...previousEpisode.sourceWindowIds,
							window.windowId,
						])
					: [window.windowId],
				startedAtMs: canContinue
					? Math.min(previousEpisode.startedAtMs, startedAtMs)
					: startedAtMs,
				endedAtMs: canContinue
					? Math.max(previousEpisode.endedAtMs, endedAtMs)
					: endedAtMs,
				goalVersion: window.goalVersion,
				anchor,
				classification,
				hypothesis: {
					text: "可能在进行当前可见操作",
					citedFactIds: evidenceFactIds.slice(0, 1),
					generator: "deterministic-template.v2",
				},
				evidenceFactIds: canContinue
					? unique([
							...previousEpisode.evidenceFactIds,
							...evidenceFactIds,
						])
					: evidenceFactIds,
				supportingFactIds: canContinue
					? unique([
							...previousEpisode.supportingFactIds,
							...supportingFactIds,
						])
					: supportingFactIds,
				coverage: mergeCoverage(
					segment.facts.map((fact) => fact.coverage),
				),
			});
		}
		const hypotheses = await this.hypotheses.generate(
			episodes,
			facts,
			window.goal,
		);
		for (const episode of episodes) {
			const hypothesis = hypotheses.get(episode.episodeId);
			if (hypothesis) episode.hypothesis = hypothesis;
		}
		return episodes;
	}

	private async shouldContinue(
		previous: ActivityEpisodeV2,
		facts: readonly EvidenceFactV2[],
		anchor: EvidenceAnchorV2,
		goalVersion: number | null,
		startedAtMs: number,
	): Promise<boolean> {
		const gapMs = startedAtMs - previous.endedAtMs;
		if (
			(gapMs < 0 && startedAtMs < previous.startedAtMs) ||
			gapMs > EPISODE_CROSS_WINDOW_GAP_MS ||
			previous.goalVersion !== goalVersion
		) {
			return false;
		}
		if (sameAnchor(previous.anchor, anchor)) return true;
		if (!this.similarity) return false;
		const similarity = await this.similarity.compare(previous, facts);
		return (
			Number.isFinite(similarity) &&
			similarity >= EPISODE_CROSS_WINDOW_SIMILARITY
		);
	}
}

export class HeuristicTimelineEpisodeClassifier
	implements TimelineEpisodeClassifier
{
	async classify(
		facts: readonly EvidenceFactV2[],
		goal: ActiveGoalContextV1 | null,
	): Promise<EpisodeClassificationV2> {
		const appCorpus = facts
			.flatMap((fact) => [
				fact.templateArgs.appName,
				fact.templateArgs.appId,
			])
			.filter((value): value is string => typeof value === "string")
			.join(" ")
			.toLowerCase();
		const browserFacts = facts.filter(
			(fact) => fact.templateCode === "browser.visible_page",
		);
		const browserMetadata = browserFacts
			.flatMap((fact) => [
				fact.templateArgs.title,
				fact.templateArgs.url,
				fact.templateArgs.domain,
			])
			.filter((value): value is string => typeof value === "string")
			.join(" ")
			.toLowerCase();
		let activity: EpisodeClassificationV2["activity"] = "other_unknown";
		if (
			facts.some((fact) => fact.templateCode === "presence.changed")
		) {
			activity = "idle_transition";
		} else if (
			/(visual studio code|vscode|xcode|terminal|iterm|code editor)/u.test(
				appCorpus,
			)
		) {
			activity = "development";
		} else if (
			/(飞书|feishu|lark|qq|微信|wechat|slack|teams|messages)/u.test(
				appCorpus,
			)
		) {
			activity = "communication";
		} else if (
			/(网易云|music|spotify|vlc|quicktime|media player)/u.test(
				appCorpus,
			)
		) {
			activity = "media";
		} else if (
			/(^|\s)(finder|访达|system settings|系统设置)(\s|$)/u.test(
				appCorpus,
			)
		) {
			activity = "system_file_ops";
		} else if (browserFacts.length > 0) {
			if (
				/(github|gitlab|stackoverflow|developer\.|localhost|127\.0\.0\.1)/u.test(
					browserMetadata,
				)
			) {
				activity = "development";
			} else if (
				/(mail\.|gmail|outlook|slack|teams|feishu|lark|qq\.com)/u.test(
					browserMetadata,
				)
			) {
				activity = "communication";
			} else if (
				/(youtube|bilibili|spotify|music|video)/u.test(
					browserMetadata,
				)
			) {
				activity = "media";
			} else if (
				/(amazon|taobao|tmall|jd\.com|shop|checkout|cart)/u.test(
					browserMetadata,
				)
			) {
				activity = "commerce";
			} else {
				activity = "research";
			}
		} else if (
			facts.some((fact) => fact.templateCode === "application.text_value")
		) {
			activity = "writing";
		}
		const uncertain = activity === "other_unknown";
		return {
			activity,
			goalRelevance: goal ? "uncertain" : null,
			confidence: uncertain ? 0.35 : 0.6,
			oodScore: uncertain ? 0.9 : 0.45,
			abstain: uncertain,
			modelVersion: "deterministic-cold-start.v2",
		};
	}
}

function segmentFacts(facts: readonly EvidenceFactV2[]): FactSegment[] {
	const ordered = [...facts].sort(
		(left, right) =>
			left.startedAtMs - right.startedAtMs ||
			left.factId.localeCompare(right.factId),
	);
	const segments: FactSegment[] = [];
	let current: FactSegment | null = null;
	let index = 0;
	while (index < ordered.length) {
		const fact = ordered[index];
		if (!fact) {
			index += 1;
			continue;
		}
		if (fact.role === "boundary") {
			if (current) segments.push(current);
			current = null;
			index += 1;
			continue;
		}
		if (!current) {
			current = { facts: [fact], supportingFactIds: new Set() };
			index += 1;
			continue;
		}
		const previous = current.facts.at(-1);
		if (
			previous &&
			fact.startedAtMs - previous.endedAtMs >=
				EPISODE_INACTIVITY_BOUNDARY_MS
		) {
			segments.push(current);
			current = { facts: [fact], supportingFactIds: new Set() };
			index += 1;
			continue;
		}
		const currentAnchor = segmentAnchor(current.facts);
		if (
			fact.role === "primary" &&
			hasAnchor(currentAnchor) &&
			hasAnchor(fact.anchor) &&
			!sameAnchor(currentAnchor, fact.anchor)
		) {
			const returnedAt = findBriefReturn(
				ordered,
				index,
				currentAnchor,
				fact.startedAtMs,
			);
			if (returnedAt !== null) {
				for (let detour = index; detour < returnedAt; detour += 1) {
					const supporting = ordered[detour];
					if (!supporting || supporting.role === "boundary") break;
					current.facts.push(supporting);
					current.supportingFactIds.add(supporting.factId);
				}
				index = returnedAt;
				continue;
			}
			segments.push(current);
			current = { facts: [fact], supportingFactIds: new Set() };
			index += 1;
			continue;
		}
		current.facts.push(fact);
		index += 1;
	}
	if (current) segments.push(current);
	return collapseOverflowSegments(
		segments.filter((segment) => segment.facts.length > 0),
		EPISODE_MAX_PRIMARY_SEGMENTS,
	);
}

function collapseOverflowSegments(
	input: readonly FactSegment[],
	limit: number,
): FactSegment[] {
	const segments = input.map((segment) => ({
		facts: [...segment.facts],
		supportingFactIds: new Set(segment.supportingFactIds),
	}));
	while (segments.length > limit) {
		let selectedIndex = 0;
		for (let index = 1; index < segments.length; index += 1) {
			const candidate = segments[index];
			const selected = segments[selectedIndex];
			if (
				candidate &&
				selected &&
				segmentDuration(candidate) < segmentDuration(selected)
			) {
				selectedIndex = index;
			}
		}
		const selected = segments[selectedIndex];
		if (!selected) break;
		const previous = segments[selectedIndex - 1];
		const next = segments[selectedIndex + 1];
		const mergeIntoPrevious =
			previous !== undefined &&
			(next === undefined ||
				sameAnchor(
					segmentAnchor(previous.facts),
					segmentAnchor(selected.facts),
				) ||
				!sameAnchor(
					segmentAnchor(next.facts),
					segmentAnchor(selected.facts),
				));
		const targetIndex = mergeIntoPrevious
			? selectedIndex - 1
			: selectedIndex + 1;
		const target = segments[targetIndex];
		if (!target) break;
		for (const fact of selected.facts) {
			target.supportingFactIds.add(fact.factId);
		}
		for (const factId of selected.supportingFactIds) {
			target.supportingFactIds.add(factId);
		}
		target.facts = [...target.facts, ...selected.facts].sort(
			(left, right) =>
				left.startedAtMs - right.startedAtMs ||
				left.factId.localeCompare(right.factId),
		);
		segments.splice(selectedIndex, 1);
	}
	return segments;
}

function segmentDuration(segment: FactSegment): number {
	const startedAtMs = Math.min(
		...segment.facts.map((fact) => fact.startedAtMs),
	);
	const endedAtMs = Math.max(
		...segment.facts.map((fact) => fact.endedAtMs),
	);
	return Math.max(0, endedAtMs - startedAtMs);
}

function findBriefReturn(
	facts: readonly EvidenceFactV2[],
	fromIndex: number,
	anchor: EvidenceAnchorV2,
	detourStartedAtMs: number,
): number | null {
	for (let index = fromIndex + 1; index < facts.length; index += 1) {
		const fact = facts[index];
		if (!fact || fact.role === "boundary") return null;
		if (fact.startedAtMs - detourStartedAtMs > EPISODE_BRIEF_DETOUR_MS) {
			return null;
		}
		if (fact.role === "primary" && sameAnchor(fact.anchor, anchor)) {
			return index;
		}
	}
	return null;
}

function segmentAnchor(facts: readonly EvidenceFactV2[]): EvidenceAnchorV2 {
	const candidates = facts.filter((fact) => hasAnchor(fact.anchor));
	const primary = candidates.filter((fact) => fact.role === "primary");
	const selected = (primary.length > 0 ? primary : candidates)
		.map((fact, index) => ({
			fact,
			index,
			specificity: anchorSpecificity(fact.anchor),
		}))
		.sort(
			(left, right) =>
				right.specificity - left.specificity ||
				right.index - left.index,
		)[0]?.fact;
	return (
		selected?.anchor ?? {
			appId: null,
			windowId: null,
			documentId: null,
			pageId: null,
		}
	);
}

function sameAnchor(
	left: EvidenceAnchorV2,
	right: EvidenceAnchorV2,
): boolean {
	return (
		compatibleAnchorPart(left.appId, right.appId) &&
		compatibleAnchorPart(left.windowId, right.windowId) &&
		compatibleAnchorPart(left.documentId, right.documentId) &&
		compatibleAnchorPart(left.pageId, right.pageId)
	);
}

function compatibleAnchorPart(
	left: string | null,
	right: string | null,
): boolean {
	return left === null || right === null || left === right;
}

function anchorSpecificity(anchor: EvidenceAnchorV2): number {
	return [
		anchor.appId,
		anchor.windowId,
		anchor.documentId,
		anchor.pageId,
	].filter((value) => value !== null).length;
}

function hasAnchor(anchor: EvidenceAnchorV2): boolean {
	return (
		anchor.appId !== null ||
		anchor.windowId !== null ||
		anchor.documentId !== null ||
		anchor.pageId !== null
	);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
