import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PROGRESS_PARSERS,
  createThrottle,
  parseAnyProgressLine,
  percentFromCount,
  percentFromRegex,
} from '../src/core/progress.ts'
import { currentStepLabel, makeSteps, markStep, parseSteps, stepProgress } from '../src/core/steps.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { decs, decsResult, scratch } from './helpers.ts'

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

test('pytest parser reads the bracketed percent and ignores lines without one', () => {
  assert.equal(PROGRESS_PARSERS.pytest('tests/test_x.py::y PASSED [ 37%]'), 37)
  assert.equal(PROGRESS_PARSERS.pytest('tests/test_x.py::y PASSED [100%]'), 100)
  assert.equal(PROGRESS_PARSERS.pytest('collecting tests...'), null)
})

test('percent parser reads any bare NN%; fraction parser reads any N/M', () => {
  assert.equal(PROGRESS_PARSERS.percent('42% of the work is done'), 42)
  assert.equal(PROGRESS_PARSERS.percent('no percent here'), null)
  assert.equal(PROGRESS_PARSERS.fraction('gate 183/412'), Math.round((183 / 412) * 100))
  assert.equal(PROGRESS_PARSERS.fraction('0/0'), null, 'a zero total must not divide by zero')
})

test('parseAnyProgressLine tries every built-in parser in turn', () => {
  assert.equal(parseAnyProgressLine('[ 10%]'), 10)
  assert.equal(parseAnyProgressLine('3/10'), 30)
  assert.equal(parseAnyProgressLine('nothing matches'), null)
})

test('percentFromRegex: two groups are N/M, one group is a literal percent', () => {
  assert.equal(percentFromRegex(/(\d+)\/(\d+)/, '183/412'), Math.round((183 / 412) * 100))
  assert.equal(percentFromRegex(/(\d+)%/, 'done: 88%'), 88)
  assert.equal(percentFromRegex(/(\d+)\/(\d+)/, 'no match'), null)
})

test('percentFromCount is lines/total, clamped, zero-total safe', () => {
  assert.equal(percentFromCount(5, 23), Math.round((5 / 23) * 100))
  assert.equal(percentFromCount(0, 0), 0)
  assert.equal(percentFromCount(50, 10), 100, 'overshoot clamps to 100')
})

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

test('throttle: writes immediately on a cold start, then at most once per interval', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const writes: number[] = []
  const th = createThrottle<number>(60, (v) => writes.push(v))
  th.push(1)
  assert.deepEqual(writes, [1], 'first push writes immediately')
  th.push(2)
  th.push(3)
  t.mock.timers.tick(59)
  assert.deepEqual(writes, [1], 'rapid pushes inside the window do not write yet')
  t.mock.timers.tick(1)
  assert.deepEqual(writes, [1, 3], 'the trailing write is the LAST value pushed, not every value')
})

test('throttle: flush() forces the pending value immediately, and is a no-op with nothing pending', () => {
  const writes: number[] = []
  const t = createThrottle<number>(10_000, (v) => writes.push(v))
  t.push(1)
  t.push(2)
  assert.deepEqual(writes, [1])
  t.flush()
  assert.deepEqual(writes, [1, 2], 'flush delivers the queued trailing value without waiting out the interval')
  t.flush()
  assert.deepEqual(writes, [1, 2], 'a second flush with nothing pending writes nothing')
})

test('throttle: a value pushed well after the interval writes immediately again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const writes: number[] = []
  const th = createThrottle<number>(30, (v) => writes.push(v))
  th.push(1)
  t.mock.timers.tick(50)
  th.push(2)
  assert.deepEqual(writes, [1, 2])
})

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

test('steps: make/mark/progress/currentStepLabel round-trip', () => {
  const steps = makeSteps(['merge 6 branches', 'full gate', 'yaml', 'push'])
  assert.deepEqual(steps.map((s) => s.done), [false, false, false, false])
  const after2 = markStep(steps, 2)
  assert.deepEqual(after2.map((s) => s.done), [true, true, false, false])
  assert.equal(stepProgress(after2), 50)
  assert.equal(currentStepLabel(after2), 'full gate')
  assert.throws(() => markStep(after2, 5), /only 4 steps/)
  assert.throws(() => markStep([], 1), /no steps yet/)
})

test('parseSteps tolerates a bare string list and an unrelated shape', () => {
  assert.deepEqual(parseSteps(['a', 'b']), [{ label: 'a', done: false }, { label: 'b', done: false }])
  assert.deepEqual(parseSteps([{ label: 'x', done: true }]), [{ label: 'x', done: true }])
  assert.deepEqual(parseSteps('not an array'), [])
  assert.deepEqual(parseSteps(undefined), [])
})

// ---------------------------------------------------------------------------
// CLI: decs progress / decs steps / decs step
// ---------------------------------------------------------------------------

test('decs progress: DECS_NODE binds the id; progress starts a not_started node', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the full gate', '--task'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'not_started')

  decs(root, ['progress', '45', 'gate 183/412'], { DECS_NODE: '1' })
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'in_progress', 'progress moving is as much a start as decs start')
  assert.equal(d.progress, 45)
  assert.equal(d.progress_msg, 'gate 183/412')
})

test('decs progress: DECS_TASK still works as the old alias', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  decs(root, ['progress', '10'], { DECS_TASK: '1', DECS_NODE: undefined })
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).progress, 10)
})

test('decs progress: NODDIT_NODE works like DECS_NODE, and wins when both are set', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'a', '--task'])
  decs(root, ['add', 'b', '--task'])
  decs(root, ['progress', '20'], { NODDIT_NODE: '2' })
  assert.equal(JSON.parse(decs(root, ['get', '2', '--json'])).progress, 20, 'NODDIT_NODE alone binds the id')
  decs(root, ['progress', '77'], { NODDIT_NODE: '2', DECS_NODE: '1' })
  assert.equal(JSON.parse(decs(root, ['get', '2', '--json'])).progress, 77, 'NODDIT_NODE wins over DECS_NODE')
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).progress, null, 'node 1 (named only by DECS_NODE) was not touched')
})

test('decs progress: no DECS_NODE/DECS_TASK and no --node is a clear, non-zero-exit error', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const r = decsResult(root, ['progress', '50'], { DECS_NODE: undefined, DECS_TASK: undefined })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no node/)
})

test('decs progress --count-lines: reads the file once, does not follow it', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const log = join(root, 'run.log')
  writeFileSync(log, 'a\nb\nc\nd\ne\n')
  const out = decs(root, ['progress', '--count-lines', log, '--total', '23'], { DECS_NODE: '1' })
  assert.match(out, /22%/)
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).progress, 22)
})

test('decs progress --from-file: auto-detects a noddit JSONL events file with no --parse flag', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const log = join(root, 'events.jsonl')
  writeFileSync(log, ['{"type":"start","total":10,"label":"pytest"}', '{"type":"progress","done":3,"failed":1}'].join('\n') + '\n')

  decs(root, ['progress', '--from-file', log, '--idle', '100'], { DECS_NODE: '1' })

  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.progress, 30)
  assert.equal(d.progress_msg, '3/10 · 1 failed')
})

test('decs progress --from-file --parse jsonl: explicit flag reads the same events', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const log = join(root, 'events.jsonl')
  writeFileSync(log, ['{"type":"start","total":4}', '{"type":"progress","done":2}', '{"type":"finish","ok":true,"summary":"all good"}'].join('\n') + '\n')

  decs(root, ['progress', '--from-file', log, '--parse', 'jsonl', '--idle', '100'], { DECS_NODE: '1' })

  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.progress, 100, 'finish always lands at 100%')
  assert.equal(d.progress_msg, 'all good')
})

test('decs progress --from-file: a plain log with no JSON still uses the legacy parsers (auto-detect does not break them)', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const log = join(root, 'run.log')
  writeFileSync(log, 'collecting...\ntests/test_x.py::y PASSED [ 37%]\n')

  decs(root, ['progress', '--from-file', log, '--idle', '100'], { DECS_NODE: '1' })

  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).progress, 37)
})

test('decs progress --from-file: an explicit --msg overrides the message an event line would have set', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const log = join(root, 'events.jsonl')
  writeFileSync(log, ['{"type":"start","total":4}', '{"type":"progress","done":2}'].join('\n') + '\n')

  decs(root, ['progress', '--from-file', log, '--idle', '100', '--msg', 'custom override'], { DECS_NODE: '1' })

  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.progress, 50)
  assert.equal(d.progress_msg, 'custom override')
})

test('decs progress --from-file: an unrecognized --parse name is a clear error, and still lists jsonl', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const log = join(root, 'run.log')
  writeFileSync(log, 'anything\n')
  const r = decsResult(root, ['progress', '--from-file', log, '--parse', 'nope'], { DECS_NODE: '1' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /jsonl/)
})

test('decs progress: stdin is parsed AND teed through to stdout unchanged', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const lines = ['tests/a.py::1 PASSED [ 10%]', 'tests/a.py::2 PASSED [ 55%]', 'tests/a.py::3 PASSED [100%]']
  const out = decs(root, ['progress', '--parse', 'pytest'], { DECS_NODE: '1' }, `${lines.join('\n')}\n`)
  assert.equal(out.trim(), lines.join('\n'), 'stdin passes through byte-for-byte (tee)')
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).progress, 100, 'the throttle still lands the final value')
})

test('decs steps / decs step: step n sets n/total progress and logs a note', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'release', '--task'])
  decs(root, ['steps', '1', 'merge 6 branches', 'full gate', 'yaml', 'push'])
  let d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.steps.length, 4)
  assert.equal(d.progress, 0)

  decs(root, ['step', '1', '2'])
  d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.progress, 50)
  assert.equal(d.progress_msg, 'full gate')
  assert.equal(d.status, 'in_progress')
  assert.ok(d.notes.some((n: { text: string }) => n.text.includes('step 2/4')))

  assert.equal(decsResult(root, ['step', '1', '9']).code, 1, 'a step number past the end is refused')
})
