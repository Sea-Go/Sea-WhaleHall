from __future__ import annotations

from whalehall_training.contracts import (
    Event,
    EventWindow,
    Goal,
    GoldLabel,
    TeacherLabel,
)
from whalehall_training.pipeline import TeacherVote


def make_window(
    index: int,
    *,
    participant: str | None = None,
    trigger_reason: str = "goal_boundary",
    event_count: int = 4,
    has_goal: bool = True,
    model_input: str | None = None,
    event_ids: list[str] | None = None,
    gold_activity: str | None = None,
    gold_relevance: str | None = None,
) -> EventWindow:
    started = 1_700_000_000_000 + index * 1_000_000
    duration = 300_000 if trigger_reason == "max_wait" else 20_000
    if trigger_reason == "event_count":
        event_count = 64
    ids = event_ids or [f"event-{index}-{item}" for item in range(event_count)]
    events = tuple(
        Event(
            event_id=event_id,
            kind="editor.documentChanged",
            source="vscode",
            occurred_at_ms=started + item * 100,
            summary=f"edited Python document {item}",
            attributes={"insertedCharacters": item + 1},
        )
        for item, event_id in enumerate(ids)
    )
    goal = (
        Goal(goal_id=f"goal-{index // 2}", version=1, text="Implement WhaleHall")
        if has_goal
        else None
    )
    gold = (
        GoldLabel(
            activity=gold_activity,
            goal_relevance=gold_relevance if has_goal else None,
        )
        if gold_activity is not None
        else None
    )
    return EventWindow(
        window_id=f"window-{index:05d}",
        participant_id=participant or f"participant-{index % 3}",
        device_id=f"device-{index % 4}",
        project_goal_id=goal.goal_id if goal else None,
        session_id=f"session-{index}",
        session_date="2026-07-29",
        goal=goal,
        trigger_reason=trigger_reason,
        started_at_ms=started,
        ended_at_ms=started + duration,
        events=events,
        context_only=(),
        model_input=model_input or f"[editor] changed file number {index}",
        metadata={},
        gold=gold,
    )


def make_vote(
    window: EventWindow,
    pass_name: str,
    *,
    activity: str = "development",
    relevance: str | None = "direct",
    ambiguous: bool = False,
) -> TeacherVote:
    if not window.has_goal:
        relevance = None
    return TeacherVote(
        pass_name=pass_name,
        label=TeacherLabel(
            window_id=window.window_id,
            activity=activity,
            goal_relevance=relevance,
            ambiguous=ambiguous,
            reason_codes=("document_edit",),
        ),
        model_tag="qwen3:4b",
        model_digest="sha256:fixture",
        ollama_version="0.9.0",
        parameter_size="4.0B",
        quantization_level="Q4_K_M",
        prompt_version="teacher-prompt.v1",
        taxonomy_version="activity-taxonomy.v1",
    )
