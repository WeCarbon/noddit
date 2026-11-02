# noddit

The Python SDK for **[Noddit](https://github.com/WeCarbon/noddit)** — the task and decision hub for AI coding agents, where agents put their work and their questions and you answer with one keypress in a terminal bench or the desktop app. This package lets Python jobs report progress to a Noddit node: run your tests or scripts anywhere (a Docker container, CI), and `nod progress` / `nod run` on the host moves the node's progress bar and closes it when the run finishes. The main project, the `nod` CLI (`npm i -g @wecarbon/noddit`) and the desktop app live at [github.com/WeCarbon/noddit](https://github.com/WeCarbon/noddit).

Write progress as [JSON Lines](https://jsonlines.org/) — one small JSON
object per step, appended to a plain file — so anything watching that file
from outside (a terminal UI, a CI step, a dashboard) can show a live
"3823/10011 · 2 failed" without you building a protocol for it.

Pure standard library, no dependencies, Python 3.10+. MIT licensed.

```sh
pip install noddit
```

## As a library

```python
import noddit

events = noddit.progress_events("run.jsonl")
events.start(total=len(jobs), label="processing widgets")
for i, job in enumerate(jobs, start=1):
    run(job)
    events.step(done=i, total=len(jobs))
events.finish(ok=True, summary=f"{len(jobs)} widgets done")
```

Every call appends exactly one JSON line and never raises: a write that
can't happen (missing directory, full disk, read-only mount) is swallowed,
with one warning on stderr the first time it happens. See
[`docs/progress-events.md`](docs/progress-events.md) for the exact fields
each event carries.

## As a pytest plugin

Installing `noddit` registers a pytest plugin that mirrors a test run the
same way — but it writes nothing unless you ask:

```sh
pytest --noddit-events run.jsonl
# or
NODDIT_EVENTS=run.jsonl pytest
```

With neither flag nor environment variable set, the plugin does nothing at
all — a plain `pytest` run, `-q`, or any other output format is unaffected.

Each test counts once (`start` after collection with the total, one
`progress` line per test as it finishes, `finish` with pass/fail/skip
counts and up to 50 failing test names), and running under `pytest-xdist`
only the controller process writes — never one line per worker.

```jsonl
{"v": 1, "type": "start", "total": 3, "label": "pytest", "ts": 1732000000.0}
{"v": 1, "type": "progress", "done": 1, "total": 3, "passed": 1, "failed": 0, "skipped": 0, "nodeid": "tests/test_x.py::test_a", "outcome": "passed", "ts": 1732000000.4}
{"v": 1, "type": "progress", "done": 2, "total": 3, "passed": 1, "failed": 1, "skipped": 0, "nodeid": "tests/test_x.py::test_b", "outcome": "failed", "ts": 1732000000.9}
{"v": 1, "type": "finish", "ok": false, "exitstatus": 1, "passed": 2, "failed": 1, "skipped": 0, "failed_nodeids": ["tests/test_x.py::test_b"], "duration_s": 1.21, "summary": "2 passed, 1 failed in 1.21s", "ts": 1732000001.2}
```

## Who reads this

This is the same event format the [`nod`](https://github.com/wecarbon/noddit)
CLI follows with `nod progress --from-file run.jsonl` (auto-detected) and
`nod run <id> -- pytest …` (which also sets `NODDIT_EVENTS` for you) — but
nothing here depends on `nod`. Any reader that follows the file and
understands `start`/`progress`/`finish` works.

## Development

```sh
cd python
python -m venv .venv && . .venv/bin/activate
pip install -e ".[test]"
pytest
python -m build
twine check dist/*
```
