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
  await b.until(has(b, /still has options waiting on the owner/))
  assert.equal(store.get(asking.id)!.state, 'needs_decision')
})

test('App: @ flips who does it — a to-do for you hands to an AI as a reply (queued); an AI’s own node becomes your to-do', async (t) => {
  const store = tmpStore(t)
  const todo = store.create({ title: 'call the vendor', author: A, task: true, assignee: 'human' })
  const aiTask = store.create({ title: 'run the gate', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /call the vendor/))

  await b.press('g', ...`${todo.id}`.split(''), '\r')
  await b.until(has(b, /call the vendor/))
  await b.press('@')
  await b.until(has(b, /X\d+ is an AI.s now/))
  const handed = store.get(todo.id)!
  assert.equal(handed.assignee, undefined)
  assert.equal(handed.queued, true)
  assert.match(handed.body, /交给 AI 了/, 'the note body is file-format content, always written in Chinese')

  await b.press('g', ...`${aiTask.id}`.split(''), '\r')
  await b.until(has(b, /run the gate/))
  await b.press('@')
  await b.until(has(b, /X\d+ is yours now/))
  assert.equal(store.get(aiTask.id)!.assignee, 'human')
})
