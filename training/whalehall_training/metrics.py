from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Mapping, Sequence

from .contracts import (
    ACTIVITY_LABELS,
    GOAL_RELEVANCE_LABELS,
    EventWindow,
)
from .pipeline import AggregatedWeakLabel, TeacherVote, aggregate_teacher_votes


def safe_divide(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def classification_report(
    truth: Sequence[str],
    predictions: Sequence[str],
    labels: Sequence[str],
) -> dict[str, object]:
    if len(truth) != len(predictions):
        raise ValueError("truth and predictions must have equal lengths")
    allowed = set(labels)
    if set(truth) - allowed or set(predictions) - allowed:
        raise ValueError("classification values are outside the supplied labels")
    rows: dict[str, dict[str, float | int]] = {}
    f1_values: list[float] = []
    for label in labels:
        true_positive = sum(
            expected == label and predicted == label
            for expected, predicted in zip(truth, predictions, strict=True)
        )
        false_positive = sum(
            expected != label and predicted == label
            for expected, predicted in zip(truth, predictions, strict=True)
        )
        false_negative = sum(
            expected == label and predicted != label
            for expected, predicted in zip(truth, predictions, strict=True)
        )
        support = sum(expected == label for expected in truth)
        precision = safe_divide(true_positive, true_positive + false_positive)
        recall = safe_divide(true_positive, true_positive + false_negative)
        f1 = safe_divide(2 * precision * recall, precision + recall)
        f1_values.append(f1)
        rows[label] = {
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "support": support,
        }
    accuracy = safe_divide(
        sum(
            expected == predicted
            for expected, predicted in zip(truth, predictions, strict=True)
        ),
        len(truth),
    )
    return {
        "accuracy": accuracy,
        "macroF1": sum(f1_values) / len(f1_values) if f1_values else 0.0,
        "perClass": rows,
        "count": len(truth),
    }


def softmax(logits: Sequence[float], temperature: float = 1.0) -> list[float]:
    if temperature <= 0 or not math.isfinite(temperature):
        raise ValueError("temperature must be finite and positive")
    if not logits:
        raise ValueError("logits must not be empty")
    scaled = [float(value) / temperature for value in logits]
    maximum = max(scaled)
    exponentials = [math.exp(value - maximum) for value in scaled]
    total = sum(exponentials)
    return [value / total for value in exponentials]


def negative_log_likelihood(
    logits: Sequence[Sequence[float]],
    targets: Sequence[int],
    *,
    temperature: float = 1.0,
) -> float:
    if len(logits) != len(targets) or not logits:
        raise ValueError("logits and targets must have equal non-zero lengths")
    losses = []
    for row, target in zip(logits, targets, strict=True):
        if not 0 <= target < len(row):
            raise ValueError("target index is out of range")
        probability = max(softmax(row, temperature)[target], 1e-15)
        losses.append(-math.log(probability))
    return sum(losses) / len(losses)


def fit_temperature(
    logits: Sequence[Sequence[float]],
    targets: Sequence[int],
    *,
    minimum: float = 0.05,
    maximum: float = 10.0,
    iterations: int = 80,
) -> float:
    """Fit a scalar temperature with deterministic golden-section search."""

    if minimum <= 0 or maximum <= minimum:
        raise ValueError("invalid temperature bounds")
    left = math.log(minimum)
    right = math.log(maximum)
    ratio = (math.sqrt(5) - 1) / 2
    inner_left = right - ratio * (right - left)
    inner_right = left + ratio * (right - left)
    left_loss = negative_log_likelihood(
        logits, targets, temperature=math.exp(inner_left)
    )
    right_loss = negative_log_likelihood(
        logits, targets, temperature=math.exp(inner_right)
    )
    for _ in range(iterations):
        if left_loss <= right_loss:
            right = inner_right
            inner_right = inner_left
            right_loss = left_loss
            inner_left = right - ratio * (right - left)
            left_loss = negative_log_likelihood(
                logits, targets, temperature=math.exp(inner_left)
            )
        else:
            left = inner_left
            inner_left = inner_right
            left_loss = right_loss
            inner_right = left + ratio * (right - left)
            right_loss = negative_log_likelihood(
                logits, targets, temperature=math.exp(inner_right)
            )
    return math.exp((left + right) / 2)


def expected_calibration_error(
    logits: Sequence[Sequence[float]],
    targets: Sequence[int],
    *,
    temperature: float = 1.0,
    bins: int = 15,
) -> float:
    if len(logits) != len(targets):
        raise ValueError("logits and targets must have equal lengths")
    if bins <= 0:
        raise ValueError("bins must be positive")
    bucket_confidences: list[list[float]] = [[] for _ in range(bins)]
    bucket_correct: list[list[float]] = [[] for _ in range(bins)]
    for row, target in zip(logits, targets, strict=True):
        probabilities = softmax(row, temperature)
        prediction = max(range(len(row)), key=lambda index: probabilities[index])
        confidence = probabilities[prediction]
        bucket_index = min(int(confidence * bins), bins - 1)
        bucket_confidences[bucket_index].append(confidence)
        bucket_correct[bucket_index].append(float(prediction == target))
    total = len(logits)
    if total == 0:
        return 0.0
    error = 0.0
    for confidences, correct in zip(
        bucket_confidences, bucket_correct, strict=True
    ):
        if not confidences:
            continue
        average_confidence = sum(confidences) / len(confidences)
        average_accuracy = sum(correct) / len(correct)
        error += (
            len(confidences)
            / total
            * abs(average_accuracy - average_confidence)
        )
    return error


def embedding_recall_at_k(
    embeddings: Sequence[Sequence[float]],
    labels: Sequence[str],
    *,
    k: int = 10,
) -> float:
    if len(embeddings) != len(labels):
        raise ValueError("embeddings and labels must have equal lengths")
    if k <= 0:
        raise ValueError("k must be positive")
    if len(embeddings) < 2:
        return 0.0
    dimensions = {len(vector) for vector in embeddings}
    if len(dimensions) != 1 or 0 in dimensions:
        raise ValueError("embeddings must share a non-zero dimension")

    normalized: list[list[float]] = []
    for vector in embeddings:
        norm = math.sqrt(sum(float(value) ** 2 for value in vector))
        if norm == 0:
            normalized.append([0.0 for _ in vector])
        else:
            normalized.append([float(value) / norm for value in vector])
    hits = 0
    for index, vector in enumerate(normalized):
        neighbors = sorted(
            (
                (
                    -sum(
                        left * right
                        for left, right in zip(vector, other, strict=True)
                    ),
                    other_index,
                )
                for other_index, other in enumerate(normalized)
                if other_index != index
            )
        )[: min(k, len(normalized) - 1)]
        if any(labels[neighbor_index] == labels[index] for _, neighbor_index in neighbors):
            hits += 1
    return hits / len(normalized)


@dataclass(frozen=True)
class TeacherGateThresholds:
    minimum_gold_examples: int = 1000
    schema_validity: float = 0.995
    activity_macro_f1: float = 0.80
    relevance_macro_f1: float = 0.82
    accepted_audit_accuracy: float = 0.90
    minimum_per_class_precision: float = 0.85
    triple_agreement_accuracy: float = 0.93

    @classmethod
    def from_mapping(
        cls, value: Mapping[str, object]
    ) -> "TeacherGateThresholds":
        return cls(
            minimum_gold_examples=int(value["minimumGoldExamples"]),
            schema_validity=float(value["schemaValidity"]),
            activity_macro_f1=float(value["activityMacroF1"]),
            relevance_macro_f1=float(value["relevanceMacroF1"]),
            accepted_audit_accuracy=float(value["acceptedAuditAccuracy"]),
            minimum_per_class_precision=float(
                value["minimumPerClassPrecision"]
            ),
            triple_agreement_accuracy=float(
                value["tripleAgreementAccuracy"]
            ),
        )


def _pair_accuracy(
    windows: Sequence[EventWindow],
    labels: Mapping[str, tuple[str, str | None]],
) -> float:
    compared = 0
    correct = 0
    for window in windows:
        if window.gold is None or window.window_id not in labels:
            continue
        compared += 1
        prediction = labels[window.window_id]
        correct += prediction == (
            window.gold.activity,
            window.gold.goal_relevance,
        )
    return safe_divide(correct, compared)


def evaluate_teacher_gate(
    gold_windows: Sequence[EventWindow],
    votes: Sequence[TeacherVote],
    *,
    attempted_count: int | None = None,
    invalid_schema_count: int = 0,
    thresholds: TeacherGateThresholds = TeacherGateThresholds(),
) -> dict[str, object]:
    labeled_gold = [window for window in gold_windows if window.gold is not None]
    by_id = {window.window_id: window for window in labeled_gold}
    pass_a = {
        vote.label.window_id: vote.label
        for vote in votes
        if vote.pass_name == "A" and vote.label.window_id in by_id
    }
    attempted = (
        attempted_count
        if attempted_count is not None
        else len(pass_a) + invalid_schema_count
    )
    valid_label_count = min(
        len(pass_a),
        max(attempted - invalid_schema_count, 0),
    )
    schema_validity = safe_divide(valid_label_count, attempted)

    activity_truth: list[str] = []
    activity_predictions: list[str] = []
    relevance_truth: list[str] = []
    relevance_predictions: list[str] = []
    for window in labeled_gold:
        prediction = pass_a.get(window.window_id)
        if prediction is None or window.gold is None:
            continue
        activity_truth.append(window.gold.activity)
        activity_predictions.append(prediction.activity)
        if (
            window.gold.goal_relevance is not None
            and prediction.goal_relevance is not None
        ):
            relevance_truth.append(window.gold.goal_relevance)
            relevance_predictions.append(prediction.goal_relevance)
    activity_report = classification_report(
        activity_truth, activity_predictions, ACTIVITY_LABELS
    )
    relevance_report = classification_report(
        relevance_truth, relevance_predictions, GOAL_RELEVANCE_LABELS
    )

    aggregates = aggregate_teacher_votes(labeled_gold, votes)
    accepted_pairs = {
        label.window_id: (label.activity, label.goal_relevance)
        for label in aggregates
        if label.status in {"accepted_single", "accepted_majority"}
        and label.activity is not None
    }
    accepted_accuracy = _pair_accuracy(labeled_gold, accepted_pairs)

    grouped_votes: dict[str, list[TeacherVote]] = defaultdict(list)
    for vote in votes:
        if vote.label.window_id in by_id:
            grouped_votes[vote.label.window_id].append(vote)
    unanimous_pairs: dict[str, tuple[str, str | None]] = {}
    for window_id, window_votes in grouped_votes.items():
        if {vote.pass_name for vote in window_votes} != {"A", "B", "C"}:
            continue
        pairs = {
            (vote.label.activity, vote.label.goal_relevance)
            for vote in window_votes
        }
        if len(pairs) == 1:
            unanimous_pairs[window_id] = next(iter(pairs))
    triple_accuracy = _pair_accuracy(labeled_gold, unanimous_pairs)

    per_class = activity_report["perClass"]
    assert isinstance(per_class, Mapping)
    per_class_precisions = [
        float(row["precision"])
        for row in per_class.values()
        if isinstance(row, Mapping)
    ]
    minimum_precision = min(per_class_precisions, default=0.0)
    checks = {
        "minimumGoldExamples": len(labeled_gold)
        >= thresholds.minimum_gold_examples,
        "schemaValidity": schema_validity >= thresholds.schema_validity,
        "activityMacroF1": float(activity_report["macroF1"])
        >= thresholds.activity_macro_f1,
        "relevanceMacroF1": float(relevance_report["macroF1"])
        >= thresholds.relevance_macro_f1,
        "acceptedAuditAccuracy": accepted_accuracy
        >= thresholds.accepted_audit_accuracy,
        "minimumPerClassPrecision": minimum_precision
        >= thresholds.minimum_per_class_precision,
        "tripleAgreementAccuracy": triple_accuracy
        >= thresholds.triple_agreement_accuracy,
    }
    return {
        "gateVersion": "teacher-gate.v1",
        "passed": all(checks.values()),
        "checks": checks,
        "goldCount": len(labeled_gold),
        "attemptedCount": attempted,
        "invalidSchemaCount": invalid_schema_count,
        "validPassALabelCount": len(pass_a),
        "schemaValidity": schema_validity,
        "activity": activity_report,
        "relevance": relevance_report,
        "acceptedAuditAccuracy": accepted_accuracy,
        "minimumPerClassPrecision": minimum_precision,
        "tripleAgreementAccuracy": triple_accuracy,
        "tripleAgreementCount": len(unanimous_pairs),
    }


def evaluate_slices(
    records: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    """Evaluate activity predictions globally and on required launch slices."""

    def report_for(items: Sequence[Mapping[str, object]]) -> dict[str, object]:
        truth = [str(item["activityGold"]) for item in items]
        predictions = [str(item["activityPredicted"]) for item in items]
        return classification_report(truth, predictions, ACTIVITY_LABELS)

    slices = {
        "all": list(records),
        "event_count": [
            record
            for record in records
            if record.get("triggerReason") == "event_count"
        ],
        "max_wait": [
            record
            for record in records
            if record.get("triggerReason") == "max_wait"
        ],
        "no_goal": [
            record for record in records if record.get("hasGoal") is False
        ],
        "unseen_participant": [
            record
            for record in records
            if record.get("unseenParticipant") is True
        ],
    }
    return {
        name: report_for(items) if items else {"count": 0, "macroF1": 0.0}
        for name, items in slices.items()
    }


def evaluate_student_records(
    records: Sequence[Mapping[str, object]],
    *,
    acceptance: Mapping[str, object],
    confidence_threshold: float = 0.9,
    gold_only_macro_f1: float | None = None,
) -> dict[str, object]:
    """Build the complete v1 launch-gate report from frozen-test rows."""

    if not records:
        raise ValueError("student evaluation requires at least one record")
    activity_truth = [str(record["activityGold"]) for record in records]
    activity_predictions = [
        str(record["activityPredicted"]) for record in records
    ]
    activity = classification_report(
        activity_truth, activity_predictions, ACTIVITY_LABELS
    )
    goal_records = [
        record
        for record in records
        if record.get("goalRelevanceGold") is not None
    ]
    relevance = classification_report(
        [str(record["goalRelevanceGold"]) for record in goal_records],
        [str(record["goalRelevancePredicted"]) for record in goal_records],
        GOAL_RELEVANCE_LABELS,
    )
    slices = evaluate_slices(records)

    activity_logits: list[list[float]] = []
    activity_targets: list[int] = []
    relevance_logits: list[list[float]] = []
    relevance_targets: list[int] = []
    confidences: list[float] = []
    correct: list[bool] = []
    for record in records:
        raw_activity_logits = record.get("activityLogits")
        if isinstance(raw_activity_logits, Sequence) and not isinstance(
            raw_activity_logits, (str, bytes)
        ):
            row = [float(value) for value in raw_activity_logits]
            if len(row) != len(ACTIVITY_LABELS):
                raise ValueError("activityLogits has the wrong class count")
            activity_logits.append(row)
            activity_targets.append(
                ACTIVITY_LABELS.index(str(record["activityGold"]))
            )
            derived_confidence = max(softmax(row))
        else:
            derived_confidence = float(record.get("confidence", 0.0))
        confidence = float(record.get("confidence", derived_confidence))
        confidences.append(confidence)
        activity_correct = (
            record["activityGold"] == record["activityPredicted"]
        )
        relevance_correct = (
            record.get("goalRelevanceGold")
            == record.get("goalRelevancePredicted")
        )
        correct.append(
            bool(activity_correct)
            and (
                record.get("goalRelevanceGold") is None
                or bool(relevance_correct)
            )
        )
        raw_relevance_logits = record.get("relevanceLogits")
        if (
            record.get("goalRelevanceGold") is not None
            and isinstance(raw_relevance_logits, Sequence)
            and not isinstance(raw_relevance_logits, (str, bytes))
        ):
            row = [float(value) for value in raw_relevance_logits]
            if len(row) != len(GOAL_RELEVANCE_LABELS):
                raise ValueError("relevanceLogits has the wrong class count")
            relevance_logits.append(row)
            relevance_targets.append(
                GOAL_RELEVANCE_LABELS.index(
                    str(record["goalRelevanceGold"])
                )
            )
    activity_ece = (
        expected_calibration_error(activity_logits, activity_targets)
        if len(activity_logits) == len(records)
        else 1.0
    )
    relevance_ece = (
        expected_calibration_error(relevance_logits, relevance_targets)
        if len(relevance_logits) == len(goal_records)
        else 1.0
    )
    ece = max(activity_ece, relevance_ece)
    high_confidence_indexes = [
        index
        for index, confidence in enumerate(confidences)
        if confidence >= confidence_threshold
    ]
    high_confidence_precision = safe_divide(
        sum(correct[index] for index in high_confidence_indexes),
        len(high_confidence_indexes),
    )
    high_confidence_coverage = safe_divide(
        len(high_confidence_indexes), len(records)
    )
    refocus_records = [
        record
        for record in records
        if record.get("feedbackCode") == "refocus"
    ]
    refocus_precision = safe_divide(
        sum(
            record.get("goalRelevanceGold") == "unrelated"
            for record in refocus_records
        ),
        len(refocus_records),
    )
    per_class = activity["perClass"]
    assert isinstance(per_class, Mapping)
    minimum_activity_f1 = min(
        (
            float(row["f1"])
            for row in per_class.values()
            if isinstance(row, Mapping)
        ),
        default=0.0,
    )
    seen_records = [
        record
        for record in records
        if record.get("unseenParticipant") is not True
    ]
    unseen_records = [
        record
        for record in records
        if record.get("unseenParticipant") is True
    ]
    seen_macro_f1 = (
        float(
            classification_report(
                [str(record["activityGold"]) for record in seen_records],
                [
                    str(record["activityPredicted"])
                    for record in seen_records
                ],
                ACTIVITY_LABELS,
            )["macroF1"]
        )
        if seen_records
        else 0.0
    )
    unseen_macro_f1 = (
        float(slices["unseen_participant"]["macroF1"])  # type: ignore[index]
        if unseen_records
        else 0.0
    )
    unseen_drop = seen_macro_f1 - unseen_macro_f1
    distillation_gain = (
        float(activity["macroF1"]) - gold_only_macro_f1
        if gold_only_macro_f1 is not None
        else None
    )
    checks = {
        "activityMacroF1": float(activity["macroF1"])
        >= float(acceptance["activityMacroF1"]),
        "activityPerClassF1": minimum_activity_f1
        >= float(acceptance["activityPerClassF1"]),
        "relevanceMacroF1": float(relevance["macroF1"])
        >= float(acceptance["relevanceMacroF1"]),
        "ece": ece <= float(acceptance["ece"]),
        "highConfidencePrecision": high_confidence_precision
        >= float(acceptance["highConfidencePrecision"]),
        "highConfidenceCoverage": high_confidence_coverage
        >= float(acceptance["highConfidenceCoverage"]),
        "refocusPrecision": refocus_precision
        >= float(acceptance["refocusPrecision"]),
        "maxWaitMacroF1": float(slices["max_wait"]["macroF1"])  # type: ignore[index]
        >= float(acceptance["maxWaitMacroF1"]),
        "eventCountMacroF1": float(slices["event_count"]["macroF1"])  # type: ignore[index]
        >= float(acceptance["eventCountMacroF1"]),
        "noGoalActivityMacroF1": float(slices["no_goal"]["macroF1"])  # type: ignore[index]
        >= float(acceptance["noGoalActivityMacroF1"]),
        "unseenParticipantMaximumDrop": bool(seen_records and unseen_records)
        and unseen_drop <= float(acceptance["unseenParticipantMaximumDrop"]),
        "minimumDistillationGain": distillation_gain is not None
        and distillation_gain >= float(acceptance["minimumDistillationGain"]),
    }
    embeddings = [
        record.get("embedding")
        for record in records
        if isinstance(record.get("embedding"), Sequence)
        and not isinstance(record.get("embedding"), (str, bytes))
    ]
    embedding_recall = (
        embedding_recall_at_k(
            [[float(value) for value in vector] for vector in embeddings],  # type: ignore[union-attr]
            activity_truth,
            k=10,
        )
        if len(embeddings) == len(records)
        else None
    )
    return {
        "evaluationVersion": "student-evaluation.v1",
        "passed": all(checks.values()),
        "checks": checks,
        "activity": activity,
        "relevance": relevance,
        "slices": slices,
        "activityEce": activity_ece,
        "relevanceEce": relevance_ece,
        "ece": ece,
        "highConfidenceThreshold": confidence_threshold,
        "highConfidencePrecision": high_confidence_precision,
        "highConfidenceCoverage": high_confidence_coverage,
        "refocusPrecision": refocus_precision,
        "refocusCount": len(refocus_records),
        "seenParticipantMacroF1": seen_macro_f1,
        "unseenParticipantMacroF1": unseen_macro_f1,
        "unseenParticipantDrop": unseen_drop,
        "goldOnlyMacroF1": gold_only_macro_f1,
        "distillationGain": distillation_gain,
        "embeddingRecallAt10": embedding_recall,
    }
