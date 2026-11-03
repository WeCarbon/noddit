import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { renameRetrying, withFileLock } from '../src/core/lock.ts'
import { NOTE_KIND } from '../src/core/format.ts'
import { decsAsync, scratch } from './helpers.ts'

test('concurrent notes on one entry never lose a write', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 'concurrent appends', author: 'race · lane', options: [{ key: '1', label: 'x' }] })
  const N = 16
  // read-modify-write race: without the per-entry lock, a later writer's stale copy drops an earlier note
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      decsAsync(root, ['note', String(d.id), `note #${i}.`, '--author', `race-${i} · lane`]),
    ),
  )
  const text = readFileSync(store.get(d.id)!.file, 'utf8')
  for (let i = 0; i < N; i++) assert.ok(text.includes(`note #${i}.`), `note ${i} was lost`)
  assert.equal(readdirSync(join(root, 'decisions', 'active')).length, 1, 'no temp files left behind')
  assert.ok(!existsSync(join(root, 'decisions', '.locks', `D${d.id}.lock`)), 'the lock is released')
})

test('answers pushed at once, as the desktop app does, all land and all queue', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const ids = Array.from({ length: 6 }, (_, i) => store.create({ title: `pick ${i}`, author: 'race · lane', options: [{ key: '1', label: 'a' }, { key: '2', label: 'b' }] }).id)
  // Each push rewrites its own node, then queue.json and checkins.json, which every push shares.
  await Promise.all(ids.map((id) => decsAsync(root, ['push', String(id), '2', '--human'])))
  for (const id of ids) assert.equal(store.get(id)!.answer?.choice, '2', `the answer to ${id} was lost`)
  const queued = (JSON.parse(readFileSync(join(root, 'decisions', 'queue.json'), 'utf8')) as { queue: number[] }).queue
  assert.deepEqual([...queued].sort((a, b) => a - b), ids, 'every answer is waiting for its lane')
})

test('a note and an answer on a stale copy both land', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const stale = store.create({ title: 't', author: 'lane · x', options: [{ key: '1', label: 'a' }] })

  // The bench holds `stale` for the whole session; a lane appends meanwhile.
  store.append(stale, `${NOTE_KIND.addendum}（agent · lane · 2026-10-28 10:00:00）`, 'the fact I just found out', 'lane')
  const answered = store.answer(stale, { choice: '1' })
  assert.ok(answered.body.includes('the fact I just found out'), 'answering from a stale copy must not erase the note')
})

test('a lock left behind by a dead process is taken over', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lock = join(root, 'x.lock')
  mkdirSync(root, { recursive: true })
  writeFileSync(lock, '99999\n')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  const started = Date.now()
  assert.equal(withFileLock(lock, () => 42, { staleMs: 1000 }), 42)
  assert.ok(Date.now() - started < 1000, 'a stale lock is stolen at once, not waited out')
  assert.ok(!existsSync(lock))
})

// ---------------------------------------------------------------------------
// renameRetrying: Windows can reject a rename over an open file with
// EPERM/EBUSY for a moment (antivirus, OneDrive, an editor without
// FILE_SHARE_DELETE). Simulated here with an injected `rename` — no real
// file locking, and nothing platform-specific, needed to exercise the retry.
// ---------------------------------------------------------------------------

class Flaky {
  calls = 0
  failTimes: number
  codes: string[]
  constructor(failTimes: number, codes: string[] = []) {
    this.failTimes = failTimes
    this.codes = codes
  }
  rename = (from: string, to: string): void => {
    this.calls++
    if (this.calls <= this.failTimes) {
      const err = new Error('busy') as NodeJS.ErrnoException
      err.code = this.codes[this.calls - 1] ?? 'EPERM'
      throw err
    }
    renameSync(from, to)
  }
}

test('renameRetrying succeeds once a transient EPERM/EBUSY clears', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const from = join(root, 'a.tmp')
  const to = join(root, 'a.txt')
  writeFileSync(from, 'content')
  const f = new Flaky(2, ['EPERM', 'EBUSY'])
  renameRetrying(from, to, 5, f.rename)
  assert.equal(f.calls, 3)
  assert.equal(readFileSync(to, 'utf8'), 'content')
})

test('renameRetrying gives up after its attempt budget, and never retries an unrelated error', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const from = join(root, 'b.tmp')
  const to = join(root, 'b.txt')
  writeFileSync(from, 'x')
  assert.throws(() => renameRetrying(from, to, 3, new Flaky(10).rename), /busy/)

  const notFound = new Flaky(1, ['ENOENT'])
  assert.throws(() => renameRetrying(from, to, 5, notFound.rename), /busy/)
  assert.equal(notFound.calls, 1, 'a non-transient error is not retried')
})
