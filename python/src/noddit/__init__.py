"""noddit: progress events as JSON Lines, for anything that wants to watch a long-running run from outside.

>>> import noddit
>>> events = noddit.progress_events("run.jsonl")
>>> events.start(total=100, label="processing widgets")
>>> events.step(done=1, total=100)
>>> events.finish(ok=True, summary="done")

The same file format is what `noddit.pytest` (this package's pytest plugin,
enabled with `--noddit-events PATH` or `NODDIT_EVENTS`) writes for a test
run. See docs/progress-events.md for the full schema.
"""

from ._events import ProgressEvents, progress_events

__all__ = ["progress_events", "ProgressEvents"]
__version__ = "0.1.0"
