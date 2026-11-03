import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BIN, decs, decsResult, scratch, waitFor } from './helpers.ts'

/**
 * A tiny cross-platform "test runner" controlled by its first argv: writes
 * noddit progress events to $NODDIT_EVENTS (when set) and exits however the
 * mode says. Used in place of a real `pytest` so these tests don't depend
 * on Python being installed, and run the same on Windows CI.
 */
const FIXTURE = `
const fs = require('node:fs')
const mode = process.argv[2]
const events = process.env.NODDIT_EVENTS
function emit(obj) {
  if (!events) return
  fs.appendFileSync(events, JSON.stringify(obj) + '\\n')
}
if (mode === 'success') {
  emit({ type: 'start', total: 2, label: 'fixture' })
  console.log('line 1')
  emit({ type: 'progress', done: 1, total: 2, passed: 1, failed: 0 })
  console.log('line 2')
  emit({ type: 'progress', done: 2, total: 2, passed: 2, failed: 0 })
  emit({ type: 'finish', ok: true, exitstatus: 0, passed: 2, failed: 0, skipped: 0, duration_s: 0.1, summary: '2 passed in 0.1s' })
  process.exit(0)
} else if (mode === 'fail') {
  emit({ type: 'start', total: 2, label: 'fixture' })
  console.log('t1 ok')
  emit({ type: 'progress', done: 1, total: 2, passed: 1, failed: 0, nodeid: 't1' })
  console.error('t2 FAILED')
  emit({ type: 'progress', done: 2, total: 2, passed: 1, failed: 1, nodeid: 't2', outcome: 'failed' })
  emit({ type: 'finish', ok: false, exitstatus: 1, passed: 1, failed: 1, skipped: 0, failed_nodeids: ['t2'], duration_s: 0.1, summary: '1 passed, 1 failed in 0.1s' })
  process.exit(1)
} else if (mode === 'no-events-ok') {
  console.log('plain output, no events written at all')
  process.exit(0)
} else if (mode === 'no-events-fail') {
  console.log('plain output, no events written at all')
  process.exit(1)
} else if (mode === 'many-lines') {
  for (let i = 0; i < 30; i++) console.log('line ' + i)
  process.exit(1)
} else if (mode === 'slow-start') {
  // Long enough that even a loaded machine's own process-spawn overhead (this
  // fixture, "nod get" polling it back) can't eat the whole window before the
  // in-progress check below gets to look.
  setTimeout(() => {
    emit({ type: 'start', total: 1, label: 'slow' })
    emit({ type: 'progress', done: 1, total: 1 })
    emit({ type: 'finish', ok: true, summary: 'done' })
    process.exit(0)
  }, 2000)
} else {
  console.error('unknown mode ' + mode)
  process.exit(2)
}
`

function writeFixture(root: string): string {
  const path = join(root, 'fixture.cjs')
  writeFileSync(path, FIXTURE)
  return path
}

/** `nod run` with a plain argv (bypassing the `decs()` helper's shell-quoting-free execFileSync is fine too, but this spells out env for a background spawn). */
function spawnRun(root: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawn(process.execPath, [BIN, 'run', ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', DECS_LANG: 'en', CLAUDECODE: '1', ...env },
  })
}

test('nod run: a successful command marks the node done, with counts/duration/log in the note', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const script = writeFixture(root)
  const log = join(root, 'run.log')

  const out = decs(root, ['run', '1', '--log', log, '--', process.execPath, script, 'success'])
  assert.match(out, /line 1/)
  assert.match(out, /line 2/)
  assert.match(out, /1 done/)

  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'completed')
  assert.equal(d.progress, 100)
  assert.equal(d.progress_msg, '2 passed in 0.1s')
  assert.match(d.notes.at(-1).text, /2 passed in 0\.1s/)
  assert.match(d.notes.at(-1).text, /exit 0/)
  assert.match(d.notes.at(-1).text, new RegExp(`log: .*run\\.log`))

  assert.equal(readFileSync(log, 'utf8').trim(), ['line 1', 'line 2'].join('\n'), '--log gets the tail of the command\'s own output')
})

test('nod run: exit code is the command\'s own', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const script = writeFixture(root)

  const okResult = decsResult(root, ['run', '1', '--', process.execPath, script, 'success'])
  assert.equal(okResult.code, 0)

  decs(root, ['add', 't2', '--task'])
  const failResult = decsResult(root, ['run', '2', '--', process.execPath, script, 'fail'])
  assert.equal(failResult.code, 1)
})

test('nod run: a failing command holds the node waiting, with the last lines of output and failed test names', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const script = writeFixture(root)

  const r = decsResult(root, ['run', '1', '--', process.execPath, script, 'fail'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /failing/)

  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.status, 'waiting')
  assert.match(d.waiting_on, /^failing:/)

  const text = d.notes.map((n: { text: string }) => n.text).join('\n---\n')
  assert.match(text, /t2/, 'the failing nodeid shows up in a note')
  assert.match(text, /t1 ok/, 'stdout is captured in the tail even though it was also streamed live')
  assert.match(text, /t2 FAILED/, 'stderr is captured in the tail too')
  assert.match(text, /exit 1/)
})

test('nod run: a command that never writes any events still settles from its exit code alone', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'a', '--task'])
  decs(root, ['add', 'b', '--task'])
  const script = writeFixture(root)

  decs(root, ['run', '1', '--', process.execPath, script, 'no-events-ok'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'completed')

  decsResult(root, ['run', '2', '--', process.execPath, script, 'no-events-fail'])
  const d2 = JSON.parse(decs(root, ['get', '2', '--json']))
  assert.equal(d2.status, 'waiting')
  assert.match(d2.waiting_on, /^failing: exit 1/)
})

test('nod run: the failure note keeps only the last ~20 lines of output, not the whole thing', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const script = writeFixture(root)

  decsResult(root, ['run', '1', '--', process.execPath, script, 'many-lines'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  const text = d.notes.map((n: { text: string }) => n.text).join('\n')
  assert.ok(!text.includes('line 0'), 'the earliest lines should have scrolled out of the tail')
  assert.ok(text.includes('line 29'), 'the most recent line should still be there')
})

test('nod run: --events uses exactly that path, and leaves the file behind afterwards', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const script = writeFixture(root)
  const eventsPath = join(root, 'my-events.jsonl')

  decs(root, ['run', '1', '--events', eventsPath, '--', process.execPath, script, 'success'])
  assert.ok(existsSync(eventsPath), 'an explicitly-given --events path is not cleaned up')
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n')
  assert.equal(JSON.parse(lines[0]).type, 'start')
  assert.equal(JSON.parse(lines.at(-1)!).type, 'finish')
})

test('nod run: with no --events, a generated events file is passed to the child via NODDIT_EVENTS and cleaned up after', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  // A script that just echoes back where NODDIT_EVENTS pointed, so the test
  // can check it existed (as a file our own temp dir, not something handed
  // in) without hard-coding a path.
  const probe = join(root, 'probe.cjs')
  writeFileSync(
    probe,
    "const fs = require('node:fs'); const p = process.env.NODDIT_EVENTS; console.log('EVENTS_PATH=' + p); fs.appendFileSync(p, JSON.stringify({type:'finish',ok:true}) + '\\n'); process.exit(0)",
  )
  const tmpRoot = tmpdir()

  const out = decs(root, ['run', '1', '--', process.execPath, probe])
  const m = /EVENTS_PATH=(.+)/.exec(out)
  assert.ok(m, 'the child saw NODDIT_EVENTS set')
  const eventsPath = m![1].trim()
  assert.ok(eventsPath.startsWith(tmpRoot) || eventsPath.includes('nod-run-'), 'a generated path, not something under the project')
  assert.ok(!existsSync(eventsPath), 'cleaned up once the run finished')
})

test('nod run: --wait-label shows as the progress message until the first event arrives', async (t) => {
  const root = scratch()
  // nod start/run also touch $DECS_HOME/session-nodes.json under a file lock;
  // left on the default it's the real, shared ~/.decs — contended by every
  // other agent on the machine running nod commands at the same time, which
  // is exactly what turned the gap below from a microsecond race into a real
  // one (N260). Pinning it to a scratch dir isolates the test from that.
  const home = scratch()
  const env = { DECS_HOME: home }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'], env)
  decs(root, ['add', 't', '--task'], env)
  const script = writeFixture(root)

  const proc = spawnRun(root, ['1', '--wait-label', 'warming up', '--', process.execPath, script, 'slow-start'], env)
  t.after(() => proc.kill())

  // `nod run` writes status (store.start) and the wait-label (store.progress)
  // as two separate file writes, with that session bookkeeping in between —
  // poll for the actual label rather than just the status, in case a slow
  // machine still stretches the gap enough to catch it (N260: polling for
  // status alone once caught it mid-gap, label still null). Both writes land
  // well before the fixture's own first event either way.
  let mid: { status: string; progress_msg: string | null } = { status: '', progress_msg: null }
  await waitFor(() => {
    mid = JSON.parse(decs(root, ['get', '1', '--json'], env))
    return mid.progress_msg === 'warming up'
  }, 'the wait-label to show as the progress message', 15_000, 20)
  assert.equal(mid.status, 'in_progress')

  await new Promise((resolveP) => proc.once('exit', resolveP))
  const final = JSON.parse(decs(root, ['get', '1', '--json'], env))
  assert.equal(final.status, 'completed')
  assert.equal(final.progress_msg, 'done')
})

test('nod run: an already-finished node refuses to run again', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  decs(root, ['done', '1'])
  const script = writeFixture(root)

  const r = decsResult(root, ['run', '1', '--', process.execPath, script, 'success'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /already done or closed/)
})

test('nod run: no command after -- is a clear error', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  const r = decsResult(root, ['run', '1'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no command/)
})

test('nod run: no node id is a clear error', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  const r = decsResult(root, ['run'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /which node/)
})

test('nod run: a node still "to do" is started, same as nod progress piping in', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 't', '--task'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'not_started')
  const script = writeFixture(root)
  decs(root, ['run', '1', '--', process.execPath, script, 'success'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).status, 'completed')
})
