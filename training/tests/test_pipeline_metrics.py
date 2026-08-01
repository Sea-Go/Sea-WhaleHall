from __future__ import annotations

import unittest
import json
import tempfile
from pathlib import Path

from whalehall_training.contracts import ACTIVITY_LABELS
from whalehall_training.metrics import (
    TeacherGateThresholds,
    classification_report,
    evaluate_teacher_gate,
    expected_calibration_error,
    fit_temperature,
)
from whalehall_training.pipeline import (
    AggregatedWeakLabel,
    aggregate_teacher_votes,
    materialize_student_examples,
    select_high_risk_windows,
    select_teacher_candidates,
    select_weak_training_set,
)
from whalehall_training.training import (
    StudentTrainingConfig,
    apply_calibration_to_runtime,
    artifact_manifest,
    student_runtime_metadata,
)

from tests.helpers import make_vote, make_window


class PipelineTests(unittest.TestCase):
    def test_candidate_selection_is_deterministic(self) -> None:
        windows = [make_window(index) for index in range(30)]
        first = select_teacher_candidates(windows, target=12, seed=17)
        second = select_teacher_candidates(
            list(reversed(windows)), target=12, seed=17
        )
        self.assertEqual(
            [window.window_id for window in first],
            [window.window_id for window in second],
        )

    def test_high_risk_selection_uses_exact_target_without_duplicates(self) -> None:
        windows = []
        votes = []
        for index in range(20):
            base = make_window(index)
            metadata = {
                "studentEntropy": index / 20,
                "studentMargin": 1 - index / 20,
                "studentActivity": (
                    "writing" if index % 2 else "development"
                ),
                "oodScore": (20 - index) / 20,
            }
            window = type(base)(**{**base.__dict__, "metadata": metadata})
            windows.append(window)
            votes.append(make_vote(window, "A"))
        selection = select_high_risk_windows(
            windows, votes, target=10, seed=29
        )
        self.assertEqual(len(selection.windows), 10)
        self.assertEqual(
            len({window.window_id for window in selection.windows}), 10
        )
        self.assertEqual(sum(selection.quota_counts.values()), 10)

    def test_three_pass_majority_and_no_majority_human_queue(self) -> None:
        majority_window = make_window(1)
        review_window = make_window(2)
        votes = [
            make_vote(majority_window, "A", activity="development"),
            make_vote(majority_window, "B", activity="development"),
            make_vote(majority_window, "C", activity="writing"),
            make_vote(review_window, "A", activity="development"),
            make_vote(review_window, "B", activity="writing"),
            make_vote(review_window, "C", activity="research"),
        ]
        labels = aggregate_teacher_votes(
            [majority_window, review_window],
            votes,
            high_risk_window_ids={
                majority_window.window_id,
                review_window.window_id,
            },
        )
        self.assertEqual(labels[0].status, "accepted_majority")
        self.assertEqual(labels[0].activity, "development")
        self.assertEqual(labels[0].weight, 0.8)
        self.assertAlmostEqual(
            labels[0].activity_distribution["development"], 2 / 3
        )
        self.assertEqual(labels[1].status, "human_review")
        self.assertEqual(labels[1].weight, 0.0)

    def test_materialize_masks_relevance_for_no_goal_gold(self) -> None:
        window = make_window(
            1,
            has_goal=False,
            gold_activity="research",
            gold_relevance=None,
        )
        examples = materialize_student_examples([window])
        self.assertEqual(len(examples), 1)
        self.assertIsNone(examples[0]["goalText"])
        self.assertIsNone(examples[0]["goalRelevance"])
        self.assertEqual(sum(examples[0]["relevanceDistribution"].values()), 0.0)

    def test_weak_selection_enforces_trigger_and_no_goal_mix(self) -> None:
        labels = []
        trigger_reasons = (
            ["event_count"] * 11
            + ["max_wait"] * 6
            + ["goal_boundary"] * 3
        )
        for index, trigger_reason in enumerate(trigger_reasons):
            labels.append(
                AggregatedWeakLabel(
                    window_id=f"weak-{index:02d}",
                    status="accepted_single",
                    activity="development",
                    goal_relevance=None if index < 5 else "direct",
                    activity_distribution={"development": 1.0},
                    relevance_distribution=(
                        {} if index < 5 else {"direct": 1.0}
                    ),
                    weight=0.35,
                    vote_count=1,
                    agreement_count=1,
                    ambiguous=False,
                    reason_codes=("document_edit",),
                    trigger_reason=trigger_reason,
                    has_goal=index >= 5,
                )
            )
        selected = select_weak_training_set(
            labels,
            target=20,
            per_activity_minimum=0,
            per_activity_maximum=20,
            per_relevance_minimum=0,
            seed=43,
        )
        self.assertEqual(len(selected), 20)
        self.assertEqual(sum(not label.has_goal for label in selected), 5)

    def test_teacher_gate_counts_missing_pass_a_as_invalid_coverage(self) -> None:
        windows = [
            make_window(
                index,
                gold_activity="development",
                gold_relevance="direct",
            )
            for index in range(2)
        ]
        report = evaluate_teacher_gate(
            windows,
            [make_vote(windows[0], "A")],
            attempted_count=2,
            thresholds=TeacherGateThresholds(
                minimum_gold_examples=1,
                schema_validity=0.9,
                activity_macro_f1=0.0,
                relevance_macro_f1=0.0,
                accepted_audit_accuracy=0.0,
                minimum_per_class_precision=0.0,
                triple_agreement_accuracy=0.0,
            ),
        )
        self.assertEqual(report["schemaValidity"], 0.5)
        self.assertFalse(report["checks"]["schemaValidity"])


class MetricTests(unittest.TestCase):
    def test_classification_report_macro_f1(self) -> None:
        truth = list(ACTIVITY_LABELS)
        report = classification_report(truth, truth, ACTIVITY_LABELS)
        self.assertEqual(report["accuracy"], 1.0)
        self.assertEqual(report["macroF1"], 1.0)

    def test_temperature_fit_improves_overconfident_nll_calibration(self) -> None:
        logits = [[8.0, 0.0], [8.0, 0.0], [0.0, 8.0], [0.0, 8.0]]
        targets = [0, 1, 1, 0]
        temperature = fit_temperature(logits, targets)
        self.assertGreater(temperature, 1.0)
        before = expected_calibration_error(logits, targets)
        after = expected_calibration_error(
            logits, targets, temperature=temperature
        )
        self.assertLess(after, before)

    def test_runtime_metadata_does_not_embed_training_machine_paths(self) -> None:
        config = StudentTrainingConfig(
            input_path=Path("/private/training/examples.jsonl"),
            output_directory=Path("/private/training/artifact"),
            base_model="/private/training/dapt-checkpoint",
        )
        metadata = student_runtime_metadata(
            config,
            resolved_precision="fp32",
        )
        serialized = str(metadata)
        self.assertNotIn("/private/training", serialized)
        self.assertEqual(metadata["encoderConfig"], "config.json")
        self.assertEqual(metadata["weights"], "student.pt")
        self.assertEqual(
            metadata["schemaVersion"],
            "modernbert-runtime.v2",
        )
        self.assertEqual(
            metadata["inputFormat"]["serialization"],
            "immutable_modelInput_single_sequence",
        )
        self.assertFalse(
            metadata["inputFormat"]["genericTokenizerTruncation"]
        )
        self.assertEqual(
            metadata["trainingExecution"]["resolvedPrecision"],
            "fp32",
        )
        self.assertTrue(
            metadata["trainingExecution"]["gradientCheckpointing"]
        )
        self.assertFalse(metadata["calibration"]["calibrated"])

    def test_finalize_runtime_installs_calibration_atomically(self) -> None:
        config = StudentTrainingConfig(
            input_path=Path("examples.jsonl"),
            output_directory=Path("artifact"),
            base_model="answerdotai/ModernBERT-base",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime_path = root / "runtime.json"
            calibration_path = root / "calibration.json"
            runtime_path.write_text(
                json.dumps(
                    student_runtime_metadata(
                        config,
                        resolved_precision="fp32",
                    )
                ),
                encoding="utf-8",
            )
            calibration_path.write_text(
                json.dumps(
                    {
                        "calibrationVersion": "temperature-scaling.v1",
                        "activityTemperature": 1.7,
                        "relevanceTemperature": 1.3,
                        "activityEce": 0.03,
                        "relevanceEce": 0.04,
                        "activityCount": 1500,
                        "relevanceCount": 1100,
                    }
                ),
                encoding="utf-8",
            )
            runtime = apply_calibration_to_runtime(root, calibration_path)
            self.assertTrue(runtime["calibration"]["calibrated"])
            self.assertEqual(
                runtime["calibration"]["activityTemperature"], 1.7
            )

    def test_artifact_manifest_requires_locked_tokenizer_contract(self) -> None:
        config = StudentTrainingConfig(
            input_path=Path("examples.jsonl"),
            output_directory=Path("artifact"),
            base_model="answerdotai/ModernBERT-base",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "config.json",
                "student.pt",
                "tokenizer.json",
                "tokenizer_config.json",
            ):
                (root / name).write_text(name, encoding="utf-8")
            runtime = student_runtime_metadata(
                config,
                tokenizer_sha256="a" * 64,
                resolved_precision="bf16",
            )
            (root / "runtime.json").write_text(
                json.dumps(runtime),
                encoding="utf-8",
            )
            manifest_path = root / "manifest.json"
            manifest = artifact_manifest(
                root,
                model_version="modernbert-whalehall-v1",
                manifest_path=manifest_path,
            )
            self.assertEqual(
                manifest["manifestVersion"],
                "model-artifact.v2",
            )
            self.assertEqual(manifest["tokenizerSha256"], "a" * 64)
            self.assertEqual(
                manifest["trainingExecution"]["resolvedPrecision"],
                "bf16",
            )
            manifest_path.write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )
            rerun = artifact_manifest(
                root,
                model_version="modernbert-whalehall-v1",
                manifest_path=manifest_path,
            )
            self.assertEqual(manifest, rerun)
            self.assertNotIn(
                "manifest.json",
                [item["path"] for item in rerun["files"]],
            )
            with self.assertRaisesRegex(ValueError, "model version"):
                artifact_manifest(
                    root,
                    model_version="forged-model-version",
                    manifest_path=manifest_path,
                )
            with self.assertRaisesRegex(ValueError, "taxonomy version"):
                artifact_manifest(
                    root,
                    model_version="modernbert-whalehall-v1",
                    taxonomy_version="forged-taxonomy",
                    manifest_path=manifest_path,
                )
            (root / "tokenizer.json").unlink()
            with self.assertRaisesRegex(ValueError, "tokenizer.json"):
                artifact_manifest(
                    root,
                    model_version="modernbert-whalehall-v1",
                    manifest_path=manifest_path,
                )


if __name__ == "__main__":
    unittest.main()
