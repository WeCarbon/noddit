import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · goto title test'

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-goto-title-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

/** Whether the right pane (what the cursor is on) mentions `re`. */
const right = (b: { frame: () => string[] }, re: RegExp) => () => b.frame().some((l) => re.test(l.split('│').slice(1).join('│')))

test('App: g/: on text that is not a ref falls back to a title match, same as the app palette', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'call the vendor about the invoice', author: A, task: true })
  store.create({ title: 'write the release notes', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /call the vendor/))

  await b.press('g', ...'vendor'.split(''), '\r')
  await b.until(right(b, /call the vendor about the invoice/))
})

test('App: a title match that fits more than one node lands on one and says the others too', async (t) => {
  const store = tmpStore(t)
  const first = store.create({ title: 'ship v1', author: A, task: true })
  store.create({ title: 'ship v2', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /ship v1/))

  await b.press('g', ...'ship'.split(''), '\r')
  await b.until(right(b, new RegExp(`ship v${first.id === 1 ? 1 : 2}`)))
  await b.until(has(b, /Also matches/))
})

test('App: g on text matching nothing says not found, exactly as a bad ref does', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'write the release notes', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /write the release notes/))
  await b.press('g', ...'nonexistent'.split(''), '\r')
  await b.until(has(b, /nonexistent not found/))
})

test('App: a ref that resolves still wins outright, with no title fallback', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'vendor call', author: A, task: true })
  const target = store.create({ title: 'the real target', author: A, task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /vendor call/))
  await b.press('g', ...`${target.id}`.split(''), '\r')
  await b.until(right(b, /the real target/))
  assert.ok(!has(b, /Also matches/)())
})
