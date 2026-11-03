import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { everyUntil, parseEvery } from '../src/core/fuzzy-date.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { decs, decsResult, scratch } from './helpers.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lane-every · test'

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  return root
}

const get = (root: string, id: number) => JSON.parse(decs(root, ['get', String(id), '--json'])) as Record<string, any>
const startOfDayIn = (days: number) => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days).getTime()
}

test('R reads as whole days or weeks, and 「delay R days」 lands on the start of the day R after today', () => {
  assert.deepEqual(['3d', '3', '3 days', '3天', '2w', '2周', '1 week'].map(parseEvery), ['3d', '3d', '3d', '3d', '2w', '2w', '1w'])
  assert.deepEqual(['0', 'soon', '3h', ''].map(parseEvery), [undefined, undefined, undefined, undefined])
  const now = new Date(2026, 10, 3, 15, 30)
  assert.equal(everyUntil('3d', now).getTime(), new Date(2026, 10, 6).getTime())
  assert.equal(everyUntil('1w', now).getTime(), new Date(2026, 10, 10).getTime())
})

test('nod add --every stores R; nod defer --every puts it off to today + R; a wait keeps its who and moves its day', (t) => {
  const root = project(t)
  decs(root, ['add', '--task', 'chase Lee on the KYC', '--every', '3 days'])
  const d = get(root, 1)
  assert.equal(d.every, '3d')
  assert.match(readFileSync(String(d.file), 'utf8'), /^every: 3d$/m)

  assert.match(decs(root, ['defer', '1', '--every', '--human']), /deferred until/)
  const passive = get(root, 1)
  assert.equal(passive.delay.kind, 'passive')
  assert.equal(Date.parse(passive.deferred_until), startOfDayIn(3))

  decs(root, ['defer', '1', '--off'])
  decs(root, ['hold', '1', '--on', 'Lee', '--until', 'tomorrow'])
  decs(root, ['defer', '1', '--every', '--human'])
  const active = get(root, 1)
  assert.equal(active.status, 'waiting')
  assert.equal(active.waiting_on, 'Lee')
  assert.equal(Date.parse(active.waiting_until), startOfDayIn(3))

  decs(root, ['defer', '1', '--every', '5d', '--human'])
  assert.equal(Date.parse(get(root, 1).waiting_until), startOfDayIn(5), '--every <span> this once')
  assert.equal(get(root, 1).every, '3d', 'and the node keeps its own R')
})

test('nod edit --every sets and clears R; bad or missing R says so', (t) => {
  const root = project(t)
  decs(root, ['add', '--task', 'follow up with Bob'])
  assert.notEqual(decsResult(root, ['defer', '1', '--every', '--human']).code, 0, 'no R yet')
  assert.match(decsResult(root, ['defer', '1', '--every', '--human']).stderr, /has no R/)
  decs(root, ['edit', '1', '--every', '2w'])
  assert.equal(get(root, 1).every, '2w')
  decs(root, ['edit', '1', '--every', 'off'])
  assert.equal(get(root, 1).every, null)
  assert.notEqual(decsResult(root, ['add', '--task', 'x', '--every', 'soon']).code, 0)
  assert.notEqual(decsResult(root, ['defer', '1', '--every', '3d', '--until', 'fri']).code, 0)
})

test('App: D delays to today + R; without R it says how to set one', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-every-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const a = store.create({ title: 'a chase Carol', author: A, task: true, every: '3d' })
  store.create({ title: 'b no R', author: A, task: true })
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /a chase Carol/))
  await b.until(has(b, /↻ every 3d/))
  await b.press('D')
  await b.until(has(b, new RegExp(`X${a.id} delayed until`)))
  assert.equal(Date.parse(store.get(a.id)!.deferredUntil!), startOfDayIn(3))
})
