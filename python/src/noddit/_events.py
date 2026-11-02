"""Append-only JSON Lines progress events.

``noddit.progress_events(path)`` returns a `ProgressEvents` bound to one
file. Each of `.start()`, `.step()` and `.finish()` appends exactly one JSON
object as its own line (see docs/progress-events.md for the field-by-field
schema). This module is pure standard library and never raises into the
caller: a write that can't happen (missing directory, full disk, a
read-only mount) is swallowed, and the first failure on a given instance
prints one warning to stderr so the problem isn't silent forever.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Optional

SCHEMA_VERSION = 1


class ProgressEvents:
    """Appends `start`/`progress`/`finish` events, one JSON object per line.

    Not thread-safe for truly concurrent writers to the *same path* from
    different processes beyond what the OS gives `O_APPEND` writes of a
    single `write()` call (true on POSIX and on Windows for writes that
    don't straddle a buffer boundary, which a single JSON line never does
    in practice). One writer per file is the supported shape; a build that
    wants several belongs to several files.
    """

    def __init__(self, path: "os.PathLike[str] | str") -> None:
        self._path = os.fspath(path)
        self._warned = False

    def start(self, total: Optional[int] = None, label: Optional[str] = None, **extra: Any) -> None:
        """Announces the run is beginning. `total` is the expected step count, if known."""
        self._write("start", {"total": total, "label": label, **extra})

    def step(
        self,
        done: Optional[int] = None,
        total: Optional[int] = None,
        msg: Optional[str] = None,
        **counts: Any,
    ) -> None:
        """One unit of progress. `**counts` is free-form (e.g. `passed=3, failed=0`)."""
        self._write("progress", {"done": done, "total": total, "msg": msg, **counts})

    def finish(
        self,
        ok: bool,
        summary: Optional[str] = None,
        exitstatus: Optional[int] = None,
        **extra: Any,
    ) -> None:
        """The run is over. `ok` is the one field a reader can always rely on being there."""
        self._write("finish", {"ok": ok, "summary": summary, "exitstatus": exitstatus, **extra})

    def _write(self, event_type: str, fields: dict[str, Any]) -> None:
        record: dict[str, Any] = {"v": SCHEMA_VERSION, "type": event_type, "ts": time.time()}
        for key, value in fields.items():
            if value is not None:
                record[key] = value
        try:
            line = json.dumps(record, default=_json_default) + "\n"
        except (TypeError, ValueError, RecursionError) as exc:
            self._warn(f"a progress event could not be serialized to JSON: {exc}")
            return
        try:
            # A single write() of one line, in append mode, is as atomic as
            # stdlib I/O gets without a lock file: on POSIX O_APPEND makes
            # the write itself atomic with respect to other appenders to the
            # same file, and flushing (plus a best-effort fsync) here means a
            # reader tailing the file sees the line as soon as this returns.
            with open(self._path, "a", encoding="utf-8", newline="\n") as fh:
                fh.write(line)
                fh.flush()
                try:
                    os.fsync(fh.fileno())
                except OSError:
                    pass  # not every filesystem supports fsync; the flush above already happened
        except OSError as exc:
            self._warn(f"could not write a progress event to {self._path!r}: {exc}")

    def _warn(self, message: str) -> None:
        if self._warned:
            return
        self._warned = True
        try:
            print(f"noddit: {message}", file=sys.stderr)
        except Exception:
            pass  # a warning that itself fails to print is still not the caller's problem


def _json_default(value: Any) -> str:
    return str(value)


def progress_events(path: "os.PathLike[str] | str") -> ProgressEvents:
    """Returns a `ProgressEvents` that appends JSON Lines events to `path`.

    `path`'s parent directory must already exist; nothing is created or
    truncated until the first `.start()`/`.step()`/`.finish()` call, and a
    failure to write never raises (see the module docstring).
    """
    return ProgressEvents(path)
