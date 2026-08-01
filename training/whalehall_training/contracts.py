from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
TAXONOMY_PATH = PACKAGE_ROOT / "taxonomy" / "activity.v1.json"

with TAXONOMY_PATH.open("r", encoding="utf-8") as taxonomy_file:
    _TAXONOMY = json.load(taxonomy_file)

ACTIVITY_LABELS: tuple[str, ...] = tuple(_TAXONOMY["activities"])
GOAL_RELEVANCE_LABELS: tuple[str, ...] = tuple(_TAXONOMY["goalRelevance"])
TRIGGER_REASONS: tuple[str, ...] = tuple(_TAXONOMY["triggerReasons"])
REASON_CODES: tuple[str, ...] = tuple(_TAXONOMY["reasonCodes"])

_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ID_MAXIMUM = 160
_FORBIDDEN_ATTRIBUTE_KEYS = {
    "key",
    "key_name",
    "keyname",
    "keycode",
    "raw_key",
    "password",
    "passcode",
    "otp",
    "clipboard",
    "absolute_x",
    "absolute_y",
    "screen_x",
    "screen_y",
}


class ValidationError(ValueError):
    """A stable, user-facing validation failure for a JSONL record."""


def _require_mapping(value: object, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{path} must be an object")
    return value


def _require_sequence(value: object, path: str) -> Sequence[object]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ValidationError(f"{path} must be an array")
    return value


def _require_string(
    value: object,
    path: str,
    *,
    maximum: int = _ID_MAXIMUM,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{path} must be a string")
    if not allow_empty and not value.strip():
        raise ValidationError(f"{path} must not be empty")
    if len(value) > maximum:
        raise ValidationError(f"{path} exceeds {maximum} characters")
    return value


def _require_integer(value: object, path: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{path} must be an integer")
    if value < minimum:
        raise ValidationError(f"{path} must be >= {minimum}")
    return value


def _reject_sensitive_keys(value: object, path: str) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = re.sub(r"(?<!^)(?=[A-Z])", "_", str(key)).lower()
            if normalized in _FORBIDDEN_ATTRIBUTE_KEYS:
                raise ValidationError(
                    f"{path}.{key} is forbidden: raw keys, secrets, clipboard "
                    "content, and absolute pointer coordinates are not training data"
                )
            _reject_sensitive_keys(child, f"{path}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for index, child in enumerate(value):
            _reject_sensitive_keys(child, f"{path}[{index}]")


@dataclass(frozen=True)
class Event:
    event_id: str
    kind: str
    source: str
    occurred_at_ms: int
    summary: str
    attributes: Mapping[str, Any]

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "eventId": self.event_id,
            "kind": self.kind,
            "source": self.source,
            "occurredAtMs": self.occurred_at_ms,
            "summary": self.summary,
        }
        if self.attributes:
            value["attributes"] = dict(self.attributes)
        return value


@dataclass(frozen=True)
class Goal:
    goal_id: str
    version: int
    text: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "goalId": self.goal_id,
            "version": self.version,
            "text": self.text,
        }


@dataclass(frozen=True)
class GoldLabel:
    activity: str
    goal_relevance: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "activity": self.activity,
            "goalRelevance": self.goal_relevance,
        }


@dataclass(frozen=True)
class EventWindow:
    window_id: str
    participant_id: str
    device_id: str
    project_goal_id: str | None
    session_id: str
    session_date: str
    goal: Goal | None
    trigger_reason: str
    started_at_ms: int
    ended_at_ms: int
    events: tuple[Event, ...]
    context_only: tuple[Event, ...]
    model_input: str
    metadata: Mapping[str, Any]
    gold: GoldLabel | None
    schema_version: str = "event-window.v1"

    @property
    def event_ids(self) -> frozenset[str]:
        return frozenset(event.event_id for event in self.events)

    @property
    def has_goal(self) -> bool:
        return self.goal is not None

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "schemaVersion": self.schema_version,
            "windowId": self.window_id,
            "participantId": self.participant_id,
            "deviceId": self.device_id,
            "projectGoalId": self.project_goal_id,
            "sessionId": self.session_id,
            "sessionDate": self.session_date,
            "goal": self.goal.as_dict() if self.goal else None,
            "triggerReason": self.trigger_reason,
            "startedAtMs": self.started_at_ms,
            "endedAtMs": self.ended_at_ms,
            "events": [event.as_dict() for event in self.events],
            "contextOnly": [event.as_dict() for event in self.context_only],
            "modelInput": self.model_input,
        }
        if self.metadata:
            value["metadata"] = dict(self.metadata)
        if self.gold is not None:
            value["gold"] = self.gold.as_dict()
        return value


@dataclass(frozen=True)
class TeacherLabel:
    window_id: str
    activity: str
    goal_relevance: str | None
    ambiguous: bool
    reason_codes: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "windowId": self.window_id,
            "activity": self.activity,
            "goalRelevance": self.goal_relevance,
            "ambiguous": self.ambiguous,
            "reasonCodes": list(self.reason_codes),
        }


def _parse_event(value: object, path: str) -> Event:
    data = _require_mapping(value, path)
    allowed = {
        "eventId",
        "kind",
        "source",
        "occurredAtMs",
        "summary",
        "attributes",
    }
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ValidationError(f"{path} has unknown fields: {', '.join(unknown)}")
    attributes = data.get("attributes", {})
    attributes_mapping = _require_mapping(attributes, f"{path}.attributes")
    _reject_sensitive_keys(attributes_mapping, f"{path}.attributes")
    return Event(
        event_id=_require_string(data.get("eventId"), f"{path}.eventId"),
        kind=_require_string(data.get("kind"), f"{path}.kind"),
        source=_require_string(data.get("source"), f"{path}.source"),
        occurred_at_ms=_require_integer(
            data.get("occurredAtMs"), f"{path}.occurredAtMs"
        ),
        summary=_require_string(
            data.get("summary"), f"{path}.summary", maximum=4000
        ),
        attributes=dict(attributes_mapping),
    )


def parse_event_window(value: object) -> EventWindow:
    data = _require_mapping(value, "$")
    required = {
        "schemaVersion",
        "windowId",
        "participantId",
        "deviceId",
        "projectGoalId",
        "sessionId",
        "sessionDate",
        "goal",
        "triggerReason",
        "startedAtMs",
        "endedAtMs",
        "events",
        "contextOnly",
        "modelInput",
    }
    allowed = {
        "schemaVersion",
        "windowId",
        "participantId",
        "deviceId",
        "projectGoalId",
        "sessionId",
        "sessionDate",
        "goal",
        "triggerReason",
        "startedAtMs",
        "endedAtMs",
        "events",
        "contextOnly",
        "modelInput",
        "metadata",
        "gold",
    }
    unknown = sorted(set(data) - allowed)
    missing = sorted(required - set(data))
    if missing:
        raise ValidationError(f"$ is missing fields: {', '.join(missing)}")
    if unknown:
        raise ValidationError(f"$ has unknown fields: {', '.join(unknown)}")
    if data.get("schemaVersion") != "event-window.v1":
        raise ValidationError("$.schemaVersion must equal event-window.v1")

    session_date = _require_string(data.get("sessionDate"), "$.sessionDate")
    if not _DATE_PATTERN.fullmatch(session_date):
        raise ValidationError("$.sessionDate must use YYYY-MM-DD")

    project_goal_id_value = data.get("projectGoalId")
    project_goal_id = (
        None
        if project_goal_id_value is None
        else _require_string(project_goal_id_value, "$.projectGoalId")
    )

    goal_value = data.get("goal")
    goal: Goal | None = None
    if goal_value is not None:
        goal_data = _require_mapping(goal_value, "$.goal")
        if set(goal_data) != {"goalId", "version", "text"}:
            raise ValidationError(
                "$.goal must contain exactly goalId, version, and text"
            )
        goal = Goal(
            goal_id=_require_string(goal_data["goalId"], "$.goal.goalId"),
            version=_require_integer(goal_data["version"], "$.goal.version"),
            text=_require_string(
                goal_data["text"], "$.goal.text", maximum=4000
            ),
        )

    trigger_reason = _require_string(
        data.get("triggerReason"), "$.triggerReason"
    )
    if trigger_reason not in TRIGGER_REASONS:
        raise ValidationError(
            f"$.triggerReason must be one of {', '.join(TRIGGER_REASONS)}"
        )

    started_at_ms = _require_integer(data.get("startedAtMs"), "$.startedAtMs")
    ended_at_ms = _require_integer(data.get("endedAtMs"), "$.endedAtMs")
    if ended_at_ms < started_at_ms:
        raise ValidationError("$.endedAtMs must be >= $.startedAtMs")

    event_values = _require_sequence(data.get("events"), "$.events")
    if not 1 <= len(event_values) <= 64:
        raise ValidationError("$.events must contain 1 to 64 semantic events")
    events = tuple(
        _parse_event(event, f"$.events[{index}]")
        for index, event in enumerate(event_values)
    )
    if len({event.event_id for event in events}) != len(events):
        raise ValidationError("$.events contains duplicate eventId values")
    if any(
        event.occurred_at_ms > ended_at_ms
        for event in events
    ):
        raise ValidationError(
            "$.events timestamps must not exceed the sealed window end"
        )
    if events[0].occurred_at_ms != started_at_ms:
        raise ValidationError(
            "$.startedAtMs must equal the first effective event timestamp"
        )

    context_values = _require_sequence(
        data.get("contextOnly", []), "$.contextOnly"
    )
    if len(context_values) > 5:
        raise ValidationError("$.contextOnly must contain at most 5 events")
    context_only = tuple(
        _parse_event(event, f"$.contextOnly[{index}]")
        for index, event in enumerate(context_values)
    )
    if len({event.event_id for event in context_only}) != len(context_only):
        raise ValidationError("$.contextOnly contains duplicate eventId values")
    if any(
        event.event_id in {item.event_id for item in events}
        for event in context_only
    ):
        raise ValidationError(
            "$.contextOnly events must not be counted again in $.events"
        )
    if any(
        event.occurred_at_ms < max(0, started_at_ms - 30_000)
        or event.occurred_at_ms > started_at_ms
        for event in context_only
    ):
        raise ValidationError(
            "$.contextOnly events must be from the preceding 30 seconds"
        )
    context_token_estimate = sum(
        max(
            (len(event.summary) + 3) // 4,
            (len(event.summary.encode("utf-8")) + 2) // 3,
        )
        for event in context_only
    )
    if context_token_estimate > 96:
        raise ValidationError(
            "$.contextOnly exceeds the conservative 96-token budget"
        )

    if trigger_reason == "event_count":
        if len(events) != 64:
            raise ValidationError("event_count windows must contain 64 events")
        if ended_at_ms - started_at_ms > 300_000:
            raise ValidationError(
                "event_count cannot occur after the five-minute deadline"
            )
    elif trigger_reason == "max_wait":
        if len(events) >= 64:
            raise ValidationError("max_wait windows must contain fewer than 64 events")
        if ended_at_ms - started_at_ms < 300_000:
            raise ValidationError(
                "max_wait windows must span at least five minutes"
            )

    metadata_value = data.get("metadata", {})
    metadata = _require_mapping(metadata_value, "$.metadata")
    _reject_sensitive_keys(metadata, "$.metadata")

    gold_value = data.get("gold")
    gold: GoldLabel | None = None
    if gold_value is not None:
        gold_data = _require_mapping(gold_value, "$.gold")
        if set(gold_data) != {"activity", "goalRelevance"}:
            raise ValidationError(
                "$.gold must contain exactly activity and goalRelevance"
            )
        activity = _require_string(gold_data["activity"], "$.gold.activity")
        if activity not in ACTIVITY_LABELS:
            raise ValidationError("$.gold.activity is outside the v1 taxonomy")
        relevance_value = gold_data["goalRelevance"]
        relevance = (
            None
            if relevance_value is None
            else _require_string(relevance_value, "$.gold.goalRelevance")
        )
        if relevance is not None and relevance not in GOAL_RELEVANCE_LABELS:
            raise ValidationError(
                "$.gold.goalRelevance is outside the v1 taxonomy"
            )
        if goal is None and relevance is not None:
            raise ValidationError(
                "$.gold.goalRelevance must be null when the window has no goal"
            )
        if goal is not None and relevance is None:
            raise ValidationError(
                "$.gold.goalRelevance is required when the window has a goal"
            )
        gold = GoldLabel(activity=activity, goal_relevance=relevance)

    return EventWindow(
        window_id=_require_string(data.get("windowId"), "$.windowId"),
        participant_id=_require_string(
            data.get("participantId"), "$.participantId"
        ),
        device_id=_require_string(data.get("deviceId"), "$.deviceId"),
        project_goal_id=project_goal_id,
        session_id=_require_string(data.get("sessionId"), "$.sessionId"),
        session_date=session_date,
        goal=goal,
        trigger_reason=trigger_reason,
        started_at_ms=started_at_ms,
        ended_at_ms=ended_at_ms,
        events=events,
        context_only=context_only,
        model_input=_require_string(
            data.get("modelInput"), "$.modelInput", maximum=131_072
        ),
        metadata=dict(metadata),
        gold=gold,
    )


def parse_teacher_label(
    value: object,
    *,
    expected_window_ids: set[str] | None = None,
) -> TeacherLabel:
    data = _require_mapping(value, "$")
    required = {
        "windowId",
        "activity",
        "goalRelevance",
        "ambiguous",
        "reasonCodes",
    }
    if set(data) != required:
        missing = sorted(required - set(data))
        unknown = sorted(set(data) - required)
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if unknown:
            details.append(f"unknown {', '.join(unknown)}")
        raise ValidationError(f"teacher label fields are invalid: {'; '.join(details)}")

    window_id = _require_string(data["windowId"], "$.windowId")
    if expected_window_ids is not None and window_id not in expected_window_ids:
        raise ValidationError(f"teacher returned unexpected windowId {window_id}")
    activity = _require_string(data["activity"], "$.activity")
    if activity not in ACTIVITY_LABELS:
        raise ValidationError("$.activity is outside activity-taxonomy.v1")
    relevance_value = data["goalRelevance"]
    goal_relevance = (
        None
        if relevance_value is None
        else _require_string(relevance_value, "$.goalRelevance")
    )
    if (
        goal_relevance is not None
        and goal_relevance not in GOAL_RELEVANCE_LABELS
    ):
        raise ValidationError(
            "$.goalRelevance is outside activity-taxonomy.v1"
        )
    if not isinstance(data["ambiguous"], bool):
        raise ValidationError("$.ambiguous must be a boolean")
    reason_values = _require_sequence(data["reasonCodes"], "$.reasonCodes")
    if not 1 <= len(reason_values) <= 6:
        raise ValidationError("$.reasonCodes must contain 1 to 6 values")
    reason_codes = tuple(
        _require_string(reason, f"$.reasonCodes[{index}]")
        for index, reason in enumerate(reason_values)
    )
    if len(set(reason_codes)) != len(reason_codes):
        raise ValidationError("$.reasonCodes must be unique")
    unknown_reasons = sorted(set(reason_codes) - set(REASON_CODES))
    if unknown_reasons:
        raise ValidationError(
            f"unknown reasonCodes: {', '.join(unknown_reasons)}"
        )
    return TeacherLabel(
        window_id=window_id,
        activity=activity,
        goal_relevance=goal_relevance,
        ambiguous=data["ambiguous"],
        reason_codes=reason_codes,
    )


def teacher_response_schema(batch_size: int) -> dict[str, Any]:
    """Return the exact Ollama structured-output schema for one batch."""

    if not 1 <= batch_size <= 8:
        raise ValueError("batch_size must be between 1 and 8")
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["schemaVersion", "labels"],
        "properties": {
            "schemaVersion": {"const": "teacher-label-batch.v1"},
            "labels": {
                "type": "array",
                "minItems": batch_size,
                "maxItems": batch_size,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "windowId",
                        "activity",
                        "goalRelevance",
                        "ambiguous",
                        "reasonCodes",
                    ],
                    "properties": {
                        "windowId": {"type": "string"},
                        "activity": {"enum": list(ACTIVITY_LABELS)},
                        "goalRelevance": {
                            "enum": [*GOAL_RELEVANCE_LABELS, None]
                        },
                        "ambiguous": {"type": "boolean"},
                        "reasonCodes": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 6,
                            "uniqueItems": True,
                            "items": {"enum": list(REASON_CODES)},
                        },
                    },
                },
            },
        },
    }
