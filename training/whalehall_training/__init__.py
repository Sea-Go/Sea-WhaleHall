"""WhaleHall's versioned teacher/student training pipeline.

The package intentionally keeps its import surface dependency-free.  Heavy
training libraries are imported only by the commands that actually need them.
"""

from .contracts import (
    ACTIVITY_LABELS,
    GOAL_RELEVANCE_LABELS,
    EventWindow,
    TeacherLabel,
    ValidationError,
    parse_event_window,
    parse_teacher_label,
)

__all__ = [
    "ACTIVITY_LABELS",
    "GOAL_RELEVANCE_LABELS",
    "EventWindow",
    "TeacherLabel",
    "ValidationError",
    "parse_event_window",
    "parse_teacher_label",
]

__version__ = "0.1.0"
