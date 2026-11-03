import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { estMinutes, estimateTotal, fmtMinutes } from '../src/core/estimate.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { estimateMark } from '../src/tui/views.ts'
import { decs, scratch } from './helpers.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lane-est · test'

function tmpStore(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'decs-est-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

test('estimates read the shapes people write, and print back short', () => {
  assert.deepEqual(['2h', '30m', '1h30m', '1h 30m', '1.5h', '0.5 人日', '1d', '45', '2小时'].map(estMinutes), [120, 30, 90, 90, 90, 240, 480, 45, 120])
  assert.deepEqual(['soon', '', undefined, '2 days of work'].map(estMinutes), [undefined, undefined, undefined, undefined])
  assert.deepEqual([90, 30, 120].map(fmtMinutes), ['1h30m', '30m', '2h'])
})

test('est is the assignee\'s time: a to-do for the owner counts as theirs, the rest as AI time; a parent totals what is still ahead', (t) => {
  const store = tmpStore(t)
  const plan = store.create({ title: 'plan phase 2', author: A, task: true, assignee: 'human', est: '1h' })
  store.create({ title: 'talk it through', author: A, task: true, assignee: 'human', est: '30m', parent: String(plan.id) })
  store.create({ title: 'polish code and docs', author: A, task: true, est: '2h', parent: String(plan.id) })
  const done = store.create({ title: 'already done', author: A, task: true, est: '5h', parent: String(plan.id) })
  store.complete(store.start(done))
  const items = store.all()
  const get = (id: number) => items.find((i) => i.id === id)!
  assert.deepEqual(estimateTotal(get(plan.id), items), { human: 90, ai: 120 }, 'finished work counts nothing')
  assert.equal(estimateMark(get(plan.id), items)!.text, 'you 1h30m · AI 2h')
  assert.equal(estimateMark(get(plan.id + 2), items)!.text, 'AI 2h')
})

test('nod edit --est sets it; get --json says whose time it is', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', '--task', 'review the contract', '--for', 'me'])
  decs(root, ['edit', '1', '--est', '2h'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.deepEqual([d.est, d.est_minutes, d.est_who], ['2h', 120, 'human'])
  decs(root, ['edit', '1', '--est', 'off'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).est, null)
})

test('App: a row shows whose time its estimate is', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'a train the team', author: A, task: true, assignee: 'human', est: '1h' })
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /a train the team/))
  await b.until(has(b, /you 1h/))
})
