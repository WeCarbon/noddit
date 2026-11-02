import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createEventTracker, finishSummary, isEventLine, parseEventLine } from '../src/core/events.ts'

test('parseEventLine: recognizes start/progress/finish, rejects everything else', () => {
  assert.deepEqual(parseEventLine('{"type":"start","total":10}'), { type: 'start', total: 10 })
  assert.deepEqual(parseEventLine('{"type":"progress","done":3}'), { type: 'progress', done: 3 })
  assert.deepEqual(parseEventLine('{"type":"finish","ok":true}'), { type: 'finish', ok: true })

  assert.equal(parseEventLine(''), null, 'blank line')
  assert.equal(parseEventLine('   '), null, 'whitespace-only line')
  assert.equal(parseEventLine('not json at all'), null, 'not JSON')
  assert.equal(parseEventLine('{"type":"start"'), null, 'a truncated/partial line, as a tail -f might catch mid-write')
  assert.equal(parseEventLine('[1,2,3]'), null, 'a JSON array, not an object')
  assert.equal(parseEventLine('"just a string"'), null, 'a JSON scalar, not an object')
  assert.equal(parseEventLine('{"type":"something_else"}'), null, 'an unrecognized type')
  assert.equal(parseEventLine('{"no_type_field":1}'), null, 'no type field at all')
})

test('parseEventLine keeps unknown fields rather than stripping them', () => {
  const ev = parseEventLine('{"type":"progress","done":1,"some_future_field":"x"}')
  assert.equal((ev as Record<string, unknown>).some_future_field, 'x')
})

test('isEventLine mirrors parseEventLine as a boolean', () => {
  assert.equal(isEventLine('{"type":"start"}'), true)
  assert.equal(isEventLine('plain text'), false)
})

test('finishSummary: builds a one-line summary when the event has no summary of its own', () => {
  assert.equal(finishSummary({ type: 'finish', passed: 10 }), '10 passed')
  assert.equal(finishSummary({ type: 'finish', passed: 8, failed: 2 }), '8 passed, 2 failed')
  assert.equal(finishSummary({ type: 'finish', passed: 8, failed: 2, skipped: 1 }), '8 passed, 2 failed, 1 skipped')
  assert.equal(finishSummary({ type: 'finish', ok: false, failed: 3 }), 'failed: 3 failed')
  assert.equal(finishSummary({ type: 'finish', ok: false }), 'failed', 'no counts at all, but ok is explicitly false')
  assert.equal(finishSummary({ type: 'finish' }), 'done', 'no counts, ok not even given')
})

test('createEventTracker: start sets pct 0 and carries total forward for later progress lines', () => {
  const tr = createEventTracker()
  assert.deepEqual(tr.push('{"type":"start","total":10011,"label":"pytest"}'), { pct: 0, msg: 'pytest' })
  // total omitted here — the tracker remembers it from the start line
  assert.deepEqual(tr.push('{"type":"progress","done":3823,"failed":2}'), { pct: 38, msg: '3823/10011 · 2 failed' })
  assert.equal(tr.last.start?.total, 10011)
  assert.equal(tr.last.progress?.done, 3823)
})

test('createEventTracker: progress without any failures omits the "N failed" part', () => {
  const tr = createEventTracker()
  tr.push('{"type":"start","total":4}')
  assert.deepEqual(tr.push('{"type":"progress","done":2}'), { pct: 50, msg: '2/4' })
})

test('createEventTracker: a progress line can set its own total, overriding start\'s', () => {
  const tr = createEventTracker()
  tr.push('{"type":"start","total":10}')
  assert.deepEqual(tr.push('{"type":"progress","done":5,"total":20}'), { pct: 25, msg: '5/20' })
})

test('createEventTracker: an explicit msg field wins over the computed one', () => {
  const tr = createEventTracker()
  tr.push('{"type":"start","total":4}')
  assert.deepEqual(tr.push('{"type":"progress","done":1,"msg":"custom text"}'), { pct: 25, msg: 'custom text' })
})

test('createEventTracker: finish is pct 100, msg from summary or a generated one, and lands in .last.finish', () => {
  const tr = createEventTracker()
  tr.push('{"type":"start","total":2}')
  tr.push('{"type":"progress","done":2}')
  assert.deepEqual(tr.push('{"type":"finish","ok":true,"summary":"all good"}'), { pct: 100, msg: 'all good' })
  assert.equal(tr.last.finish?.ok, true)

  const tr2 = createEventTracker()
  assert.deepEqual(tr2.push('{"type":"finish","ok":false,"passed":1,"failed":1}'), { pct: 100, msg: 'failed: 1 passed, 1 failed' })
})

test('createEventTracker: non-event lines (blank, partial, unrelated) return null and do not disturb state', () => {
  const tr = createEventTracker()
  tr.push('{"type":"start","total":10}')
  assert.equal(tr.push(''), null)
  assert.equal(tr.push('not an event'), null)
  assert.equal(tr.push('{"type":"progress"'), null, 'partial last line')
  assert.deepEqual(tr.push('{"type":"progress","done":1}'), { pct: 10, msg: '1/10' }, 'the remembered total survived the junk in between')
})

test('createEventTracker: replaying the same lines from the start is idempotent (what a full re-read each tick does)', () => {
  const lines = ['{"type":"start","total":4}', '{"type":"progress","done":1}', '{"type":"progress","done":2}']
  const tr = createEventTracker()
  let last: ReturnType<typeof tr.push> = null
  for (const line of lines) {
    const v = tr.push(line)
    if (v !== null) last = v
  }
  const firstPass = last

  // Simulate `nod progress --from-file` re-reading the whole file on the next tick.
  const tr2 = createEventTracker()
  let last2: ReturnType<typeof tr.push> = null
  for (const line of lines) {
    const v = tr2.push(line)
    if (v !== null) last2 = v
  }
  assert.deepEqual(firstPass, last2)
  assert.deepEqual(firstPass, { pct: 50, msg: '2/4' })
})
