from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from whalehall_training.contracts import ValidationError
from whalehall_training.runtime_export import (
    MODEL_INPUT_BYTE_LIMIT,
    MODEL_INPUT_TOKEN_LIMIT,
    _conservative_token_estimate,
    convert_runtime_window,
    export_runtime_database,
)


def canonical(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def desktop_event(
    *,
    event_id: str,
    kind: str,
    occurred_at_ms: int,
    sensitivity: str = "metadata",
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "schemaVersion": "desktop-event.v1",
        "eventId": event_id,
        "cursor": event_id.replace("event", "cursor"),
        "deviceId": "device-1",
        "sessionId": "session-1",
        "kind": kind,
        "source": "vscode",
        "occurredAtMs": occurred_at_ms,
        "observedAtMs": occurred_at_ms + 1,
        "goalVersion": 1,
        "sensitivity": sensitivity,
        "payload": payload or {},
    }


def render_event(event: dict[str, object]) -> str:
    return canonical(
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


def runtime_window(secret: str = "PRIVATE EDITOR TEXT") -> dict[str, object]:
    started = 1_722_222_000_000
    goal = {
        "goalId": "goal-1",
        "planId": "plan-1",
        "version": 1,
        "text": "Implement the export bridge",
        "activatedAtMs": started - 1000,
    }
    edit = desktop_event(
        event_id="event-1",
        kind="editor.documentChanged",
        occurred_at_ms=started,
        sensitivity="content",
        payload={
            "documentId": "document-1",
            "insertedChars": 12,
            "deletedChars": 0,
            "text": secret,
        },
    )
    boundary = desktop_event(
        event_id="event-2",
        kind="presence.locked",
        occurred_at_ms=started + 500,
        payload={},
    )
    rendered_goal = canonical(
        {
            "goalId": goal["goalId"],
            "planId": goal["planId"],
            "version": goal["version"],
            "text": goal["text"],
        }
    )
    model_input = (
        f"[GOAL]\n{rendered_goal}\n[CONTEXT_ONLY]\n(none)\n"
        f"[EVENTS]\n{render_event(edit)}\n{render_event(boundary)}"
    )
    return {
        "schemaVersion": "event-window.v1",
        "windowId": "window-1",
        "collectorId": "collector-1",
        "deviceId": "device-1",
        "sessionId": "session-1",
        "triggerReason": "goal_boundary",
        "goal": goal,
        "goalVersion": 1,
        "startedAtMs": started,
        "endedAtMs": started + 1000,
        "deadlineAtMs": started + 300_000,
        "eventCount": 1,
        "firstCursor": "cursor-1",
        "lastCursor": "cursor-2",
        "events": [edit, boundary],
        "contextOnly": [],
        "modelInput": model_input,
        "inputHash": hashlib.sha256(model_input.encode("utf-8")).hexdigest(),
    }


def create_database(path: Path, window: dict[str, object]) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE reflection_schema (
            singleton INTEGER PRIMARY KEY,
            version INTEGER NOT NULL
        );
        INSERT INTO reflection_schema VALUES (1, 2);
        CREATE TABLE reflection_windows (
            window_id TEXT PRIMARY KEY,
            collector_id TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            event_count INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            window_json TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        INSERT INTO reflection_windows(
            window_id, collector_id, input_hash, event_count,
            created_at_ms, window_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            window["windowId"],
            window["collectorId"],
            window["inputHash"],
            window["eventCount"],
            window["endedAtMs"],
            json.dumps(window, ensure_ascii=False, separators=(",", ":")),
        ),
    )
    connection.commit()
    connection.close()


class RuntimeExportTests(unittest.TestCase):
    def test_export_preserves_cursor_order_when_sensor_time_moves_backward(
        self,
    ) -> None:
        window = runtime_window()
        started = int(window["startedAtMs"])
        first = desktop_event(
            event_id="event-10",
            kind="editor.documentChanged",
            occurred_at_ms=started,
            payload={"insertedChars": 1},
        )
        late = desktop_event(
            event_id="event-11",
            kind="browser.tabNavigated",
            occurred_at_ms=started - 500,
            payload={"tabId": "tab-1"},
        )
        window["events"] = [first, late]
        window["eventCount"] = 2
        window["firstCursor"] = first["cursor"]
        window["lastCursor"] = late["cursor"]

        exported = convert_runtime_window(
            window,
            participant_id="participant-1",
            session_timezone="Asia/Shanghai",
        )

        self.assertEqual(
            [event.event_id for event in exported.events],
            ["event-10", "event-11"],
        )
        self.assertEqual(
            [event.occurred_at_ms for event in exported.events],
            [started, started - 500],
        )
        rendered = exported.model_input.split("\n[EVENTS]\n", 1)[1]
        rendered_values = [json.loads(line) for line in rendered.split("\n")]
        self.assertEqual(
            [value["kind"] for value in rendered_values],
            ["editor.documentChanged", "browser.tabNavigated"],
        )
        self.assertEqual(
            exported.metadata["eventOrdering"],
            "runtime_cursor_order.v1",
        )

    def test_rebuilt_model_input_bounds_adversarial_content_without_dropping_events(
        self,
    ) -> None:
        window = runtime_window()
        started = int(window["startedAtMs"])
        events = [
            desktop_event(
                event_id=f"event-{index:04d}",
                kind="browser.tabNavigated",
                occurred_at_ms=started + index,
                sensitivity="content",
                payload={
                    "browserId": "browser-1",
                    "tabId": f"tab-{index}",
                    "title": f"Page {index}",
                    "url": (
                        f"https://example.test/{index}?value="
                        + ("x" * 16_000)
                    ),
                },
            )
            for index in range(64)
        ]
        window["triggerReason"] = "event_count"
        window["events"] = events
        window["eventCount"] = 64
        window["firstCursor"] = events[0]["cursor"]
        window["lastCursor"] = events[-1]["cursor"]
        goal_section = window["modelInput"].split("\n[CONTEXT_ONLY]\n", 1)[0]
        window["modelInput"] = (
            f"{goal_section}\n[CONTEXT_ONLY]\n(none)\n"
            f"[EVENTS]\n{render_event(events[0])}"
        )
        window["inputHash"] = hashlib.sha256(
            window["modelInput"].encode("utf-8")
        ).hexdigest()

        first = convert_runtime_window(
            window,
            participant_id="participant-1",
            session_timezone="Asia/Shanghai",
            include_content=True,
        )
        second = convert_runtime_window(
            window,
            participant_id="participant-1",
            session_timezone="Asia/Shanghai",
            include_content=True,
        )

        self.assertEqual(first.model_input, second.model_input)
        self.assertLessEqual(
            len(first.model_input.encode("utf-8")),
            MODEL_INPUT_BYTE_LIMIT,
        )
        self.assertLessEqual(
            _conservative_token_estimate(first.model_input),
            MODEL_INPUT_TOKEN_LIMIT,
        )
        rendered_events = first.model_input.split("\n[EVENTS]\n", 1)[1]
        self.assertEqual(len(rendered_events.splitlines()), 64)

    def test_default_export_rebuilds_model_input_without_content_leakage(self) -> None:
        secret = "PRIVATE EDITOR TEXT"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "reflections.sqlite3"
            create_database(database, runtime_window(secret))
            before_hash = hashlib.sha256(database.read_bytes()).hexdigest()
            output = root / "windows.jsonl"
            manifest = root / "manifest.json"
            result = export_runtime_database(
                database,
                output,
                manifest,
                participant_id="participant-1",
                session_timezone="Asia/Shanghai",
            )
            exported_text = output.read_text(encoding="utf-8")
            self.assertNotIn(secret, exported_text)
            exported = json.loads(exported_text)
            self.assertEqual(exported["participantId"], "participant-1")
            self.assertEqual(exported["projectGoalId"], "goal-1")
            self.assertEqual(exported["metadata"]["sourceInputHash"], runtime_window(secret)["inputHash"])
            self.assertNotEqual(
                exported["metadata"]["sourceInputHash"],
                exported["metadata"]["exportedInputHash"],
            )
            self.assertEqual(exported["events"][0]["eventId"], "event-1")
            self.assertIn("presence.locked", exported["modelInput"])
            self.assertEqual(
                exported["metadata"]["runtimeBoundaryEvents"][0]["eventId"],
                "event-2",
            )
            self.assertEqual(result.exported_count, 1)
            self.assertEqual(
                result.manifest["source"]["reflectionSchemaVersion"],
                2,
            )
            self.assertEqual(
                hashlib.sha256(database.read_bytes()).hexdigest(),
                before_hash,
            )

    def test_export_is_idempotent_and_content_requires_explicit_flag(self) -> None:
        secret = "PRIVATE EDITOR TEXT"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "reflections.sqlite3"
            create_database(database, runtime_window(secret))
            first_output = root / "first.jsonl"
            first_manifest = root / "first-manifest.json"
            second_output = root / "second.jsonl"
            second_manifest = root / "second-manifest.json"
            first = export_runtime_database(
                database,
                first_output,
                first_manifest,
                participant_id="participant-1",
                session_timezone="Asia/Shanghai",
                include_content=True,
            )
            second = export_runtime_database(
                database,
                second_output,
                second_manifest,
                participant_id="participant-1",
                session_timezone="Asia/Shanghai",
                include_content=True,
            )
            self.assertIn(secret, first_output.read_text(encoding="utf-8"))
            self.assertEqual(first_output.read_bytes(), second_output.read_bytes())
            self.assertEqual(first.manifest, second.manifest)
            self.assertEqual(first.output_sha256, second.output_sha256)

    def test_forbidden_secret_fields_fail_even_with_content_enabled(self) -> None:
        window = runtime_window()
        window["events"][0]["payload"]["password"] = "never-export"
        rendered_goal = window["modelInput"].split("\n[CONTEXT_ONLY]\n", 1)[0]
        window["modelInput"] = (
            f"{rendered_goal}\n[CONTEXT_ONLY]\n(none)\n[EVENTS]\n"
            + "\n".join(render_event(event) for event in window["events"])
        )
        window["inputHash"] = hashlib.sha256(
            window["modelInput"].encode("utf-8")
        ).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "reflections.sqlite3"
            create_database(database, window)
            with self.assertRaisesRegex(ValidationError, "forbidden"):
                export_runtime_database(
                    database,
                    root / "output.jsonl",
                    root / "manifest.json",
                    participant_id="participant-1",
                    session_timezone="Asia/Shanghai",
                    include_content=True,
                )

    def test_nested_api_key_is_always_rejected(self) -> None:
        window = runtime_window()
        window["events"][0]["payload"]["nested"] = {
            "apiKey": "must-not-cross-export"
        }
        rendered_goal = window["modelInput"].split("\n[CONTEXT_ONLY]\n", 1)[0]
        window["modelInput"] = (
            f"{rendered_goal}\n[CONTEXT_ONLY]\n(none)\n[EVENTS]\n"
            + "\n".join(render_event(event) for event in window["events"])
        )
        window["inputHash"] = hashlib.sha256(
            window["modelInput"].encode("utf-8")
        ).hexdigest()
        with self.assertRaisesRegex(ValidationError, "forbidden"):
            convert_runtime_window(
                window,
                participant_id="participant-1",
                session_timezone="Asia/Shanghai",
                include_content=True,
            )


if __name__ == "__main__":
    unittest.main()
