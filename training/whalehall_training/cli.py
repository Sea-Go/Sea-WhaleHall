from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Mapping, Sequence

from .contracts import ACTIVITY_LABELS, EventWindow, ValidationError
from .dataset import (
    dataset_manifest,
    deduplicate_windows,
    deterministic_group_split,
    validate_jsonl,
    write_jsonl,
)
from .metrics import (
    TeacherGateThresholds,
    evaluate_student_records,
    evaluate_teacher_gate,
)
from .inference_server import (
    DEFAULT_MAX_MODEL_INPUT_BYTES,
    DEFAULT_MAX_REQUEST_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_PORT,
    ArtifactInferenceRunner,
    create_inference_server,
)
from .model import MissingTrainingDependency, smoke_test_artifact
from .pipeline import (
    aggregate_teacher_votes,
    balance_audit,
    materialize_student_examples,
    read_aggregated_weak_labels,
    read_teacher_votes,
    select_high_risk_windows,
    select_teacher_candidates,
    select_weak_training_set,
    write_aggregated_labels,
)
from .runtime_export import export_runtime_database
from .teacher import (
    AllowedHours,
    LabelCheckpoint,
    OllamaTeacher,
    TeacherConfig,
    TeacherError,
    run_teacher_pass,
)
from .training import (
    DaptConfig,
    StudentTrainingConfig,
    artifact_manifest,
    apply_calibration_to_runtime,
    calibrate_from_jsonl,
    run_dapt,
    run_student_training,
)

TRAINING_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = TRAINING_ROOT / "config" / "product_v1.json"


def _load_json(path: Path) -> Mapping[str, object]:
    with path.open("r", encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _load_config(path: Path) -> Mapping[str, object]:
    config = _load_json(path)
    if config.get("configVersion") != "whalehall-training.v1":
        raise ValueError("configVersion must be whalehall-training.v1")
    dataset = config["dataset"]
    if not isinstance(dataset, Mapping):
        raise ValueError("dataset config must be an object")
    gold = dataset["gold"]
    if not isinstance(gold, Mapping):
        raise ValueError("dataset.gold config must be an object")
    expected_gold = (
        int(gold["initialTrain"])
        + int(gold["activeLearningRounds"])
        * int(gold["activeLearningPerRound"])
        + int(gold["calibration"])
        + int(gold["frozenTest"])
    )
    if expected_gold != int(gold["total"]) or expected_gold != 10_000:
        raise ValueError("gold partitions must total exactly 10,000")
    fixed = {
        "unlabeledTarget": 1_000_000,
        "teacherCandidateTarget": 300_000,
        "weakLabelTarget": 250_000,
    }
    for key, expected in fixed.items():
        if int(dataset[key]) != expected:
            raise ValueError(f"dataset.{key} must remain fixed at {expected}")
    teacher = config["teacher"]
    student = config["student"]
    if not isinstance(teacher, Mapping) or not isinstance(student, Mapping):
        raise ValueError("teacher and student configs must be objects")
    TeacherConfig.from_mapping(teacher).validate()
    loss_total = (
        float(student["hardLabelLossWeight"])
        + float(student["distillationLossWeight"])
        + float(student["contrastiveLossWeight"])
    )
    if abs(loss_total - 1.0) > 1e-9:
        raise ValueError("student loss weights must sum to 1.0")
    return config


def _read_windows(path: Path, *, require_valid: bool = True) -> tuple[EventWindow, ...]:
    with path.open("r", encoding="utf-8") as source:
        report = validate_jsonl(source)
    if require_valid and report.issues:
        first = report.issues[0]
        raise ValidationError(
            f"{path}:{first.line_number}: {first.message}; "
            f"{len(report.issues)} invalid record(s)"
        )
    return report.records


def _print_json(value: object) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def _write_pretty_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")
    temporary.replace(path)


def _dataset_validate(arguments: argparse.Namespace) -> int:
    with arguments.input.open("r", encoding="utf-8") as source:
        report = validate_jsonl(source)
    _print_json(
        {
            "valid": report.valid,
            "recordCount": len(report.records),
            "issueCount": len(report.issues),
            "issues": [
                {
                    "lineNumber": issue.line_number,
                    "message": issue.message,
                }
                for issue in report.issues[: arguments.maximum_issues]
            ],
        }
    )
    return 0 if report.valid else 2


def _dataset_dedupe(arguments: argparse.Namespace) -> int:
    windows = _read_windows(arguments.input)
    result = deduplicate_windows(
        windows, near_duplicate_threshold=arguments.threshold
    )
    write_jsonl(arguments.output, (window.as_dict() for window in result.kept))
    write_jsonl(
        arguments.report,
        (
            {
                "droppedWindowId": duplicate.dropped_window_id,
                "keptWindowId": duplicate.kept_window_id,
                "reason": duplicate.reason,
                "similarity": duplicate.similarity,
            }
            for duplicate in result.duplicates
        ),
    )
    _print_json(
        {
            "input": len(windows),
            "kept": len(result.kept),
            "duplicates": len(result.duplicates),
        }
    )
    return 0


def _dataset_export_runtime(arguments: argparse.Namespace) -> int:
    result = export_runtime_database(
        arguments.database,
        arguments.output,
        arguments.manifest,
        participant_id=arguments.participant_id,
        session_timezone=arguments.session_timezone,
        project_goal_id=arguments.project_goal_id,
        include_content=arguments.include_content,
    )
    _print_json(result.manifest)
    return 0


def _gold_targets(config: Mapping[str, object]) -> dict[str, int]:
    dataset = config["dataset"]
    assert isinstance(dataset, Mapping)
    gold = dataset["gold"]
    assert isinstance(gold, Mapping)
    rounds = int(gold["activeLearningRounds"])
    targets = {"initial_train": int(gold["initialTrain"])}
    targets.update(
        {
            f"active_learning_{round_number}": int(
                gold["activeLearningPerRound"]
            )
            for round_number in range(1, rounds + 1)
        }
    )
    targets["calibration"] = int(gold["calibration"])
    targets["frozen_test"] = int(gold["frozenTest"])
    return targets


def _dataset_split(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    windows = _read_windows(arguments.input)
    targets = (
        _gold_targets(config)
        if arguments.targets is None
        else {
            str(key): int(value)
            for key, value in json.loads(arguments.targets).items()
        }
    )
    splits = deterministic_group_split(
        windows,
        targets,
        seed=arguments.seed,
        grouping_level=arguments.grouping_level,
    )
    counts = {name: len(values) for name, values in splits.items()}
    exact = counts == targets
    if not exact and not arguments.allow_quota_drift:
        _print_json(
            {
                "written": False,
                "reason": "indivisible groups prevent exact quotas",
                "targets": targets,
                "actual": counts,
                "hint": "curate group sizes or rerun with --allow-quota-drift "
                "for a diagnostic split",
            }
        )
        return 3
    gold_balance: dict[str, object] | None = None
    if set(targets) == {
        "initial_train",
        "active_learning_1",
        "active_learning_2",
        "active_learning_3",
        "active_learning_4",
        "calibration",
        "frozen_test",
    }:
        train_windows = [
            window
            for name, values in splits.items()
            if name == "initial_train" or name.startswith("active_learning_")
            for window in values
        ]
        frozen_windows = list(splits["frozen_test"])
        if any(window.gold is None for window in windows):
            _print_json(
                {
                    "written": False,
                    "reason": "fixed gold split contains windows without gold labels",
                }
            )
            return 4
        train_counts = {
            activity: sum(
                window.gold is not None
                and window.gold.activity == activity
                for window in train_windows
            )
            for activity in ACTIVITY_LABELS
        }
        frozen_counts = {
            activity: sum(
                window.gold is not None
                and window.gold.activity == activity
                for window in frozen_windows
            )
            for activity in ACTIVITY_LABELS
        }
        balance_config = config["dataset"]["balance"]  # type: ignore[index]
        assert isinstance(balance_config, Mapping)
        train_minimum = int(balance_config["goldTrainPerActivityMinimum"])
        frozen_minimum = int(balance_config["frozenTestPerActivityMinimum"])
        violations = [
            f"train:{activity}={count}<{train_minimum}"
            for activity, count in train_counts.items()
            if count < train_minimum
        ] + [
            f"frozen_test:{activity}={count}<{frozen_minimum}"
            for activity, count in frozen_counts.items()
            if count < frozen_minimum
        ]
        gold_balance = {
            "trainActivityCounts": train_counts,
            "frozenTestActivityCounts": frozen_counts,
            "violations": violations,
        }
        if violations and not arguments.allow_quota_drift:
            _print_json(
                {
                    "written": False,
                    "reason": "gold class minima are not satisfied",
                    "violations": violations,
                }
            )
            return 4
    arguments.output_directory.mkdir(parents=True, exist_ok=True)
    for name, values in splits.items():
        write_jsonl(
            arguments.output_directory / f"{name}.jsonl",
            (window.as_dict() for window in values),
        )
    manifest = dataset_manifest(
        splits,
        grouping_level=arguments.grouping_level,
        seed=arguments.seed,
    )
    manifest["targets"] = targets
    manifest["exactTargets"] = exact
    if gold_balance is not None:
        manifest["goldBalance"] = gold_balance
    manifest_path = arguments.output_directory / "manifest.json"
    _write_pretty_json(manifest_path, manifest)
    _print_json(manifest)
    return 0


def _candidate_select(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    dataset = config["dataset"]
    assert isinstance(dataset, Mapping)
    windows = _read_windows(arguments.input)
    selected = select_teacher_candidates(
        windows,
        target=int(dataset["teacherCandidateTarget"]),
        seed=arguments.seed,
    )
    write_jsonl(arguments.output, (window.as_dict() for window in selected))
    _print_json({"input": len(windows), "selected": len(selected)})
    return 0


def _teacher_label(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    teacher_mapping = config["teacher"]
    assert isinstance(teacher_mapping, Mapping)
    teacher = OllamaTeacher(TeacherConfig.from_mapping(teacher_mapping))
    windows = _read_windows(arguments.input)
    result = run_teacher_pass(
        windows,
        pass_name=arguments.pass_name,
        teacher=teacher,
        checkpoint_path=arguments.checkpoint,
        output_path=arguments.output,
        pause_file=arguments.pause_file,
        dry_run=arguments.dry_run,
        thinking=arguments.thinking,
        allowed_hours=(
            None
            if arguments.allowed_hours is None
            else AllowedHours.parse(arguments.allowed_hours)
        ),
        thermal_guard=not arguments.no_thermal_guard,
        thermal_unknown_policy=arguments.thermal_unknown_policy,
        thermal_backoff_seconds=arguments.thermal_backoff_seconds,
        thermal_maximum_sleep_seconds=arguments.thermal_maximum_sleep_seconds,
    )
    _print_json(
        {
            "status": result.status,
            "pass": result.pass_name,
            "completedBefore": result.completed_before,
            "completedNow": result.completed_now,
            "remaining": result.remaining,
            "batches": result.batches,
            "pauseReason": result.pause_reason,
        }
    )
    return 0


def _read_votes(paths: Sequence[Path]) -> tuple[object, ...]:
    votes = []
    for path in paths:
        with path.open("r", encoding="utf-8") as source:
            votes.extend(read_teacher_votes(source))
    return tuple(votes)


def _high_risk_select(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    teacher_config = config["teacher"]
    assert isinstance(teacher_config, Mapping)
    windows = _read_windows(arguments.windows)
    votes = _read_votes(arguments.votes)
    selection = select_high_risk_windows(
        windows,
        votes,  # type: ignore[arg-type]
        target=int(teacher_config["highRiskCount"]),
        seed=arguments.seed,
    )
    write_jsonl(
        arguments.output,
        (window.as_dict() for window in selection.windows),
    )
    manifest = {
        "selectionVersion": "high-risk-selection.v1",
        "selected": len(selection.windows),
        "quotaCounts": selection.quota_counts,
        "selectionReasons": selection.selection_reasons,
    }
    _write_pretty_json(arguments.manifest, manifest)
    _print_json(
        {
            "selected": len(selection.windows),
            "quotaCounts": selection.quota_counts,
        }
    )
    return 0


def _teacher_aggregate(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    teacher_config = config["teacher"]
    assert isinstance(teacher_config, Mapping)
    windows = _read_windows(arguments.windows)
    votes = _read_votes(arguments.votes)
    high_risk_ids = (
        {window.window_id for window in _read_windows(arguments.high_risk)}
        if arguments.high_risk
        else set()
    )
    labels = aggregate_teacher_votes(
        windows,
        votes,  # type: ignore[arg-type]
        high_risk_window_ids=high_risk_ids,
        single_weight=float(teacher_config["singlePassWeight"]),
        majority_weight=float(teacher_config["threePassMajorityWeight"]),
    )
    write_aggregated_labels(arguments.output, labels)
    if arguments.human_queue is not None:
        write_aggregated_labels(
            arguments.human_queue,
            [
                label
                for label in labels
                if label.status in {"human_review", "pending_arbitration"}
            ],
        )
    _print_json(balance_audit(labels))
    return 0


def _weak_select(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    dataset = config["dataset"]
    assert isinstance(dataset, Mapping)
    balance = dataset["balance"]
    assert isinstance(balance, Mapping)
    with arguments.input.open("r", encoding="utf-8") as source:
        labels = read_aggregated_weak_labels(source)
    selected = select_weak_training_set(
        labels,
        target=int(dataset["weakLabelTarget"]),
        per_activity_minimum=int(balance["weakPerActivityMinimum"]),
        per_activity_maximum=int(balance["weakPerActivityMaximum"]),
        per_relevance_minimum=int(balance["weakPerRelevanceMinimum"]),
        event_count_fraction=float(balance["eventCountFraction"]),
        max_wait_fraction=float(balance["maxWaitFractionMinimum"]),
        boundary_fraction=float(balance["boundaryFraction"]),
        no_goal_fraction=float(balance["noGoalFractionMinimum"]),
        seed=arguments.seed,
    )
    write_aggregated_labels(arguments.output, selected)
    _print_json(balance_audit(selected))
    return 0


def _teacher_gate(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    teacher_config = config["teacher"]
    assert isinstance(teacher_config, Mapping)
    windows = _read_windows(arguments.gold)
    votes = _read_votes(arguments.votes)
    thresholds = TeacherGateThresholds.from_mapping(teacher_config["gate"])  # type: ignore[arg-type]
    report = evaluate_teacher_gate(
        windows,
        votes,  # type: ignore[arg-type]
        attempted_count=arguments.attempted,
        invalid_schema_count=arguments.invalid_schema,
        thresholds=thresholds,
    )
    _write_pretty_json(arguments.output, report)
    _print_json(report)
    return 0 if report["passed"] else 4


def _teacher_benchmark(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    teacher_mapping = config["teacher"]
    assert isinstance(teacher_mapping, Mapping)
    teacher_config = TeacherConfig.from_mapping(teacher_mapping)
    with LabelCheckpoint(arguments.checkpoint, teacher_config) as checkpoint:
        report = checkpoint.benchmark(arguments.pass_name)
    _write_pretty_json(arguments.output, report)
    _print_json(report)
    return 0 if int(report["labelCount"]) >= arguments.minimum_labels else 4


def _student_materialize(arguments: argparse.Namespace) -> int:
    windows = _read_windows(arguments.windows)
    labels = ()
    if arguments.weak_labels is not None:
        with arguments.weak_labels.open("r", encoding="utf-8") as source:
            labels = read_aggregated_weak_labels(source)
    examples = materialize_student_examples(windows, labels)
    write_jsonl(arguments.output, examples)
    _print_json({"windows": len(windows), "examples": len(examples)})
    return 0


def _train_dapt(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    student = config["student"]
    assert isinstance(student, Mapping)
    result = run_dapt(
        DaptConfig(
            input_path=arguments.input,
            output_directory=arguments.output_directory,
            validation_path=arguments.validation,
            base_model=str(student["baseModel"]),
            epochs=arguments.epochs,
            maximum_tokens=int(student.get("daptMaximumTokens", 1024)),
            batch_size=arguments.batch_size,
            learning_rate=arguments.learning_rate,
            seed=arguments.seed,
            device=arguments.device,
            maximum_steps=arguments.maximum_steps,
            minimum_delta=arguments.minimum_delta,
        )
    )
    _print_json(result)
    return 0


def _train_student(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    student = config["student"]
    assert isinstance(student, Mapping)
    distillation_weight = (
        float(student["distillationLossWeight"])
        if arguments.distillation_weight is None
        else arguments.distillation_weight
    )
    contrastive_weight = float(student["contrastiveLossWeight"])
    if arguments.hard_only:
        distillation_weight = 0.0
        contrastive_weight = 0.0
    else:
        if arguments.disable_kd:
            distillation_weight = 0.0
        if arguments.disable_contrastive:
            contrastive_weight = 0.0
    hard_weight = 1.0 - distillation_weight - contrastive_weight
    if hard_weight <= 0:
        raise ValueError(
            "distillation + contrastive weights must leave positive hard CE weight"
        )
    result = run_student_training(
        StudentTrainingConfig(
            input_path=arguments.input,
            output_directory=arguments.output_directory,
            base_model=arguments.base_model
            or str(student["baseModel"]),
            validation_path=arguments.validation,
            epochs=(
                5
                if arguments.epochs is None and arguments.hard_only
                else 2
                if arguments.epochs is None
                else arguments.epochs
            ),
            maximum_tokens=int(student["maximumTokens"]),
            batch_size=(
                int(student["recommendedMicroBatchSize"])
                if arguments.batch_size is None
                else arguments.batch_size
            ),
            mixed_precision=(
                str(student["mixedPrecision"])
                if arguments.mixed_precision is None
                else arguments.mixed_precision
            ),
            gradient_checkpointing=(
                bool(student["gradientCheckpointing"])
                and not arguments.no_gradient_checkpointing
            ),
            learning_rate=arguments.learning_rate,
            embedding_dimensions=int(student["embeddingDimensions"]),
            hard_weight=hard_weight,
            distillation_weight=distillation_weight,
            contrastive_weight=contrastive_weight,
            distillation_temperature=(
                float(student["distillationTemperature"])
                if arguments.distillation_temperature is None
                else arguments.distillation_temperature
            ),
            seed=arguments.seed,
            device=arguments.device,
            maximum_steps=arguments.maximum_steps,
            model_version=arguments.model_version,
            hard_only=arguments.hard_only,
            early_stopping_patience=arguments.patience,
            minimum_delta=arguments.minimum_delta,
        )
    )
    _print_json(result)
    return 0


def _calibrate(arguments: argparse.Namespace) -> int:
    _print_json(calibrate_from_jsonl(arguments.input, arguments.output))
    return 0


def _finalize_runtime(arguments: argparse.Namespace) -> int:
    runtime = apply_calibration_to_runtime(
        arguments.artifact_directory,
        arguments.calibration,
    )
    _print_json(runtime)
    return 0


def _evaluate(arguments: argparse.Namespace) -> int:
    config = _load_config(arguments.config)
    acceptance = config["acceptance"]
    if not isinstance(acceptance, Mapping):
        raise ValueError("acceptance config must be an object")
    records = []
    with arguments.input.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, Mapping):
                raise ValueError(f"line {line_number} must be an object")
            records.append(value)
    report = evaluate_student_records(
        records,
        acceptance=acceptance,
        confidence_threshold=arguments.confidence_threshold,
        gold_only_macro_f1=arguments.gold_only_macro_f1,
    )
    _write_pretty_json(arguments.output, report)
    _print_json(report)
    return 0 if report["passed"] or arguments.allow_fail else 4


def _manifest(arguments: argparse.Namespace) -> int:
    manifest = artifact_manifest(
        arguments.directory,
        model_version=arguments.model_version,
        manifest_path=arguments.output,
    )
    _write_pretty_json(arguments.output, manifest)
    _print_json(manifest)
    return 0


def _artifact_smoke(arguments: argparse.Namespace) -> int:
    report = smoke_test_artifact(arguments.directory)
    _print_json(report)
    return 0


def _serve(arguments: argparse.Namespace) -> int:
    token = os.environ.get(arguments.token_env)
    if token == "":
        raise ValueError(
            f"{arguments.token_env} is set but empty; unset it or provide a token"
        )
    runner = ArtifactInferenceRunner(
        arguments.artifact_directory,
        device=arguments.device,
    )
    server = create_inference_server(
        runner,
        port=arguments.port,
        authorization_token=token,
        maximum_request_bytes=arguments.maximum_request_bytes,
        maximum_response_bytes=arguments.maximum_response_bytes,
        maximum_model_input_bytes=arguments.maximum_model_input_bytes,
        maximum_concurrency=arguments.concurrency,
    )
    _print_json(
        {
            "status": "ready",
            "endpoint": (
                f"http://127.0.0.1:{server.server_address[1]}"
                "/v1/reflections:infer"
            ),
            "modelVersion": runner.model_version,
            "taxonomyVersion": runner.taxonomy_version,
            "authorization": "required" if token is not None else "disabled",
            "maximumConcurrency": arguments.concurrency,
        }
    )
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="whalehall-training")
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help="versioned product training config",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    dataset = commands.add_parser("dataset")
    dataset_commands = dataset.add_subparsers(dest="dataset_command", required=True)
    validate = dataset_commands.add_parser("validate")
    validate.add_argument("input", type=Path)
    validate.add_argument("--maximum-issues", type=int, default=100)
    validate.set_defaults(handler=_dataset_validate)
    dedupe = dataset_commands.add_parser("dedupe")
    dedupe.add_argument("input", type=Path)
    dedupe.add_argument("output", type=Path)
    dedupe.add_argument("--report", type=Path, required=True)
    dedupe.add_argument("--threshold", type=float, default=0.9)
    dedupe.set_defaults(handler=_dataset_dedupe)
    export_runtime = dataset_commands.add_parser("export-runtime")
    export_runtime.add_argument("database", type=Path)
    export_runtime.add_argument("output", type=Path)
    export_runtime.add_argument("--manifest", type=Path, required=True)
    export_runtime.add_argument("--participant-id", required=True)
    export_runtime.add_argument("--session-timezone", required=True)
    export_runtime.add_argument("--project-goal-id")
    export_runtime.add_argument("--include-content", action="store_true")
    export_runtime.set_defaults(handler=_dataset_export_runtime)
    split = dataset_commands.add_parser("split")
    split.add_argument("input", type=Path)
    split.add_argument("output_directory", type=Path)
    split.add_argument("--targets", help="JSON object; default is fixed gold split")
    split.add_argument(
        "--grouping-level",
        choices=[
            "participant",
            "device",
            "project_goal",
            "session_day",
            "window",
        ],
        default="participant",
    )
    split.add_argument("--seed", type=int, default=17)
    split.add_argument("--allow-quota-drift", action="store_true")
    split.set_defaults(handler=_dataset_split)

    candidates = commands.add_parser("candidates")
    candidates.add_argument("input", type=Path)
    candidates.add_argument("output", type=Path)
    candidates.add_argument("--seed", type=int, default=17)
    candidates.set_defaults(handler=_candidate_select)

    teacher = commands.add_parser("teacher")
    teacher_commands = teacher.add_subparsers(dest="teacher_command", required=True)
    label = teacher_commands.add_parser("label")
    label.add_argument("input", type=Path)
    label.add_argument("output", type=Path)
    label.add_argument("--checkpoint", type=Path, required=True)
    label.add_argument("--pass", dest="pass_name", choices=["A", "B", "C"], required=True)
    label.add_argument("--pause-file", type=Path)
    label.add_argument(
        "--allowed-hours",
        metavar="HH:MM-HH:MM",
        help=(
            "local wall-clock interval; overnight ranges are supported and "
            "the run pauses cleanly outside it"
        ),
    )
    label.add_argument(
        "--no-thermal-guard",
        action="store_true",
        help="disable the default macOS thermal-pressure batch-boundary guard",
    )
    label.add_argument(
        "--thermal-unknown-policy",
        choices=["pause", "continue"],
        default="pause",
        help="fail-safe behavior when macOS thermal pressure cannot be read",
    )
    label.add_argument(
        "--thermal-backoff-seconds",
        type=float,
        default=60.0,
        help="cool-down before one thermal recheck",
    )
    label.add_argument(
        "--thermal-maximum-sleep-seconds",
        type=float,
        default=300.0,
        help="upper bound on a single thermal cool-down sleep",
    )
    label.add_argument("--dry-run", action="store_true")
    label.add_argument(
        "--thinking",
        action="store_true",
        help="only for explicitly selected high-risk arbitration",
    )
    label.set_defaults(handler=_teacher_label)
    high_risk = teacher_commands.add_parser("high-risk")
    high_risk.add_argument("windows", type=Path)
    high_risk.add_argument("output", type=Path)
    high_risk.add_argument("--votes", type=Path, nargs="+", required=True)
    high_risk.add_argument("--manifest", type=Path, required=True)
    high_risk.add_argument("--seed", type=int, default=29)
    high_risk.set_defaults(handler=_high_risk_select)
    aggregate = teacher_commands.add_parser("aggregate")
    aggregate.add_argument("windows", type=Path)
    aggregate.add_argument("output", type=Path)
    aggregate.add_argument("--votes", type=Path, nargs="+", required=True)
    aggregate.add_argument("--high-risk", type=Path)
    aggregate.add_argument("--human-queue", type=Path)
    aggregate.set_defaults(handler=_teacher_aggregate)
    weak = teacher_commands.add_parser("select-weak")
    weak.add_argument("input", type=Path)
    weak.add_argument("output", type=Path)
    weak.add_argument("--seed", type=int, default=43)
    weak.set_defaults(handler=_weak_select)
    gate = teacher_commands.add_parser("gate")
    gate.add_argument("gold", type=Path)
    gate.add_argument("output", type=Path)
    gate.add_argument("--votes", type=Path, nargs="+", required=True)
    gate.add_argument(
        "--attempted",
        type=int,
        help="number of gold windows submitted, not number of HTTP batches",
    )
    gate.add_argument(
        "--invalid-schema",
        type=int,
        default=0,
        help="number of submitted windows lost to schema-invalid responses",
    )
    gate.set_defaults(handler=_teacher_gate)
    benchmark = teacher_commands.add_parser("benchmark")
    benchmark.add_argument("checkpoint", type=Path)
    benchmark.add_argument("output", type=Path)
    benchmark.add_argument(
        "--pass",
        dest="pass_name",
        choices=["A", "B", "C"],
        default="A",
    )
    benchmark.add_argument("--minimum-labels", type=int, default=1000)
    benchmark.set_defaults(handler=_teacher_benchmark)

    materialize = commands.add_parser("materialize")
    materialize.add_argument("windows", type=Path)
    materialize.add_argument("output", type=Path)
    materialize.add_argument("--weak-labels", type=Path)
    materialize.set_defaults(handler=_student_materialize)

    train = commands.add_parser("train")
    train_commands = train.add_subparsers(dest="train_command", required=True)
    dapt = train_commands.add_parser("dapt")
    dapt.add_argument("input", type=Path)
    dapt.add_argument("output_directory", type=Path)
    dapt.add_argument(
        "--validation",
        type=Path,
        help="independent held-out EventWindow JSONL; required outside smoke runs",
    )
    dapt.add_argument("--epochs", type=int, default=1)
    dapt.add_argument("--batch-size", type=int, default=8)
    dapt.add_argument("--learning-rate", type=float, default=5e-5)
    dapt.add_argument("--seed", type=int, default=17)
    dapt.add_argument("--device")
    dapt.add_argument("--maximum-steps", type=int)
    dapt.add_argument("--minimum-delta", type=float, default=0.0)
    dapt.set_defaults(handler=_train_dapt)
    student = train_commands.add_parser("student")
    student.add_argument("input", type=Path)
    student.add_argument("output_directory", type=Path)
    student.add_argument(
        "--validation",
        type=Path,
        help="independent held-out student-example JSONL; required outside smoke runs",
    )
    student.add_argument("--base-model")
    student.add_argument(
        "--epochs",
        type=int,
        help="default 2 for distillation and 5 for --hard-only",
    )
    student.add_argument("--batch-size", type=int)
    student.add_argument(
        "--mixed-precision",
        choices=["auto", "bf16", "fp16", "fp32"],
        help="auto selects CUDA bf16 when supported, otherwise CUDA fp16",
    )
    student.add_argument(
        "--no-gradient-checkpointing",
        action="store_true",
        help="diagnostic override; formal 8,192-token runs keep it enabled",
    )
    student.add_argument("--learning-rate", type=float, default=2e-5)
    student.add_argument("--seed", type=int, default=17)
    student.add_argument("--device")
    student.add_argument("--maximum-steps", type=int)
    student.add_argument("--patience", type=int, default=2)
    student.add_argument("--minimum-delta", type=float, default=0.0)
    student.add_argument(
        "--model-version",
        default="modernbert-whalehall-v1",
    )
    student.add_argument(
        "--distillation-temperature",
        type=float,
        choices=[1.0, 2.0, 4.0],
    )
    student.add_argument(
        "--distillation-weight",
        type=float,
        choices=[0.25, 0.4, 0.55],
    )
    student.add_argument("--disable-kd", action="store_true")
    student.add_argument("--disable-contrastive", action="store_true")
    student.add_argument("--hard-only", action="store_true")
    student.set_defaults(handler=_train_student)

    calibrate = commands.add_parser("calibrate")
    calibrate.add_argument("input", type=Path)
    calibrate.add_argument("output", type=Path)
    calibrate.set_defaults(handler=_calibrate)
    finalize = commands.add_parser("finalize-runtime")
    finalize.add_argument("artifact_directory", type=Path)
    finalize.add_argument("calibration", type=Path)
    finalize.set_defaults(handler=_finalize_runtime)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("input", type=Path)
    evaluate.add_argument("output", type=Path)
    evaluate.add_argument("--confidence-threshold", type=float, default=0.9)
    evaluate.add_argument("--gold-only-macro-f1", type=float, required=True)
    evaluate.add_argument(
        "--allow-fail",
        action="store_true",
        help="write a diagnostic report without enforcing the launch gate",
    )
    evaluate.set_defaults(handler=_evaluate)
    manifest = commands.add_parser("manifest")
    manifest.add_argument("directory", type=Path)
    manifest.add_argument("output", type=Path)
    manifest.add_argument("--model-version", required=True)
    manifest.set_defaults(handler=_manifest)
    smoke = commands.add_parser("smoke")
    smoke.add_argument("directory", type=Path)
    smoke.set_defaults(handler=_artifact_smoke)
    serve = commands.add_parser("serve")
    serve.add_argument("artifact_directory", type=Path)
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument("--device", default="cpu")
    serve.add_argument("--concurrency", type=int, default=1)
    serve.add_argument(
        "--token-env",
        default="WHALEHALL_MODERNBERT_TOKEN",
        help="environment variable containing the optional bearer token",
    )
    serve.add_argument(
        "--maximum-request-bytes",
        type=int,
        default=DEFAULT_MAX_REQUEST_BYTES,
    )
    serve.add_argument(
        "--maximum-response-bytes",
        type=int,
        default=DEFAULT_MAX_RESPONSE_BYTES,
    )
    serve.add_argument(
        "--maximum-model-input-bytes",
        type=int,
        default=DEFAULT_MAX_MODEL_INPUT_BYTES,
    )
    serve.set_defaults(handler=_serve)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        return int(arguments.handler(arguments))
    except (
        OSError,
        ValueError,
        ValidationError,
        TeacherError,
        MissingTrainingDependency,
    ) as error:
        parser.error(str(error))
    return 2
