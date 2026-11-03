import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · tui attach test'
const CTRL_A = '\x01'

function tmpStore(t: { after: (fn: () => void) => void }): { store: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'decs-attach-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { store: new Store([initLayout(root)]), root }
}

test('App: Ctrl-A while writing a reply stages a file, shown as 📎N, without losing the draft typed so far', async (t) => {
  const { store, root } = tmpStore(t)
  const d = store.create({ title: 'ship the schema change', author: A, task: true })
  const file = join(root, 'schema.png')
  writeFileSync(file, 'fake png bytes')

  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /ship the schema change/))
  await b.press('n')
  await b.until(has(b, /Reply to/))
  await b.press('see the screenshot')
  await b.press(CTRL_A)
  await b.until(has(b, /Attach files/))
  await b.press(...file.split(''), '\r')
  await b.until(has(b, /📎1/))
  assert.match(b.frame().join('\n'), /see the screenshot/, 'the draft typed before Ctrl-A survived the round trip')

  await b.press('\r') // commits the reply
  await b.until(has(b, /reply added/))
  const after = store.get(d.id)!
  assert.match(after.body, /see the screenshot/)
  assert.equal(after.attachments.length, 1)
  assert.match(after.attachments[0].target, /schema\.png$/)
})

test('App: Esc from the attach prompt returns to the reply draft with nothing staged yet', async (t) => {
  const { store } = tmpStore(t)
  store.create({ title: 'a task', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /a task/))
  await b.press('n')
  await b.until(has(b, /Reply to/))
  await b.press('partial draft')
  await b.press(CTRL_A)
  await b.until(has(b, /Attach files/))
  await b.press('\x1b')
  await b.until(has(b, /Reply to/))
  assert.match(b.frame().join('\n'), /partial draft/)
  assert.ok(!has(b, /📎/)())
})

test('App: a path that does not exist is refused, not staged', async (t) => {
  const { store } = tmpStore(t)
  store.create({ title: 'a task', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /a task/))
  await b.press('n')
  await b.until(has(b, /Reply to/))
  await b.press(CTRL_A)
  await b.until(has(b, /Attach files/))
  await b.press(...'/nonexistent/path/here'.split(''), '\r')
  await b.until(has(b, /Not found, not attached/))
  await b.until(has(b, /Reply to/))
  assert.ok(!has(b, /📎/)())
})

test('App: Esc cancelling the whole reply drops anything staged too', async (t) => {
  const { store, root } = tmpStore(t)
  const d = store.create({ title: 'a task', author: A, task: true })
  const file = join(root, 'note.txt')
  writeFileSync(file, 'hi')
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /a task/))
  await b.press('n')
  await b.until(has(b, /Reply to/))
  await b.press(CTRL_A)
  await b.until(has(b, /Attach files/))
  await b.press(...file.split(''), '\r')
  await b.until(has(b, /📎1/))
  await b.press('\x1b') // cancel the whole reply
  await b.until(() => !has(b, /Reply to/)())
  assert.equal(store.get(d.id)!.attachments.length, 0, 'nothing was ever committed')
})

test('App: Ctrl-A also works while confirming an answer; the file lands with that answer', async (t) => {
  const { store, root } = tmpStore(t)
  const d = store.create({ title: 'ship v1 or wait', author: A, options: [{ key: '1', label: 'ship now' }, { key: '2', label: 'wait' }], default: '1' })
  const file = join(root, 'plan.pdf')
  writeFileSync(file, 'fake pdf bytes')

  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /ship v1 or wait/))
  await b.press('1')
  await b.until(has(b, /Answer X\d+/))
  await b.press(CTRL_A)
  await b.until(has(b, /Attach files/))
  await b.press(...file.split(''), '\r')
  await b.until(has(b, /📎1/))
  await b.press('\r') // commits the answer
  await b.until(has(b, /awaiting an AI/))
  const after = store.get(d.id)!
  assert.equal(after.answer?.choice, '1')
  assert.equal(after.attachments.length, 1)
  assert.match(after.attachments[0].target, /plan\.pdf$/)
})
