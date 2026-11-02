"""Only runs when pytest-xdist is actually installed in this environment —
`pip install -e ".[test-xdist]"` — otherwise it's skipped rather than
failing a plain `pip install -e ".[test]"` setup.
"""

import json

import pytest

pytest.importorskip("xdist")


def read_events(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_only_the_controller_writes(pytester, monkeypatch):
    monkeypatch.delenv("NODDIT_EVENTS", raising=False)
    pytester.makepyfile(
        test_x="""
        import pytest

        @pytest.mark.parametrize("n", range(6))
        def test_it(n):
            assert True
        """
    )
    events_path = pytester.path / "events.jsonl"
    result = pytester.runpytest_subprocess("-p", "xdist", "-n", "2", f"--noddit-events={events_path}")
    result.assert_outcomes(passed=6)

    events = read_events(events_path)
    starts = [e for e in events if e["type"] == "start"]
    finishes = [e for e in events if e["type"] == "finish"]
    progress = [e for e in events if e["type"] == "progress"]

    assert len(starts) == 1, "exactly one start line — not one per worker"
    assert len(finishes) == 1, "exactly one finish line — not one per worker"
    assert starts[0]["total"] == 6
    assert finishes[0]["passed"] == 6
    assert len(progress) == 6, "one progress line per test, relayed from the workers to the controller"
