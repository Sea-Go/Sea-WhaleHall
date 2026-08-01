from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .contracts import Event, EventWindow, Goal, ValidationError, parse_event_window

RUNTIME_EXPORT_VERSION = "runtime-window-export.v2"
RUNTIME_SCHEMA_VERSION = "event-window.v1"
DESKTOP_EVENT_SCHEMA_VERSION = "desktop-event.v1"
SUPPORTED_REFLECTION_SQLITE_SCHEMA_VERSIONS = frozenset({1, 2})
MODEL_INPUT_TOKEN_LIMIT = 3_000
MODEL_INPUT_BYTE_LIMIT = 32 * 1_024
MAX_ACTIVE_GOAL_TEXT_LENGTH = 1_000

_NON_COUNTED_KINDS = {
    "goal.contextChanged",
    "authorization.revoked",
    "authorization.granted",
    "presence.afkStarted",
    "presence.afkEnded",
    "presence.locked",
    "presence.unlocked",
    "presence.sleep",
    "presence.wake",
    "reflection.completed",
    "reflection.failed",
    "tool.started",
    "tool.progress",
    "tool.completed",
    "tool.failed",
    "tool.cancelled",
    "system.heartbeat",
}
_BOUNDARY_KINDS = {
    "goal.contextChanged",
    "authorization.revoked",
    "presence.afkStarted",
    "presence.afkEnded",
    "presence.locked",
    "presence.unlocked",
    "presence.sleep",
    "presence.wake",
}
_CONTENT_KEYS = {
    "document_name",
    "document_text",
    "file_name",
    "href",
    "label",
    "query",
    "relative_path",
    "search_term",
    "search_terms",
    "text",
    "title",
    "url",
    "value",
    "window_title",
}
_FORBIDDEN_KEYS = {
    "absolute_x",
    "absolute_y",
    "access_token",
    "authorization",
    "clipboard",
    "cookie",
    "key",
    "key_code",
    "key_name",
    "keycode",
    "otp",
    "passcode",
    "password",
    "private_key",
    "raw_key",
    "refresh_token",
    "screen_x",
    "screen_y",
    "secret",
}
_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FORBIDDEN_KEY_MARKERS = (
    "access_token",
    "api_key",
    "auth_token",
    "authentication",
    "authorization",
    "clipboard",
    "cookie",
    "credential",
    "key_code",
    "key_name",
    "key_value",
    "otp",
    "passcode",
    "password",
    "private_key",
    "raw_key",
    "refresh_token",
    "secret",
    "session_token",
)
_CONTENT_KEY_SUFFIXES = (
    "_content",
    "_path",
    "_query",
    "_text",
    "_title",
    "_url",
)


@dataclass(frozen=True)
class RuntimeExportResult:
    exported_count: int
    output_sha256: str
    source_rows_sha256: str
    manifest: Mapping[str, object]


def _normalized_key(key: object) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", str(key)).lower()


def _is_forbidden_key(key: str) -> bool:
    return key in _FORBIDDEN_KEYS or any(
        marker in key for marker in _FORBIDDEN_KEY_MARKERS
    )


def _is_content_key(key: str) -> bool:
    return key in _CONTENT_KEYS or key.endswith(_CONTENT_KEY_SUFFIXES)


def _sanitize_value(
    value: object,
    *,
    include_content: bool,
    redaction_counter: list[int],
    path: str,
) -> object:
    if isinstance(value, Mapping):
        result: dict[str, object] = {}
        for key in sorted(value, key=str):
            normalized = _normalized_key(key)
            if _is_forbidden_key(normalized):
                raise ValidationError(
                    f"{path}.{key} contains a forbidden raw-key, secret, "
                    "clipboard, credential, or absolute-coordinate field"
                )
            if not include_content and _is_content_key(normalized):
                redaction_counter[0] += 1
                continue
            result[str(key)] = _sanitize_value(
                value[key],
                include_content=include_content,
                redaction_counter=redaction_counter,
                path=f"{path}.{key}",
            )
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [
            _sanitize_value(
                item,
                include_content=include_content,
                redaction_counter=redaction_counter,
                path=f"{path}[{index}]",
            )
            for index, item in enumerate(value)
        ]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise ValidationError(f"{path} contains an unsupported JSON value")


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _conservative_token_estimate(value: str) -> int:
    ascii_run = 0
    tokens = 0
    for character in value:
        if ord(character) <= 0x7F:
            ascii_run += 1
            continue
        if ascii_run:
            tokens += (ascii_run + 3) // 4
            ascii_run = 0
        tokens += 1
    if ascii_run:
        tokens += (ascii_run + 3) // 4
    return tokens


def _model_input_fits(value: str) -> bool:
    return (
        len(value.encode("utf-8")) <= MODEL_INPUT_BYTE_LIMIT
        and _conservative_token_estimate(value) <= MODEL_INPUT_TOKEN_LIMIT
    )


def _compose_model_input(
    goal_section: str,
    context_lines: Sequence[str],
    event_lines: Sequence[str],
) -> str:
    context_section = "(none)" if not context_lines else "\n".join(context_lines)
    return (
        f"[GOAL]\n{goal_section}\n"
        f"[CONTEXT_ONLY]\n{context_section}\n"
        f"[EVENTS]\n{chr(10).join(event_lines)}"
    )


def _runtime_model_event_line(event: Mapping[str, object]) -> str:
    return _canonical_json(
        {
            "eventId": event["eventId"],
            "cursor": event["cursor"],
            "kind": event["kind"],
            "source": event["source"],
            "occurredAtMs": event["occurredAtMs"],
            "goalVersion": event["goalVersion"],
            "payload": event["payload"],
        }
    )


def _compact_model_value(value: object, depth: int = 0) -> object:
    if isinstance(value, str):
        return value[:160]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= 4:
        return "[bounded]"
    if isinstance(value, Mapping):
        return {
            str(key): _compact_model_value(value[key], depth + 1)
            for key in sorted(value, key=str)
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        selected = [
            _compact_model_value(entry, depth + 1) for entry in value[:8]
        ]
        if len(value) > len(selected):
            selected.append({"omittedItems": len(value) - len(selected)})
        return selected
    return str(value)[:160]


def _render_event_skeleton(event: Mapping[str, object]) -> str:
    return _canonical_json(
        {
            "kind": event["kind"],
            "occurredAtMs": event["occurredAtMs"],
        }
    )


def _render_compact_event(event: Mapping[str, object]) -> str:
    return _canonical_json(
        {
            "kind": event["kind"],
            "occurredAtMs": event["occurredAtMs"],
            "payload": _compact_model_value(event["payload"]),
        }
    )


def _render_bounded_model_input(
    goal_section: str,
    context_events: Sequence[Mapping[str, object]],
    events: Sequence[Mapping[str, object]],
) -> str:
    rich_context_lines = [
        _runtime_model_event_line(event) for event in context_events
    ]
    rich_event_lines = [_runtime_model_event_line(event) for event in events]
    rich = _compose_model_input(
        goal_section, rich_context_lines, rich_event_lines
    )
    if _model_input_fits(rich):
        return rich

    context_lines = [_render_event_skeleton(event) for event in context_events]
    event_lines = [_render_event_skeleton(event) for event in events]
    bounded = _compose_model_input(goal_section, context_lines, event_lines)
    if not _model_input_fits(bounded):
        raise ValidationError(
            "goal and semantic event skeleton exceed the deterministic "
            "model input budget"
        )

    upgrades: list[tuple[list[str], int, str]] = []
    for index in range(len(events) - 1, -1, -1):
        upgrades.append(
            (event_lines, index, _render_compact_event(events[index]))
        )
    for index in range(len(context_events) - 1, -1, -1):
        upgrades.append(
            (
                context_lines,
                index,
                _render_compact_event(context_events[index]),
            )
        )
    for lines, index, replacement in upgrades:
        previous = lines[index]
        lines[index] = replacement
        candidate = _compose_model_input(
            goal_section, context_lines, event_lines
        )
        if _model_input_fits(candidate):
            bounded = candidate
        else:
            lines[index] = previous
    return bounded


def _require_mapping(value: object, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{path} must be an object")
    return value


def _runtime_event(
    value: object,
    *,
    include_content: bool,
    redaction_counter: list[int],
    path: str,
) -> tuple[Event, dict[str, object], str]:
    event = _require_mapping(value, path)
    expected = {
        "schemaVersion",
        "eventId",
        "cursor",
        "deviceId",
        "sessionId",
        "kind",
        "source",
        "occurredAtMs",
        "observedAtMs",
        "goalVersion",
        "sensitivity",
        "payload",
    }
    if set(event) != expected or event.get("schemaVersion") != DESKTOP_EVENT_SCHEMA_VERSION:
        raise ValidationError(f"{path} must exactly match desktop-event.v1")
    for field in ("eventId", "cursor", "deviceId", "sessionId", "kind", "source"):
        if not isinstance(event.get(field), str) or not event[field]:
            raise ValidationError(f"{path}.{field} must be a non-empty string")
    for field in ("occurredAtMs", "observedAtMs"):
        field_value = event.get(field)
        if (
            isinstance(field_value, bool)
            or not isinstance(field_value, int)
            or field_value < 0
        ):
            raise ValidationError(f"{path}.{field} must be a non-negative integer")
    goal_version = event.get("goalVersion")
    if (
        goal_version is not None
        and (
            isinstance(goal_version, bool)
            or not isinstance(goal_version, int)
            or goal_version < 0
        )
    ):
        raise ValidationError(f"{path}.goalVersion is invalid")
    sensitivity = event.get("sensitivity")
    if sensitivity not in {"metadata", "content"}:
        raise ValidationError(f"{path}.sensitivity is invalid")
    before = redaction_counter[0]
    sanitized_payload = _sanitize_value(
        _require_mapping(event.get("payload"), f"{path}.payload"),
        include_content=include_content,
        redaction_counter=redaction_counter,
        path=f"{path}.payload",
    )
    if sensitivity == "content" and not include_content:
        # The event remains useful for structural counts, but no content-bearing
        # payload field can cross the export boundary.
        redaction_counter[0] += int(redaction_counter[0] == before)
    sanitized_runtime = {
        "schemaVersion": DESKTOP_EVENT_SCHEMA_VERSION,
        "eventId": event["eventId"],
        "cursor": event["cursor"],
        "deviceId": event["deviceId"],
        "sessionId": event["sessionId"],
        "kind": event["kind"],
        "source": event["source"],
        "occurredAtMs": event["occurredAtMs"],
        "observedAtMs": event["observedAtMs"],
        "goalVersion": goal_version,
        "sensitivity": sensitivity,
        "payload": sanitized_payload,
    }
    training_event = Event(
        event_id=str(event["eventId"]),
        kind=str(event["kind"]),
        source=str(event["source"]),
        occurred_at_ms=int(event["occurredAtMs"]),
        summary=f"{event['kind']} observed by {event['source']}",
        attributes={
            "cursor": event["cursor"],
            "goalVersion": goal_version,
            "sensitivity": sensitivity,
            "payload": sanitized_payload,
        },
    )
    return training_event, sanitized_runtime, str(event["kind"])


def _runtime_goal(value: object) -> tuple[Goal | None, dict[str, object] | None, str]:
    if value is None:
        return None, None, "null"
    goal = _require_mapping(value, "$.goal")
    expected = {"goalId", "planId", "version", "text", "activatedAtMs"}
    if set(goal) != expected:
        raise ValidationError("$.goal has an unexpected shape")
    if not isinstance(goal.get("goalId"), str) or not goal["goalId"]:
        raise ValidationError("$.goal.goalId must be a non-empty string")
    if goal.get("planId") is not None and not isinstance(goal["planId"], str):
        raise ValidationError("$.goal.planId must be string or null")
    if (
        not isinstance(goal.get("text"), str)
        or not goal["text"]
        or len(goal["text"]) > MAX_ACTIVE_GOAL_TEXT_LENGTH
    ):
        raise ValidationError(
            "$.goal.text must contain 1 to "
            f"{MAX_ACTIVE_GOAL_TEXT_LENGTH} characters"
        )
    for field in ("version", "activatedAtMs"):
        field_value = goal.get(field)
        if (
            isinstance(field_value, bool)
            or not isinstance(field_value, int)
            or field_value < 0
        ):
            raise ValidationError(f"$.goal.{field} is invalid")
    training_goal = Goal(
        goal_id=str(goal["goalId"]),
        version=int(goal["version"]),
        text=str(goal["text"]),
    )
    runtime_goal = {
        "goalId": goal["goalId"],
        "planId": goal["planId"],
        "version": goal["version"],
        "text": goal["text"],
        "activatedAtMs": goal["activatedAtMs"],
    }
    rendered = _canonical_json(
        {
            "goalId": goal["goalId"],
            "planId": goal["planId"],
            "version": goal["version"],
            "text": goal["text"],
        }
    )
    return training_goal, runtime_goal, rendered


def _session_date(timestamp_ms: int, timezone: ZoneInfo) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone).date().isoformat()


def convert_runtime_window(
    value: object,
    *,
    participant_id: str,
    session_timezone: str,
    project_goal_id: str | None = None,
    include_content: bool = False,
) -> EventWindow:
    runtime = _require_mapping(value, "$")
    expected = {
        "schemaVersion",
        "windowId",
        "collectorId",
        "deviceId",
        "sessionId",
        "triggerReason",
        "goal",
        "goalVersion",
        "startedAtMs",
        "endedAtMs",
        "deadlineAtMs",
        "eventCount",
        "firstCursor",
        "lastCursor",
        "events",
        "contextOnly",
        "modelInput",
        "inputHash",
    }
    if set(runtime) != expected or runtime.get("schemaVersion") != RUNTIME_SCHEMA_VERSION:
        raise ValidationError("$ must exactly match the runtime EventWindowV1")
    for field in (
        "windowId",
        "collectorId",
        "deviceId",
        "sessionId",
        "firstCursor",
        "lastCursor",
        "modelInput",
        "inputHash",
    ):
        if not isinstance(runtime.get(field), str) or not runtime[field]:
            raise ValidationError(f"$.{field} must be a non-empty string")
    if runtime.get("triggerReason") not in {
        "event_count",
        "max_wait",
        "goal_boundary",
        "presence_boundary",
    }:
        raise ValidationError("$.triggerReason is invalid")
    for field in ("startedAtMs", "endedAtMs", "deadlineAtMs", "eventCount"):
        field_value = runtime.get(field)
        if (
            isinstance(field_value, bool)
            or not isinstance(field_value, int)
            or field_value < 0
        ):
            raise ValidationError(f"$.{field} must be a non-negative integer")
    if int(runtime["eventCount"]) < 1:
        raise ValidationError("$.eventCount must be positive")
    if not isinstance(runtime.get("events"), list) or not isinstance(
        runtime.get("contextOnly"), list
    ):
        raise ValidationError("$.events and $.contextOnly must be arrays")
    if not participant_id or len(participant_id) > 160:
        raise ValidationError("participant_id must be 1 to 160 characters")
    if project_goal_id is not None and (
        not project_goal_id or len(project_goal_id) > 160
    ):
        raise ValidationError("project_goal_id must be 1 to 160 characters")
    try:
        timezone = ZoneInfo(session_timezone)
    except ZoneInfoNotFoundError as error:
        raise ValidationError(
            f"unknown IANA session timezone {session_timezone}"
        ) from error

    source_model_input = str(runtime["modelInput"])
    source_input_hash = str(runtime["inputHash"])
    observed_source_hash = hashlib.sha256(
        source_model_input.encode("utf-8")
    ).hexdigest()
    if source_input_hash != observed_source_hash:
        raise ValidationError("$.inputHash does not match $.modelInput")

    runtime_goal_version = runtime.get("goalVersion")
    if (
        runtime_goal_version is not None
        and (
            isinstance(runtime_goal_version, bool)
            or not isinstance(runtime_goal_version, int)
            or runtime_goal_version < 0
        )
    ):
        raise ValidationError("$.goalVersion is invalid")
    goal, runtime_goal, rendered_goal = _runtime_goal(runtime.get("goal"))
    if (goal is None) != (runtime_goal_version is None):
        raise ValidationError("$.goal and $.goalVersion must be jointly null/non-null")
    if goal is not None and goal.version != runtime_goal_version:
        raise ValidationError("$.goalVersion must match $.goal.version")

    redaction_counter = [0]
    counted_events: list[Event] = []
    model_events: list[dict[str, object]] = []
    boundary_events: list[dict[str, object]] = []
    operational_event_count = 0
    for index, raw_event in enumerate(runtime["events"]):
        event, sanitized, kind = _runtime_event(
            raw_event,
            include_content=include_content,
            redaction_counter=redaction_counter,
            path=f"$.events[{index}]",
        )
        if kind not in _NON_COUNTED_KINDS:
            counted_events.append(event)
            model_events.append(sanitized)
        elif kind in _BOUNDARY_KINDS:
            boundary_events.append(sanitized)
            # Online modelInput contains the boundary that sealed the window.
            # Keep the sanitized structural boundary in the rebuilt training
            # input while excluding it from the counted Event tuple.
            model_events.append(sanitized)
        else:
            operational_event_count += 1
    if len(counted_events) != int(runtime["eventCount"]):
        raise ValidationError(
            "$.eventCount must equal the number of counted semantic events"
        )

    context_events: list[Event] = []
    model_context_events: list[dict[str, object]] = []
    context_boundaries: list[dict[str, object]] = []
    for index, raw_event in enumerate(runtime["contextOnly"]):
        event, sanitized, kind = _runtime_event(
            raw_event,
            include_content=include_content,
            redaction_counter=redaction_counter,
            path=f"$.contextOnly[{index}]",
        )
        if kind not in _NON_COUNTED_KINDS:
            context_events.append(event)
            model_context_events.append(sanitized)
        elif kind in _BOUNDARY_KINDS:
            context_boundaries.append(sanitized)
        else:
            operational_event_count += 1

    # EventJournal cursor/array order is the authoritative total order.
    # Multiple sensors can append an event whose occurredAtMs predates a
    # previously appended event; reordering here would make offline training
    # differ from immutable online modelInput and break cursor semantics.

    rendered_model_input = _render_bounded_model_input(
        rendered_goal,
        model_context_events,
        model_events,
    )
    exported_input_hash = hashlib.sha256(
        rendered_model_input.encode("utf-8")
    ).hexdigest()
    resolved_project_goal_id = (
        project_goal_id
        if project_goal_id is not None
        else (goal.goal_id if goal is not None else None)
    )
    metadata: dict[str, object] = {
        "transformVersion": RUNTIME_EXPORT_VERSION,
        "sourceInputHash": source_input_hash,
        "exportedInputHash": exported_input_hash,
        "sessionTimezone": session_timezone,
        "runtimeCollectorId": runtime["collectorId"],
        "runtimeDeadlineAtMs": runtime["deadlineAtMs"],
        "runtimeEventCount": runtime["eventCount"],
        "eventOrdering": "runtime_cursor_order.v1",
        "includeContent": include_content,
        "redactedFieldCount": redaction_counter[0],
        "operationalEventCountExcluded": operational_event_count,
    }
    if runtime_goal is not None:
        metadata["runtimeGoal"] = {
            "planId": runtime_goal["planId"],
            "activatedAtMs": runtime_goal["activatedAtMs"],
        }
    if boundary_events:
        metadata["runtimeBoundaryEvents"] = boundary_events
    if context_boundaries:
        metadata["runtimeContextBoundaryEvents"] = context_boundaries

    window = EventWindow(
        window_id=str(runtime["windowId"]),
        participant_id=participant_id,
        device_id=str(runtime["deviceId"]),
        project_goal_id=resolved_project_goal_id,
        session_id=str(runtime["sessionId"]),
        session_date=_session_date(int(runtime["startedAtMs"]), timezone),
        goal=goal,
        trigger_reason=str(runtime["triggerReason"]),
        started_at_ms=int(runtime["startedAtMs"]),
        ended_at_ms=int(runtime["endedAtMs"]),
        events=tuple(counted_events),
        context_only=tuple(context_events),
        model_input=rendered_model_input,
        metadata=metadata,
        gold=None,
    )
    # Reuse the authoritative strict training validator before export.
    return parse_event_window(window.as_dict())


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def export_runtime_database(
    database_path: Path,
    output_path: Path,
    manifest_path: Path,
    *,
    participant_id: str,
    session_timezone: str,
    project_goal_id: str | None = None,
    include_content: bool = False,
) -> RuntimeExportResult:
    if not database_path.is_file():
        raise ValidationError(f"runtime database does not exist: {database_path}")
    uri = f"{database_path.resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.execute("PRAGMA query_only = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    try:
        schema_row = connection.execute(
            "SELECT version FROM reflection_schema WHERE singleton = 1"
        ).fetchone()
        if (
            schema_row is None
            or len(schema_row) != 1
            or isinstance(schema_row[0], bool)
            or not isinstance(schema_row[0], int)
            or schema_row[0] not in SUPPORTED_REFLECTION_SQLITE_SCHEMA_VERSIONS
        ):
            raise ValidationError(
                "runtime reflection SQLite schema version must be one of "
                f"{sorted(SUPPORTED_REFLECTION_SQLITE_SCHEMA_VERSIONS)}"
            )
        reflection_schema_version = int(schema_row[0])
        columns = {
            str(row[1])
            for row in connection.execute(
                "PRAGMA table_info(reflection_windows)"
            )
        }
        required_columns = {
            "window_id",
            "collector_id",
            "input_hash",
            "event_count",
            "created_at_ms",
            "window_json",
        }
        if not required_columns.issubset(columns):
            raise ValidationError("reflection_windows schema is incomplete")
        connection.execute("BEGIN")
        rows = list(
            connection.execute(
                """
                SELECT window_id, collector_id, input_hash, event_count,
                       created_at_ms, window_json
                FROM reflection_windows
                ORDER BY window_id COLLATE BINARY
                """
            )
        )
        source_digest = hashlib.sha256()
        windows: list[EventWindow] = []
        for row_index, row in enumerate(rows):
            (
                row_window_id,
                row_collector_id,
                row_input_hash,
                row_event_count,
                row_created_at_ms,
                raw_json,
            ) = row
            if not isinstance(raw_json, str):
                raise ValidationError(
                    f"reflection_windows row {row_index} has non-text window_json"
                )
            source_digest.update(
                _canonical_json(
                    {
                        "windowId": row_window_id,
                        "collectorId": row_collector_id,
                        "inputHash": row_input_hash,
                        "eventCount": row_event_count,
                        "createdAtMs": row_created_at_ms,
                        "windowJson": raw_json,
                    }
                ).encode("utf-8")
            )
            source_digest.update(b"\n")
            try:
                raw_window = json.loads(raw_json)
            except json.JSONDecodeError as error:
                raise ValidationError(
                    f"reflection_windows row {row_index} has invalid JSON"
                ) from error
            runtime = _require_mapping(raw_window, f"row[{row_index}]")
            if (
                runtime.get("windowId") != row_window_id
                or runtime.get("collectorId") != row_collector_id
                or runtime.get("inputHash") != row_input_hash
                or runtime.get("eventCount") != row_event_count
                or runtime.get("endedAtMs") != row_created_at_ms
            ):
                raise ValidationError(
                    f"reflection_windows row {row_index} columns disagree with window_json"
                )
            windows.append(
                convert_runtime_window(
                    runtime,
                    participant_id=participant_id,
                    session_timezone=session_timezone,
                    project_goal_id=project_goal_id,
                    include_content=include_content,
                )
            )
        connection.commit()
    finally:
        connection.close()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(output_path.suffix + ".tmp")
    output_digest = hashlib.sha256()
    with temporary_output.open("wb") as output:
        for window in windows:
            line = (
                json.dumps(
                    window.as_dict(),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                + "\n"
            ).encode("utf-8")
            output.write(line)
            output_digest.update(line)
    temporary_output.replace(output_path)
    dates = sorted({window.session_date for window in windows})
    manifest: dict[str, object] = {
        "manifestVersion": "runtime-window-export-manifest.v1",
        "transformVersion": RUNTIME_EXPORT_VERSION,
        "source": {
            "reflectionSchemaVersion": reflection_schema_version,
            "windowSchemaVersion": RUNTIME_SCHEMA_VERSION,
            "rowCount": len(rows),
            "rowsSha256": source_digest.hexdigest(),
            "databaseFileSha256": _file_sha256(database_path),
        },
        "output": {
            "schemaVersion": "event-window.v1",
            "rowCount": len(windows),
            "sha256": output_digest.hexdigest(),
        },
        "participantId": participant_id,
        "sessionTimezone": session_timezone,
        "sessionDates": dates,
        "projectGoalIdOverride": project_goal_id,
        "includeContent": include_content,
        "ordering": "windowId:binary",
    }
    wal_path = Path(f"{database_path}-wal")
    if wal_path.is_file():
        manifest["source"]["walFileSha256"] = _file_sha256(wal_path)  # type: ignore[index]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_manifest = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    with temporary_manifest.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(manifest, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")
    temporary_manifest.replace(manifest_path)
    return RuntimeExportResult(
        exported_count=len(windows),
        output_sha256=output_digest.hexdigest(),
        source_rows_sha256=source_digest.hexdigest(),
        manifest=manifest,
    )
