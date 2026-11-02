"""The `noddit` pytest plugin: mirrors a test run as progress events.

Registered via the `pytest11` entry point under the name `noddit`. Installing
the package is not enough to turn it on — it writes nothing unless
`--noddit-events PATH` is passed on the command line, or the `NODDIT_EVENTS`
environment variable is set, so a plain `pytest` run (CI, a developer's
terminal, -q, a tqdm-style runner) is byte-for-byte unaffected. It also never
changes the run's outcome: every hook here swallows its own errors rather
than letting one propagate into pytest's test loop.

Under `pytest-xdist`, only the controller process writes. A worker process
has `config.workerinput` set (xdist's own marker); the controller doesn't.
xdist relays every worker's `TestReport` back through the controller's own
`pytest_runtest_logreport` hook, so the controller sees the whole run's
reports exactly as it would without `-n` — it is simply the one process
that must not *also* see its own copy filtered out.
"""

from __future__ import annotations

import os
import time
from typing import TYPE_CHECKING, Optional

from ._events import progress_events

if TYPE_CHECKING:
    import pytest

#: finish events never list more than this many failing nodeids — a run with
#: thousands of failures shouldn't turn one JSON line into a small novel.
MAX_FAILED_NODEIDS = 50

_CONFIG_ATTR = "_noddit_session"


def pytest_addoption(parser: "pytest.Parser") -> None:
    group = parser.getgroup("noddit")
    group.addoption(
        "--noddit-events",
        dest="noddit_events",
        default=None,
        metavar="PATH",
        help="append JSON Lines progress events to PATH as this run goes (see noddit.progress_events); default $NODDIT_EVENTS",
    )


def _is_xdist_worker(config: "pytest.Config") -> bool:
    return getattr(config, "workerinput", None) is not None


def _events_path(config: "pytest.Config") -> Optional[str]:
    explicit = config.getoption("noddit_events", default=None)
    if explicit:
        return str(explicit)
    return os.environ.get("NODDIT_EVENTS") or None


def pytest_configure(config: "pytest.Config") -> None:
    if _is_xdist_worker(config):
        return
    path = _events_path(config)
    if not path:
        return
    # `pytest_xdist_node_collection_finished` has no hookspec at all unless
    # pytest-xdist's own plugin is loaded — defining that method
    # unconditionally makes pytest's hookimpl validation (`check_pending`)
    # crash every run that doesn't have xdist installed. So the plugin
    # object only grows that extra hook when xdist is actually in play.
    cls = _NodditXdistSession if config.pluginmanager.hasplugin("xdist") else _NodditSession
    session = cls(path)
    setattr(config, _CONFIG_ATTR, session)
    # A plugin registered at runtime still gets every later hook call for
    # this session (collection, each test report, session finish) — pluggy
    # recomputes who implements a hook each time it's fired.
    config.pluginmanager.register(session, name="noddit-events-session")


class _NodditSession:
    """Owns one run's worth of state; registered as its own mini pytest plugin.

    `pytest_runtest_logreport`'s hookspec takes only a `report`, with no way
    to ask pluggy for `config` too — the usual way plugins that need both
    get at each report *and* shared state do it is to be an object with
    hook methods, holding that state as attributes, rather than a bare
    module-level function.
    """

    def __init__(self, path: str) -> None:
        self.events = progress_events(path)
        self.total = 0
        self.done = 0
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.failed_nodeids: list[str] = []
        self._reported: set[str] = set()
        self._started_at = time.monotonic()
        self._started = False

    def pytest_collection_finish(self, session: "pytest.Session") -> None:
        # Under xdist this never fires on the controller at all (it collects
        # through `pytest_xdist_node_collection_finished` instead, below) —
        # this is the plain, non-distributed path.
        if self._started:
            return
        self._started = True
        self.total = len(session.items)
        self.events.start(total=self.total, label="pytest")

    def pytest_runtest_logreport(self, report: "pytest.TestReport") -> None:
        outcome = self._outcome_once(report)
        if outcome is None:
            return
        self.done += 1
        if outcome == "passed":
            self.passed += 1
        elif outcome == "failed":
            self.failed += 1
            if len(self.failed_nodeids) < MAX_FAILED_NODEIDS:
                self.failed_nodeids.append(report.nodeid)
        else:
            self.skipped += 1
        self.events.step(
            done=self.done,
            total=self.total,
            passed=self.passed,
            failed=self.failed,
            skipped=self.skipped,
            nodeid=report.nodeid,
            outcome=outcome,
        )

    def pytest_sessionfinish(self, session: "pytest.Session", exitstatus: int) -> None:
        duration_s = time.monotonic() - self._started_at
        ok = int(exitstatus) == 0
        self.events.finish(
            ok=ok,
            exitstatus=int(exitstatus),
            passed=self.passed,
            failed=self.failed,
            skipped=self.skipped,
            failed_nodeids=self.failed_nodeids or None,
            duration_s=round(duration_s, 3),
            summary=_summary(self.passed, self.failed, self.skipped, duration_s),
        )

    def _outcome_once(self, report: "pytest.TestReport") -> Optional[str]:
        """Each test counts exactly once: its `call` phase if it had one,
        else whichever of `setup`/`teardown` actually failed or was
        skipped (a fixture error or a `skip` mark never reaches `call`
        at all). The first qualifying phase wins; later phases for the
        same nodeid (e.g. a passing call followed by a teardown error)
        are seen but don't move the counters again.
        """
        if report.when == "call":
            outcome = "failed" if report.failed else "skipped" if report.skipped else "passed"
        elif report.when in ("setup", "teardown") and (report.failed or report.skipped):
            outcome = "failed" if report.failed else "skipped"
        else:
            return None
        if report.nodeid in self._reported:
            return None
        self._reported.add(report.nodeid)
        return outcome


class _NodditXdistSession(_NodditSession):
    """The controller's plugin object when pytest-xdist is loaded.

    `pytest_collection_finish` never fires on an xdist controller — it
    collects through this hook instead, fired once per worker as each one
    finishes its own (full, under the default load-scheduling) collection.
    Every worker reports the same whole-suite id list, so the first one in
    is enough; `pytest_runtest_logreport` and `pytest_sessionfinish` are
    unchanged since xdist relays those straight through to the controller.
    """

    def pytest_xdist_node_collection_finished(self, ids: "list[str]") -> None:
        if self._started:
            return
        self._started = True
        self.total = len(ids)
        self.events.start(total=self.total, label="pytest")


def _summary(passed: int, failed: int, skipped: int, duration_s: float) -> str:
    parts = [f"{passed} passed"]
    if failed:
        parts.append(f"{failed} failed")
    if skipped:
        parts.append(f"{skipped} skipped")
    return f"{', '.join(parts)} in {duration_s:.2f}s"
