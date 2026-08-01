from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence, TextIO

from .contracts import EventWindow, ValidationError, parse_event_window


@dataclass(frozen=True)
class JsonlIssue:
    line_number: int
    message: str


@dataclass(frozen=True)
class ValidationReport:
    records: tuple[EventWindow, ...]
    issues: tuple[JsonlIssue, ...]

    @property
    def valid(self) -> bool:
        return not self.issues


@dataclass(frozen=True)
class DuplicateRecord:
    dropped_window_id: str
    kept_window_id: str
    reason: str
    similarity: float


@dataclass(frozen=True)
class DeduplicationResult:
    kept: tuple[EventWindow, ...]
    duplicates: tuple[DuplicateRecord, ...]


def iter_jsonl(stream: TextIO) -> Iterator[tuple[int, object]]:
    for line_number, raw_line in enumerate(stream, start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            yield line_number, json.loads(line)
        except json.JSONDecodeError as error:
            raise ValidationError(
                f"line {line_number}: invalid JSON at column {error.colno}: "
                f"{error.msg}"
            ) from error


def validate_jsonl(stream: TextIO, *, fail_fast: bool = False) -> ValidationReport:
    records: list[EventWindow] = []
    issues: list[JsonlIssue] = []
    seen_window_ids: dict[str, int] = {}
    try:
        rows = iter_jsonl(stream)
        for line_number, value in rows:
            try:
                window = parse_event_window(value)
                previous_line = seen_window_ids.get(window.window_id)
                if previous_line is not None:
                    raise ValidationError(
                        f"duplicate windowId; first seen on line {previous_line}"
                    )
                seen_window_ids[window.window_id] = line_number
                records.append(window)
            except ValidationError as error:
                issues.append(JsonlIssue(line_number, str(error)))
                if fail_fast:
                    break
    except ValidationError as error:
        match = re.match(r"line (\d+):", str(error))
        line_number = int(match.group(1)) if match else 0
        issues.append(JsonlIssue(line_number, str(error)))
    return ValidationReport(tuple(records), tuple(issues))


def write_jsonl(path: Path, values: Iterable[Mapping[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as output:
        for value in values:
            output.write(
                json.dumps(
                    value,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
            output.write("\n")


_WHITESPACE = re.compile(r"\s+")


def normalized_model_text(window: EventWindow) -> str:
    # The deterministic model input already contains the canonical goal
    # section. Repeating goal text here would make deduplication use a
    # different representation from student training and serving.
    return _WHITESPACE.sub(" ", window.model_input.casefold()).strip()


def content_fingerprint(window: EventWindow) -> str:
    normalized = normalized_model_text(window)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _character_shingles(text: str, size: int = 3) -> frozenset[str]:
    compact = _WHITESPACE.sub(" ", text)
    if len(compact) <= size:
        return frozenset({compact})
    return frozenset(
        compact[index : index + size]
        for index in range(0, len(compact) - size + 1)
    )


def _simhash(shingles: frozenset[str]) -> int:
    totals = [0] * 64
    for shingle in shingles:
        value = int.from_bytes(
            hashlib.blake2b(shingle.encode("utf-8"), digest_size=8).digest(),
            byteorder="big",
        )
        for bit in range(64):
            totals[bit] += 1 if value & (1 << bit) else -1
    result = 0
    for bit, total in enumerate(totals):
        if total >= 0:
            result |= 1 << bit
    return result


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 1.0


def deduplicate_windows(
    windows: Sequence[EventWindow],
    *,
    near_duplicate_threshold: float = 0.9,
) -> DeduplicationResult:
    """Deterministically remove exact and near-duplicate model inputs.

    Records are considered in lexical ``windowId`` order.  SimHash banding
    limits exact Jaccard comparisons without introducing random state.
    """

    if not 0.0 <= near_duplicate_threshold <= 1.0:
        raise ValueError("near_duplicate_threshold must be between 0 and 1")
    kept: list[EventWindow] = []
    duplicates: list[DuplicateRecord] = []
    exact: dict[str, int] = {}
    shingle_sets: list[frozenset[str]] = []
    band_indexes: list[dict[int, list[int]]] = [defaultdict(list) for _ in range(4)]

    for window in sorted(windows, key=lambda item: item.window_id):
        fingerprint = content_fingerprint(window)
        exact_index = exact.get(fingerprint)
        if exact_index is not None:
            duplicates.append(
                DuplicateRecord(
                    dropped_window_id=window.window_id,
                    kept_window_id=kept[exact_index].window_id,
                    reason="exact",
                    similarity=1.0,
                )
            )
            continue

        shingles = _character_shingles(normalized_model_text(window))
        signature = _simhash(shingles)
        candidates: set[int] = set()
        for band_number, band_index in enumerate(band_indexes):
            band_value = (signature >> (band_number * 16)) & 0xFFFF
            candidates.update(band_index.get(band_value, ()))

        duplicate_index: int | None = None
        duplicate_similarity = 0.0
        for candidate_index in sorted(
            candidates, key=lambda index: kept[index].window_id
        ):
            similarity = _jaccard(shingles, shingle_sets[candidate_index])
            if similarity >= near_duplicate_threshold:
                duplicate_index = candidate_index
                duplicate_similarity = similarity
                break
        if duplicate_index is not None:
            duplicates.append(
                DuplicateRecord(
                    dropped_window_id=window.window_id,
                    kept_window_id=kept[duplicate_index].window_id,
                    reason="near",
                    similarity=duplicate_similarity,
                )
            )
            continue

        kept_index = len(kept)
        kept.append(window)
        shingle_sets.append(shingles)
        exact[fingerprint] = kept_index
        for band_number, band_index in enumerate(band_indexes):
            band_value = (signature >> (band_number * 16)) & 0xFFFF
            band_index[band_value].append(kept_index)

    return DeduplicationResult(tuple(kept), tuple(duplicates))


class _DisjointSet:
    def __init__(self, size: int) -> None:
        self._parents = list(range(size))
        self._ranks = [0] * size

    def find(self, value: int) -> int:
        parent = self._parents[value]
        if parent != value:
            self._parents[value] = self.find(parent)
        return self._parents[value]

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self._ranks[left_root] < self._ranks[right_root]:
            left_root, right_root = right_root, left_root
        self._parents[right_root] = left_root
        if self._ranks[left_root] == self._ranks[right_root]:
            self._ranks[left_root] += 1


def overlap_components(
    windows: Sequence[EventWindow],
    *,
    threshold: float = 0.5,
) -> tuple[tuple[int, ...], ...]:
    """Group windows sharing more than ``threshold`` of either event set."""

    if not 0.0 <= threshold < 1.0:
        raise ValueError("overlap threshold must be in [0, 1)")
    disjoint_set = _DisjointSet(len(windows))
    by_event: dict[str, list[int]] = defaultdict(list)
    for index, window in enumerate(windows):
        for event_id in window.event_ids:
            by_event[event_id].append(index)

    intersections: dict[tuple[int, int], int] = defaultdict(int)
    for indexes in by_event.values():
        ordered = sorted(indexes)
        for left_position, left in enumerate(ordered):
            for right in ordered[left_position + 1 :]:
                intersections[(left, right)] += 1

    event_counts = [len(window.event_ids) for window in windows]
    for (left, right), intersection in intersections.items():
        denominator = min(event_counts[left], event_counts[right])
        if denominator and intersection / denominator > threshold:
            disjoint_set.union(left, right)

    components: dict[int, list[int]] = defaultdict(list)
    for index in range(len(windows)):
        components[disjoint_set.find(index)].append(index)
    return tuple(
        tuple(component)
        for component in sorted(
            components.values(),
            key=lambda values: min(windows[index].window_id for index in values),
        )
    )


_HIERARCHY_LEVELS = {
    "participant": 1,
    "device": 2,
    "project_goal": 3,
    "session_day": 4,
    "window": 5,
}


def hierarchy_key(window: EventWindow, level: str) -> tuple[str, ...]:
    depth = _HIERARCHY_LEVELS.get(level)
    if depth is None:
        raise ValueError(
            "level must be participant, device, project_goal, session_day, or window"
        )
    values = (
        window.participant_id,
        window.device_id,
        window.project_goal_id or (window.goal.goal_id if window.goal else "<NO_GOAL>"),
        f"{window.session_id}:{window.session_date}",
        window.window_id,
    )
    return values[:depth]


def _stable_order(value: str, seed: int) -> str:
    return hashlib.sha256(f"{seed}:{value}".encode("utf-8")).hexdigest()


def deterministic_group_split(
    windows: Sequence[EventWindow],
    targets: Mapping[str, int],
    *,
    seed: int = 17,
    grouping_level: str = "participant",
    overlap_threshold: float = 0.5,
) -> dict[str, tuple[EventWindow, ...]]:
    """Assign indivisible hierarchy/overlap groups to deterministic splits.

    The default keeps every participant in one split.  A personal-model
    dataset may explicitly descend to ``device``, ``project_goal`` or
    ``session_day``; the chosen level must be recorded in the dataset manifest.
    """

    if not targets or any(value < 0 for value in targets.values()):
        raise ValueError("targets must be non-empty non-negative counts")
    split_names = tuple(sorted(targets))
    disjoint_set = _DisjointSet(len(windows))
    first_by_hierarchy: dict[tuple[str, ...], int] = {}
    for index, window in enumerate(windows):
        key = hierarchy_key(window, grouping_level)
        previous = first_by_hierarchy.get(key)
        if previous is None:
            first_by_hierarchy[key] = index
        else:
            disjoint_set.union(previous, index)
    for component in overlap_components(windows, threshold=overlap_threshold):
        for index in component[1:]:
            disjoint_set.union(component[0], index)

    grouped: dict[int, list[EventWindow]] = defaultdict(list)
    for index, window in enumerate(windows):
        grouped[disjoint_set.find(index)].append(window)
    groups = sorted(
        grouped.values(),
        key=lambda group: (
            _stable_order(min(window.window_id for window in group), seed),
            min(window.window_id for window in group),
        ),
    )

    assigned: dict[str, list[EventWindow]] = {name: [] for name in split_names}
    for group in groups:
        def split_priority(name: str) -> tuple[float, int, str]:
            target = targets[name]
            current = len(assigned[name])
            deficit_ratio = (target - current) / max(target, 1)
            return (-deficit_ratio, current, name)

        chosen = min(split_names, key=split_priority)
        assigned[chosen].extend(group)

    return {
        name: tuple(sorted(values, key=lambda window: window.window_id))
        for name, values in assigned.items()
    }


def dataset_manifest(
    splits: Mapping[str, Sequence[EventWindow]],
    *,
    grouping_level: str,
    seed: int,
) -> dict[str, object]:
    digest = hashlib.sha256()
    for split_name in sorted(splits):
        for window in sorted(
            splits[split_name], key=lambda item: item.window_id
        ):
            digest.update(split_name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(window.window_id.encode("utf-8"))
            digest.update(b"\0")
            digest.update(content_fingerprint(window).encode("ascii"))
            digest.update(b"\n")
    return {
        "manifestVersion": "dataset-manifest.v1",
        "schemaVersion": "event-window.v1",
        "groupingHierarchy": [
            "participant",
            "device",
            "project_goal",
            "session_day",
            "window",
        ],
        "groupingLevel": grouping_level,
        "seed": seed,
        "counts": {name: len(values) for name, values in sorted(splits.items())},
        "contentSha256": digest.hexdigest(),
    }
