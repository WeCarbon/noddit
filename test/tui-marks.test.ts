import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · tui marks test'

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-marks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

const go = (id: number) => ['g', ...`${id}`.split(''), '\r']
const rowOf = (b: { frame: () => string[] }, title: string) => b.frame().find((l) => l.includes(title)) ?? ''

test('TUI marks: space marks rows (• at the start), s starts every marked node and only those, then the marks go', async (t) => {
  const store = tmpStore(t)
  const one = store.create({ title: 'write the notes', author: A, task: true })
  const two = store.create({ title: 'check the links', author: A, task: true })
  const three = store.create({ title: 'leave this alone', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /leave this alone/))

  await b.press(...go(one.id), ' ')
  await b.until(has(b, /1 marked/))
  await b.press(...go(two.id), ' ')
  await b.until(has(b, /2 marked/))
  assert.match(rowOf(b, 'write the notes'), /•/)
  assert.match(rowOf(b, 'check the links'), /•/)
  assert.doesNotMatch(rowOf(b, 'leave this alone'), /•/)

  await b.press('s')
  await b.until(has(b, /Started · 2/))
  assert.equal(store.get(one.id)!.state, 'in_progress')
  assert.equal(store.get(two.id)!.state, 'in_progress')
  assert.equal(store.get(three.id)!.state, 'not_started')
  assert.doesNotMatch(rowOf(b, 'write the notes'), /•/, 'marks clear once the batch ran')
})

test('TUI marks: space again unmarks; Esc clears the marks instead of quitting, and the keys go back to the cursor row', async (t) => {
  const store = tmpStore(t)
  const one = store.create({ title: 'first chore', author: A, task: true })
  const two = store.create({ title: 'second chore', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /second chore/))

  await b.press(...go(one.id), ' ', ' ')
  await b.until(has(b, /Marks cleared/))
  await b.press(' ', ...go(two.id), ' ')
  await b.until(has(b, /2 marked/))
  await b.press('\x1b')
  await b.until(has(b, /Marks cleared/))
  await b.quiet()
  assert.match(b.frame().join('\n'), /second chore/, 'still running')

  await b.press('!')
  await b.quiet()
  assert.equal(store.get(two.id)!.urgency, 'high')
  assert.notEqual(store.get(one.id)!.urgency, 'high', 'no marks left: ! acted on the cursor row alone')
})

test('TUI marks: a node the action does not fit is named, the rest still happen', async (t) => {
  const store = tmpStore(t)
  const task = store.create({ title: 'a plain task', author: A, task: true })
  const asking = store.create({ title: 'ship it or not', author: A, options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], default: '1' })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /ship it or not/))

  await b.press(...go(task.id), ' ', ...go(asking.id), ' ', 's')
  await b.until(has(b, /Started · 1 — not X\d+: /))
  assert.equal(store.get(task.id)!.state, 'in_progress')
  assert.equal(store.get(asking.id)!.state, 'needs_decision')
})

test('TUI marks: d asks once for every marked node, and delays them all', async (t) => {
  const store = tmpStore(t)
  const one = store.create({ title: 'renew the cert', author: A, task: true })
  const two = store.create({ title: 'rotate the keys', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /rotate the keys/))

  await b.press(...go(one.id), ' ', ...go(two.id), ' ', 'd')
  await b.until(has(b, /Delay 2 marked until/))
  await b.press(...'3d'.split(''), '\r')
  await b.until(has(b, /Delayed · 2/))
  assert.ok(store.get(one.id)!.deferredAt)
  assert.ok(store.get(two.id)!.deferredAt)
})

test('TUI marks: A asks why once and archives every marked node — closing open ones, marking decided ones seen', async (t) => {
  const store = tmpStore(t)
  const open = store.create({ title: 'old idea', author: A, task: true })
  const asked = store.create({ title: 'pick a name', author: A, options: [{ key: '1', label: 'Keep' }, { key: '2', label: 'Rename' }], default: '1' })
  store.answer(asked, { choice: '1', by: 'owner', role: 'human' })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /pick a name/))

  await b.press(...go(open.id), ' ', ...go(asked.id), ' ', 'A')
  await b.until(has(b, /Close 2 marked, reason/))
  await b.press(...'dropped'.split(''), '\r')
  await b.until(has(b, /Archived · 2/))
  assert.equal(store.get(open.id)!.state, 'closed')
  assert.equal(store.get(asked.id)!.state, 'completed')
})

test('TUI marks: the help screen lists Space', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'anything', author: A, task: true })
  const b = bench(t, store, { view: 'all', rows: 200 })
  await b.until(has(b, /anything/))
  await b.press('?')
  await b.until(has(b, /Space +marks \/ unmarks the node under the cursor/))
})
