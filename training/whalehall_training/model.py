from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .contracts import ACTIVITY_LABELS, GOAL_RELEVANCE_LABELS
from .model_input import (
    event_token_mask_from_offsets,
    prepare_model_input,
)


class MissingTrainingDependency(RuntimeError):
    pass


def _training_dependencies() -> tuple[Any, Any, Any]:
    try:
        import torch
        from transformers import AutoConfig, AutoModel
    except ImportError as error:
        raise MissingTrainingDependency(
            "ModernBERT training requires torch and transformers in the "
            "dedicated GPU environment; the data/teacher pipeline does not"
        ) from error
    return torch, AutoConfig, AutoModel


@dataclass(frozen=True)
class MultiTaskModelConfig:
    base_model: str = "answerdotai/ModernBERT-base"
    activity_classes: int = len(ACTIVITY_LABELS)
    relevance_classes: int = len(GOAL_RELEVANCE_LABELS)
    embedding_dimensions: int = 256
    dropout: float = 0.1


def build_multitask_model(
    config: MultiTaskModelConfig,
    *,
    encoder_config: Any | None = None,
) -> Any:
    """Build the shared ModernBERT encoder and its three task heads.

    Returning a dynamically defined ``nn.Module`` keeps importing this package
    dependency-free on collection/teacher machines.
    """

    torch, _, auto_model = _training_dependencies()

    class ModernBertMultiTask(torch.nn.Module):  # type: ignore[misc]
        def __init__(self) -> None:
            super().__init__()
            self.encoder = (
                auto_model.from_pretrained(config.base_model)
                if encoder_config is None
                else auto_model.from_config(encoder_config)
            )
            hidden_size = int(self.encoder.config.hidden_size)
            self.dropout = torch.nn.Dropout(config.dropout)
            self.activity_head = torch.nn.Linear(
                hidden_size, config.activity_classes
            )
            self.relevance_head = torch.nn.Linear(
                hidden_size, config.relevance_classes
            )
            self.embedding_head = torch.nn.Linear(
                hidden_size, config.embedding_dimensions
            )
            self.whalehall_config = config

        @staticmethod
        def _masked_mean(hidden_states: Any, mask: Any) -> Any:
            expanded = mask.to(hidden_states.dtype).unsqueeze(-1)
            denominator = expanded.sum(dim=1).clamp_min(1.0)
            return (hidden_states * expanded).sum(dim=1) / denominator

        def forward(
            self,
            *,
            input_ids: Any,
            attention_mask: Any,
            event_token_mask: Any,
        ) -> dict[str, Any]:
            outputs = self.encoder(
                input_ids=input_ids,
                attention_mask=attention_mask,
                return_dict=True,
            )
            hidden_states = outputs.last_hidden_state
            effective_event_mask = event_token_mask.bool() & attention_mask.bool()
            event_pooled = self._masked_mean(
                hidden_states, effective_event_mask
            )
            joint_pooled = self._masked_mean(
                hidden_states, attention_mask.bool()
            )
            activity_logits = self.activity_head(self.dropout(event_pooled))
            relevance_logits = self.relevance_head(self.dropout(joint_pooled))
            embedding = torch.nn.functional.normalize(
                self.embedding_head(event_pooled),
                p=2,
                dim=-1,
            )
            return {
                "activity_logits": activity_logits,
                "relevance_logits": relevance_logits,
                "embedding": embedding,
            }

    return ModernBertMultiTask()


def _weighted_mean(values: Any, weights: Any) -> Any:
    return (values * weights).sum() / weights.sum().clamp_min(1e-8)


def _supervised_contrastive_loss(
    torch: Any,
    embeddings: Any,
    labels: Any,
    weights: Any,
    *,
    temperature: float = 0.1,
) -> Any:
    similarity = embeddings @ embeddings.transpose(0, 1) / temperature
    batch_size = embeddings.shape[0]
    identity = torch.eye(
        batch_size, device=embeddings.device, dtype=torch.bool
    )
    positive_mask = labels.unsqueeze(0).eq(labels.unsqueeze(1)) & ~identity
    valid_anchor = positive_mask.any(dim=1)
    if not bool(valid_anchor.any()):
        return embeddings.sum() * 0.0
    logits = similarity.masked_fill(identity, float("-inf"))
    log_probabilities = logits - torch.logsumexp(logits, dim=1, keepdim=True)
    positive_count = positive_mask.sum(dim=1).clamp_min(1)
    per_anchor = -(
        log_probabilities.masked_fill(~positive_mask, 0.0).sum(dim=1)
        / positive_count
    )
    return _weighted_mean(per_anchor[valid_anchor], weights[valid_anchor])


def compute_multitask_loss(
    outputs: dict[str, Any],
    *,
    activity_targets: Any,
    relevance_targets: Any,
    teacher_activity_distribution: Any,
    teacher_relevance_distribution: Any,
    sample_weights: Any,
    hard_weight: float = 0.45,
    distillation_weight: float = 0.40,
    contrastive_weight: float = 0.15,
    distillation_temperature: float = 2.0,
    contrastive_temperature: float = 0.1,
) -> dict[str, Any]:
    """Compute hard CE + temperature-scaled KD + supervised contrastive loss."""

    torch, _, _ = _training_dependencies()
    functional = torch.nn.functional
    activity_logits = outputs["activity_logits"]
    relevance_logits = outputs["relevance_logits"]
    embeddings = outputs["embedding"]
    weights = sample_weights.to(activity_logits.dtype)

    activity_ce = functional.cross_entropy(
        activity_logits, activity_targets, reduction="none"
    )
    hard_activity = _weighted_mean(activity_ce, weights)
    relevance_mask = relevance_targets.ge(0)
    if bool(relevance_mask.any()):
        relevance_ce = functional.cross_entropy(
            relevance_logits[relevance_mask],
            relevance_targets[relevance_mask],
            reduction="none",
        )
        hard_relevance = _weighted_mean(
            relevance_ce, weights[relevance_mask]
        )
        hard_loss = (hard_activity + hard_relevance) / 2
    else:
        hard_relevance = relevance_logits.sum() * 0.0
        hard_loss = hard_activity

    temperature = distillation_temperature
    activity_kl = functional.kl_div(
        functional.log_softmax(activity_logits / temperature, dim=-1),
        teacher_activity_distribution,
        reduction="none",
    ).sum(dim=-1) * (temperature**2)
    kd_activity = _weighted_mean(activity_kl, weights)
    if bool(relevance_mask.any()):
        relevance_kl = functional.kl_div(
            functional.log_softmax(
                relevance_logits[relevance_mask] / temperature, dim=-1
            ),
            teacher_relevance_distribution[relevance_mask],
            reduction="none",
        ).sum(dim=-1) * (temperature**2)
        kd_relevance = _weighted_mean(
            relevance_kl, weights[relevance_mask]
        )
        distillation_loss = (kd_activity + kd_relevance) / 2
    else:
        kd_relevance = relevance_logits.sum() * 0.0
        distillation_loss = kd_activity

    contrastive_loss = _supervised_contrastive_loss(
        torch,
        embeddings,
        activity_targets,
        weights,
        temperature=contrastive_temperature,
    )
    total = (
        hard_weight * hard_loss
        + distillation_weight * distillation_loss
        + contrastive_weight * contrastive_loss
    )
    return {
        "loss": total,
        "hard_loss": hard_loss,
        "hard_activity_loss": hard_activity,
        "hard_relevance_loss": hard_relevance,
        "distillation_loss": distillation_loss,
        "activity_kd_loss": kd_activity,
        "relevance_kd_loss": kd_relevance,
        "contrastive_loss": contrastive_loss,
    }


def load_multitask_artifact(
    directory: Any,
    *,
    map_location: str = "cpu",
) -> tuple[Any, dict[str, Any]]:
    """Rebuild strictly from an artifact directory, never a training path."""

    import json
    from pathlib import Path

    torch, auto_config, _ = _training_dependencies()
    root = Path(directory)
    runtime_path = root / "runtime.json"
    weights_path = root / "student.pt"
    if not runtime_path.is_file() or not weights_path.is_file():
        raise ValueError("artifact must contain runtime.json and student.pt")
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    if runtime.get("schemaVersion") != "modernbert-runtime.v2":
        raise ValueError("unsupported or missing runtime metadata version")
    architecture = runtime.get("architecture")
    if not isinstance(architecture, dict):
        raise ValueError("runtime architecture metadata is missing")
    encoder_config = auto_config.from_pretrained(
        root,
        local_files_only=True,
    )
    model_config = MultiTaskModelConfig(
        base_model=".",
        activity_classes=int(architecture["activityClasses"]),
        relevance_classes=int(architecture["relevanceClasses"]),
        embedding_dimensions=int(architecture["embeddingDimensions"]),
        dropout=float(architecture["dropout"]),
    )
    model = build_multitask_model(
        model_config,
        encoder_config=encoder_config,
    )
    checkpoint = torch.load(
        weights_path,
        map_location=map_location,
        weights_only=True,
    )
    if not isinstance(checkpoint, dict) or not isinstance(
        checkpoint.get("stateDict"), dict
    ):
        raise ValueError("student.pt does not contain a stateDict")
    model.load_state_dict(checkpoint["stateDict"], strict=True)
    model.eval()
    return model, runtime


def smoke_test_artifact(directory: Any) -> dict[str, Any]:
    """Load local-only weights and execute one dependency-backed forward pass."""

    from pathlib import Path

    torch, _, _ = _training_dependencies()
    try:
        from transformers import AutoTokenizer
    except ImportError as error:
        raise MissingTrainingDependency(
            "artifact smoke requires transformers AutoTokenizer"
        ) from error
    root = Path(directory)
    model, runtime = load_multitask_artifact(root)
    tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
    model_input = (
        '[GOAL]\n{"goalId":"smoke","planId":null,"text":"smoke","version":1}'
        "\n[CONTEXT_ONLY]\n(none)\n[EVENTS]\n"
        '{"kind":"editor.documentChanged","occurredAtMs":1}'
    )
    prepared = prepare_model_input(
        model_input,
        tokenizer,
        maximum_tokens=int(runtime["maximumTokens"]),
    )
    encoded = tokenizer(
        [prepared.text],
        truncation=False,
        return_tensors="pt",
        return_offsets_mapping=True,
    )
    offsets = encoded.pop("offset_mapping")[0].tolist()
    attended = encoded["attention_mask"][0].tolist()
    event_mask = torch.tensor(
        [
            event_token_mask_from_offsets(
                offsets,
                attended,
                event_character_start=prepared.event_character_start,
            )
        ],
        dtype=torch.long,
    )
    with torch.no_grad():
        output = model(
            input_ids=encoded["input_ids"],
            attention_mask=encoded["attention_mask"],
            event_token_mask=event_mask,
        )
    shapes = {
        key: list(value.shape)
        for key, value in output.items()
    }
    expected = {
        "activity_logits": [1, len(ACTIVITY_LABELS)],
        "relevance_logits": [1, len(GOAL_RELEVANCE_LABELS)],
        "embedding": [
            1,
            int(runtime["architecture"]["embeddingDimensions"]),
        ],
    }
    if shapes != expected:
        raise ValueError(
            f"artifact forward shapes are invalid: expected {expected}, got {shapes}"
        )
    embedding_norm = float(output["embedding"].norm(dim=-1).item())
    if abs(embedding_norm - 1.0) > 1e-4:
        raise ValueError("artifact embedding is not L2 normalized")
    return {
        "smokeVersion": "modernbert-artifact-smoke.v1",
        "passed": True,
        "modelVersion": runtime["modelVersion"],
        "shapes": shapes,
        "embeddingNorm": embedding_norm,
    }
