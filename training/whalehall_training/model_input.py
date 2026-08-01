from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

MODEL_INPUT_CONTRACT_VERSION = "deterministic-window-single-sequence.v1"
STRUCTURED_CROP_VERSION = "all-skeletons-latest-primary-first.v1"
DEFAULT_STUDENT_MAXIMUM_TOKENS = 8192
DEFAULT_MODEL_INPUT_BYTES = 32 * 1024

GOAL_MARKER = "[GOAL]\n"
CONTEXT_MARKER = "\n[CONTEXT_ONLY]\n"
EVENT_MARKER = "\n[EVENTS]\n"


class ModelInputContractError(ValueError):
    """Raised when immutable model input cannot satisfy the token contract."""


@dataclass(frozen=True)
class ParsedModelInput:
    goal_section: str
    context_lines: tuple[str, ...]
    event_lines: tuple[str, ...]
    context_values: tuple[Mapping[str, object], ...]
    event_values: tuple[Mapping[str, object], ...]


@dataclass(frozen=True)
class PreparedModelInput:
    text: str
    event_character_start: int
    token_count: int
    primary_event_count: int
    context_event_count: int
    was_cropped: bool


def canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def parse_model_input(model_input: str) -> ParsedModelInput:
    if (
        not model_input.startswith(GOAL_MARKER)
        or model_input.count(GOAL_MARKER) != 1
        or model_input.count(CONTEXT_MARKER) != 1
        or model_input.count(EVENT_MARKER) != 1
    ):
        raise ModelInputContractError(
            "modelInput must contain exactly one deterministic "
            "[GOAL], [CONTEXT_ONLY], and [EVENTS] section"
        )
    goal_and_rest = model_input[len(GOAL_MARKER) :]
    goal_section, separator, rest = goal_and_rest.partition(CONTEXT_MARKER)
    if not separator:
        raise ModelInputContractError(
            "modelInput is missing the deterministic context section"
        )
    context_section, separator, event_section = rest.partition(EVENT_MARKER)
    if not separator or EVENT_MARKER in event_section:
        raise ModelInputContractError(
            "modelInput must contain exactly one deterministic events section"
        )
    # The window builder delimits canonical JSON records with ASCII LF.
    # `str.splitlines()` would also split valid JSON strings containing U+2028.
    event_lines = tuple(event_section.split("\n"))
    if not event_lines or any(not line for line in event_lines):
        raise ModelInputContractError(
            "modelInput [EVENTS] must contain non-empty JSON lines"
        )
    context_lines = (
        ()
        if context_section == "(none)"
        else tuple(context_section.split("\n"))
    )
    if any(not line for line in context_lines):
        raise ModelInputContractError(
            "modelInput [CONTEXT_ONLY] must use (none) or non-empty JSON lines"
        )
    context_values = tuple(
        _parse_event_line(line, section="CONTEXT_ONLY")
        for line in context_lines
    )
    event_values = tuple(
        _parse_event_line(line, section="EVENTS") for line in event_lines
    )
    return ParsedModelInput(
        goal_section=goal_section,
        context_lines=context_lines,
        event_lines=event_lines,
        context_values=context_values,
        event_values=event_values,
    )


def prepare_model_input(
    model_input: str,
    tokenizer: Any,
    *,
    maximum_tokens: int = DEFAULT_STUDENT_MAXIMUM_TOKENS,
) -> PreparedModelInput:
    """Fit one deterministic window with the exact artifact tokenizer.

    The original input is used unchanged when it fits. Otherwise every
    context and primary event is first represented by its kind/timestamp
    skeleton. Remaining tokens are spent on primary events from newest to
    oldest, then on context-only events from newest to oldest. No generic
    tokenizer truncation is allowed.
    """

    if (
        isinstance(maximum_tokens, bool)
        or not isinstance(maximum_tokens, int)
        or maximum_tokens < 1
    ):
        raise ModelInputContractError("maximum_tokens must be a positive integer")
    _require_fast_tokenizer(tokenizer)
    parsed = parse_model_input(model_input)
    original_tokens = tokenizer_token_count(tokenizer, model_input)
    if original_tokens <= maximum_tokens:
        return _prepared(
            model_input,
            token_count=original_tokens,
            parsed=parsed,
            was_cropped=False,
        )

    context_lines = [_event_skeleton(value) for value in parsed.context_values]
    event_lines = [_event_skeleton(value) for value in parsed.event_values]
    bounded = _compose(
        parsed.goal_section,
        context_lines=context_lines,
        event_lines=event_lines,
    )
    bounded_tokens = tokenizer_token_count(tokenizer, bounded)
    if bounded_tokens > maximum_tokens:
        raise ModelInputContractError(
            "goal plus all event kind/timestamp skeletons require "
            f"{bounded_tokens} tokens, exceeding artifact limit "
            f"{maximum_tokens}; refusing lossy tokenizer truncation"
        )

    # Upgrade primary evidence first. Iterating newest-to-oldest makes the
    # priority deterministic even when only one additional detail fits.
    upgrades: list[tuple[list[str], int, Mapping[str, object], str]] = []
    for index in range(len(parsed.event_values) - 1, -1, -1):
        upgrades.append(
            (
                event_lines,
                index,
                parsed.event_values[index],
                parsed.event_lines[index],
            )
        )
    for index in range(len(parsed.context_values) - 1, -1, -1):
        upgrades.append(
            (
                context_lines,
                index,
                parsed.context_values[index],
                parsed.context_lines[index],
            )
        )

    for lines, index, value, original_line in upgrades:
        previous = lines[index]
        selected = previous
        for replacement in _detail_candidates(value, original_line):
            if replacement == previous:
                continue
            lines[index] = replacement
            candidate = _compose(
                parsed.goal_section,
                context_lines=context_lines,
                event_lines=event_lines,
            )
            candidate_tokens = tokenizer_token_count(tokenizer, candidate)
            if candidate_tokens <= maximum_tokens:
                bounded = candidate
                bounded_tokens = candidate_tokens
                selected = replacement
                break
        lines[index] = selected

    # Defensive recount: the returned sequence is the exact string that both
    # training and serving pass to the tokenizer without truncation.
    final_tokens = tokenizer_token_count(tokenizer, bounded)
    if final_tokens > maximum_tokens:
        raise AssertionError("structured crop exceeded its verified token budget")
    prepared_parsed = parse_model_input(bounded)
    if len(prepared_parsed.event_lines) != len(parsed.event_lines):
        raise AssertionError("structured crop lost a primary event skeleton")
    return _prepared(
        bounded,
        token_count=final_tokens,
        parsed=prepared_parsed,
        was_cropped=True,
    )


def tokenizer_token_count(tokenizer: Any, text: str) -> int:
    encoded = tokenizer(
        text,
        add_special_tokens=True,
        truncation=False,
    )
    input_ids = encoded["input_ids"]
    if hasattr(input_ids, "tolist"):
        input_ids = input_ids.tolist()
    if (
        isinstance(input_ids, Sequence)
        and input_ids
        and isinstance(input_ids[0], Sequence)
    ):
        if len(input_ids) != 1:
            raise ModelInputContractError(
                "tokenizer returned multiple rows for one model input"
            )
        input_ids = input_ids[0]
    if not isinstance(input_ids, Sequence):
        raise ModelInputContractError("tokenizer did not return input_ids")
    return len(input_ids)


def tokenizer_fingerprint(tokenizer: Any) -> str:
    """Hash the fast-tokenizer graph and special-token mapping."""

    _require_fast_tokenizer(tokenizer)
    backend = getattr(tokenizer, "backend_tokenizer", None)
    if backend is None or not callable(getattr(backend, "to_str", None)):
        raise ModelInputContractError(
            "artifact tokenizer must expose a serializable backend graph"
        )
    payload = canonical_json(
        {
            "backend": backend.to_str(),
            "specialTokens": _json_safe(
                getattr(tokenizer, "special_tokens_map", {})
            ),
        }
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def event_token_mask_from_offsets(
    offsets: Sequence[Sequence[int]],
    attention_mask: Sequence[int],
    *,
    event_character_start: int,
) -> list[int]:
    if len(offsets) != len(attention_mask):
        raise ModelInputContractError(
            "tokenizer offsets and attention mask lengths differ"
        )
    mask: list[int] = []
    for offset, attended in zip(offsets, attention_mask, strict=True):
        if len(offset) != 2:
            raise ModelInputContractError(
                "tokenizer offset mapping entries must have length two"
            )
        start, end = int(offset[0]), int(offset[1])
        mask.append(
            int(
                bool(int(attended))
                and end > start
                and end > event_character_start
            )
        )
    if not any(mask):
        raise ModelInputContractError(
            "tokenizer produced no primary event tokens"
        )
    return mask


def expected_runtime_input_format() -> dict[str, object]:
    return {
        "contractVersion": MODEL_INPUT_CONTRACT_VERSION,
        "serialization": "immutable_modelInput_single_sequence",
        "cropPolicy": STRUCTURED_CROP_VERSION,
        "genericTokenizerTruncation": False,
        "activityPooling": "primary_event_tokens_mean",
        "relevancePooling": "all_attended_tokens_mean",
        "eventMask": "fast_tokenizer_offset_mapping_after_events_marker",
        "preserveAllPrimaryEventSkeletons": True,
        "sourceByteMaximum": DEFAULT_MODEL_INPUT_BYTES,
    }


def _prepared(
    text: str,
    *,
    token_count: int,
    parsed: ParsedModelInput,
    was_cropped: bool,
) -> PreparedModelInput:
    marker_index = text.index(EVENT_MARKER)
    event_character_start = marker_index + len(EVENT_MARKER)
    return PreparedModelInput(
        text=text,
        event_character_start=event_character_start,
        token_count=token_count,
        primary_event_count=len(parsed.event_lines),
        context_event_count=len(parsed.context_lines),
        was_cropped=was_cropped,
    )


def _parse_event_line(line: str, *, section: str) -> Mapping[str, object]:
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise ModelInputContractError(
            f"modelInput [{section}] contains invalid JSON"
        ) from error
    if not isinstance(value, Mapping):
        raise ModelInputContractError(
            f"modelInput [{section}] event lines must be JSON objects"
        )
    kind = value.get("kind")
    occurred_at_ms = value.get("occurredAtMs")
    if not isinstance(kind, str) or not kind:
        raise ModelInputContractError(
            f"modelInput [{section}] event kind must be non-empty"
        )
    if (
        isinstance(occurred_at_ms, bool)
        or not isinstance(occurred_at_ms, int)
        or occurred_at_ms < 0
    ):
        raise ModelInputContractError(
            f"modelInput [{section}] occurredAtMs must be non-negative integer"
        )
    return value


def _compose(
    goal_section: str,
    *,
    context_lines: Sequence[str],
    event_lines: Sequence[str],
) -> str:
    context = "(none)" if not context_lines else "\n".join(context_lines)
    return (
        f"{GOAL_MARKER}{goal_section}"
        f"{CONTEXT_MARKER}{context}"
        f"{EVENT_MARKER}{chr(10).join(event_lines)}"
    )


def _event_skeleton(value: Mapping[str, object]) -> str:
    return canonical_json(
        {
            "kind": value["kind"],
            "occurredAtMs": value["occurredAtMs"],
        }
    )


def _detail_candidates(
    value: Mapping[str, object],
    original_line: str,
) -> tuple[str, ...]:
    candidates = [original_line]
    for string_limit, item_limit, key_limit in (
        (160, 8, 32),
        (80, 4, 16),
        (40, 2, 8),
        (16, 1, 4),
    ):
        detail: dict[str, object] = {
            "kind": value["kind"],
            "occurredAtMs": value["occurredAtMs"],
        }
        if "payload" in value:
            detail["payload"] = _bounded_value(
                value["payload"],
                depth=0,
                string_limit=string_limit,
                item_limit=item_limit,
                key_limit=key_limit,
            )
        elif "attributes" in value:
            detail["attributes"] = _bounded_value(
                value["attributes"],
                depth=0,
                string_limit=string_limit,
                item_limit=item_limit,
                key_limit=key_limit,
            )
        elif isinstance(value.get("summary"), str):
            detail["summary"] = str(value["summary"])[:string_limit]
        candidates.append(canonical_json(detail))
    candidates.append(_event_skeleton(value))
    return tuple(dict.fromkeys(candidates))


def _bounded_value(
    value: object,
    *,
    depth: int,
    string_limit: int,
    item_limit: int,
    key_limit: int,
) -> object:
    if isinstance(value, str):
        return value[:string_limit]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= 4:
        return "[bounded]"
    if isinstance(value, Mapping):
        keys = sorted((str(key) for key in value))[:key_limit]
        result = {
            key: _bounded_value(
                value[key],
                depth=depth + 1,
                string_limit=string_limit,
                item_limit=item_limit,
                key_limit=key_limit,
            )
            for key in keys
        }
        if len(value) > len(keys):
            result["_omittedKeys"] = len(value) - len(keys)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        selected = [
            _bounded_value(
                item,
                depth=depth + 1,
                string_limit=string_limit,
                item_limit=item_limit,
                key_limit=key_limit,
            )
            for item in value[:item_limit]
        ]
        if len(value) > len(selected):
            selected.append({"omittedItems": len(value) - len(selected)})
        return selected
    return str(value)[:string_limit]


def _require_fast_tokenizer(tokenizer: Any) -> None:
    if getattr(tokenizer, "is_fast", False) is not True:
        raise ModelInputContractError(
            "ModernBERT input contract requires the locked fast tokenizer"
        )


def _json_safe(value: object) -> object:
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, Mapping):
        return {
            str(key): _json_safe(entry)
            for key, entry in sorted(value.items(), key=lambda item: str(item[0]))
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [_json_safe(entry) for entry in value]
    return str(value)
