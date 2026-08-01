from __future__ import annotations

import hashlib
import json
import math
import random
import tempfile
from contextlib import nullcontext
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

from .contracts import ACTIVITY_LABELS, GOAL_RELEVANCE_LABELS
from .metrics import expected_calibration_error, fit_temperature
from .model_input import (
    DEFAULT_STUDENT_MAXIMUM_TOKENS,
    ModelInputContractError,
    event_token_mask_from_offsets,
    expected_runtime_input_format,
    parse_model_input,
    prepare_model_input,
    tokenizer_fingerprint,
)
from .model import (
    MissingTrainingDependency,
    MultiTaskModelConfig,
    build_multitask_model,
    compute_multitask_loss,
)


def _dependencies() -> tuple[Any, Any, Any, Any]:
    try:
        import torch
        from torch.utils.data import DataLoader, IterableDataset
        from transformers import (
            AutoModelForMaskedLM,
            AutoTokenizer,
            DataCollatorForLanguageModeling,
        )
    except ImportError as error:
        raise MissingTrainingDependency(
            "GPU commands require torch and transformers. Install them only "
            "in the dedicated 16–24 GiB CUDA training environment."
        ) from error
    return (
        torch,
        (DataLoader, IterableDataset),
        (AutoModelForMaskedLM, AutoTokenizer),
        DataCollatorForLanguageModeling,
    )


def _iter_json_objects(path: Path) -> Iterator[Mapping[str, Any]]:
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, Mapping):
                raise ValueError(f"{path}:{line_number} must contain an object")
            yield value


def _device(torch: Any, requested: str | None = None) -> Any:
    if requested is not None:
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _set_seed(torch: Any, seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


TRAINING_PRECISIONS = frozenset({"auto", "bf16", "fp16", "fp32"})


def resolve_training_precision(
    requested: str,
    *,
    device_type: str,
    cuda_bf16_supported: bool = False,
) -> str:
    """Resolve a portable precision request without importing torch."""

    if requested not in TRAINING_PRECISIONS:
        raise ValueError(
            "mixed_precision must be one of auto, bf16, fp16, fp32"
        )
    if device_type == "cuda":
        if requested == "auto":
            return "bf16" if cuda_bf16_supported else "fp16"
        if requested == "bf16" and not cuda_bf16_supported:
            raise ValueError("requested CUDA device does not support bf16")
        return requested
    if requested in {"bf16", "fp16"}:
        raise ValueError(
            f"{requested} mixed precision is only supported on CUDA training"
        )
    return "fp32"


def _autocast_context(
    torch: Any,
    *,
    device_type: str,
    resolved_precision: str,
) -> Any:
    if resolved_precision == "bf16":
        return torch.autocast(device_type=device_type, dtype=torch.bfloat16)
    if resolved_precision == "fp16":
        return torch.autocast(device_type=device_type, dtype=torch.float16)
    return nullcontext()


def _fp16_grad_scaler(torch: Any, *, enabled: bool) -> Any:
    if not enabled:
        return None
    amp = getattr(torch, "amp", None)
    scaler_type = getattr(amp, "GradScaler", None)
    if scaler_type is not None:
        try:
            return scaler_type("cuda", enabled=True)
        except TypeError:
            return scaler_type(enabled=True)
    return torch.cuda.amp.GradScaler(enabled=True)


@dataclass(frozen=True)
class EarlyStoppingDecision:
    best_epoch: int | None
    best_loss: float | None
    stale_epochs: int
    last_improved: bool
    should_stop: bool
    reason: str


def early_stopping_decision(
    validation_losses: Sequence[float],
    *,
    patience: int,
    minimum_delta: float = 0.0,
    baseline_loss: float | None = None,
) -> EarlyStoppingDecision:
    """Select a best epoch and stop state without importing torch.

    Epoch zero denotes an optional frozen pre-training baseline. Trained
    epochs are one-indexed.
    """

    if patience < 1:
        raise ValueError("early-stopping patience must be at least one")
    if minimum_delta < 0:
        raise ValueError("early-stopping minimum delta must be non-negative")
    if baseline_loss is not None and not math.isfinite(baseline_loss):
        raise ValueError("baseline validation loss must be finite")
    best_loss = baseline_loss
    best_epoch = 0 if baseline_loss is not None else None
    stale_epochs = 0
    last_improved = False
    for epoch, loss in enumerate(validation_losses, start=1):
        if not math.isfinite(loss):
            raise ValueError("validation losses must be finite")
        improved = best_loss is None or loss < best_loss - minimum_delta
        if improved:
            best_loss = loss
            best_epoch = epoch
            stale_epochs = 0
        else:
            stale_epochs += 1
        last_improved = improved
    should_stop = bool(validation_losses) and stale_epochs >= patience
    if not validation_losses:
        reason = "awaiting_validation"
    elif should_stop:
        reason = "patience_exhausted"
    elif last_improved:
        reason = "validation_improved"
    else:
        reason = "within_patience"
    return EarlyStoppingDecision(
        best_epoch=best_epoch,
        best_loss=best_loss,
        stale_epochs=stale_epochs,
        last_improved=last_improved,
        should_stop=should_stop,
        reason=reason,
    )


@dataclass(frozen=True)
class DaptConfig:
    input_path: Path
    output_directory: Path
    base_model: str = "answerdotai/ModernBERT-base"
    validation_path: Path | None = None
    epochs: int = 1
    maximum_tokens: int = 1024
    batch_size: int = 8
    learning_rate: float = 5e-5
    weight_decay: float = 0.01
    seed: int = 17
    device: str | None = None
    maximum_steps: int | None = None
    minimum_delta: float = 0.0


def validate_dapt_config(config: DaptConfig) -> None:
    if not 1 <= config.epochs <= 2:
        raise ValueError("DAPT is capped at two epochs")
    if config.maximum_steps is not None and config.maximum_steps < 1:
        raise ValueError("maximum_steps must be positive")
    if config.minimum_delta < 0:
        raise ValueError("minimum_delta must be non-negative")
    if config.maximum_steps is None:
        if config.validation_path is None:
            raise ValueError(
                "formal DAPT requires an independent --validation JSONL"
            )
        if config.validation_path.resolve() == config.input_path.resolve():
            raise ValueError("DAPT training and validation JSONL must differ")


def run_dapt(config: DaptConfig) -> dict[str, object]:
    """Run streaming masked-language domain adaptation on EventWindow JSONL."""

    validate_dapt_config(config)
    torch, data_types, transformer_types, collator_type = _dependencies()
    data_loader_type, iterable_dataset_type = data_types
    auto_mlm, auto_tokenizer = transformer_types
    _set_seed(torch, config.seed)
    device = _device(torch, config.device)
    tokenizer = auto_tokenizer.from_pretrained(config.base_model)
    model = auto_mlm.from_pretrained(config.base_model).to(device)
    collator = collator_type(
        tokenizer=tokenizer,
        mlm=True,
        mlm_probability=0.15,
    )

    class WindowTextDataset(iterable_dataset_type):  # type: ignore[misc]
        def __init__(self, path: Path) -> None:
            super().__init__()
            self.path = path

        def __iter__(self) -> Iterator[dict[str, Any]]:
            worker = torch.utils.data.get_worker_info()
            for index, value in enumerate(_iter_json_objects(self.path)):
                if worker is not None and index % worker.num_workers != worker.id:
                    continue
                model_input = value.get("modelInput")
                if not isinstance(model_input, str) or not model_input:
                    continue
                encoded = tokenizer(
                    model_input,
                    truncation=True,
                    max_length=config.maximum_tokens,
                    add_special_tokens=True,
                    return_overflowing_tokens=True,
                    return_special_tokens_mask=True,
                )
                input_rows = encoded["input_ids"]
                if input_rows and not isinstance(input_rows[0], Sequence):
                    input_rows = [input_rows]
                for row_index in range(len(input_rows)):
                    yield {
                        key: (
                            value[row_index]
                            if isinstance(value, Sequence)
                            and value
                            and isinstance(value[0], Sequence)
                            else value
                        )
                        for key, value in encoded.items()
                        if key
                        in {
                            "input_ids",
                            "attention_mask",
                            "token_type_ids",
                            "special_tokens_mask",
                        }
                    }

    loader = data_loader_type(
        WindowTextDataset(config.input_path),
        batch_size=config.batch_size,
        collate_fn=collator,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=config.learning_rate,
        weight_decay=config.weight_decay,
    )
    step = 0
    cumulative_loss = 0.0
    validation_losses: list[float] = []
    baseline_validation_loss: float | None = None
    best_epoch: int | None = None
    best_validation_loss: float | None = None
    stop_reason = "smoke_maximum_steps_no_early_stopping"

    def evaluate_validation() -> float:
        if config.validation_path is None:
            raise RuntimeError("validation path is required for formal DAPT")
        random_state = torch.random.get_rng_state()
        torch.manual_seed(config.seed + 100_000)
        model.eval()
        total_loss = 0.0
        total_examples = 0
        validation_loader = data_loader_type(
            WindowTextDataset(config.validation_path),
            batch_size=config.batch_size,
            collate_fn=collator,
        )
        try:
            with torch.no_grad():
                for batch in validation_loader:
                    batch = {
                        key: value.to(device) for key, value in batch.items()
                    }
                    output = model(**batch)
                    batch_size = int(batch["input_ids"].shape[0])
                    total_loss += float(output.loss.detach().cpu()) * batch_size
                    total_examples += batch_size
        finally:
            torch.random.set_rng_state(random_state)
        if total_examples == 0:
            raise ValueError("DAPT validation JSONL contains no usable windows")
        return total_loss / total_examples

    config.output_directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".whalehall-dapt-best-",
        dir=config.output_directory.parent,
    ) as temporary_directory:
        best_state_path = Path(temporary_directory) / "state.pt"
        if config.maximum_steps is None:
            baseline_validation_loss = evaluate_validation()
            best_validation_loss = baseline_validation_loss
            best_epoch = 0
            torch.save(model.state_dict(), best_state_path)

        for epoch in range(1, config.epochs + 1):
            model.train()
            epoch_steps = 0
            for batch in loader:
                batch = {key: value.to(device) for key, value in batch.items()}
                optimizer.zero_grad(set_to_none=True)
                output = model(**batch)
                output.loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                step += 1
                epoch_steps += 1
                cumulative_loss += float(output.loss.detach().cpu())
                if (
                    config.maximum_steps is not None
                    and step >= config.maximum_steps
                ):
                    break
            if epoch_steps == 0:
                raise ValueError("DAPT training JSONL contains no usable windows")
            if config.maximum_steps is not None:
                if step >= config.maximum_steps:
                    break
                continue
            validation_losses.append(evaluate_validation())
            decision = early_stopping_decision(
                validation_losses,
                patience=1,
                minimum_delta=config.minimum_delta,
                baseline_loss=baseline_validation_loss,
            )
            best_epoch = decision.best_epoch
            best_validation_loss = decision.best_loss
            if decision.last_improved:
                torch.save(model.state_dict(), best_state_path)
            if decision.should_stop:
                stop_reason = decision.reason
                break
        else:
            if config.maximum_steps is None:
                stop_reason = "maximum_epochs"

        if config.maximum_steps is None:
            model.load_state_dict(
                torch.load(
                    best_state_path,
                    map_location=device,
                    weights_only=True,
                ),
                strict=True,
            )

    config.output_directory.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(config.output_directory)
    tokenizer.save_pretrained(config.output_directory)
    metrics = {
        "stage": "dapt",
        "steps": step,
        "meanLoss": cumulative_loss / step if step else 0.0,
        "formalEarlyStopping": config.maximum_steps is None,
        "baselineValidationLoss": baseline_validation_loss,
        "validationLosses": [
            {"epoch": epoch, "loss": loss}
            for epoch, loss in enumerate(validation_losses, start=1)
        ],
        "bestEpoch": best_epoch,
        "bestValidationLoss": best_validation_loss,
        "acceptedOverBaseline": (
            None
            if config.maximum_steps is not None
            else best_epoch is not None and best_epoch > 0
        ),
        "stopReason": stop_reason,
        "config": {
            **asdict(config),
            "input_path": str(config.input_path),
            "output_directory": str(config.output_directory),
            "validation_path": (
                None
                if config.validation_path is None
                else str(config.validation_path)
            ),
        },
    }
    _write_json(config.output_directory / "dapt-metrics.json", metrics)
    return metrics


@dataclass(frozen=True)
class StudentExample:
    example_id: str
    goal_text: str | None
    model_input: str
    activity: str
    goal_relevance: str | None
    activity_distribution: tuple[float, ...]
    relevance_distribution: tuple[float, ...]
    weight: float


def parse_student_example(value: Mapping[str, Any]) -> StudentExample:
    if value.get("schemaVersion") != "student-example.v1":
        raise ValueError("student example schemaVersion must be student-example.v1")
    activity = value.get("activity")
    relevance = value.get("goalRelevance")
    if activity not in ACTIVITY_LABELS:
        raise ValueError("student example activity is outside the v1 taxonomy")
    if relevance is not None and relevance not in GOAL_RELEVANCE_LABELS:
        raise ValueError(
            "student example goalRelevance is outside the v1 taxonomy"
        )
    goal_text = value.get("goalText")
    if goal_text is not None and not isinstance(goal_text, str):
        raise ValueError("student example goalText must be string or null")
    if goal_text is None and relevance is not None:
        raise ValueError("no-goal student examples must use null goalRelevance")
    model_input = value.get("modelInput")
    if not isinstance(model_input, str) or not model_input:
        raise ValueError("student example modelInput must be non-empty")
    try:
        parsed_input = parse_model_input(model_input)
    except ModelInputContractError as error:
        raise ValueError(
            "student example modelInput violates deterministic input contract"
        ) from error
    if goal_text is None:
        if parsed_input.goal_section != "null":
            raise ValueError(
                "no-goal student example must embed null in modelInput"
            )
    else:
        try:
            embedded_goal = json.loads(parsed_input.goal_section)
        except json.JSONDecodeError as error:
            raise ValueError(
                "student example modelInput goal must be valid JSON"
            ) from error
        if (
            not isinstance(embedded_goal, Mapping)
            or embedded_goal.get("text") != goal_text
        ):
            raise ValueError(
                "student example goalText must match immutable modelInput"
            )
    activity_distribution_value = value.get("activityDistribution")
    relevance_distribution_value = value.get("relevanceDistribution")
    if not isinstance(activity_distribution_value, Mapping):
        raise ValueError("activityDistribution must be an object")
    if not isinstance(relevance_distribution_value, Mapping):
        raise ValueError("relevanceDistribution must be an object")
    activity_distribution = tuple(
        float(activity_distribution_value.get(label, 0.0))
        for label in ACTIVITY_LABELS
    )
    relevance_distribution = tuple(
        float(relevance_distribution_value.get(label, 0.0))
        for label in GOAL_RELEVANCE_LABELS
    )
    if abs(sum(activity_distribution) - 1.0) > 1e-5:
        raise ValueError("activityDistribution must sum to 1")
    if goal_text is not None and abs(sum(relevance_distribution) - 1.0) > 1e-5:
        raise ValueError("goal relevance distribution must sum to 1")
    return StudentExample(
        example_id=str(value["exampleId"]),
        goal_text=goal_text,
        model_input=model_input,
        activity=str(activity),
        goal_relevance=None if relevance is None else str(relevance),
        activity_distribution=activity_distribution,
        relevance_distribution=relevance_distribution,
        weight=float(value["weight"]),
    )


def _shuffle_buffer(
    values: Iterable[StudentExample],
    *,
    seed: int,
    size: int = 4096,
) -> Iterator[StudentExample]:
    randomizer = random.Random(seed)
    buffer: list[StudentExample] = []
    for value in values:
        if len(buffer) < size:
            buffer.append(value)
            continue
        index = randomizer.randrange(len(buffer))
        yield buffer[index]
        buffer[index] = value
    randomizer.shuffle(buffer)
    yield from buffer


@dataclass(frozen=True)
class StudentTrainingConfig:
    input_path: Path
    output_directory: Path
    base_model: str
    validation_path: Path | None = None
    epochs: int = 2
    maximum_tokens: int = DEFAULT_STUDENT_MAXIMUM_TOKENS
    batch_size: int = 4
    mixed_precision: str = "auto"
    gradient_checkpointing: bool = True
    learning_rate: float = 2e-5
    weight_decay: float = 0.01
    embedding_dimensions: int = 256
    hard_weight: float = 0.45
    distillation_weight: float = 0.40
    contrastive_weight: float = 0.15
    distillation_temperature: float = 2.0
    seed: int = 17
    device: str | None = None
    maximum_steps: int | None = None
    model_version: str = "modernbert-whalehall-v1"
    hard_only: bool = False
    early_stopping_patience: int = 2
    minimum_delta: float = 0.0


def validate_student_training_config(config: StudentTrainingConfig) -> None:
    maximum_epochs = 5 if config.hard_only else 2
    if not 1 <= config.epochs <= maximum_epochs:
        mode = "gold-only" if config.hard_only else "weak-label distillation"
        raise ValueError(f"{mode} training is capped at {maximum_epochs} epochs")
    if config.hard_only and (
        abs(config.hard_weight - 1.0) > 1e-9
        or config.distillation_weight != 0
        or config.contrastive_weight != 0
    ):
        raise ValueError("hard-only training requires loss weights 1.0/0.0/0.0")
    if config.hard_only and config.early_stopping_patience != 2:
        raise ValueError("gold-only early-stopping patience is pinned to 2")
    if any(
        weight < 0
        for weight in (
            config.hard_weight,
            config.distillation_weight,
            config.contrastive_weight,
        )
    ) or abs(
        config.hard_weight
        + config.distillation_weight
        + config.contrastive_weight
        - 1.0
    ) > 1e-9:
        raise ValueError("student loss weights must be non-negative and sum to one")
    if config.early_stopping_patience < 1:
        raise ValueError("student early-stopping patience must be positive")
    if config.minimum_delta < 0:
        raise ValueError("minimum_delta must be non-negative")
    if config.maximum_steps is not None and config.maximum_steps < 1:
        raise ValueError("maximum_steps must be positive")
    if config.batch_size < 1:
        raise ValueError("student batch_size must be positive")
    if config.contrastive_weight > 0 and config.batch_size < 3:
        raise ValueError(
            "supervised contrastive loss requires batch_size >= 3; "
            "use a larger CUDA node or explicitly disable contrastive"
        )
    if config.mixed_precision not in TRAINING_PRECISIONS:
        raise ValueError(
            "mixed_precision must be one of auto, bf16, fp16, fp32"
        )
    if not 1 <= config.maximum_tokens <= DEFAULT_STUDENT_MAXIMUM_TOKENS:
        raise ValueError(
            "student maximum_tokens must be between 1 and "
            f"{DEFAULT_STUDENT_MAXIMUM_TOKENS}"
        )
    if config.maximum_steps is None:
        if config.validation_path is None:
            raise ValueError(
                "formal student training requires an independent "
                "--validation JSONL"
            )
        if config.validation_path.resolve() == config.input_path.resolve():
            raise ValueError(
                "student training and validation JSONL must differ"
            )


def student_runtime_metadata(
    config: StudentTrainingConfig,
    *,
    dropout: float = 0.1,
    tokenizer_sha256: str | None = None,
    resolved_precision: str | None = None,
) -> dict[str, object]:
    """Create portable runtime metadata without training-machine paths."""

    return {
        "schemaVersion": "modernbert-runtime.v2",
        "modelVersion": config.model_version,
        "modelFamily": "ModernBERT",
        "encoderConfig": "config.json",
        "weights": "student.pt",
        "maximumTokens": config.maximum_tokens,
        "tokenizerSha256": tokenizer_sha256,
        "inputFormat": expected_runtime_input_format(),
        "trainingExecution": {
            "requestedPrecision": config.mixed_precision,
            "resolvedPrecision": resolved_precision,
            "gradientCheckpointing": config.gradient_checkpointing,
            "microBatchSize": config.batch_size,
        },
        "oodScoring": "max_normalized_entropy.v1",
        "architecture": {
            "activityClasses": len(ACTIVITY_LABELS),
            "relevanceClasses": len(GOAL_RELEVANCE_LABELS),
            "embeddingDimensions": config.embedding_dimensions,
            "dropout": dropout,
        },
        "taxonomy": {
            "version": "activity-taxonomy.v1",
            "activities": list(ACTIVITY_LABELS),
            "goalRelevance": list(GOAL_RELEVANCE_LABELS),
        },
        "calibration": {
            "version": "temperature-scaling.v1",
            "calibrated": False,
            "activityTemperature": 1.0,
            "relevanceTemperature": 1.0,
        },
    }


def run_student_training(config: StudentTrainingConfig) -> dict[str, object]:
    """Train all three heads using a streaming, deterministic JSONL loader."""

    validate_student_training_config(config)
    torch, data_types, transformer_types, _ = _dependencies()
    data_loader_type, iterable_dataset_type = data_types
    _, auto_tokenizer = transformer_types
    _set_seed(torch, config.seed)
    device = _device(torch, config.device)
    cuda_bf16_supported = bool(
        device.type == "cuda"
        and callable(getattr(torch.cuda, "is_bf16_supported", None))
        and torch.cuda.is_bf16_supported()
    )
    resolved_precision = resolve_training_precision(
        config.mixed_precision,
        device_type=str(device.type),
        cuda_bf16_supported=cuda_bf16_supported,
    )
    tokenizer = auto_tokenizer.from_pretrained(config.base_model)
    # Fail before an expensive run if the selected checkpoint did not ship the
    # required fast tokenizer. The final fingerprint is computed after the
    # saved artifact is reloaded locally.
    training_tokenizer_sha256 = tokenizer_fingerprint(tokenizer)
    model = build_multitask_model(
        MultiTaskModelConfig(
            base_model=config.base_model,
            embedding_dimensions=config.embedding_dimensions,
        )
    )
    if config.gradient_checkpointing:
        enable_checkpointing = getattr(
            model.encoder,
            "gradient_checkpointing_enable",
            None,
        )
        if not callable(enable_checkpointing):
            raise ValueError(
                "selected encoder does not support gradient checkpointing"
            )
        try:
            enable_checkpointing(
                gradient_checkpointing_kwargs={"use_reentrant": False}
            )
        except TypeError:
            enable_checkpointing()
        if hasattr(model.encoder.config, "use_cache"):
            model.encoder.config.use_cache = False
    model = model.to(device)
    encoder_limit = int(
        getattr(model.encoder.config, "max_position_embeddings", 0)
    )
    if encoder_limit < config.maximum_tokens:
        raise ValueError(
            "student maximum_tokens exceeds encoder "
            f"max_position_embeddings ({encoder_limit})"
        )
    activity_indexes = {
        label: index for index, label in enumerate(ACTIVITY_LABELS)
    }
    relevance_indexes = {
        label: index for index, label in enumerate(GOAL_RELEVANCE_LABELS)
    }

    class ExampleDataset(iterable_dataset_type):  # type: ignore[misc]
        def __init__(
            self,
            path: Path,
            epoch: int,
            *,
            shuffle: bool,
        ) -> None:
            super().__init__()
            self.path = path
            self.epoch = epoch
            self.shuffle = shuffle

        def __iter__(self) -> Iterator[StudentExample]:
            worker = torch.utils.data.get_worker_info()
            examples = (
                parse_student_example(value)
                for index, value in enumerate(_iter_json_objects(self.path))
                if worker is None
                or index % worker.num_workers == worker.id
            )
            if self.shuffle:
                yield from _shuffle_buffer(
                    examples, seed=config.seed + self.epoch
                )
            else:
                yield from examples

    def collate(examples: Sequence[StudentExample]) -> dict[str, Any]:
        prepared = [
            prepare_model_input(
                example.model_input,
                tokenizer,
                maximum_tokens=config.maximum_tokens,
            )
            for example in examples
        ]
        encoded = tokenizer(
            [item.text for item in prepared],
            truncation=False,
            padding=True,
            return_tensors="pt",
            return_offsets_mapping=True,
        )
        offset_mapping = encoded.pop("offset_mapping")
        event_masks = []
        for row_index, item in enumerate(prepared):
            attended = encoded["attention_mask"][row_index].tolist()
            if sum(int(value) for value in attended) > config.maximum_tokens:
                raise RuntimeError(
                    "locked tokenizer exceeded the verified input budget"
                )
            event_masks.append(
                event_token_mask_from_offsets(
                    offset_mapping[row_index].tolist(),
                    attended,
                    event_character_start=item.event_character_start,
                )
            )
        event_mask = torch.tensor(event_masks, dtype=torch.long)
        return {
            **encoded,
            "event_token_mask": event_mask,
            "activity_targets": torch.tensor(
                [activity_indexes[item.activity] for item in examples],
                dtype=torch.long,
            ),
            "relevance_targets": torch.tensor(
                [
                    -1
                    if item.goal_relevance is None
                    else relevance_indexes[item.goal_relevance]
                    for item in examples
                ],
                dtype=torch.long,
            ),
            "teacher_activity_distribution": torch.tensor(
                [item.activity_distribution for item in examples],
                dtype=torch.float32,
            ),
            "teacher_relevance_distribution": torch.tensor(
                [item.relevance_distribution for item in examples],
                dtype=torch.float32,
            ),
            "sample_weights": torch.tensor(
                [item.weight for item in examples],
                dtype=torch.float32,
            ),
        }

    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=config.learning_rate,
        weight_decay=config.weight_decay,
    )
    grad_scaler = _fp16_grad_scaler(
        torch,
        enabled=resolved_precision == "fp16",
    )
    steps = 0
    totals: dict[str, float] = {
        "loss": 0.0,
        "hard_loss": 0.0,
        "distillation_loss": 0.0,
        "contrastive_loss": 0.0,
    }
    validation_losses: list[float] = []
    best_epoch: int | None = None
    best_validation_loss: float | None = None
    stop_reason = "smoke_maximum_steps_no_early_stopping"

    def calculate_losses(batch: Mapping[str, Any]) -> dict[str, Any]:
        outputs = model(
            input_ids=batch["input_ids"],
            attention_mask=batch["attention_mask"],
            event_token_mask=batch["event_token_mask"],
        )
        return compute_multitask_loss(
            outputs,
            activity_targets=batch["activity_targets"],
            relevance_targets=batch["relevance_targets"],
            teacher_activity_distribution=batch[
                "teacher_activity_distribution"
            ],
            teacher_relevance_distribution=batch[
                "teacher_relevance_distribution"
            ],
            sample_weights=batch["sample_weights"],
            hard_weight=config.hard_weight,
            distillation_weight=config.distillation_weight,
            contrastive_weight=config.contrastive_weight,
            distillation_temperature=config.distillation_temperature,
        )

    def evaluate_validation() -> float:
        if config.validation_path is None:
            raise RuntimeError("validation path is required for formal training")
        model.eval()
        validation_loader = data_loader_type(
            ExampleDataset(config.validation_path, 0, shuffle=False),
            batch_size=config.batch_size,
            collate_fn=collate,
        )
        total_loss = 0.0
        total_examples = 0
        with torch.no_grad():
            for batch in validation_loader:
                batch = {key: value.to(device) for key, value in batch.items()}
                with _autocast_context(
                    torch,
                    device_type=str(device.type),
                    resolved_precision=resolved_precision,
                ):
                    losses = calculate_losses(batch)
                batch_size = int(batch["input_ids"].shape[0])
                total_loss += float(losses["loss"].detach().cpu()) * batch_size
                total_examples += batch_size
        if total_examples == 0:
            raise ValueError(
                "student validation JSONL contains no usable examples"
            )
        return total_loss / total_examples

    config.output_directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".whalehall-student-best-",
        dir=config.output_directory.parent,
    ) as temporary_directory:
        best_state_path = Path(temporary_directory) / "state.pt"
        for epoch in range(1, config.epochs + 1):
            model.train()
            epoch_steps = 0
            loader = data_loader_type(
                ExampleDataset(config.input_path, epoch, shuffle=True),
                batch_size=config.batch_size,
                collate_fn=collate,
            )
            for batch in loader:
                batch = {key: value.to(device) for key, value in batch.items()}
                optimizer.zero_grad(set_to_none=True)
                with _autocast_context(
                    torch,
                    device_type=str(device.type),
                    resolved_precision=resolved_precision,
                ):
                    losses = calculate_losses(batch)
                if grad_scaler is not None:
                    grad_scaler.scale(losses["loss"]).backward()
                    grad_scaler.unscale_(optimizer)
                else:
                    losses["loss"].backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                if grad_scaler is not None:
                    grad_scaler.step(optimizer)
                    grad_scaler.update()
                else:
                    optimizer.step()
                steps += 1
                epoch_steps += 1
                for key in totals:
                    totals[key] += float(losses[key].detach().cpu())
                if (
                    config.maximum_steps is not None
                    and steps >= config.maximum_steps
                ):
                    break
            if epoch_steps == 0:
                raise ValueError(
                    "student training JSONL contains no usable examples"
                )
            if config.maximum_steps is not None:
                if steps >= config.maximum_steps:
                    break
                continue
            validation_losses.append(evaluate_validation())
            decision = early_stopping_decision(
                validation_losses,
                patience=config.early_stopping_patience,
                minimum_delta=config.minimum_delta,
            )
            best_epoch = decision.best_epoch
            best_validation_loss = decision.best_loss
            if decision.last_improved:
                torch.save(model.state_dict(), best_state_path)
            if decision.should_stop:
                stop_reason = decision.reason
                break
        else:
            if config.maximum_steps is None:
                stop_reason = "maximum_epochs"

        if config.maximum_steps is None:
            model.load_state_dict(
                torch.load(
                    best_state_path,
                    map_location=device,
                    weights_only=True,
                ),
                strict=True,
            )

    config.output_directory.mkdir(parents=True, exist_ok=True)
    model.encoder.config._name_or_path = "answerdotai/ModernBERT-base"
    model.encoder.config.save_pretrained(config.output_directory)
    portable_model_config = asdict(model.whalehall_config)
    portable_model_config["base_model"] = "."
    torch.save(
        {
            "stateDict": model.state_dict(),
            "modelConfig": portable_model_config,
            "taxonomy": {
                "activities": list(ACTIVITY_LABELS),
                "goalRelevance": list(GOAL_RELEVANCE_LABELS),
            },
        },
        config.output_directory / "student.pt",
    )
    tokenizer.name_or_path = "answerdotai/ModernBERT-base"
    if isinstance(getattr(tokenizer, "init_kwargs", None), dict):
        tokenizer.init_kwargs["name_or_path"] = "answerdotai/ModernBERT-base"
    tokenizer.save_pretrained(config.output_directory)
    artifact_tokenizer = auto_tokenizer.from_pretrained(
        config.output_directory,
        local_files_only=True,
    )
    locked_tokenizer_sha256 = tokenizer_fingerprint(artifact_tokenizer)
    if locked_tokenizer_sha256 != training_tokenizer_sha256:
        raise RuntimeError(
            "saved artifact tokenizer changed the training tokenization graph"
        )
    runtime = student_runtime_metadata(
        config,
        dropout=float(model.whalehall_config.dropout),
        tokenizer_sha256=locked_tokenizer_sha256,
        resolved_precision=resolved_precision,
    )
    _write_json(config.output_directory / "runtime.json", runtime)
    metrics = {
        "stage": "student",
        "steps": steps,
        "meanLosses": {
            key: value / steps if steps else 0.0
            for key, value in totals.items()
        },
        "mode": "gold_only" if config.hard_only else "weak_distillation",
        "formalEarlyStopping": config.maximum_steps is None,
        "validationLosses": [
            {"epoch": epoch, "loss": loss}
            for epoch, loss in enumerate(validation_losses, start=1)
        ],
        "bestEpoch": best_epoch,
        "bestValidationLoss": best_validation_loss,
        "stopReason": stop_reason,
        "seed": config.seed,
        "baseModel": config.base_model,
        "embeddingDimensions": config.embedding_dimensions,
        "modelVersion": config.model_version,
        "trainingExecution": {
            "requestedPrecision": config.mixed_precision,
            "resolvedPrecision": resolved_precision,
            "gradientCheckpointing": config.gradient_checkpointing,
            "microBatchSize": config.batch_size,
        },
    }
    _write_json(config.output_directory / "training-metrics.json", metrics)
    return metrics


def calibrate_from_jsonl(
    input_path: Path,
    output_path: Path,
) -> dict[str, object]:
    activity_logits: list[list[float]] = []
    activity_targets: list[int] = []
    relevance_logits: list[list[float]] = []
    relevance_targets: list[int] = []
    for value in _iter_json_objects(input_path):
        activity_logits.append([float(item) for item in value["activityLogits"]])
        activity_targets.append(int(value["activityTarget"]))
        if value.get("relevanceTarget") is not None:
            relevance_logits.append(
                [float(item) for item in value["relevanceLogits"]]
            )
            relevance_targets.append(int(value["relevanceTarget"]))
    activity_temperature = fit_temperature(
        activity_logits, activity_targets
    )
    relevance_temperature = (
        fit_temperature(relevance_logits, relevance_targets)
        if relevance_logits
        else 1.0
    )
    result = {
        "calibrationVersion": "temperature-scaling.v1",
        "activityTemperature": activity_temperature,
        "relevanceTemperature": relevance_temperature,
        "activityEce": expected_calibration_error(
            activity_logits,
            activity_targets,
            temperature=activity_temperature,
        ),
        "relevanceEce": (
            expected_calibration_error(
                relevance_logits,
                relevance_targets,
                temperature=relevance_temperature,
            )
            if relevance_logits
            else 0.0
        ),
        "activityCount": len(activity_targets),
        "relevanceCount": len(relevance_targets),
    }
    _write_json(output_path, result)
    return result


def apply_calibration_to_runtime(
    artifact_directory: Path,
    calibration_path: Path,
) -> dict[str, object]:
    runtime_path = artifact_directory / "runtime.json"
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    calibration = json.loads(calibration_path.read_text(encoding="utf-8"))
    if runtime.get("schemaVersion") != "modernbert-runtime.v2":
        raise ValueError("artifact runtime.json has an unsupported schema")
    if calibration.get("calibrationVersion") != "temperature-scaling.v1":
        raise ValueError("calibration file has an unsupported schema")
    activity_temperature = float(calibration["activityTemperature"])
    relevance_temperature = float(calibration["relevanceTemperature"])
    if (
        activity_temperature <= 0
        or relevance_temperature <= 0
        or int(calibration["activityCount"]) < 1
        or int(calibration["relevanceCount"]) < 1
    ):
        raise ValueError("calibration temperatures/counts are invalid")
    runtime["calibration"] = {
        "version": "temperature-scaling.v1",
        "calibrated": True,
        "activityTemperature": activity_temperature,
        "relevanceTemperature": relevance_temperature,
        "activityEce": float(calibration["activityEce"]),
        "relevanceEce": float(calibration["relevanceEce"]),
        "activityCount": int(calibration["activityCount"]),
        "relevanceCount": int(calibration["relevanceCount"]),
    }
    _write_json(runtime_path, runtime)
    return runtime


def artifact_manifest(
    directory: Path,
    *,
    model_version: str,
    taxonomy_version: str = "activity-taxonomy.v1",
    manifest_path: Path | None = None,
) -> dict[str, object]:
    runtime_path = directory / "runtime.json"
    if not runtime_path.is_file():
        raise ValueError("model artifact must contain runtime.json")
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    if (
        runtime.get("schemaVersion") != "modernbert-runtime.v2"
        or runtime.get("inputFormat") != expected_runtime_input_format()
    ):
        raise ValueError(
            "model artifact runtime input contract is missing or incompatible"
        )
    runtime_model_version = runtime.get("modelVersion")
    runtime_taxonomy = runtime.get("taxonomy")
    runtime_taxonomy_version = (
        runtime_taxonomy.get("version")
        if isinstance(runtime_taxonomy, Mapping)
        else None
    )
    if (
        not isinstance(runtime_model_version, str)
        or not runtime_model_version
        or model_version != runtime_model_version
    ):
        raise ValueError(
            "manifest model version must exactly match runtime.json"
        )
    if (
        not isinstance(runtime_taxonomy_version, str)
        or not runtime_taxonomy_version
        or taxonomy_version != runtime_taxonomy_version
    ):
        raise ValueError(
            "manifest taxonomy version must exactly match runtime.json"
        )
    maximum_tokens = runtime.get("maximumTokens")
    if (
        isinstance(maximum_tokens, bool)
        or not isinstance(maximum_tokens, int)
        or not 1 <= maximum_tokens <= DEFAULT_STUDENT_MAXIMUM_TOKENS
    ):
        raise ValueError("model artifact maximum token budget is invalid")
    training_execution = runtime.get("trainingExecution")
    if (
        not isinstance(training_execution, Mapping)
        or set(training_execution)
        != {
            "requestedPrecision",
            "resolvedPrecision",
            "gradientCheckpointing",
            "microBatchSize",
        }
        or training_execution.get("requestedPrecision")
        not in TRAINING_PRECISIONS
        or training_execution.get("resolvedPrecision")
        not in {"bf16", "fp16", "fp32"}
        or not isinstance(
            training_execution.get("gradientCheckpointing"),
            bool,
        )
        or isinstance(training_execution.get("microBatchSize"), bool)
        or not isinstance(training_execution.get("microBatchSize"), int)
        or int(training_execution["microBatchSize"]) < 1
    ):
        raise ValueError("model artifact training execution metadata is invalid")
    tokenizer_sha256 = runtime.get("tokenizerSha256")
    if (
        not isinstance(tokenizer_sha256, str)
        or len(tokenizer_sha256) != 64
        or any(character not in "0123456789abcdef" for character in tokenizer_sha256)
    ):
        raise ValueError("model artifact tokenizer fingerprint is invalid")
    required_files = {
        "config.json",
        "runtime.json",
        "student.pt",
        "tokenizer.json",
        "tokenizer_config.json",
    }
    missing = sorted(
        name for name in required_files if not (directory / name).is_file()
    )
    if missing:
        raise ValueError(
            "model artifact is missing required files: " + ", ".join(missing)
        )
    excluded_paths: set[Path] = set()
    if manifest_path is not None:
        excluded_paths.add(manifest_path.resolve())
        excluded_paths.add(
            manifest_path.with_suffix(manifest_path.suffix + ".tmp").resolve()
        )
    files = []
    for path in sorted(
        (
            item
            for item in directory.rglob("*")
            if item.is_file() and item.resolve() not in excluded_paths
        ),
        key=lambda item: str(item.relative_to(directory)),
    ):
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        files.append(
            {
                "path": str(path.relative_to(directory)),
                "bytes": path.stat().st_size,
                "sha256": digest.hexdigest(),
            }
        )
    return {
        "manifestVersion": "model-artifact.v2",
        "modelVersion": runtime_model_version,
        "taxonomyVersion": runtime_taxonomy_version,
        "tokenizerSha256": tokenizer_sha256,
        "maximumTokens": maximum_tokens,
        "inputFormat": runtime["inputFormat"],
        "trainingExecution": dict(training_execution),
        "files": files,
    }


def _write_json(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")
    temporary.replace(path)
