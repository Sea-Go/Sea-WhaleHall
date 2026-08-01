from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from whalehall_training.model_input import (
    ModelInputContractError,
    event_token_mask_from_offsets,
    parse_model_input,
    prepare_model_input,
    tokenizer_fingerprint,
)
from whalehall_training.runtime_export import _render_bounded_model_input

try:
    from transformers import AutoTokenizer
except ImportError:
    AutoTokenizer = None


class _FakeBackend:
    def __init__(self, value: str = "fake-tokenizer-v1") -> None:
        self.value = value

    def to_str(self) -> str:
        return self.value


class CharacterTokenizer:
    """Small fast-tokenizer double with exact character offsets."""

    is_fast = True
    special_tokens_map = {"cls_token": "[CLS]", "sep_token": "[SEP]"}

    def __init__(self, backend: str = "fake-tokenizer-v1") -> None:
        self.backend_tokenizer = _FakeBackend(backend)

    def __call__(
        self,
        text: str,
        *,
        add_special_tokens: bool = True,
        truncation: bool = False,
    ) -> dict[str, object]:
        if truncation:
            raise AssertionError("generic truncation is forbidden")
        characters = list(text)
        input_ids = [ord(character) % 251 + 3 for character in characters]
        offsets = [(index, index + 1) for index in range(len(characters))]
        if add_special_tokens:
            input_ids = [1, *input_ids, 2]
            offsets = [(0, 0), *offsets, (0, 0)]
        return {"input_ids": input_ids, "offset_mapping": offsets}


def model_input(*, event_count: int, payload_size: int) -> str:
    goal = json.dumps(
        {
            "goalId": "goal-1",
            "planId": None,
            "text": "完成 WhaleHall",
            "version": 1,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    lines = []
    for index in range(event_count):
        lines.append(
            json.dumps(
                {
                    "kind": "editor.documentChanged",
                    "occurredAtMs": 1_000 + index,
                    "payload": {
                        "insertedText": f"newest-{index}-" + "x" * payload_size
                    },
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    return (
        f"[GOAL]\n{goal}\n[CONTEXT_ONLY]\n(none)\n"
        f"[EVENTS]\n{chr(10).join(lines)}"
    )


class ModelInputContractTests(unittest.TestCase):
    def test_fitting_input_is_passed_to_model_unchanged(self) -> None:
        tokenizer = CharacterTokenizer()
        source = model_input(event_count=2, payload_size=3)
        prepared = prepare_model_input(
            source,
            tokenizer,
            maximum_tokens=len(source) + 2,
        )
        self.assertEqual(prepared.text, source)
        self.assertEqual(prepared.text.count("完成 WhaleHall"), 1)
        self.assertFalse(prepared.was_cropped)
        self.assertEqual(prepared.primary_event_count, 2)

    def test_exact_crop_preserves_all_64_skeletons_and_newest_details(self) -> None:
        tokenizer = CharacterTokenizer()
        source = model_input(event_count=64, payload_size=2_000)
        # The character tokenizer intentionally makes the builder's
        # tokenizer-free estimate insufficient. The exact crop has room for
        # all skeletons and a small number of newest payloads.
        prepared = prepare_model_input(
            source,
            tokenizer,
            maximum_tokens=3_900,
        )
        parsed = parse_model_input(prepared.text)
        self.assertTrue(prepared.was_cropped)
        self.assertLessEqual(prepared.token_count, 3_900)
        self.assertEqual(len(parsed.event_lines), 64)
        self.assertEqual(
            [value["occurredAtMs"] for value in parsed.event_values],
            list(range(1_000, 1_064)),
        )
        self.assertNotIn("payload", parsed.event_values[0])
        self.assertIn("payload", parsed.event_values[-1])
        self.assertIn(
            "newest-63",
            str(parsed.event_values[-1]["payload"]),
        )

    def test_refuses_lossy_fallback_when_all_skeletons_cannot_fit(self) -> None:
        tokenizer = CharacterTokenizer()
        source = model_input(event_count=64, payload_size=2_000)
        with self.assertRaisesRegex(
            ModelInputContractError,
            "refusing lossy tokenizer truncation",
        ):
            prepare_model_input(source, tokenizer, maximum_tokens=512)

    def test_event_mask_uses_single_sequence_offsets(self) -> None:
        tokenizer = CharacterTokenizer()
        source = model_input(event_count=1, payload_size=3)
        prepared = prepare_model_input(
            source,
            tokenizer,
            maximum_tokens=len(source) + 2,
        )
        encoded = tokenizer(source)
        offsets = encoded["offset_mapping"]
        attention = [1] * len(offsets)
        mask = event_token_mask_from_offsets(
            offsets,
            attention,
            event_character_start=prepared.event_character_start,
        )
        self.assertFalse(any(mask[: prepared.event_character_start + 1]))
        self.assertTrue(any(mask[prepared.event_character_start + 1 :]))

    def test_tokenizer_fingerprint_locks_backend_and_special_tokens(self) -> None:
        first = tokenizer_fingerprint(CharacterTokenizer())
        second = tokenizer_fingerprint(CharacterTokenizer())
        changed = tokenizer_fingerprint(CharacterTokenizer("fake-tokenizer-v2"))
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)
        self.assertEqual(len(first), 64)

    @unittest.skipUnless(
        AutoTokenizer is not None,
        "transformers is installed only in the dedicated model environment",
    )
    def test_cached_official_modernbert_tokenizer_keeps_64_skeletons(self) -> None:
        assert AutoTokenizer is not None
        try:
            tokenizer = AutoTokenizer.from_pretrained(
                "answerdotai/ModernBERT-base",
                local_files_only=True,
            )
        except OSError as error:
            self.skipTest(f"official tokenizer is not cached: {error}")
        goal = json.dumps(
            {
                "goalId": "goal-1",
                "planId": None,
                "text": "完成 WhaleHall 的行为理解与反思系统",
                "version": 1,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        events = [
            {
                "eventId": f"event-{index}",
                "cursor": f"cursor-{index}",
                "kind": "editor.documentChanged",
                "source": "vscode",
                "occurredAtMs": 1_700_000_000_000 + index,
                "goalVersion": 1,
                "payload": {
                    "documentId": "doc-1",
                    "insertedText": f"latest-{index}-" + "代码" * 400,
                    "insertedChars": 800,
                },
            }
            for index in range(64)
        ]
        source = _render_bounded_model_input(goal, [], events)
        prepared = prepare_model_input(
            source,
            tokenizer,
            maximum_tokens=8_192,
        )
        parsed = parse_model_input(prepared.text)
        self.assertEqual(len(parsed.event_lines), 64)
        self.assertLessEqual(prepared.token_count, 8_192)
        self.assertIn("payload", parsed.event_values[-1])
        with tempfile.TemporaryDirectory() as directory:
            tokenizer.save_pretrained(directory)
            reloaded = AutoTokenizer.from_pretrained(
                Path(directory),
                local_files_only=True,
            )
            self.assertEqual(
                tokenizer_fingerprint(tokenizer),
                tokenizer_fingerprint(reloaded),
            )


if __name__ == "__main__":
    unittest.main()
