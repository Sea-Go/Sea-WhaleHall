from __future__ import annotations

import unittest
from pathlib import Path

from whalehall_training.cli import build_parser
from whalehall_training.training import (
    DaptConfig,
    StudentTrainingConfig,
    early_stopping_decision,
    resolve_training_precision,
    validate_dapt_config,
    validate_student_training_config,
)


class EarlyStoppingTests(unittest.TestCase):
    def test_dapt_requires_first_epoch_to_beat_frozen_baseline(self) -> None:
        improved = early_stopping_decision(
            [0.9],
            patience=1,
            baseline_loss=1.0,
        )
        self.assertFalse(improved.should_stop)
        self.assertEqual(improved.best_epoch, 1)

        stalled = early_stopping_decision(
            [0.9, 0.91],
            patience=1,
            baseline_loss=1.0,
        )
        self.assertTrue(stalled.should_stop)
        self.assertEqual(stalled.best_epoch, 1)
        self.assertEqual(stalled.reason, "patience_exhausted")

    def test_student_patience_counts_consecutive_non_improving_epochs(self) -> None:
        decision = early_stopping_decision(
            [1.0, 0.9, 0.91, 0.92],
            patience=2,
        )
        self.assertTrue(decision.should_stop)
        self.assertEqual(decision.best_epoch, 2)
        self.assertEqual(decision.stale_epochs, 2)

    def test_minimum_delta_is_applied_to_model_selection(self) -> None:
        decision = early_stopping_decision(
            [1.0, 0.995],
            patience=1,
            minimum_delta=0.01,
        )
        self.assertTrue(decision.should_stop)
        self.assertEqual(decision.best_epoch, 1)


class TrainingConfigTests(unittest.TestCase):
    def test_precision_policy_is_cuda_safe_and_cpu_smoke_stays_fp32(self) -> None:
        self.assertEqual(
            resolve_training_precision(
                "auto",
                device_type="cpu",
            ),
            "fp32",
        )
        self.assertEqual(
            resolve_training_precision(
                "auto",
                device_type="cuda",
                cuda_bf16_supported=True,
            ),
            "bf16",
        )
        self.assertEqual(
            resolve_training_precision(
                "auto",
                device_type="cuda",
                cuda_bf16_supported=False,
            ),
            "fp16",
        )
        with self.assertRaisesRegex(ValueError, "does not support bf16"):
            resolve_training_precision(
                "bf16",
                device_type="cuda",
                cuda_bf16_supported=False,
            )
        with self.assertRaisesRegex(ValueError, "only supported on CUDA"):
            resolve_training_precision("fp16", device_type="cpu")

    def test_formal_dapt_requires_distinct_validation_but_smoke_does_not(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires.*validation"):
            validate_dapt_config(
                DaptConfig(Path("train.jsonl"), Path("artifact"))
            )
        validate_dapt_config(
            DaptConfig(
                Path("train.jsonl"),
                Path("artifact"),
                maximum_steps=1,
            )
        )
        with self.assertRaisesRegex(ValueError, "must differ"):
            validate_dapt_config(
                DaptConfig(
                    Path("same.jsonl"),
                    Path("artifact"),
                    validation_path=Path("same.jsonl"),
                )
            )

    def test_student_modes_enforce_epoch_caps_and_validation(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires.*validation"):
            validate_student_training_config(
                StudentTrainingConfig(
                    Path("train.jsonl"),
                    Path("artifact"),
                    "base",
                )
            )
        validate_student_training_config(
            StudentTrainingConfig(
                Path("train.jsonl"),
                Path("artifact"),
                "base",
                maximum_steps=1,
            )
        )
        validate_student_training_config(
            StudentTrainingConfig(
                Path("train.jsonl"),
                Path("artifact"),
                "base",
                validation_path=Path("validation.jsonl"),
                epochs=5,
                hard_weight=1.0,
                distillation_weight=0.0,
                contrastive_weight=0.0,
                hard_only=True,
            )
        )
        with self.assertRaisesRegex(ValueError, "capped at 2"):
            validate_student_training_config(
                StudentTrainingConfig(
                    Path("train.jsonl"),
                    Path("artifact"),
                    "base",
                    validation_path=Path("validation.jsonl"),
                    epochs=3,
                )
            )
        with self.assertRaisesRegex(ValueError, "patience is pinned to 2"):
            validate_student_training_config(
                StudentTrainingConfig(
                    Path("train.jsonl"),
                    Path("artifact"),
                    "base",
                    validation_path=Path("validation.jsonl"),
                    epochs=5,
                    hard_weight=1.0,
                    distillation_weight=0.0,
                    contrastive_weight=0.0,
                    hard_only=True,
                    early_stopping_patience=1,
                )
            )
        with self.assertRaisesRegex(
            ValueError,
            "contrastive loss requires batch_size >= 3",
        ):
            validate_student_training_config(
                StudentTrainingConfig(
                    Path("train.jsonl"),
                    Path("artifact"),
                    "base",
                    maximum_steps=1,
                    batch_size=2,
                )
            )
        validate_student_training_config(
            StudentTrainingConfig(
                Path("train.jsonl"),
                Path("artifact"),
                "base",
                maximum_steps=1,
                batch_size=1,
                hard_weight=0.6,
                distillation_weight=0.4,
                contrastive_weight=0.0,
            )
        )

    def test_cli_exposes_validation_and_teacher_runtime_guards(self) -> None:
        parser = build_parser()
        dapt = parser.parse_args(
            [
                "train",
                "dapt",
                "train.jsonl",
                "artifact",
                "--validation",
                "validation.jsonl",
            ]
        )
        self.assertEqual(dapt.validation, Path("validation.jsonl"))
        teacher = parser.parse_args(
            [
                "teacher",
                "label",
                "windows.jsonl",
                "votes.jsonl",
                "--checkpoint",
                "checkpoint.sqlite3",
                "--pass",
                "A",
                "--allowed-hours",
                "22:00-06:00",
            ]
        )
        self.assertEqual(teacher.allowed_hours, "22:00-06:00")
        self.assertFalse(teacher.no_thermal_guard)
        student = parser.parse_args(
            [
                "train",
                "student",
                "train.jsonl",
                "artifact",
                "--mixed-precision",
                "fp16",
                "--no-gradient-checkpointing",
            ]
        )
        self.assertEqual(student.mixed_precision, "fp16")
        self.assertTrue(student.no_gradient_checkpointing)


if __name__ == "__main__":
    unittest.main()
