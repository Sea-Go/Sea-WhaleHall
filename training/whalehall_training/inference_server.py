from __future__ import annotations

import hashlib
import hmac
import json
import math
import socket
import threading
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Any, Mapping, Protocol, Sequence

from .contracts import ACTIVITY_LABELS, GOAL_RELEVANCE_LABELS
from .model_input import (
    DEFAULT_MODEL_INPUT_BYTES,
    DEFAULT_STUDENT_MAXIMUM_TOKENS,
    ModelInputContractError,
    event_token_mask_from_offsets,
    expected_runtime_input_format,
    parse_model_input,
    prepare_model_input,
    tokenizer_fingerprint,
)
from .model import MissingTrainingDependency, load_multitask_artifact

REQUEST_SCHEMA_VERSION = "modernbert-request.v1"
RESPONSE_SCHEMA_VERSION = "modernbert-inference.v1"
TAXONOMY_VERSION = "activity-taxonomy.v1"
INFERENCE_PATH = "/v1/reflections:infer"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
DEFAULT_MAX_MODEL_INPUT_BYTES = DEFAULT_MODEL_INPUT_BYTES
DEFAULT_SOCKET_TIMEOUT_SECONDS = 15.0


class InferenceProtocolError(ValueError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.public_message = message


@dataclass(frozen=True)
class ModernBertRequest:
    window_id: str
    input_hash: str
    model_input: str
    has_goal: bool
    goal_version: int | None
    taxonomy_version: str
    goal_text: str | None


class InferenceRunner(Protocol):
    model_version: str
    taxonomy_version: str

    def infer(self, request: ModernBertRequest) -> Mapping[str, object]: ...


def _require_identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 200:
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            f"{field} must be a non-empty string of at most 200 characters.",
        )
    return value


def _parse_model_sections(
    model_input: str,
    *,
    has_goal: bool,
    goal_text: str | None,
    goal_version: int | None,
) -> None:
    try:
        parsed_input = parse_model_input(model_input)
    except ModelInputContractError as error:
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            "modelInput violates the deterministic input contract.",
        ) from error
    goal_section = parsed_input.goal_section

    if has_goal:
        try:
            goal_value = json.loads(goal_section)
        except json.JSONDecodeError as error:
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "INVALID_REQUEST",
                "modelInput goal section must be valid JSON.",
            ) from error
        if not isinstance(goal_value, Mapping):
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "INVALID_REQUEST",
                "modelInput goal section must contain the active goal.",
            )
        if set(goal_value) != {
            "goalId",
            "planId",
            "text",
            "version",
        }:
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "INVALID_REQUEST",
                "modelInput goal section has an unexpected shape.",
            )
        canonical_goal = json.dumps(
            goal_value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        if canonical_goal != goal_section:
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "INVALID_REQUEST",
                "modelInput goal section must use canonical JSON.",
            )
        embedded_version = goal_value.get("version")
        if (
            isinstance(embedded_version, bool)
            or not isinstance(embedded_version, int)
            or embedded_version != goal_version
        ):
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "GOAL_VERSION_MISMATCH",
                "goalVersion must match the immutable modelInput goal.",
            )
        embedded_goal_text = goal_value.get("text")
        if (
            not isinstance(embedded_goal_text, str)
            or not embedded_goal_text
            or embedded_goal_text != goal_text
        ):
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "GOAL_TEXT_MISMATCH",
                "goalText must match the immutable modelInput goal.",
            )
    else:
        if goal_section != "null":
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "GOAL_VERSION_MISMATCH",
                "hasGoal=false requires a null modelInput goal.",
            )


def validate_request(
    value: object,
    *,
    expected_taxonomy_version: str = TAXONOMY_VERSION,
    maximum_model_input_bytes: int = DEFAULT_MAX_MODEL_INPUT_BYTES,
) -> ModernBertRequest:
    if not isinstance(value, Mapping):
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            "Request JSON must be an object.",
        )
    expected_keys = {
        "schemaVersion",
        "windowId",
        "inputHash",
        "modelInput",
        "hasGoal",
        "goalText",
        "goalVersion",
        "taxonomyVersion",
    }
    if set(value) != expected_keys or value.get("schemaVersion") != REQUEST_SCHEMA_VERSION:
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            "Request must exactly match modernbert-request.v1.",
        )
    window_id = _require_identifier(value.get("windowId"), "windowId")
    input_hash = value.get("inputHash")
    if (
        not isinstance(input_hash, str)
        or len(input_hash) != 64
        or any(character not in "0123456789abcdef" for character in input_hash)
    ):
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            "inputHash must be a lowercase SHA-256 digest.",
        )
    model_input = value.get("modelInput")
    if not isinstance(model_input, str) or not model_input:
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            "modelInput must be a non-empty string.",
        )
    if len(model_input.encode("utf-8")) > maximum_model_input_bytes:
        raise InferenceProtocolError(
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            "MODEL_INPUT_TOO_LARGE",
            "modelInput exceeded the configured size limit.",
        )
    observed_hash = hashlib.sha256(model_input.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(observed_hash, input_hash):
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INPUT_HASH_MISMATCH",
            "inputHash does not match the immutable modelInput.",
        )
    has_goal = value.get("hasGoal")
    if not isinstance(has_goal, bool):
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            "hasGoal must be boolean.",
        )
    goal_text_value = value.get("goalText")
    goal_version_value = value.get("goalVersion")
    if has_goal:
        if (
            not isinstance(goal_text_value, str)
            or not goal_text_value.strip()
            or len(goal_text_value) > 4000
        ):
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "GOAL_TEXT_MISMATCH",
                "hasGoal=true requires a non-empty goalText.",
            )
        goal_text: str | None = goal_text_value
        if (
            isinstance(goal_version_value, bool)
            or not isinstance(goal_version_value, int)
            or goal_version_value < 0
        ):
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "GOAL_VERSION_MISMATCH",
                "hasGoal=true requires a non-negative integer goalVersion.",
            )
        goal_version: int | None = goal_version_value
    else:
        if goal_version_value is not None or goal_text_value is not None:
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "GOAL_VERSION_MISMATCH",
                "hasGoal=false requires goalText=null and goalVersion=null.",
            )
        goal_text = None
        goal_version = None
    taxonomy_version = value.get("taxonomyVersion")
    if taxonomy_version != expected_taxonomy_version:
        raise InferenceProtocolError(
            HTTPStatus.BAD_REQUEST,
            "TAXONOMY_MISMATCH",
            f"taxonomyVersion must be {expected_taxonomy_version}.",
        )
    _parse_model_sections(
        model_input,
        has_goal=has_goal,
        goal_text=goal_text,
        goal_version=goal_version,
    )
    return ModernBertRequest(
        window_id=window_id,
        input_hash=input_hash,
        model_input=model_input,
        has_goal=has_goal,
        goal_version=goal_version,
        taxonomy_version=str(taxonomy_version),
        goal_text=goal_text,
    )


def temperature_scaled_probabilities(
    logits: Sequence[float],
    temperature: float,
) -> tuple[float, ...]:
    if not logits or temperature <= 0 or not math.isfinite(temperature):
        raise ValueError("logits and temperature must be finite and valid")
    scaled = [float(value) / temperature for value in logits]
    if any(not math.isfinite(value) for value in scaled):
        raise ValueError("model logits must be finite")
    maximum = max(scaled)
    exponentials = [math.exp(value - maximum) for value in scaled]
    total = sum(exponentials)
    return tuple(value / total for value in exponentials)


def _normalized_entropy(probabilities: Sequence[float]) -> float:
    entropy = -sum(
        probability * math.log(probability)
        for probability in probabilities
        if probability > 0
    )
    return max(0.0, min(entropy / math.log(len(probabilities)), 1.0))


def _probability_mapping(
    value: object,
    labels: Sequence[str],
    field: str,
) -> dict[str, float]:
    if not isinstance(value, Mapping) or set(value) != set(labels):
        raise ValueError(f"{field} must contain the exact taxonomy")
    probabilities = {}
    total = 0.0
    for label in labels:
        probability = value.get(label)
        if (
            isinstance(probability, bool)
            or not isinstance(probability, (int, float))
            or not math.isfinite(float(probability))
            or not 0 <= float(probability) <= 1
        ):
            raise ValueError(f"{field} contains an invalid probability")
        probabilities[label] = float(probability)
        total += float(probability)
    if abs(total - 1.0) > 1e-4:
        raise ValueError(f"{field} must sum to one")
    return {
        label: probability / total
        for label, probability in probabilities.items()
    }


def validate_response(
    value: object,
    *,
    has_goal: bool,
    expected_model_version: str,
    expected_window_id: str,
    expected_input_hash: str,
    expected_taxonomy_version: str = TAXONOMY_VERSION,
) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != {
        "schemaVersion",
        "modelVersion",
        "taxonomyVersion",
        "windowId",
        "inputHash",
        "activityProbabilities",
        "goalRelevanceProbabilities",
        "embedding",
        "oodScore",
    }:
        raise ValueError("runner returned an invalid response shape")
    if value.get("schemaVersion") != RESPONSE_SCHEMA_VERSION:
        raise ValueError("runner returned an invalid response schema")
    if value.get("modelVersion") != expected_model_version:
        raise ValueError("runner returned the wrong model version")
    if value.get("taxonomyVersion") != expected_taxonomy_version:
        raise ValueError("runner returned the wrong taxonomy version")
    if (
        value.get("windowId") != expected_window_id
        or value.get("inputHash") != expected_input_hash
    ):
        raise ValueError("runner returned mismatched request correlation")
    activity = _probability_mapping(
        value.get("activityProbabilities"),
        ACTIVITY_LABELS,
        "activityProbabilities",
    )
    relevance_value = value.get("goalRelevanceProbabilities")
    if has_goal:
        relevance: dict[str, float] | None = _probability_mapping(
            relevance_value,
            GOAL_RELEVANCE_LABELS,
            "goalRelevanceProbabilities",
        )
    else:
        if relevance_value is not None:
            raise ValueError("no-goal response must use null relevance")
        relevance = None
    embedding_value = value.get("embedding")
    if (
        not isinstance(embedding_value, Sequence)
        or isinstance(embedding_value, (str, bytes))
        or len(embedding_value) != 256
    ):
        raise ValueError("embedding must have 256 values")
    embedding = [float(item) for item in embedding_value]
    if any(not math.isfinite(item) for item in embedding):
        raise ValueError("embedding must be finite")
    norm = math.sqrt(sum(item * item for item in embedding))
    if norm == 0 or abs(norm - 1.0) > 0.01:
        raise ValueError("embedding must be L2 normalized")
    embedding = [item / norm for item in embedding]
    ood_score_value = value.get("oodScore")
    if (
        isinstance(ood_score_value, bool)
        or not isinstance(ood_score_value, (int, float))
        or not math.isfinite(float(ood_score_value))
        or not 0 <= float(ood_score_value) <= 1
    ):
        raise ValueError("oodScore must be between zero and one")
    return {
        "schemaVersion": RESPONSE_SCHEMA_VERSION,
        "modelVersion": expected_model_version,
        "taxonomyVersion": expected_taxonomy_version,
        "windowId": expected_window_id,
        "inputHash": expected_input_hash,
        "activityProbabilities": activity,
        "goalRelevanceProbabilities": relevance,
        "embedding": embedding,
        "oodScore": float(ood_score_value),
    }


class ArtifactInferenceRunner:
    """Strict, local-only ModernBERT artifact runner."""

    def __init__(self, artifact_directory: Path, *, device: str = "cpu") -> None:
        try:
            import torch
            from transformers import AutoTokenizer
        except ImportError as error:
            raise MissingTrainingDependency(
                "serving requires torch and transformers in the model runtime"
            ) from error
        model, runtime = load_multitask_artifact(
            artifact_directory,
            map_location="cpu",
        )
        taxonomy = runtime.get("taxonomy")
        calibration = runtime.get("calibration")
        architecture = runtime.get("architecture")
        input_format = runtime.get("inputFormat")
        training_execution = runtime.get("trainingExecution")
        if (
            not isinstance(taxonomy, Mapping)
            or taxonomy.get("version") != TAXONOMY_VERSION
            or taxonomy.get("activities") != list(ACTIVITY_LABELS)
            or taxonomy.get("goalRelevance") != list(GOAL_RELEVANCE_LABELS)
        ):
            raise ValueError("artifact taxonomy does not match activity-taxonomy.v1")
        if (
            not isinstance(architecture, Mapping)
            or architecture.get("activityClasses") != len(ACTIVITY_LABELS)
            or architecture.get("relevanceClasses")
            != len(GOAL_RELEVANCE_LABELS)
            or architecture.get("embeddingDimensions") != 256
        ):
            raise ValueError("artifact architecture does not match inference v1")
        if input_format != expected_runtime_input_format():
            raise ValueError("artifact tokenizer input contract is incompatible")
        if (
            not isinstance(training_execution, Mapping)
            or training_execution.get("requestedPrecision")
            not in {"auto", "bf16", "fp16", "fp32"}
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
            raise ValueError(
                "artifact training execution metadata is incompatible"
            )
        if runtime.get("oodScoring") != "max_normalized_entropy.v1":
            raise ValueError("artifact OOD scoring contract is incompatible")
        if (
            not isinstance(calibration, Mapping)
            or calibration.get("version") != "temperature-scaling.v1"
            or calibration.get("calibrated") is not True
        ):
            raise ValueError(
                "artifact must contain frozen calibrated temperatures before serving"
            )
        activity_temperature = float(calibration["activityTemperature"])
        relevance_temperature = float(calibration["relevanceTemperature"])
        if (
            not math.isfinite(activity_temperature)
            or not math.isfinite(relevance_temperature)
            or activity_temperature <= 0
            or relevance_temperature <= 0
        ):
            raise ValueError("artifact calibration temperatures are invalid")
        model_version = runtime.get("modelVersion")
        if not isinstance(model_version, str) or not model_version:
            raise ValueError("artifact modelVersion is invalid")
        maximum_tokens = runtime.get("maximumTokens")
        if (
            isinstance(maximum_tokens, bool)
            or not isinstance(maximum_tokens, int)
            or maximum_tokens < 1
            or maximum_tokens > DEFAULT_STUDENT_MAXIMUM_TOKENS
        ):
            raise ValueError("artifact maximumTokens is invalid")
        encoder_limit = int(
            getattr(model.encoder.config, "max_position_embeddings", 0)
        )
        if maximum_tokens > encoder_limit:
            raise ValueError(
                "artifact maximumTokens exceeds encoder position limit"
            )

        self._torch = torch
        self._model = model.to(torch.device(device))
        self._tokenizer = AutoTokenizer.from_pretrained(
            artifact_directory,
            local_files_only=True,
        )
        expected_tokenizer_sha256 = runtime.get("tokenizerSha256")
        if (
            not isinstance(expected_tokenizer_sha256, str)
            or len(expected_tokenizer_sha256) != 64
            or not hmac.compare_digest(
                tokenizer_fingerprint(self._tokenizer),
                expected_tokenizer_sha256,
            )
        ):
            raise ValueError(
                "artifact tokenizer does not match the locked training tokenizer"
            )
        self._device = torch.device(device)
        self._maximum_tokens = maximum_tokens
        self._activity_temperature = activity_temperature
        self._relevance_temperature = relevance_temperature
        self._lock = threading.Lock()
        self.model_version = model_version
        self.taxonomy_version = TAXONOMY_VERSION

    def infer(self, request: ModernBertRequest) -> Mapping[str, object]:
        torch = self._torch
        try:
            prepared = prepare_model_input(
                request.model_input,
                self._tokenizer,
                maximum_tokens=self._maximum_tokens,
            )
        except ModelInputContractError as error:
            raise ValueError(
                "modelInput cannot satisfy the artifact token contract"
            ) from error
        encoded = self._tokenizer(
            [prepared.text],
            truncation=False,
            padding=True,
            return_tensors="pt",
            return_offsets_mapping=True,
        )
        offset_mapping = encoded.pop("offset_mapping")[0].tolist()
        attended = encoded["attention_mask"][0].tolist()
        if sum(int(value) for value in attended) > self._maximum_tokens:
            raise ValueError("artifact tokenizer exceeded verified token budget")
        event_mask = torch.tensor(
            [
                event_token_mask_from_offsets(
                    offset_mapping,
                    attended,
                    event_character_start=prepared.event_character_start,
                )
            ],
            dtype=torch.long,
            device=self._device,
        )
        input_ids = encoded["input_ids"].to(self._device)
        attention_mask = encoded["attention_mask"].to(self._device)
        with self._lock, torch.no_grad():
            output = self._model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                event_token_mask=event_mask,
            )
        activity_logits = [
            float(item)
            for item in output["activity_logits"][0].detach().cpu().tolist()
        ]
        relevance_logits = [
            float(item)
            for item in output["relevance_logits"][0].detach().cpu().tolist()
        ]
        activity_values = temperature_scaled_probabilities(
            activity_logits,
            self._activity_temperature,
        )
        relevance_values = temperature_scaled_probabilities(
            relevance_logits,
            self._relevance_temperature,
        )
        embedding = [
            float(item)
            for item in output["embedding"][0].detach().cpu().tolist()
        ]
        activity = dict(zip(ACTIVITY_LABELS, activity_values, strict=True))
        relevance = dict(
            zip(GOAL_RELEVANCE_LABELS, relevance_values, strict=True)
        )
        ood_score = _normalized_entropy(activity_values)
        if request.has_goal:
            ood_score = max(
                ood_score,
                _normalized_entropy(relevance_values),
            )
        response: dict[str, object] = {
            "schemaVersion": RESPONSE_SCHEMA_VERSION,
            "modelVersion": self.model_version,
            "taxonomyVersion": self.taxonomy_version,
            "windowId": request.window_id,
            "inputHash": request.input_hash,
            "activityProbabilities": activity,
            "goalRelevanceProbabilities": (
                relevance if request.has_goal else None
            ),
            "embedding": embedding,
            "oodScore": ood_score,
        }
        return validate_response(
            response,
            has_goal=request.has_goal,
            expected_model_version=self.model_version,
            expected_window_id=request.window_id,
            expected_input_hash=request.input_hash,
            expected_taxonomy_version=self.taxonomy_version,
        )


def _error_body(code: str, message: str) -> bytes:
    return json.dumps(
        {"error": {"code": code, "message": message}},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


class InferenceApplication:
    def __init__(
        self,
        runner: InferenceRunner,
        *,
        authorization_token: str | None = None,
        maximum_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
        maximum_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        maximum_model_input_bytes: int = DEFAULT_MAX_MODEL_INPUT_BYTES,
    ) -> None:
        if authorization_token is not None and not 1 <= len(authorization_token) <= 4096:
            raise ValueError("authorization token length is invalid")
        if maximum_request_bytes < 1024 or maximum_response_bytes < 1024:
            raise ValueError("request and response bounds must be at least 1024 bytes")
        if (
            maximum_model_input_bytes < 1
            or maximum_model_input_bytes > maximum_request_bytes
            or maximum_model_input_bytes > DEFAULT_MAX_MODEL_INPUT_BYTES
        ):
            raise ValueError(
                "model input bound must fit inside request bound and the "
                "deterministic 32 KiB source contract"
            )
        self.runner = runner
        self.authorization_token = authorization_token
        self.maximum_request_bytes = maximum_request_bytes
        self.maximum_response_bytes = maximum_response_bytes
        self.maximum_model_input_bytes = maximum_model_input_bytes

    def authorize(self, header: str | None) -> bool:
        if self.authorization_token is None:
            return True
        expected = f"Bearer {self.authorization_token}"
        return header is not None and hmac.compare_digest(header, expected)

    def infer(self, body: bytes) -> bytes:
        if len(body) > self.maximum_request_bytes:
            raise InferenceProtocolError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "REQUEST_TOO_LARGE",
                "Request exceeded the configured size limit.",
            )
        try:
            value = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise InferenceProtocolError(
                HTTPStatus.BAD_REQUEST,
                "INVALID_JSON",
                "Request body must be valid UTF-8 JSON.",
            ) from error
        request = validate_request(
            value,
            expected_taxonomy_version=self.runner.taxonomy_version,
            maximum_model_input_bytes=self.maximum_model_input_bytes,
        )
        try:
            result = self.runner.infer(request)
            validated = validate_response(
                result,
                has_goal=request.has_goal,
                expected_model_version=self.runner.model_version,
                expected_window_id=request.window_id,
                expected_input_hash=request.input_hash,
                expected_taxonomy_version=self.runner.taxonomy_version,
            )
        except InferenceProtocolError:
            raise
        except Exception as error:
            raise InferenceProtocolError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "INFERENCE_FAILED",
                "Model inference failed.",
            ) from error
        encoded = json.dumps(
            validated,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        if len(encoded) > self.maximum_response_bytes:
            raise InferenceProtocolError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "RESPONSE_TOO_LARGE",
                "Model response exceeded the configured size limit.",
            )
        return encoded


class _InferenceHandler(BaseHTTPRequestHandler):
    server_version = "WhaleHallModernBERT/1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    @property
    def application(self) -> InferenceApplication:
        return self.server.application  # type: ignore[attr-defined]

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(DEFAULT_SOCKET_TIMEOUT_SECONDS)

    def log_message(self, _format: str, *_arguments: object) -> None:
        # Never log authorization headers or modelInput.
        return

    def do_GET(self) -> None:
        if self.path != "/healthz":
            self._send_error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Not found.")
            return
        body = json.dumps(
            {
                "status": "ready",
                "modelVersion": self.application.runner.model_version,
                "taxonomyVersion": self.application.runner.taxonomy_version,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self._send_json(HTTPStatus.OK, body)

    def do_POST(self) -> None:
        if self.path != INFERENCE_PATH:
            self._send_error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Not found.")
            return
        if not self.application.authorize(self.headers.get("authorization")):
            self._send_error(
                HTTPStatus.UNAUTHORIZED,
                "UNAUTHORIZED",
                "Authorization failed.",
            )
            return
        content_type = self.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send_error(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                "UNSUPPORTED_MEDIA_TYPE",
                "Content-Type must be application/json.",
            )
            return
        if self.headers.get("transfer-encoding") is not None:
            self._send_error(
                HTTPStatus.BAD_REQUEST,
                "CHUNKED_NOT_SUPPORTED",
                "Chunked request bodies are not supported.",
            )
            return
        content_length_header = self.headers.get("content-length")
        if content_length_header is None:
            self._send_error(
                HTTPStatus.LENGTH_REQUIRED,
                "LENGTH_REQUIRED",
                "Content-Length is required.",
            )
            return
        try:
            content_length = int(content_length_header)
        except ValueError:
            self._send_error(
                HTTPStatus.BAD_REQUEST,
                "INVALID_LENGTH",
                "Content-Length is invalid.",
            )
            return
        if content_length < 0 or content_length > self.application.maximum_request_bytes:
            self._send_error(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "REQUEST_TOO_LARGE",
                "Request exceeded the configured size limit.",
            )
            return
        try:
            body = self.rfile.read(content_length)
            if len(body) != content_length:
                raise InferenceProtocolError(
                    HTTPStatus.BAD_REQUEST,
                    "INCOMPLETE_BODY",
                    "Request body was incomplete.",
                )
            response = self.application.infer(body)
            self._send_json(HTTPStatus.OK, response)
        except InferenceProtocolError as error:
            self._send_error(error.status, error.code, error.public_message)
        except (OSError, socket.timeout):
            self.close_connection = True

    def _send_json(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _send_error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, _error_body(code, message))


class BoundedInferenceServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    block_on_close = True
    request_queue_size = 8

    def __init__(
        self,
        server_address: tuple[str, int],
        application: InferenceApplication,
        *,
        maximum_concurrency: int,
    ) -> None:
        if server_address[0] != DEFAULT_HOST:
            raise ValueError("inference server may bind only to 127.0.0.1")
        if not 1 <= maximum_concurrency <= 4:
            raise ValueError("maximum concurrency must be between 1 and 4")
        self.application = application
        self._slots = threading.BoundedSemaphore(maximum_concurrency)
        super().__init__(server_address, _InferenceHandler)

    def process_request(
        self,
        request: socket.socket,
        client_address: tuple[str, int],
    ) -> None:
        if not self._slots.acquire(blocking=False):
            body = _error_body(
                "SERVER_BUSY",
                "Inference concurrency limit reached.",
            )
            response = (
                b"HTTP/1.1 429 Too Many Requests\r\n"
                b"content-type: application/json\r\n"
                + f"content-length: {len(body)}\r\n".encode("ascii")
                + b"cache-control: no-store\r\n"
                b"connection: close\r\n\r\n"
                + body
            )
            try:
                request.sendall(response)
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(
        self,
        request: socket.socket,
        client_address: tuple[str, int],
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def create_inference_server(
    runner: InferenceRunner,
    *,
    port: int = DEFAULT_PORT,
    authorization_token: str | None = None,
    maximum_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
    maximum_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    maximum_model_input_bytes: int = DEFAULT_MAX_MODEL_INPUT_BYTES,
    maximum_concurrency: int = 1,
) -> BoundedInferenceServer:
    if not 0 <= port <= 65535:
        raise ValueError("port must be between 0 and 65535")
    application = InferenceApplication(
        runner,
        authorization_token=authorization_token,
        maximum_request_bytes=maximum_request_bytes,
        maximum_response_bytes=maximum_response_bytes,
        maximum_model_input_bytes=maximum_model_input_bytes,
    )
    return BoundedInferenceServer(
        (DEFAULT_HOST, port),
        application,
        maximum_concurrency=maximum_concurrency,
    )
