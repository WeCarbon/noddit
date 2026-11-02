import json
import re


def read_events(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


PASS_FAIL_SKIP = """
import pytest

def test_pass():
    assert True

def test_fail():
    assert False

@pytest.mark.skip(reason="nope")
def test_skip():
    assert True
"""


def test_plugin_does_nothing_without_the_flag_or_env(pytester, monkeypatch):
    monkeypatch.delenv("NODDIT_EVENTS", raising=False)
    pytester.makepyfile(test_x="def test_ok():\n    assert True\n")
    result = pytester.runpytest()
    result.assert_outcomes(passed=1)
    assert not list(pytester.path.glob("*.jsonl")), "no --noddit-events/$NODDIT_EVENTS given, so nothing should be written"


def test_events_file_via_cli_flag(pytester, monkeypatch):
    monkeypatch.delenv("NODDIT_EVENTS", raising=False)
    pytester.makepyfile(test_x=PASS_FAIL_SKIP)
    events_path = pytester.path / "events.jsonl"
    result = pytester.runpytest(f"--noddit-events={events_path}")
    result.assert_outcomes(passed=1, failed=1, skipped=1)

    events = read_events(events_path)
    assert events[0]["type"] == "start"
    assert events[0]["total"] == 3
    assert [e["type"] for e in events[1:-1]] == ["progress", "progress", "progress"]

    finish = events[-1]
    assert finish["type"] == "finish"
    assert finish["ok"] is False
    assert finish["passed"] == 1
    assert finish["failed"] == 1
    assert finish["skipped"] == 1
    assert finish["failed_nodeids"] == ["test_x.py::test_fail"]
    assert "duration_s" in finish
    assert "summary" in finish


def test_events_file_via_env_var(pytester, monkeypatch):
    pytester.makepyfile(test_x="def test_ok():\n    assert True\n")
    events_path = pytester.path / "via-env.jsonl"
    monkeypatch.setenv("NODDIT_EVENTS", str(events_path))
    result = pytester.runpytest()
    result.assert_outcomes(passed=1)

    events = read_events(events_path)
    assert events[0]["type"] == "start"
    assert events[-1]["type"] == "finish"
    assert events[-1]["ok"] is True


def test_cli_flag_wins_over_env_var(pytester, monkeypatch):
    pytester.makepyfile(test_x="def test_ok():\n    assert True\n")
    env_path = pytester.path / "env.jsonl"
    cli_path = pytester.path / "cli.jsonl"
    monkeypatch.setenv("NODDIT_EVENTS", str(env_path))
    pytester.runpytest(f"--noddit-events={cli_path}")
    assert cli_path.exists()
    assert not env_path.exists()


def test_each_test_counted_once_including_a_setup_error(pytester, monkeypatch):
    monkeypatch.delenv("NODDIT_EVENTS", raising=False)
    pytester.makepyfile(
        test_y="""
        import pytest

        @pytest.fixture
        def broken():
            raise RuntimeError("setup blew up")

        def test_setup_error(broken):
            assert True

        def test_ok():
            assert True
        """
    )
    events_path = pytester.path / "events.jsonl"
    result = pytester.runpytest(f"--noddit-events={events_path}")
    result.assert_outcomes(passed=1, errors=1)

    events = read_events(events_path)
    progress = [e for e in events if e["type"] == "progress"]
    assert len(progress) == 2, "one line per test, even though one of them failed in setup"
    finish = events[-1]
    assert finish["passed"] == 1
    assert finish["failed"] == 1


def test_does_not_change_the_test_outcome_when_the_events_path_is_unwritable(pytester, monkeypatch):
    monkeypatch.delenv("NODDIT_EVENTS", raising=False)
    pytester.makepyfile(test_x="def test_ok():\n    assert True\n")
    bad_path = pytester.path / "nowhere" / "events.jsonl"  # parent dir does not exist
    result = pytester.runpytest(f"--noddit-events={bad_path}")
    result.assert_outcomes(passed=1)
    assert result.ret == 0
    assert not bad_path.exists()


def test_terminal_output_is_unaffected(pytester, monkeypatch):
    monkeypatch.delenv("NODDIT_EVENTS", raising=False)
    pytester.makepyfile(test_x="def test_ok():\n    assert True\n")
    events_path = pytester.path / "events.jsonl"
    with_plugin = pytester.runpytest("-q", f"--noddit-events={events_path}")
    without_plugin = pytester.runpytest("-q")
    # Same dots and the same outcome counts either way — the plugin adds no
    # output of its own (the trailing "in N.NNs" naturally differs run to run).
    assert with_plugin.outlines[:-1] == without_plugin.outlines[:-1]
    assert re.fullmatch(r"1 passed in [\d.]+s", with_plugin.outlines[-1])
    assert re.fullmatch(r"1 passed in [\d.]+s", without_plugin.outlines[-1])
