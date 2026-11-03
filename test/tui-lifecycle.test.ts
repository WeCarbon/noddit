import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · tui lifecycle test'
const opt = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-lifecycle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

test('App: s starts a not-started node; already running, decided, or finished says so instead', async (t) => {
  const store = tmpStore(t)
  const todo = store.create({ title: 'call the vendor', author: A, task: true })
  const running = store.start(store.create({ title: 'already going', author: A, task: true }))
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /call the vendor/))

  await b.press('g', ...`${todo.id}`.split(''), '\r')
  await b.until(has(b, /call the vendor/))
  await b.press('s')
  await b.until(has(b, /X\d+ started/))
  assert.equal(store.get(todo.id)!.state, 'in_progress')

  await b.press('g', ...`${running.id}`.split(''), '\r')
  await b.until(has(b, /already going/))
  await b.press('s')
  await b.until(has(b, /is already In progress/))
  assert.equal(store.get(running.id)!.state, 'in_progress')
})

test('App: s on a node still needing a decision refuses, same as nod start', async (t) => {
  const store = tmpStore(t)
  const asking = store.create({ title: 'ship it or not', author: A, options: opt, default: '1' })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /ship it or not/))
  await b.press('s')
  await b.until(has(b, /still waiting on the owner.s decision, can.t start/))
  assert.equal(store.get(asking.id)!.state, 'needs_decision')
})
