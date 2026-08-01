from __future__ import annotations

import json
import tempfile
import unittest
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from whalehall_training.teacher import (
    AllowedHours,
    LabelCheckpoint,
    OllamaProvenance,
    OllamaTeacher,
    TeacherConfig,
    TeacherSchemaError,
    TeacherTransportError,
    TeacherUsage,
    ThermalProbeResult,
    pack_batches,
    run_teacher_pass,
)

from tests.helpers import make_vote, make_window


class TeacherTests(unittest.TestCase):
    def test_allowed_hours_supports_daytime_overnight_and_full_day(self) -> None:
        daytime = AllowedHours.parse("09:00-17:00")
        overnight = AllowedHours.parse("22:30-06:00")
        full_day = AllowedHours.parse("00:00-00:00")
        self.assertTrue(
            daytime.contains(datetime(2026, 1, 1, 9, 0, tzinfo=timezone.utc))
        )
        self.assertFalse(
            daytime.contains(datetime(2026, 1, 1, 17, 0, tzinfo=timezone.utc))
        )
        self.assertTrue(
            overnight.contains(datetime(2026, 1, 1, 23, 0, tzinfo=timezone.utc))
        )
        self.assertTrue(
            overnight.contains(datetime(2026, 1, 2, 5, 59, tzinfo=timezone.utc))
        )
        self.assertTrue(
            full_day.contains(datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc))
        )
        with self.assertRaisesRegex(ValueError, "HH:MM-HH:MM"):
            AllowedHours.parse("9:00-17:00")

    def test_pack_batches_rebalances_tail_and_stays_four_to_eight(self) -> None:
        config = TeacherConfig(input_token_budget=3000)
        batches = pack_batches([make_window(index) for index in range(10)], config)
        self.assertEqual([len(batch.windows) for batch in batches], [6, 4])
        self.assertTrue(
            all(batch.estimated_tokens <= config.input_token_budget for batch in batches)
        )

    def test_payload_pins_qwen_context_and_disables_thinking(self) -> None:
        teacher = OllamaTeacher(TeacherConfig())
        windows = [make_window(index) for index in range(4)]
        payload = teacher.request_payload(windows)
        self.assertEqual(payload["model"], "qwen3:4b")
        self.assertIs(payload["think"], False)
        self.assertEqual(payload["options"]["num_ctx"], 4096)
        self.assertEqual(payload["keep_alive"], "30m")
        self.assertEqual(payload["format"]["properties"]["labels"]["minItems"], 4)
        user_content = json.loads(payload["messages"][1]["content"])
        self.assertEqual(user_content["labelPass"], "A")
        pass_c_content = json.loads(
            teacher.request_payload(windows, pass_name="C")["messages"][1][
                "content"
            ]
        )
        self.assertIn("ambiguity", pass_c_content["rubric"])

    def test_schema_failure_retries_once(self) -> None:
        calls: list[Mapping[str, object]] = []
        windows = [make_window(index) for index in range(4)]

        def transport(
            method: str,
            url: str,
            payload: Mapping[str, object] | None,
            timeout: float,
        ) -> Mapping[str, Any]:
            self.assertEqual(method, "POST")
            assert payload is not None
            calls.append(payload)
            if len(calls) == 1:
                return {"message": {"content": "not-json"}}
            labels = [
                make_vote(window, "A").label.as_dict() for window in windows
            ]
            return {
                "message": {
                    "content": json.dumps(
                        {
                            "schemaVersion": "teacher-label-batch.v1",
                            "labels": labels,
                        }
                    )
                }
            }

        teacher = OllamaTeacher(
            TeacherConfig(transport_attempt_maximum=1),
            transport=transport,
            sleeper=lambda _: None,
        )
        labels = teacher.label_batch(windows)
        self.assertEqual(len(labels), 4)
        self.assertEqual(len(calls), 2)

    def test_schema_failure_stops_after_configured_retry(self) -> None:
        teacher = OllamaTeacher(
            TeacherConfig(
                transport_attempt_maximum=1,
                schema_retry_maximum=1,
            ),
            transport=lambda *_: {"message": {"content": "{}"}},
            sleeper=lambda _: None,
        )
        with self.assertRaises(TeacherSchemaError):
            teacher.label_batch([make_window(index) for index in range(4)])

    def test_provenance_check_accepts_only_pinned_local_model(self) -> None:
        config = TeacherConfig()

        def transport(
            method: str,
            url: str,
            payload: Mapping[str, object] | None,
            timeout: float,
        ) -> Mapping[str, Any]:
            if url.endswith("/api/version"):
                return {"version": config.ollama_version}
            if url.endswith("/api/tags"):
                return {
                    "models": [
                        {
                            "name": config.model,
                            "digest": config.model_digest,
                            "details": {
                                "parameter_size": config.parameter_size,
                                "quantization_level": config.quantization_level,
                            },
                        }
                    ]
                }
            self.fail(f"unexpected URL {url}")

        provenance = OllamaTeacher(
            config, transport=transport
        ).fetch_provenance()
        self.assertEqual(provenance.model_digest, config.model_digest)
        self.assertEqual(provenance.ollama_version, "0.24.0")

    def test_provenance_check_fails_closed_on_version_mismatch(self) -> None:
        config = TeacherConfig()

        def transport(
            method: str,
            url: str,
            payload: Mapping[str, object] | None,
            timeout: float,
        ) -> Mapping[str, Any]:
            if url.endswith("/api/version"):
                return {"version": "0.25.0"}
            return {
                "models": [
                    {
                        "name": config.model,
                        "digest": config.model_digest,
                        "details": {
                            "parameter_size": config.parameter_size,
                            "quantization_level": config.quantization_level,
                        },
                    }
                ]
            }

        with self.assertRaisesRegex(
            TeacherTransportError, "does not match the pinned teacher"
        ):
            OllamaTeacher(config, transport=transport).fetch_provenance()

    def test_checkpoint_is_idempotent_and_exports_sorted_votes(self) -> None:
        windows = [make_window(2), make_window(1)]
        labels = [make_vote(window, "A").label for window in windows]
        config = TeacherConfig()
        provenance = OllamaProvenance(
            model_tag="qwen3:4b",
            model_digest=config.model_digest,
            ollama_version=config.ollama_version,
            parameter_size="4.0B",
            quantization_level="Q4_K_M",
            prompt_version="teacher-prompt.v1",
            taxonomy_version="activity-taxonomy.v1",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint_path = root / "labels.sqlite3"
            output_path = root / "votes.jsonl"
            with LabelCheckpoint(checkpoint_path, config) as checkpoint:
                checkpoint.set_provenance(provenance)
                checkpoint.store_batch(
                    "A",
                    labels,
                    provenance,
                    wall_duration_ms=200.0,
                    usage=TeacherUsage(
                        prompt_eval_count=100,
                        eval_count=40,
                        total_duration_ns=200_000_000,
                        eval_duration_ns=100_000_000,
                    ),
                )
                checkpoint.store_batch("A", labels, provenance)
                checkpoint.export(output_path)
                self.assertEqual(
                    checkpoint.completed_ids("A"),
                    {window.window_id for window in windows},
                )
                benchmark = checkpoint.benchmark("A")
                self.assertEqual(benchmark["labelCount"], 2)
                self.assertEqual(benchmark["outputTokensPerSecond"], 400.0)
            lines = [
                json.loads(line)
                for line in output_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(
                [line["windowId"] for line in lines],
                ["window-00001", "window-00002"],
            )

    def test_pause_and_resume_are_checkpointed_without_duplicate_requests(self) -> None:
        config = TeacherConfig(transport_attempt_maximum=1)
        windows = [make_window(index) for index in range(4)]
        calls: list[str] = []

        def transport(
            method: str,
            url: str,
            payload: Mapping[str, object] | None,
            timeout: float,
        ) -> Mapping[str, Any]:
            calls.append(url)
            if url.endswith("/api/version"):
                return {"version": config.ollama_version}
            if url.endswith("/api/tags"):
                return {
                    "models": [
                        {
                            "name": config.model,
                            "digest": config.model_digest,
                            "details": {
                                "parameter_size": config.parameter_size,
                                "quantization_level": config.quantization_level,
                            },
                        }
                    ]
                }
            return {
                "message": {
                    "content": json.dumps(
                        {
                            "schemaVersion": "teacher-label-batch.v1",
                            "labels": [
                                make_vote(window, "A").label.as_dict()
                                for window in windows
                            ],
                        }
                    )
                }
            }

        teacher = OllamaTeacher(config, transport=transport)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pause_file = root / "PAUSE"
            pause_file.touch()
            arguments = {
                "windows": windows,
                "pass_name": "A",
                "teacher": teacher,
                "checkpoint_path": root / "checkpoint.sqlite3",
                "output_path": root / "votes.jsonl",
                "pause_file": pause_file,
            }
            paused = run_teacher_pass(**arguments)
            self.assertEqual(paused.status, "paused")
            self.assertEqual(calls, [])

            pause_file.unlink()
            completed = run_teacher_pass(**arguments)
            self.assertEqual(completed.status, "complete")
            self.assertEqual(completed.completed_now, 4)
            call_count = len(calls)

            resumed = run_teacher_pass(**arguments)
            self.assertEqual(resumed.completed_before, 4)
            self.assertEqual(len(calls), call_count)

    def test_schedule_pause_happens_before_network_and_is_checkpointed(self) -> None:
        config = TeacherConfig(transport_attempt_maximum=1)
        teacher = OllamaTeacher(
            config,
            transport=lambda *_: self.fail("schedule pause must precede network"),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint_path = root / "checkpoint.sqlite3"
            result = run_teacher_pass(
                [make_window(index) for index in range(4)],
                pass_name="A",
                teacher=teacher,
                checkpoint_path=checkpoint_path,
                output_path=root / "votes.jsonl",
                allowed_hours=AllowedHours.parse("09:00-17:00"),
                clock=lambda: datetime(
                    2026, 1, 1, 20, 0, tzinfo=timezone.utc
                ),
            )
            self.assertEqual(result.status, "paused")
            self.assertEqual(result.pause_reason, "outside_allowed_hours")
            with LabelCheckpoint(checkpoint_path, config) as checkpoint:
                pauses = checkpoint.pause_history("A")
            self.assertEqual(pauses[-1]["reason"], "outside_allowed_hours")

    def test_thermal_guard_backs_off_once_and_pauses_fail_safe(self) -> None:
        config = TeacherConfig(transport_attempt_maximum=1)
        teacher = OllamaTeacher(
            config,
            transport=lambda *_: self.fail("thermal pause must precede network"),
        )
        sleeps: list[float] = []
        probes = iter(
            [
                ThermalProbeResult("serious", "test pressure"),
                ThermalProbeResult("critical", "still hot"),
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = run_teacher_pass(
                [make_window(index) for index in range(4)],
                pass_name="A",
                teacher=teacher,
                checkpoint_path=root / "checkpoint.sqlite3",
                output_path=root / "votes.jsonl",
                thermal_guard=True,
                thermal_probe=lambda: next(probes),
                thermal_backoff_seconds=600.0,
                thermal_maximum_sleep_seconds=7.0,
                sleeper=sleeps.append,
            )
        self.assertEqual(result.status, "paused")
        self.assertEqual(result.pause_reason, "thermal_pressure")
        self.assertEqual(sleeps, [7.0])

    def test_unknown_thermal_state_warns_and_pauses_by_default(self) -> None:
        config = TeacherConfig(transport_attempt_maximum=1)
        teacher = OllamaTeacher(
            config,
            transport=lambda *_: self.fail("unknown thermal must fail safe"),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with warnings.catch_warnings(record=True) as observed:
                warnings.simplefilter("always")
                result = run_teacher_pass(
                    [make_window(index) for index in range(4)],
                    pass_name="A",
                    teacher=teacher,
                    checkpoint_path=root / "checkpoint.sqlite3",
                    output_path=root / "votes.jsonl",
                    thermal_guard=True,
                    thermal_probe=lambda: ThermalProbeResult(
                        "unknown", "probe unavailable"
                    ),
                )
        self.assertEqual(result.pause_reason, "thermal_unknown")
        self.assertTrue(any("thermal state is unknown" in str(item.message) for item in observed))


if __name__ == "__main__":
    unittest.main()
