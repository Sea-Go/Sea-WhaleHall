from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence, TextIO

from .contracts import (
    ACTIVITY_LABELS,
    GOAL_RELEVANCE_LABELS,
    EventWindow,
    TeacherLabel,
    ValidationError,
    parse_teacher_label,
)
from .dataset import iter_jsonl, write_jsonl


def _stable_hash(value: str, seed: int) -> str:
    return hashlib.sha256(f"{seed}:{value}".encode("utf-8")).hexdigest()


def _window_stratum(window: EventWindow) -> tuple[str, str, str, str]:
    primary_app = window.metadata.get("primaryApp")
    if not isinstance(primary_app, str) or not primary_app:
        primary_app = window.events[0].source
    embedding_cluster = window.metadata.get("embeddingCluster", "<NO_CLUSTER>")
    return (
        window.trigger_reason,
        "goal" if window.has_goal else "no_goal",
        primary_app,
        str(embedding_cluster),
    )


def select_teacher_candidates(
    windows: Sequence[EventWindow],
    *,
    target: int = 300_000,
    seed: int = 17,
) -> tuple[EventWindow, ...]:
    """Select a deterministic, round-robin sample across behavior strata."""

    if target < 0:
        raise ValueError("target must be non-negative")
    if target >= len(windows):
        return tuple(sorted(windows, key=lambda window: window.window_id))
    strata: dict[tuple[str, str, str, str], list[EventWindow]] = defaultdict(list)
    for window in windows:
        strata[_window_stratum(window)].append(window)
    for values in strata.values():
        values.sort(
            key=lambda window: (
                _stable_hash(window.window_id, seed),
                window.window_id,
            )
        )

    selected: list[EventWindow] = []
    stratum_keys = sorted(
        strata,
        key=lambda key: (_stable_hash("|".join(key), seed), key),
    )
    indexes = {key: 0 for key in stratum_keys}
    while len(selected) < target:
        added = False
        for key in stratum_keys:
            index = indexes[key]
            values = strata[key]
            if index >= len(values):
                continue
            selected.append(values[index])
            indexes[key] = index + 1
            added = True
            if len(selected) == target:
                break
        if not added:
            break
    return tuple(sorted(selected, key=lambda window: window.window_id))


@dataclass(frozen=True)
class TeacherVote:
    pass_name: str
    label: TeacherLabel
    model_tag: str
    model_digest: str
    ollama_version: str
    parameter_size: str
    quantization_level: str
    prompt_version: str
    taxonomy_version: str


def parse_teacher_vote(value: object) -> TeacherVote:
    if not isinstance(value, Mapping):
        raise ValidationError("teacher vote must be an object")
    if value.get("schemaVersion") != "teacher-vote.v1":
        raise ValidationError("teacher vote schemaVersion must be teacher-vote.v1")
    pass_name = value.get("pass")
    if pass_name not in {"A", "B", "C"}:
        raise ValidationError("teacher vote pass must be A, B, or C")
    label_fields = {
        key: value.get(key)
        for key in (
            "windowId",
            "activity",
            "goalRelevance",
            "ambiguous",
            "reasonCodes",
        )
    }
    label = parse_teacher_label(label_fields)
    provenance_fields = (
        "modelTag",
        "modelDigest",
        "ollamaVersion",
        "parameterSize",
        "quantizationLevel",
        "promptVersion",
        "taxonomyVersion",
    )
    provenance: dict[str, str] = {}
    for field in provenance_fields:
        field_value = value.get(field)
        if not isinstance(field_value, str) or not field_value:
            raise ValidationError(f"teacher vote {field} must be a non-empty string")
        provenance[field] = field_value
    return TeacherVote(
        pass_name=pass_name,
        label=label,
        model_tag=provenance["modelTag"],
        model_digest=provenance["modelDigest"],
        ollama_version=provenance["ollamaVersion"],
        parameter_size=provenance["parameterSize"],
        quantization_level=provenance["quantizationLevel"],
        prompt_version=provenance["promptVersion"],
        taxonomy_version=provenance["taxonomyVersion"],
    )


def read_teacher_votes(stream: TextIO) -> tuple[TeacherVote, ...]:
    votes: list[TeacherVote] = []
    seen: set[tuple[str, str]] = set()
    for line_number, value in iter_jsonl(stream):
        try:
            vote = parse_teacher_vote(value)
        except ValidationError as error:
            raise ValidationError(f"line {line_number}: {error}") from error
        key = (vote.pass_name, vote.label.window_id)
        if key in seen:
            raise ValidationError(
                f"line {line_number}: duplicate pass/window teacher vote"
            )
        seen.add(key)
        votes.append(vote)
    return tuple(votes)


def _number(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    if not math.isfinite(float(value)):
        return default
    return float(value)


@dataclass(frozen=True)
class HighRiskSelection:
    windows: tuple[EventWindow, ...]
    selection_reasons: Mapping[str, str]
    quota_counts: Mapping[str, int]


_HIGH_RISK_MIX = {
    "student_uncertainty": 0.35,
    "teacher_student_disagreement": 0.25,
    "rare_and_sparse": 0.20,
    "ood_novelty": 0.10,
    "random_audit": 0.10,
}


def _allocate_quotas(target: int, mix: Mapping[str, float]) -> dict[str, int]:
    raw = {name: target * fraction for name, fraction in mix.items()}
    quotas = {name: int(math.floor(value)) for name, value in raw.items()}
    remaining = target - sum(quotas.values())
    order = sorted(
        mix,
        key=lambda name: (-(raw[name] - quotas[name]), name),
    )
    for name in order[:remaining]:
        quotas[name] += 1
    return quotas


def select_high_risk_windows(
    windows: Sequence[EventWindow],
    pass_a_votes: Sequence[TeacherVote],
    *,
    target: int = 100_000,
    seed: int = 29,
    mix: Mapping[str, float] = _HIGH_RISK_MIX,
) -> HighRiskSelection:
    """Build the B/C pool with fixed 35/25/20/10/10 selection quotas."""

    if target < 0:
        raise ValueError("target must be non-negative")
    if not math.isclose(sum(mix.values()), 1.0, abs_tol=1e-9):
        raise ValueError("high-risk mix must sum to 1.0")
    by_window = {window.window_id: window for window in windows}
    pass_a = {
        vote.label.window_id: vote
        for vote in pass_a_votes
        if vote.pass_name == "A" and vote.label.window_id in by_window
    }
    pass_a_provenance = {
        (
            vote.model_tag,
            vote.model_digest,
            vote.ollama_version,
            vote.parameter_size,
            vote.quantization_level,
            vote.prompt_version,
            vote.taxonomy_version,
        )
        for vote in pass_a.values()
    }
    if len(pass_a_provenance) > 1:
        raise ValueError(
            "pass A votes mix model, Ollama, prompt, or taxonomy versions"
        )
    if set(by_window) - set(pass_a):
        raise ValueError("every candidate window requires a pass A vote")
    effective_target = min(target, len(windows))
    quotas = _allocate_quotas(effective_target, mix)
    activity_counts = Counter(vote.label.activity for vote in pass_a.values())

    def uncertainty(window: EventWindow) -> float:
        entropy = _number(window.metadata.get("studentEntropy"))
        margin = _number(window.metadata.get("studentMargin"), 1.0)
        return entropy + (1.0 - max(0.0, min(margin, 1.0)))

    def disagreement(window: EventWindow) -> float:
        vote = pass_a[window.window_id]
        activity = window.metadata.get("studentActivity")
        relevance = window.metadata.get("studentGoalRelevance")
        return (
            (
                1.0
                if isinstance(activity, str)
                and activity != vote.label.activity
                else 0.0
            )
            + (
                1.0
                if window.has_goal
                and isinstance(relevance, str)
                and relevance != vote.label.goal_relevance
                else 0.0
            )
            + 0.1 * uncertainty(window)
        )

    def rare_sparse(window: EventWindow) -> float:
        vote = pass_a[window.window_id]
        rarity = 1.0 / max(activity_counts[vote.label.activity], 1)
        sparse = 1.0 if window.trigger_reason == "max_wait" else 0.0
        no_goal = 0.5 if not window.has_goal else 0.0
        ambiguity = 0.5 if vote.label.ambiguous else 0.0
        return rarity * len(windows) + sparse + no_goal + ambiguity

    score_functions = {
        "student_uncertainty": uncertainty,
        "teacher_student_disagreement": disagreement,
        "rare_and_sparse": rare_sparse,
        "ood_novelty": lambda window: _number(
            window.metadata.get("oodScore"),
            _number(window.metadata.get("noveltyScore")),
        ),
        "random_audit": lambda window: 0.0,
    }
    ranked: dict[str, list[EventWindow]] = {}
    for reason, score_function in score_functions.items():
        if reason == "random_audit":
            ranked[reason] = sorted(
                windows,
                key=lambda window: (
                    _stable_hash(window.window_id, seed),
                    window.window_id,
                ),
            )
        else:
            ranked[reason] = sorted(
                windows,
                key=lambda window: (
                    -score_function(window),
                    _stable_hash(window.window_id, seed),
                    window.window_id,
                ),
            )

    selected: dict[str, EventWindow] = {}
    reasons: dict[str, str] = {}
    actual_counts = {reason: 0 for reason in mix}
    for reason in mix:
        for window in ranked[reason]:
            if len(selected) == effective_target:
                break
            if actual_counts[reason] >= quotas[reason]:
                break
            if window.window_id in selected:
                continue
            selected[window.window_id] = window
            reasons[window.window_id] = reason
            actual_counts[reason] += 1

    if len(selected) < effective_target:
        fallback = sorted(
            windows,
            key=lambda window: (
                -max(
                    uncertainty(window),
                    disagreement(window),
                    rare_sparse(window),
                    _number(window.metadata.get("oodScore")),
                ),
                _stable_hash(window.window_id, seed),
                window.window_id,
            ),
        )
        for window in fallback:
            if window.window_id in selected:
                continue
            selected[window.window_id] = window
            reasons[window.window_id] = "quota_backfill"
            if len(selected) == effective_target:
                break

    return HighRiskSelection(
        windows=tuple(sorted(selected.values(), key=lambda window: window.window_id)),
        selection_reasons=dict(sorted(reasons.items())),
        quota_counts=actual_counts,
    )


@dataclass(frozen=True)
class AggregatedWeakLabel:
    window_id: str
    status: str
    activity: str | None
    goal_relevance: str | None
    activity_distribution: Mapping[str, float]
    relevance_distribution: Mapping[str, float]
    weight: float
    vote_count: int
    agreement_count: int
    ambiguous: bool
    reason_codes: tuple[str, ...]
    trigger_reason: str
    has_goal: bool

    def as_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": "weak-label.v1",
            "windowId": self.window_id,
            "status": self.status,
            "activity": self.activity,
            "goalRelevance": self.goal_relevance,
            "activityDistribution": dict(self.activity_distribution),
            "relevanceDistribution": dict(self.relevance_distribution),
            "weight": self.weight,
            "voteCount": self.vote_count,
            "agreementCount": self.agreement_count,
            "ambiguous": self.ambiguous,
            "reasonCodes": list(self.reason_codes),
            "triggerReason": self.trigger_reason,
            "hasGoal": self.has_goal,
        }


def parse_aggregated_weak_label(value: object) -> AggregatedWeakLabel:
    if not isinstance(value, Mapping):
        raise ValidationError("weak label must be an object")
    if value.get("schemaVersion") != "weak-label.v1":
        raise ValidationError("weak label schemaVersion must be weak-label.v1")
    status = value.get("status")
    if status not in {
        "accepted_single",
        "accepted_majority",
        "human_review",
        "pending_arbitration",
        "missing_pass_a",
        "invalid_pass_set",
    }:
        raise ValidationError("weak label has an unknown status")
    activity = value.get("activity")
    relevance = value.get("goalRelevance")
    if activity is not None and activity not in ACTIVITY_LABELS:
        raise ValidationError("weak label activity is outside the v1 taxonomy")
    if relevance is not None and relevance not in GOAL_RELEVANCE_LABELS:
        raise ValidationError(
            "weak label goalRelevance is outside the v1 taxonomy"
        )
    activity_distribution_value = value.get("activityDistribution")
    relevance_distribution_value = value.get("relevanceDistribution")
    if not isinstance(activity_distribution_value, Mapping):
        raise ValidationError("activityDistribution must be an object")
    if not isinstance(relevance_distribution_value, Mapping):
        raise ValidationError("relevanceDistribution must be an object")
    reason_codes_value = value.get("reasonCodes")
    if not isinstance(reason_codes_value, list) or not all(
        isinstance(reason, str) for reason in reason_codes_value
    ):
        raise ValidationError("reasonCodes must be an array of strings")
    has_goal = value.get("hasGoal")
    if not isinstance(has_goal, bool):
        raise ValidationError("hasGoal must be boolean")
    return AggregatedWeakLabel(
        window_id=str(value["windowId"]),
        status=str(status),
        activity=None if activity is None else str(activity),
        goal_relevance=None if relevance is None else str(relevance),
        activity_distribution={
            label: float(activity_distribution_value.get(label, 0.0))
            for label in ACTIVITY_LABELS
        },
        relevance_distribution={
            label: float(relevance_distribution_value.get(label, 0.0))
            for label in GOAL_RELEVANCE_LABELS
        },
        weight=float(value["weight"]),
        vote_count=int(value["voteCount"]),
        agreement_count=int(value["agreementCount"]),
        ambiguous=bool(value["ambiguous"]),
        reason_codes=tuple(reason_codes_value),
        trigger_reason=str(value["triggerReason"]),
        has_goal=has_goal,
    )


def read_aggregated_weak_labels(
    stream: TextIO,
) -> tuple[AggregatedWeakLabel, ...]:
    labels = []
    seen: set[str] = set()
    for line_number, value in iter_jsonl(stream):
        try:
            label = parse_aggregated_weak_label(value)
        except (KeyError, TypeError, ValueError, ValidationError) as error:
            raise ValidationError(f"line {line_number}: {error}") from error
        if label.window_id in seen:
            raise ValidationError(
                f"line {line_number}: duplicate weak-label windowId"
            )
        seen.add(label.window_id)
        labels.append(label)
    return tuple(labels)


def _distribution(
    labels: Iterable[str | None],
    classes: Sequence[str],
) -> dict[str, float]:
    values = [label for label in labels if label is not None]
    counts = Counter(values)
    total = len(values)
    if total == 0:
        return {label: 0.0 for label in classes}
    return {label: counts[label] / total for label in classes}


def aggregate_teacher_votes(
    windows: Sequence[EventWindow],
    votes: Sequence[TeacherVote],
    *,
    high_risk_window_ids: set[str] | None = None,
    single_weight: float = 0.35,
    ambiguous_single_weight: float = 0.25,
    majority_weight: float = 0.8,
) -> tuple[AggregatedWeakLabel, ...]:
    by_window = {window.window_id: window for window in windows}
    provenance = {
        (
            vote.model_tag,
            vote.model_digest,
            vote.ollama_version,
            vote.parameter_size,
            vote.quantization_level,
            vote.prompt_version,
            vote.taxonomy_version,
        )
        for vote in votes
    }
    if len(provenance) > 1:
        raise ValueError(
            "teacher votes mix model, Ollama, prompt, or taxonomy versions"
        )
    grouped: dict[str, list[TeacherVote]] = defaultdict(list)
    for vote in votes:
        if vote.label.window_id not in by_window:
            raise ValueError(f"vote references unknown window {vote.label.window_id}")
        grouped[vote.label.window_id].append(vote)
    high_risk = high_risk_window_ids or set()
    results: list[AggregatedWeakLabel] = []

    for window_id in sorted(by_window):
        window = by_window[window_id]
        window_votes = sorted(grouped.get(window_id, ()), key=lambda item: item.pass_name)
        pass_names = [vote.pass_name for vote in window_votes]
        if len(set(pass_names)) != len(pass_names):
            raise ValueError(f"{window_id} has duplicate teacher passes")
        if not window_votes or "A" not in pass_names:
            status = "missing_pass_a"
            winner: tuple[str, str | None] | None = None
            agreement_count = 0
            weight = 0.0
        elif window_id in high_risk and set(pass_names) != {"A", "B", "C"}:
            status = "pending_arbitration"
            winner = None
            agreement_count = 0
            weight = 0.0
        elif len(window_votes) == 1:
            status = "accepted_single"
            label = window_votes[0].label
            winner = (label.activity, label.goal_relevance)
            agreement_count = 1
            weight = (
                ambiguous_single_weight if label.ambiguous else single_weight
            )
        elif set(pass_names) == {"A", "B", "C"}:
            pairs = [
                (vote.label.activity, vote.label.goal_relevance)
                for vote in window_votes
            ]
            pair_counts = Counter(pairs)
            winner, agreement_count = min(
                pair_counts.items(),
                key=lambda item: (-item[1], item[0][0], str(item[0][1])),
            )
            if agreement_count >= 2:
                status = "accepted_majority"
                weight = majority_weight
            else:
                status = "human_review"
                winner = None
                weight = 0.0
        else:
            status = "invalid_pass_set"
            winner = None
            agreement_count = 0
            weight = 0.0

        labels = [vote.label for vote in window_votes]
        results.append(
            AggregatedWeakLabel(
                window_id=window_id,
                status=status,
                activity=winner[0] if winner else None,
                goal_relevance=winner[1] if winner else None,
                activity_distribution=_distribution(
                    (label.activity for label in labels), ACTIVITY_LABELS
                ),
                relevance_distribution=_distribution(
                    (label.goal_relevance for label in labels),
                    GOAL_RELEVANCE_LABELS,
                ),
                weight=weight,
                vote_count=len(window_votes),
                agreement_count=agreement_count,
                ambiguous=any(label.ambiguous for label in labels),
                reason_codes=tuple(
                    sorted(
                        {
                            reason
                            for label in labels
                            for reason in label.reason_codes
                        }
                    )
                ),
                trigger_reason=window.trigger_reason,
                has_goal=window.has_goal,
            )
        )
    return tuple(results)


def select_weak_training_set(
    labels: Sequence[AggregatedWeakLabel],
    *,
    target: int = 250_000,
    per_activity_minimum: int = 10_000,
    per_activity_maximum: int = 35_000,
    per_relevance_minimum: int = 25_000,
    event_count_fraction: float = 0.55,
    max_wait_fraction: float = 0.30,
    boundary_fraction: float = 0.15,
    no_goal_fraction: float = 0.25,
    seed: int = 43,
) -> tuple[AggregatedWeakLabel, ...]:
    """Select an exact-size weak set while enforcing hard label minima/maxima."""

    accepted = [
        label
        for label in labels
        if label.status in {"accepted_single", "accepted_majority"}
        and label.activity is not None
    ]
    if len(accepted) < target:
        raise ValueError(
            f"only {len(accepted)} accepted weak labels; {target} required"
        )
    by_activity: dict[str, list[AggregatedWeakLabel]] = defaultdict(list)
    for label in accepted:
        by_activity[label.activity or ""].append(label)
    for activity in ACTIVITY_LABELS:
        if len(by_activity[activity]) < per_activity_minimum:
            raise ValueError(
                f"{activity} has {len(by_activity[activity])} accepted labels; "
                f"{per_activity_minimum} required"
            )
    ordered = sorted(
        accepted,
        key=lambda label: (
            _stable_hash(label.window_id, seed),
            label.window_id,
        ),
    )
    selected: dict[str, AggregatedWeakLabel] = {}
    activity_counts: Counter[str] = Counter()
    relevance_counts: Counter[str] = Counter()
    trigger_counts: Counter[str] = Counter()
    no_goal_count = 0

    trigger_mix = {
        "event_count": event_count_fraction,
        "max_wait": max_wait_fraction,
        "boundary": boundary_fraction,
    }
    if not math.isclose(sum(trigger_mix.values()), 1.0, abs_tol=1e-9):
        raise ValueError("weak-label trigger fractions must sum to 1.0")
    if not 0.0 <= no_goal_fraction <= 1.0:
        raise ValueError("no_goal_fraction must be between 0 and 1")
    trigger_targets = _allocate_quotas(target, trigger_mix)
    no_goal_target = math.ceil(target * no_goal_fraction)

    def trigger_group(label: AggregatedWeakLabel) -> str:
        if label.trigger_reason in {"goal_boundary", "presence_boundary"}:
            return "boundary"
        return label.trigger_reason

    def add(label: AggregatedWeakLabel) -> bool:
        nonlocal no_goal_count
        activity = label.activity
        if activity is None or label.window_id in selected:
            return False
        if activity_counts[activity] >= per_activity_maximum:
            return False
        trigger = trigger_group(label)
        if trigger not in trigger_targets:
            return False
        if trigger_counts[trigger] >= trigger_targets[trigger]:
            return False
        selected[label.window_id] = label
        activity_counts[activity] += 1
        trigger_counts[trigger] += 1
        if not label.has_goal:
            no_goal_count += 1
        if label.goal_relevance is not None:
            relevance_counts[label.goal_relevance] += 1
        return True

    for label in (item for item in ordered if not item.has_goal):
        add(label)
        if no_goal_count >= no_goal_target:
            break
    if no_goal_count < no_goal_target:
        raise ValueError(
            f"only {no_goal_count} no-goal labels can satisfy trigger/activity "
            f"caps; {no_goal_target} required"
        )

    for activity in ACTIVITY_LABELS:
        for label in (item for item in ordered if item.activity == activity):
            add(label)
            if activity_counts[activity] >= per_activity_minimum:
                break

    for relevance in GOAL_RELEVANCE_LABELS:
        for label in (
            item for item in ordered if item.goal_relevance == relevance
        ):
            add(label)
            if relevance_counts[relevance] >= per_relevance_minimum:
                break
        if relevance_counts[relevance] < per_relevance_minimum:
            raise ValueError(
                f"{relevance} has only {relevance_counts[relevance]} selected "
                f"labels; {per_relevance_minimum} required"
            )

    for trigger in ("event_count", "max_wait", "boundary"):
        for label in (
            item for item in ordered if trigger_group(item) == trigger
        ):
            add(label)
            if trigger_counts[trigger] >= trigger_targets[trigger]:
                break
        if trigger_counts[trigger] < trigger_targets[trigger]:
            raise ValueError(
                f"{trigger} can supply only {trigger_counts[trigger]} labels "
                f"under other caps; {trigger_targets[trigger]} required"
            )
    if len(selected) != target:
        raise ValueError(
            f"activity caps allow only {len(selected)} labels; target is {target}"
        )
    counts = [activity_counts[activity] for activity in ACTIVITY_LABELS]
    nonzero_counts = [count for count in counts if count]
    if max(nonzero_counts) / min(nonzero_counts) > 3.5:
        raise ValueError("selected activity ratio exceeds 3.5:1")
    return tuple(sorted(selected.values(), key=lambda label: label.window_id))


def write_aggregated_labels(
    path: Path,
    labels: Sequence[AggregatedWeakLabel],
) -> None:
    write_jsonl(path, (label.as_dict() for label in labels))


def balance_audit(labels: Sequence[AggregatedWeakLabel]) -> dict[str, object]:
    accepted = [
        label
        for label in labels
        if label.status in {"accepted_single", "accepted_majority"}
    ]
    activities = Counter(label.activity for label in accepted)
    relevances = Counter(label.goal_relevance for label in accepted)
    triggers = Counter(label.trigger_reason for label in accepted)
    boundary_count = (
        triggers["goal_boundary"] + triggers["presence_boundary"]
    )
    no_goal = sum(not label.has_goal for label in accepted)
    total = len(accepted)
    return {
        "accepted": total,
        "activityCounts": {
            activity: activities[activity] for activity in ACTIVITY_LABELS
        },
        "relevanceCounts": {
            relevance: relevances[relevance]
            for relevance in GOAL_RELEVANCE_LABELS
        },
        "triggerCounts": dict(sorted(triggers.items())),
        "triggerFractions": {
            "event_count": triggers["event_count"] / total if total else 0.0,
            "max_wait": triggers["max_wait"] / total if total else 0.0,
            "boundary": boundary_count / total if total else 0.0,
        },
        "noGoalFraction": no_goal / total if total else 0.0,
        "humanReview": sum(label.status == "human_review" for label in labels),
        "pending": sum(
            label.status == "pending_arbitration" for label in labels
        ),
    }


def materialize_student_examples(
    windows: Sequence[EventWindow],
    weak_labels: Sequence[AggregatedWeakLabel] = (),
) -> tuple[dict[str, object], ...]:
    """Join immutable windows with gold or accepted weak supervision."""

    weak_by_id = {label.window_id: label for label in weak_labels}
    if len(weak_by_id) != len(weak_labels):
        raise ValueError("weak labels contain duplicate windowId values")
    examples: list[dict[str, object]] = []
    for window in sorted(windows, key=lambda item: item.window_id):
        if window.gold is not None:
            activity = window.gold.activity
            relevance = window.gold.goal_relevance
            activity_distribution = {
                label: float(label == activity) for label in ACTIVITY_LABELS
            }
            relevance_distribution = {
                label: float(label == relevance)
                for label in GOAL_RELEVANCE_LABELS
            }
            weight = 1.0
            supervision = "gold"
        else:
            weak = weak_by_id.get(window.window_id)
            if (
                weak is None
                or weak.status not in {"accepted_single", "accepted_majority"}
                or weak.activity is None
            ):
                continue
            activity = weak.activity
            relevance = weak.goal_relevance
            activity_distribution = dict(weak.activity_distribution)
            relevance_distribution = dict(weak.relevance_distribution)
            weight = weak.weight
            supervision = "weak"
        examples.append(
            {
                "schemaVersion": "student-example.v1",
                "exampleId": window.window_id,
                "goalText": window.goal.text if window.goal else None,
                "modelInput": window.model_input,
                "activity": activity,
                "goalRelevance": relevance,
                "activityDistribution": activity_distribution,
                "relevanceDistribution": relevance_distribution,
                "weight": weight,
                "supervision": supervision,
                "participantId": window.participant_id,
                "deviceId": window.device_id,
                "projectGoalId": window.project_goal_id,
                "sessionId": window.session_id,
                "sessionDate": window.session_date,
                "triggerReason": window.trigger_reason,
            }
        )
    return tuple(examples)
