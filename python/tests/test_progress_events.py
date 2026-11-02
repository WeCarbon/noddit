import json
import os
import stat
import sys

import pytest

import noddit
from noddit import progress_events
from noddit._events import ProgressEvents


def read_events(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_progress_events_returns_a_progress_events_instance(tmp_path):
    events = progress_events(tmp_path / "run.jsonl")
    assert isinstance(events, ProgressEvents)


def test_start_step_finish_write_one_json_object_per_line(tmp_path):
    path = tmp_path / "run.jsonl"
    events = progress_events(path)
    events.start(total=3, label="widgets")
    events.step(done=1, total=3, passed=1, failed=0)
    events.step(done=2, total=3, msg="halfway")
    events.finish(ok=True, summary="done", exitstatus=0)

    lines = read_events(path)
    assert [e["type"] for e in lines] == ["start", "progress", "progress", "finish"]

    start, p1, p2, finish = lines
    assert start["total"] == 3
    assert start["label"] == "widgets"
    assert start["v"] == 1
    assert "ts" in start

    assert p1["done"] == 1
    assert p1["total"] == 3
    assert p1["passed"] == 1
    assert p1["failed"] == 0

    assert p2["done"] == 2
    assert p2["msg"] == "halfway"
    assert "total" in p2  # explicitly passed, so it is carried even though step 1 already set it

    assert finish["ok"] is True
    assert finish["summary"] == "done"
    assert finish["exitstatus"] == 0


def test_none_fields_are_omitted_not_written_as_null(tmp_path):
    path = tmp_path / "run.jsonl"
    events = progress_events(path)
    events.start()
    events.finish(ok=True)

    start, finish = read_events(path)
    assert "total" not in start
    assert "label" not in start
    assert "summary" not in finish
    assert "exitstatus" not in finish
    assert finish["ok"] is True


def test_unknown_extra_kwargs_pass_through(tmp_path):
    path = tmp_path / "run.jsonl"
    events = progress_events(path)
    events.step(done=1, total=1, nodeid="tests/test_x.py::test_y", outcome="passed", custom_field=42)

    (line,) = read_events(path)
    assert line["nodeid"] == "tests/test_x.py::test_y"
    assert line["outcome"] == "passed"
    assert line["custom_field"] == 42


def test_append_mode_keeps_earlier_lines_across_instances(tmp_path):
    path = tmp_path / "run.jsonl"
    progress_events(path).start(total=1)
    progress_events(path).finish(ok=True)

    lines = read_events(path)
    assert [e["type"] for e in lines] == ["start", "finish"]


def test_each_line_is_exactly_one_json_object_with_a_trailing_newline(tmp_path):
    path = tmp_path / "run.jsonl"
    events = progress_events(path)
    events.start(total=1)
    events.finish(ok=True)

    raw = path.read_text(encoding="utf-8")
    assert raw.endswith("\n")
    # No blank lines, no multi-line JSON — exactly one object per "\n".
    nonblank = [line for line in raw.split("\n") if line]
    assert len(nonblank) == 2
    for line in nonblank:
        json.loads(line)  # each one parses standalone


def test_write_failure_is_swallowed_and_warns_once_on_stderr(tmp_path, capsys):
    missing_dir = tmp_path / "does" / "not" / "exist" / "run.jsonl"
    events = progress_events(missing_dir)

    events.start(total=1)  # must not raise
    events.step(done=1, total=1)  # must not raise
    events.finish(ok=False)  # must not raise

    assert not missing_dir.exists()
    err = capsys.readouterr().err
    assert err.count("noddit:") == 1, "only the first failure should print a warning"


@pytest.mark.skipif(os.name == "nt", reason="chmod-based read-only simulation is POSIX-specific")
def test_unwritable_path_is_swallowed_not_raised(tmp_path, capsys):
    path = tmp_path / "run.jsonl"
    path.write_text("")
    path.chmod(0)
    try:
        events = progress_events(path)
        events.start(total=1)  # must not raise even though the file can't be opened for append
    finally:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    assert "noddit:" in capsys.readouterr().err


def test_version_field_is_always_1(tmp_path):
    path = tmp_path / "run.jsonl"
    events = progress_events(path)
    events.start()
    events.step()
    events.finish(ok=True)

    for line in read_events(path):
        assert line["v"] == 1


def test_package_exposes_version(tmp_path):
    assert isinstance(noddit.__version__, str)
    assert noddit.__version__
