from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import warnings
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

from .contracts import (
    EventWindow,
    TeacherLabel,
    ValidationError,
    parse_teacher_label,
    teacher_response_schema,
)
from .dataset import write_jsonl


class TeacherError(RuntimeError):
    pass


class TeacherTransportError(TeacherError):
    pass


class TeacherSchemaError(TeacherError):
    pass


class BatchPackingError(TeacherError):
    pass


@dataclass(frozen=True)
class AllowedHours:
    """Local wall-clock interval used to stop a run at batch boundaries."""

    start_minute: int
    end_minute: int
    specification: str

    @classmethod
    def parse(cls, value: str) -> "AllowedHours":
        match = re.fullmatch(
            r"([01][0-9]|2[0-3]):([0-5][0-9])-"
            r"([01][0-9]|2[0-3]):([0-5][0-9])",
            value,
        )
        if match is None:
            raise ValueError(
                "allowed hours must use strict local-time HH:MM-HH:MM syntax"
            )
        start_hour, start_minute, end_hour, end_minute = (
            int(item) for item in match.groups()
        )
        return cls(
            start_minute=start_hour * 60 + start_minute,
            end_minute=end_hour * 60 + end_minute,
            specification=value,
        )

    def contains(self, value: datetime) -> bool:
        minute = value.hour * 60 + value.minute
        if self.start_minute == self.end_minute:
            return True
        if self.start_minute < self.end_minute:
            return self.start_minute <= minute < self.end_minute
        return minute >= self.start_minute or minute < self.end_minute


@dataclass(frozen=True)
class ThermalProbeResult:
    state: str
    detail: str

    def validate(self) -> None:
        if self.state not in {
            "nominal",
            "fair",
            "serious",
            "critical",
            "unknown",
        }:
            raise ValueError(f"unsupported thermal state: {self.state}")


ThermalProbe = Callable[[], ThermalProbeResult]


def macos_thermal_probe() -> ThermalProbeResult:
    """Read macOS thermal pressure without requiring a third-party package."""

    if sys.platform != "darwin":
        return ThermalProbeResult("unknown", "thermal probe requires macOS")
    try:
        completed = subprocess.run(
            ["pmset", "-g", "therm"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5.0,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return ThermalProbeResult(
            "unknown",
            f"pmset thermal probe failed ({type(error).__name__})",
        )
    if completed.returncode != 0:
        return ThermalProbeResult(
            "unknown",
            f"pmset thermal probe exited {completed.returncode}",
        )
    output = completed.stdout.lower()
    warning_match = re.search(
        r"thermal warning level\s*=\s*(\d+)",
        output,
    )
    speed_match = re.search(r"cpu_speed_limit\s*=\s*(\d+)", output)
    warning_level = (
        int(warning_match.group(1)) if warning_match is not None else None
    )
    speed_limit = int(speed_match.group(1)) if speed_match is not None else None
    if warning_level is not None:
        if warning_level >= 3:
            return ThermalProbeResult("critical", "thermal warning level >= 3")
        if warning_level == 2:
            return ThermalProbeResult("serious", "thermal warning level = 2")
        if warning_level == 1:
            return ThermalProbeResult("fair", "thermal warning level = 1")
        return ThermalProbeResult("nominal", "thermal warning level = 0")
    if speed_limit is not None:
        if speed_limit <= 50:
            return ThermalProbeResult("critical", "CPU speed limit <= 50%")
        if speed_limit <= 75:
            return ThermalProbeResult("serious", "CPU speed limit <= 75%")
        if speed_limit < 100:
            return ThermalProbeResult("fair", "CPU speed limit below 100%")
        return ThermalProbeResult("nominal", "CPU speed limit = 100%")
    if "no thermal warning level has been recorded" in output:
        return ThermalProbeResult("nominal", "no thermal warning recorded")
    return ThermalProbeResult(
        "unknown",
        "pmset returned no recognized thermal-pressure field",
    )


@dataclass(frozen=True)
class TeacherConfig:
    endpoint: str = "http://127.0.0.1:11434"
    model: str = "qwen3:4b"
    model_digest: str = (
        "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7"
    )
    ollama_version: str = "0.24.0"
    parameter_size: str = "4.0B"
    quantization_level: str = "Q4_K_M"
    num_ctx: int = 4096
    keep_alive: str = "30m"
    concurrency: int = 1
    batch_minimum: int = 4
    batch_maximum: int = 8
    input_token_budget: int = 2600
    schema_retry_maximum: int = 1
    transport_attempt_maximum: int = 4
    transport_backoff_seconds: tuple[float, ...] = (1.0, 3.0, 10.0, 30.0)
    prompt_version: str = "teacher-prompt.v1"
    taxonomy_version: str = "activity-taxonomy.v1"
    request_timeout_seconds: float = 180.0

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "TeacherConfig":
        return cls(
            endpoint=str(value["endpoint"]).rstrip("/"),
            model=str(value["model"]),
            model_digest=str(value["modelDigest"]),
            ollama_version=str(value["ollamaVersion"]),
            parameter_size=str(value["parameterSize"]),
            quantization_level=str(value["quantizationLevel"]),
            num_ctx=int(value["numCtx"]),
            keep_alive=str(value["keepAlive"]),
            concurrency=int(value["concurrency"]),
            batch_minimum=int(value["batchMinimum"]),
            batch_maximum=int(value["batchMaximum"]),
            input_token_budget=int(value["inputTokenBudget"]),
            schema_retry_maximum=int(value["schemaRetryMaximum"]),
            transport_attempt_maximum=int(value["transportAttemptMaximum"]),
            transport_backoff_seconds=tuple(
                float(item) for item in value["transportBackoffSeconds"]  # type: ignore[union-attr]
            ),
            prompt_version=str(value["promptVersion"]),
            taxonomy_version=str(value["taxonomyVersion"]),
        )

    def validate(self) -> None:
        if self.endpoint not in {
            "http://127.0.0.1:11434",
            "http://localhost:11434",
        }:
            raise ValueError(
                "teacher endpoint must remain the local Ollama loopback on port 11434"
            )
        if self.model != "qwen3:4b":
            raise ValueError("teacher model is pinned to qwen3:4b")
        if len(self.model_digest) != 64 or any(
            character not in "0123456789abcdef"
            for character in self.model_digest
        ):
            raise ValueError("teacher modelDigest must be a lowercase SHA-256")
        if self.ollama_version != "0.24.0":
            raise ValueError("teacher Ollama version is pinned to 0.24.0")
        if self.parameter_size != "4.0B":
            raise ValueError("teacher parameter size is pinned to 4.0B")
        if self.quantization_level != "Q4_K_M":
            raise ValueError("teacher quantization is pinned to Q4_K_M")
        if self.num_ctx != 4096:
            raise ValueError("teacher num_ctx is pinned to 4096")
        if self.concurrency != 1:
            raise ValueError("teacher concurrency is pinned to 1")
        if self.keep_alive != "30m":
            raise ValueError("teacher keep_alive is pinned to 30m")
        if self.prompt_version != "teacher-prompt.v1":
            raise ValueError("teacher prompt version must be teacher-prompt.v1")
        if self.taxonomy_version != "activity-taxonomy.v1":
            raise ValueError(
                "teacher taxonomy version must be activity-taxonomy.v1"
            )
        if self.batch_minimum != 4 or self.batch_maximum != 8:
            raise ValueError("teacher batch bounds are pinned to 4 and 8")
        if not 0 < self.input_token_budget < self.num_ctx:
            raise ValueError("input token budget must leave room for output")
        if self.schema_retry_maximum != 1:
            raise ValueError("teacher structured-output retry maximum is pinned to 1")
        if self.transport_attempt_maximum < 1:
            raise ValueError("transport attempt maximum must be positive")
        if (
            len(self.transport_backoff_seconds)
            < self.transport_attempt_maximum - 1
            or any(value < 0 for value in self.transport_backoff_seconds)
        ):
            raise ValueError(
                "transport backoff must cover every retry with non-negative values"
            )


@dataclass(frozen=True)
class OllamaProvenance:
    model_tag: str
    model_digest: str
    ollama_version: str
    parameter_size: str
    quantization_level: str
    prompt_version: str
    taxonomy_version: str

    def as_dict(self) -> dict[str, str]:
        return {
            "modelTag": self.model_tag,
            "modelDigest": self.model_digest,
            "ollamaVersion": self.ollama_version,
            "parameterSize": self.parameter_size,
            "quantizationLevel": self.quantization_level,
            "promptVersion": self.prompt_version,
            "taxonomyVersion": self.taxonomy_version,
        }


@dataclass(frozen=True)
class PackedBatch:
    windows: tuple[EventWindow, ...]
    estimated_tokens: int


@dataclass(frozen=True)
class TeacherRunResult:
    status: str
    pass_name: str
    completed_before: int
    completed_now: int
    remaining: int
    batches: int
    pause_reason: str | None = None


@dataclass(frozen=True)
class TeacherUsage:
    prompt_eval_count: int
    eval_count: int
    total_duration_ns: int
    eval_duration_ns: int


class JsonTransport(Protocol):
    def __call__(
        self,
        method: str,
        url: str,
        payload: Mapping[str, object] | None,
        timeout_seconds: float,
    ) -> Mapping[str, Any]: ...


def default_json_transport(
    method: str,
    url: str,
    payload: Mapping[str, object] | None,
    timeout_seconds: float,
) -> Mapping[str, Any]:
    body = (
        None
        if payload is None
        else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    )
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise TeacherTransportError(f"{method} {url} failed: {error}") from error
    if not isinstance(result, Mapping):
        raise TeacherTransportError(f"{method} {url} returned a non-object response")
    return result


def estimate_window_tokens(window: EventWindow) -> int:
    """Conservative tokenizer-free estimate suitable for request packing."""

    goal = window.goal.text if window.goal else "<NO_GOAL>"
    text = f"{window.window_id}\n{goal}\n{window.model_input}"
    utf8_length = len(text.encode("utf-8"))
    return max(math.ceil(len(text) / 4), math.ceil(utf8_length / 3)) + 48


def pack_batches(
    windows: Sequence[EventWindow],
    config: TeacherConfig,
) -> tuple[PackedBatch, ...]:
    """Pack deterministic 4–8 item batches below the configured token budget."""

    config.validate()
    ordered = sorted(windows, key=lambda window: window.window_id)
    if ordered and len(ordered) < config.batch_minimum:
        raise BatchPackingError(
            f"at least {config.batch_minimum} remaining windows are required"
        )

    raw_batches: list[list[tuple[EventWindow, int]]] = []
    current: list[tuple[EventWindow, int]] = []
    current_tokens = 0
    for window in ordered:
        tokens = estimate_window_tokens(window)
        if tokens > config.input_token_budget:
            raise BatchPackingError(
                f"{window.window_id} alone exceeds the input token budget"
            )
        would_overflow = current_tokens + tokens > config.input_token_budget
        is_full = len(current) == config.batch_maximum
        if current and (would_overflow or is_full):
            if len(current) < config.batch_minimum:
                raise BatchPackingError(
                    "token budget cannot fit the minimum batch of four windows"
                )
            raw_batches.append(current)
            current = []
            current_tokens = 0
        current.append((window, tokens))
        current_tokens += tokens
    if current:
        raw_batches.append(current)

    if raw_batches and len(raw_batches[-1]) < config.batch_minimum:
        tail = raw_batches[-1]
        if len(raw_batches) == 1:
            raise BatchPackingError(
                f"final batch has only {len(tail)} windows; minimum is "
                f"{config.batch_minimum}"
            )
        previous = raw_batches[-2]
        while len(tail) < config.batch_minimum and len(previous) > config.batch_minimum:
            candidate = previous[-1]
            if sum(tokens for _, tokens in tail) + candidate[1] > config.input_token_budget:
                break
            tail.insert(0, previous.pop())
        if len(tail) < config.batch_minimum:
            merged = previous + tail
            if (
                len(merged) <= config.batch_maximum
                and sum(tokens for _, tokens in merged)
                <= config.input_token_budget
            ):
                raw_batches[-2:] = [merged]
            else:
                raise BatchPackingError(
                    "unable to rebalance the final batch to four windows"
                )

    return tuple(
        PackedBatch(
            windows=tuple(window for window, _ in batch),
            estimated_tokens=sum(tokens for _, tokens in batch),
        )
        for batch in raw_batches
    )


_SYSTEM_PROMPT = """\
You are WhaleHall's deterministic activity-label teacher.
Classify only from the supplied goal and desktop semantic events.
Return exactly the requested JSON. Do not add prose or chain-of-thought.
Use goalRelevance=null when goal is null. If evidence is mixed or sparse,
set ambiguous=true and use uncertain/other_unknown as appropriate.
Never infer secret text, identity, intent, or facts absent from the events.
"""


def _compact_window(window: EventWindow) -> dict[str, object]:
    return {
        "windowId": window.window_id,
        "goal": window.goal.text if window.goal else None,
        "triggerReason": window.trigger_reason,
        "durationMs": window.ended_at_ms - window.started_at_ms,
        "eventCount": len(window.events),
        "eventKinds": sorted({event.kind for event in window.events}),
        "sources": sorted({event.source for event in window.events}),
        "modelInput": window.model_input,
    }


class OllamaTeacher:
    def __init__(
        self,
        config: TeacherConfig,
        *,
        transport: JsonTransport = default_json_transport,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        config.validate()
        self.config = config
        self._transport = transport
        self._sleeper = sleeper
        self._semaphore = threading.BoundedSemaphore(config.concurrency)
        self.last_usage = TeacherUsage(0, 0, 0, 0)

    def request_payload(
        self,
        windows: Sequence[EventWindow],
        *,
        thinking: bool = False,
        pass_name: str = "A",
    ) -> dict[str, object]:
        if pass_name not in {"A", "B", "C"}:
            raise ValueError("pass_name must be A, B, or C")
        rubric = {
            "A": (
                "Classify evidence-first: identify the dominant observable "
                "activity, then compare it with the goal."
            ),
            "B": (
                "Classify goal-first: independently test whether the observed "
                "activity directly or indirectly advances the stated goal."
            ),
            "C": (
                "Act as an ambiguity auditor: independently consider mixed, "
                "sparse, or alternative activity explanations before labeling."
            ),
        }[pass_name]
        compact = [_compact_window(window) for window in windows]
        user_prompt = json.dumps(
            {
                "instruction": "Label every window once in the same order.",
                "labelPass": pass_name,
                "rubric": rubric,
                "windows": compact,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            "think": thinking,
            "format": teacher_response_schema(len(windows)),
            "options": {
                "num_ctx": self.config.num_ctx,
                "temperature": 0,
            },
            "keep_alive": self.config.keep_alive,
        }

    def fetch_provenance(self) -> OllamaProvenance:
        version_response = self._transport(
            "GET",
            f"{self.config.endpoint}/api/version",
            None,
            self.config.request_timeout_seconds,
        )
        tags_response = self._transport(
            "GET",
            f"{self.config.endpoint}/api/tags",
            None,
            self.config.request_timeout_seconds,
        )
        models = tags_response.get("models")
        if not isinstance(models, list):
            raise TeacherTransportError("Ollama /api/tags omitted models")
        matching = [
            model
            for model in models
            if isinstance(model, Mapping)
            and model.get("name") == self.config.model
        ]
        if len(matching) != 1:
            raise TeacherTransportError(
                f"Ollama does not expose exactly one {self.config.model} model"
            )
        digest = matching[0].get("digest")
        version = version_response.get("version")
        details = matching[0].get("details")
        if not isinstance(digest, str) or not digest:
            raise TeacherTransportError("Ollama model digest is missing")
        if not isinstance(version, str) or not version:
            raise TeacherTransportError("Ollama version is missing")
        if not isinstance(details, Mapping):
            raise TeacherTransportError("Ollama model details are missing")
        parameter_size = details.get("parameter_size")
        quantization_level = details.get("quantization_level")
        observed = {
            "ollamaVersion": version,
            "modelDigest": digest,
            "parameterSize": parameter_size,
            "quantizationLevel": quantization_level,
        }
        expected = {
            "ollamaVersion": self.config.ollama_version,
            "modelDigest": self.config.model_digest,
            "parameterSize": self.config.parameter_size,
            "quantizationLevel": self.config.quantization_level,
        }
        if observed != expected:
            raise TeacherTransportError(
                "local Ollama provenance does not match the pinned teacher: "
                f"expected {expected}, observed {observed}"
            )
        return OllamaProvenance(
            model_tag=self.config.model,
            model_digest=digest,
            ollama_version=version,
            parameter_size=str(parameter_size),
            quantization_level=str(quantization_level),
            prompt_version=self.config.prompt_version,
            taxonomy_version=self.config.taxonomy_version,
        )

    def _post_with_transport_retry(
        self, payload: Mapping[str, object]
    ) -> Mapping[str, Any]:
        last_error: TeacherTransportError | None = None
        for attempt in range(self.config.transport_attempt_maximum):
            try:
                with self._semaphore:
                    return self._transport(
                        "POST",
                        f"{self.config.endpoint}/api/chat",
                        payload,
                        self.config.request_timeout_seconds,
                    )
            except TeacherTransportError as error:
                last_error = error
                if attempt + 1 >= self.config.transport_attempt_maximum:
                    break
                backoff_index = min(
                    attempt, len(self.config.transport_backoff_seconds) - 1
                )
                self._sleeper(
                    self.config.transport_backoff_seconds[backoff_index]
                )
        raise TeacherTransportError(
            f"Ollama request failed after "
            f"{self.config.transport_attempt_maximum} attempts: {last_error}"
        )

    @staticmethod
    def _parse_response(
        response: Mapping[str, Any],
        windows: Sequence[EventWindow],
    ) -> tuple[TeacherLabel, ...]:
        message = response.get("message")
        if not isinstance(message, Mapping):
            raise TeacherSchemaError("Ollama response omitted message")
        content = message.get("content")
        if not isinstance(content, str):
            raise TeacherSchemaError("Ollama response message omitted content")
        try:
            value = json.loads(content)
        except json.JSONDecodeError as error:
            raise TeacherSchemaError(
                f"teacher content is not JSON: {error.msg}"
            ) from error
        if not isinstance(value, Mapping):
            raise TeacherSchemaError("teacher content must be an object")
        if value.get("schemaVersion") != "teacher-label-batch.v1":
            raise TeacherSchemaError(
                "teacher schemaVersion must equal teacher-label-batch.v1"
            )
        raw_labels = value.get("labels")
        if not isinstance(raw_labels, list) or len(raw_labels) != len(windows):
            raise TeacherSchemaError(
                "teacher must return exactly one label per input window"
            )
        expected_ids = {window.window_id for window in windows}
        try:
            labels = tuple(
                parse_teacher_label(label, expected_window_ids=expected_ids)
                for label in raw_labels
            )
        except ValidationError as error:
            raise TeacherSchemaError(str(error)) from error
        returned_ids = [label.window_id for label in labels]
        if len(set(returned_ids)) != len(returned_ids):
            raise TeacherSchemaError("teacher returned duplicate windowId values")
        if set(returned_ids) != expected_ids:
            raise TeacherSchemaError("teacher did not return the expected windowIds")
        by_id = {window.window_id: window for window in windows}
        for label in labels:
            has_goal = by_id[label.window_id].has_goal
            if not has_goal and label.goal_relevance is not None:
                raise TeacherSchemaError(
                    f"{label.window_id} has no goal but relevance is not null"
                )
            if has_goal and label.goal_relevance is None:
                raise TeacherSchemaError(
                    f"{label.window_id} has a goal but relevance is null"
                )
        return tuple(
            sorted(
                labels,
                key=lambda label: next(
                    index
                    for index, window in enumerate(windows)
                    if window.window_id == label.window_id
                ),
            )
        )

    def label_batch(
        self,
        windows: Sequence[EventWindow],
        *,
        thinking: bool = False,
        pass_name: str = "A",
    ) -> tuple[TeacherLabel, ...]:
        if not self.config.batch_minimum <= len(windows) <= self.config.batch_maximum:
            raise BatchPackingError("live teacher batches must contain 4 to 8 windows")
        payload = self.request_payload(
            windows,
            thinking=thinking,
            pass_name=pass_name,
        )
        last_error: TeacherSchemaError | None = None
        for _ in range(self.config.schema_retry_maximum + 1):
            response = self._post_with_transport_retry(payload)
            try:
                labels = self._parse_response(response, windows)
                def usage_value(key: str) -> int:
                    value = response.get(key, 0)
                    if isinstance(value, bool) or not isinstance(
                        value, (int, float)
                    ):
                        return 0
                    return max(int(value), 0)

                self.last_usage = TeacherUsage(
                    prompt_eval_count=usage_value("prompt_eval_count"),
                    eval_count=usage_value("eval_count"),
                    total_duration_ns=usage_value("total_duration"),
                    eval_duration_ns=usage_value("eval_duration"),
                )
                return labels
            except TeacherSchemaError as error:
                last_error = error
        raise TeacherSchemaError(
            f"teacher failed structured-output validation after "
            f"{self.config.schema_retry_maximum + 1} attempts: {last_error}"
        )


def config_fingerprint(config: TeacherConfig) -> str:
    value = {
        "endpoint": config.endpoint,
        "model": config.model,
        "modelDigest": config.model_digest,
        "ollamaVersion": config.ollama_version,
        "parameterSize": config.parameter_size,
        "quantizationLevel": config.quantization_level,
        "numCtx": config.num_ctx,
        "keepAlive": config.keep_alive,
        "concurrency": config.concurrency,
        "batchMinimum": config.batch_minimum,
        "batchMaximum": config.batch_maximum,
        "inputTokenBudget": config.input_token_budget,
        "promptVersion": config.prompt_version,
        "taxonomyVersion": config.taxonomy_version,
    }
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


class LabelCheckpoint:
    """SQLite-backed idempotent checkpoint for pause/resume labeling."""

    def __init__(self, path: Path, config: TeacherConfig) -> None:
        self._config = config
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._connection = sqlite3.connect(path)
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS labels (
                pass_name TEXT NOT NULL,
                window_id TEXT NOT NULL,
                label_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (pass_name, window_id)
            );
            CREATE TABLE IF NOT EXISTS failures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pass_name TEXT NOT NULL,
                window_ids_json TEXT NOT NULL,
                error_category TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS batch_metrics (
                pass_name TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                window_count INTEGER NOT NULL,
                wall_duration_ms REAL NOT NULL,
                prompt_eval_count INTEGER NOT NULL,
                eval_count INTEGER NOT NULL,
                total_duration_ns INTEGER NOT NULL,
                eval_duration_ns INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (pass_name, batch_id)
            );
            CREATE TABLE IF NOT EXISTS run_pauses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pass_name TEXT NOT NULL,
                reason TEXT NOT NULL,
                details_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );
            """
        )
        fingerprint = config_fingerprint(config)
        current = self._connection.execute(
            "SELECT value FROM metadata WHERE key = 'configFingerprint'"
        ).fetchone()
        if current is not None and current[0] != fingerprint:
            self._connection.close()
            raise TeacherError(
                "checkpoint belongs to a different teacher configuration"
            )
        self._connection.execute(
            "INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)",
            ("configFingerprint", fingerprint),
        )
        self._connection.commit()

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "LabelCheckpoint":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def set_provenance(self, provenance: OllamaProvenance) -> None:
        expected = {
            "modelTag": self._config.model,
            "modelDigest": self._config.model_digest,
            "ollamaVersion": self._config.ollama_version,
            "parameterSize": self._config.parameter_size,
            "quantizationLevel": self._config.quantization_level,
            "promptVersion": self._config.prompt_version,
            "taxonomyVersion": self._config.taxonomy_version,
        }
        if provenance.as_dict() != expected:
            raise TeacherError(
                "checkpoint provenance does not match the pinned teacher config"
            )
        encoded = json.dumps(
            provenance.as_dict(), sort_keys=True, separators=(",", ":")
        )
        current = self._connection.execute(
            "SELECT value FROM metadata WHERE key = 'provenance'"
        ).fetchone()
        if current is not None and current[0] != encoded:
            raise TeacherError(
                "Ollama model digest/version changed during this checkpoint"
            )
        self._connection.execute(
            "INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)",
            ("provenance", encoded),
        )
        self._connection.commit()

    def completed_ids(self, pass_name: str) -> set[str]:
        rows = self._connection.execute(
            "SELECT window_id FROM labels WHERE pass_name = ?",
            (pass_name,),
        )
        return {str(row[0]) for row in rows}

    def store_batch(
        self,
        pass_name: str,
        labels: Sequence[TeacherLabel],
        provenance: OllamaProvenance,
        *,
        wall_duration_ms: float | None = None,
        usage: TeacherUsage | None = None,
    ) -> None:
        created_at_ms = int(time.time() * 1000)
        with self._connection:
            for label in labels:
                value = {
                    "schemaVersion": "teacher-vote.v1",
                    "pass": pass_name,
                    **label.as_dict(),
                    **provenance.as_dict(),
                }
                encoded = json.dumps(
                    value,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                existing = self._connection.execute(
                    """
                    SELECT label_json FROM labels
                    WHERE pass_name = ? AND window_id = ?
                    """,
                    (pass_name, label.window_id),
                ).fetchone()
                if existing is not None:
                    if str(existing[0]) != encoded:
                        raise TeacherError(
                            f"checkpoint already contains a different "
                            f"{pass_name} label for {label.window_id}"
                        )
                    continue
                self._connection.execute(
                    """
                    INSERT INTO labels(
                        pass_name, window_id, label_json, created_at_ms
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (pass_name, label.window_id, encoded, created_at_ms),
                )
            if wall_duration_ms is not None:
                actual_usage = usage or TeacherUsage(0, 0, 0, 0)
                batch_ids = sorted(label.window_id for label in labels)
                batch_id = hashlib.sha256(
                    "\0".join(batch_ids).encode("utf-8")
                ).hexdigest()
                self._connection.execute(
                    """
                    INSERT INTO batch_metrics(
                        pass_name, batch_id, window_count, wall_duration_ms,
                        prompt_eval_count, eval_count, total_duration_ns,
                        eval_duration_ns, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(pass_name, batch_id) DO NOTHING
                    """,
                    (
                        pass_name,
                        batch_id,
                        len(labels),
                        max(wall_duration_ms, 0.0),
                        actual_usage.prompt_eval_count,
                        actual_usage.eval_count,
                        actual_usage.total_duration_ns,
                        actual_usage.eval_duration_ns,
                        created_at_ms,
                    ),
                )

    def record_failure(
        self,
        pass_name: str,
        window_ids: Sequence[str],
        error_category: str,
    ) -> None:
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO failures(
                    pass_name, window_ids_json, error_category, created_at_ms
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    pass_name,
                    json.dumps(sorted(window_ids), separators=(",", ":")),
                    error_category,
                    int(time.time() * 1000),
                ),
            )

    def record_pause(
        self,
        pass_name: str,
        reason: str,
        details: Mapping[str, object] | None = None,
    ) -> None:
        encoded = json.dumps(
            dict(details or {}),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO run_pauses(
                    pass_name, reason, details_json, created_at_ms
                ) VALUES (?, ?, ?, ?)
                """,
                (pass_name, reason, encoded, int(time.time() * 1000)),
            )

    def pause_history(self, pass_name: str) -> tuple[dict[str, object], ...]:
        rows = self._connection.execute(
            """
            SELECT reason, details_json, created_at_ms
            FROM run_pauses
            WHERE pass_name = ?
            ORDER BY id
            """,
            (pass_name,),
        )
        return tuple(
            {
                "reason": str(reason),
                "details": json.loads(str(details)),
                "createdAtMs": int(created_at_ms),
            }
            for reason, details, created_at_ms in rows
        )

    def export(self, path: Path, *, pass_name: str | None = None) -> None:
        if pass_name is None:
            rows = self._connection.execute(
                "SELECT label_json FROM labels ORDER BY pass_name, window_id"
            )
        else:
            rows = self._connection.execute(
                """
                SELECT label_json FROM labels
                WHERE pass_name = ?
                ORDER BY window_id
                """,
                (pass_name,),
            )
        values = (json.loads(str(row[0])) for row in rows)
        write_jsonl(path, values)

    def benchmark(self, pass_name: str) -> dict[str, object]:
        rows = list(
            self._connection.execute(
                """
                SELECT window_count, wall_duration_ms, eval_count,
                       eval_duration_ns
                FROM batch_metrics
                WHERE pass_name = ?
                ORDER BY batch_id
                """,
                (pass_name,),
            )
        )
        wall_per_label = sorted(
            float(row[1]) / int(row[0])
            for row in rows
            if int(row[0]) > 0
        )

        def percentile(values: Sequence[float], quantile: float) -> float:
            if not values:
                return 0.0
            index = math.ceil(quantile * len(values)) - 1
            return values[max(0, min(index, len(values) - 1))]

        labels = sum(int(row[0]) for row in rows)
        wall_ms = sum(float(row[1]) for row in rows)
        eval_tokens = sum(int(row[2]) for row in rows)
        eval_duration_ns = sum(int(row[3]) for row in rows)
        return {
            "benchmarkVersion": "teacher-throughput.v1",
            "pass": pass_name,
            "batchCount": len(rows),
            "labelCount": labels,
            "p50MillisecondsPerLabel": percentile(wall_per_label, 0.50),
            "p95MillisecondsPerLabel": percentile(wall_per_label, 0.95),
            "labelsPerDay": (
                labels / (wall_ms / 1000.0) * 86_400
                if wall_ms > 0
                else 0.0
            ),
            "outputTokensPerSecond": (
                eval_tokens / (eval_duration_ns / 1_000_000_000)
                if eval_duration_ns > 0
                else 0.0
            ),
        }


def run_teacher_pass(
    windows: Sequence[EventWindow],
    *,
    pass_name: str,
    teacher: OllamaTeacher,
    checkpoint_path: Path,
    output_path: Path,
    pause_file: Path | None = None,
    dry_run: bool = False,
    thinking: bool = False,
    allowed_hours: AllowedHours | None = None,
    thermal_guard: bool = False,
    thermal_probe: ThermalProbe = macos_thermal_probe,
    thermal_unknown_policy: str = "pause",
    thermal_backoff_seconds: float = 60.0,
    thermal_maximum_sleep_seconds: float = 300.0,
    clock: Callable[[], datetime] = lambda: datetime.now().astimezone(),
    sleeper: Callable[[float], None] = time.sleep,
) -> TeacherRunResult:
    if pass_name not in {"A", "B", "C"}:
        raise ValueError("pass_name must be A, B, or C")
    unique_ids = {window.window_id for window in windows}
    if len(unique_ids) != len(windows):
        raise ValueError("teacher input contains duplicate windowId values")
    if thermal_unknown_policy not in {"pause", "continue"}:
        raise ValueError("thermal_unknown_policy must be pause or continue")
    if thermal_backoff_seconds < 0 or thermal_maximum_sleep_seconds < 0:
        raise ValueError("thermal sleep durations must be non-negative")

    def boundary_pause() -> tuple[str | None, dict[str, object]]:
        if pause_file is not None and pause_file.exists():
            return "pause_file", {"path": str(pause_file)}
        now = clock()
        if allowed_hours is not None and not allowed_hours.contains(now):
            return (
                "outside_allowed_hours",
                {
                    "allowedHours": allowed_hours.specification,
                    "observedLocalTime": now.strftime("%H:%M"),
                },
            )
        if not thermal_guard:
            return None, {}
        observed = thermal_probe()
        observed.validate()
        if observed.state == "unknown":
            warnings.warn(
                f"thermal state is unknown: {observed.detail}",
                RuntimeWarning,
                stacklevel=2,
            )
            if thermal_unknown_policy == "pause":
                return (
                    "thermal_unknown",
                    {"thermalState": observed.state, "detail": observed.detail},
                )
            return None, {}
        if observed.state not in {"serious", "critical"}:
            return None, {}
        backoff = min(
            thermal_backoff_seconds,
            thermal_maximum_sleep_seconds,
        )
        if backoff > 0:
            sleeper(backoff)
        after_backoff = thermal_probe()
        after_backoff.validate()
        if after_backoff.state in {"nominal", "fair"}:
            return None, {}
        if after_backoff.state == "unknown":
            warnings.warn(
                f"thermal state became unknown after backoff: "
                f"{after_backoff.detail}",
                RuntimeWarning,
                stacklevel=2,
            )
            if thermal_unknown_policy == "continue":
                return None, {}
            return (
                "thermal_unknown",
                {
                    "thermalState": after_backoff.state,
                    "detail": after_backoff.detail,
                    "backoffSeconds": backoff,
                },
            )
        return (
            "thermal_pressure",
            {
                "thermalState": after_backoff.state,
                "detail": after_backoff.detail,
                "backoffSeconds": backoff,
            },
        )

    if dry_run:
        batches = pack_batches(windows, teacher.config)
        return TeacherRunResult(
            status="dry_run",
            pass_name=pass_name,
            completed_before=0,
            completed_now=0,
            remaining=len(windows),
            batches=len(batches),
        )

    with LabelCheckpoint(checkpoint_path, teacher.config) as checkpoint:
        completed = checkpoint.completed_ids(pass_name)
        remaining_windows = [
            window for window in windows if window.window_id not in completed
        ]
        if not remaining_windows:
            checkpoint.export(output_path)
            return TeacherRunResult(
                status="complete",
                pass_name=pass_name,
                completed_before=len(completed),
                completed_now=0,
                remaining=0,
                batches=0,
            )
        batches = pack_batches(remaining_windows, teacher.config)
        pause_reason, pause_details = boundary_pause()
        if pause_reason is not None:
            checkpoint.record_pause(pass_name, pause_reason, pause_details)
            checkpoint.export(output_path)
            return TeacherRunResult(
                status="paused",
                pass_name=pass_name,
                completed_before=len(completed),
                completed_now=0,
                remaining=len(remaining_windows),
                batches=0,
                pause_reason=pause_reason,
            )
        provenance = teacher.fetch_provenance()
        checkpoint.set_provenance(provenance)
        completed_now = 0
        executed_batches = 0
        status = "complete"
        try:
            for batch_index, batch in enumerate(batches):
                if batch_index > 0:
                    pause_reason, pause_details = boundary_pause()
                if pause_reason is not None:
                    status = "paused"
                    checkpoint.record_pause(
                        pass_name,
                        pause_reason,
                        pause_details,
                    )
                    break
                try:
                    started_at = time.monotonic()
                    labels = teacher.label_batch(
                        batch.windows,
                        thinking=thinking,
                        pass_name=pass_name,
                    )
                    wall_duration_ms = (
                        time.monotonic() - started_at
                    ) * 1000.0
                except TeacherError as error:
                    checkpoint.record_failure(
                        pass_name,
                        [window.window_id for window in batch.windows],
                        type(error).__name__,
                    )
                    raise
                checkpoint.store_batch(
                    pass_name,
                    labels,
                    provenance,
                    wall_duration_ms=wall_duration_ms,
                    usage=teacher.last_usage,
                )
                completed_now += len(labels)
                executed_batches += 1
        except KeyboardInterrupt:
            status = "paused"
            pause_reason = "keyboard_interrupt"
            checkpoint.record_pause(pass_name, pause_reason)
        finally:
            checkpoint.export(output_path)
        return TeacherRunResult(
            status=status,
            pass_name=pass_name,
            completed_before=len(completed),
            completed_now=completed_now,
            remaining=len(remaining_windows) - completed_now,
            batches=executed_batches,
            pause_reason=pause_reason,
        )
