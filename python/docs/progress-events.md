# The progress-events format

A plain JSON Lines file: one JSON object per line, written in append mode by
whoever is running the long thing, and read (usually "tailed", like `tail
-f`) by whoever wants to watch it from outside — a terminal UI, a CI step, a
dashboard, [`nod progress`/`nod run`](https://github.com/wecarbon/noddit).

Every line has `"v"` (schema version, currently always `1`) and `"type"`,
one of `"start"`, `"progress"` or `"finish"`. Fields beyond what's listed
below may show up on any line — an unrecognized field is always safe to
ignore, so the format can grow without breaking an older reader.

Produced by `noddit.progress_events(path)` (see the package README) or by
the `noddit` pytest plugin (`--noddit-events PATH`); a reader shouldn't
assume either source, since anything writing this format is welcome to.

## `start` — the run is beginning

```json
{"v": 1, "type": "start", "total": 10011, "label": "pytest", "ts": 1732000000.0}
```

| field   | meaning                                                   |
| ------- | ---------------------------------------------------------- |
| `total` | expected number of steps, if known (a reader without one treats progress as "count only", no percentage) |
| `label` | one line describing what's running                         |
| `ts`    | Unix timestamp (seconds, float) of this event               |

## `progress` — one unit of work finished

```json
{"v": 1, "type": "progress", "done": 3823, "total": 10011, "passed": 3800, "failed": 2, "skipped": 21, "nodeid": "tests/test_x.py::test_y", "outcome": "passed", "ts": 1732000012.5}
```

| field                       | meaning                                                             |
| ---------------------------- | -------------------------------------------------------------------- |
| `done` / `total`             | progress so far; a reader renders `done/total` or a percentage       |
| `passed` / `failed` / `skipped` | running counts, when the work being tracked has an outcome per step (pytest does; a generic build step might not) |
| `nodeid`                     | which step this line is about, when steps have names (pytest's test id) |
| `outcome`                    | this step's own result: `"passed"`, `"failed"` or `"skipped"`        |
| `msg`                        | a short line of free text instead of/alongside the counts            |

## `finish` — the run is over

```json
{"v": 1, "type": "finish", "ok": true, "exitstatus": 0, "passed": 9998, "failed": 2, "skipped": 11, "failed_nodeids": ["tests/test_x.py::test_y"], "duration_s": 42.11, "summary": "9998 passed, 2 failed, 11 skipped in 42.11s", "ts": 1732000042.1}
```

| field            | meaning                                                              |
| ------------------ | ----------------------------------------------------------------------- |
| `ok`               | the one field a reader can always rely on being present: did it succeed |
| `exitstatus`       | the process's exit code, when there is one                              |
| `passed` / `failed` / `skipped` | final counts                                                |
| `failed_nodeids`   | up to 50 of the names that failed — enough to act on, not a full dump |
| `duration_s`       | how long the run took, in seconds                                     |
| `summary`          | one line for a human, e.g. what a terminal would have printed          |

## Writing it yourself

Anything that can append a line to a file and call `json.dumps` can produce
this format — `noddit.progress_events` just does the bookkeeping (the `v`
and `ts` fields, append-mode + flush, swallowing write errors) so the
calling code only has three calls to make:

```python
import noddit

events = noddit.progress_events("run.jsonl")
events.start(total=len(jobs), label="processing widgets")
for i, job in enumerate(jobs, start=1):
    run(job)
    events.step(done=i, total=len(jobs))
events.finish(ok=True, summary=f"{len(jobs)} widgets done")
```

## Reading it

Read the file as you would `tail -f` it: lines only ever get appended, and
the very last line may be incomplete if you catch the writer mid-write — an
incomplete line is not an error, it just isn't ready yet. A conforming
reader:

- ignores any `type` it doesn't recognize, and any field it doesn't recognize on a line it does;
- treats a line that fails to parse as JSON as "not there yet", not as a fatal error (retry on the next read);
- can keep a running `total` from the last `start` or `progress` line that had one, since `progress` lines are allowed to omit it once it's already known.
