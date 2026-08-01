from __future__ import annotations

import io
import json
import unittest

from whalehall_training.contracts import ValidationError, parse_event_window
from whalehall_training.dataset import (
    deduplicate_windows,
    deterministic_group_split,
    overlap_components,
    validate_jsonl,
)

from tests.helpers import make_window


class ContractTests(unittest.TestCase):
    def test_round_trip_valid_window(self) -> None:
        window = make_window(1)
        parsed = parse_event_window(window.as_dict())
        self.assertEqual(parsed, window)

    def test_rejects_raw_key_and_absolute_pointer_fields(self) -> None:
        value = make_window(1).as_dict()
        value["events"][0]["attributes"]["keyName"] = "A"
        with self.assertRaisesRegex(ValidationError, "forbidden"):
            parse_event_window(value)

        value = make_window(2).as_dict()
        value["events"][0]["attributes"]["absoluteX"] = 100
        with self.assertRaisesRegex(ValidationError, "forbidden"):
            parse_event_window(value)

    def test_enforces_dual_trigger_invariants(self) -> None:
        invalid_count = make_window(1).as_dict()
        invalid_count["triggerReason"] = "event_count"
        with self.assertRaisesRegex(ValidationError, "64 events"):
            parse_event_window(invalid_count)

        invalid_wait = make_window(2).as_dict()
        invalid_wait["triggerReason"] = "max_wait"
        with self.assertRaisesRegex(ValidationError, "five minutes"):
            parse_event_window(invalid_wait)

    def test_context_is_bounded_to_previous_thirty_seconds(self) -> None:
        value = make_window(1).as_dict()
        context = dict(value["events"][0])
        context["eventId"] = "older-context"
        context["occurredAtMs"] = value["startedAtMs"] - 30_001
        value["contextOnly"] = [context]
        with self.assertRaisesRegex(ValidationError, "preceding 30 seconds"):
            parse_event_window(value)

    def test_jsonl_reports_line_number_without_losing_valid_rows(self) -> None:
        valid = json.dumps(make_window(1).as_dict())
        source = io.StringIO(valid + "\nnot-json\n")
        report = validate_jsonl(source)
        self.assertEqual(len(report.records), 1)
        self.assertEqual(len(report.issues), 1)
        self.assertEqual(report.issues[0].line_number, 2)


class DatasetTests(unittest.TestCase):
    def test_deduplication_is_stable_by_window_id(self) -> None:
        latter = make_window(9, model_input="same normalized content")
        earlier = make_window(2, model_input=" same   normalized CONTENT ")
        result = deduplicate_windows([latter, earlier])
        self.assertEqual([item.window_id for item in result.kept], ["window-00002"])
        self.assertEqual(result.duplicates[0].kept_window_id, "window-00002")
        self.assertEqual(result.duplicates[0].reason, "exact")

    def test_overlap_above_half_forms_one_component(self) -> None:
        first = make_window(
            1, event_ids=["shared-1", "shared-2", "shared-3", "only-a"]
        )
        second = make_window(
            2, event_ids=["shared-1", "shared-2", "shared-3", "only-b"]
        )
        third = make_window(3)
        components = overlap_components([first, second, third])
        self.assertEqual(components, ((0, 1), (2,)))

    def test_participant_group_split_has_no_cross_split_leakage(self) -> None:
        windows = [
            make_window(index, participant=f"person-{index // 3}")
            for index in range(18)
        ]
        first = deterministic_group_split(
            windows,
            {"train": 12, "calibration": 3, "test": 3},
            seed=17,
            grouping_level="participant",
        )
        second = deterministic_group_split(
            list(reversed(windows)),
            {"train": 12, "calibration": 3, "test": 3},
            seed=17,
            grouping_level="participant",
        )
        self.assertEqual(
            {
                name: [window.window_id for window in split]
                for name, split in first.items()
            },
            {
                name: [window.window_id for window in split]
                for name, split in second.items()
            },
        )
        participant_splits: dict[str, set[str]] = {}
        for split_name, split in first.items():
            for window in split:
                participant_splits.setdefault(window.participant_id, set()).add(
                    split_name
                )
        self.assertTrue(
            all(len(split_names) == 1 for split_names in participant_splits.values())
        )


if __name__ == "__main__":
    unittest.main()
