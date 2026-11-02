import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { decs, decsResult, scratch } from './helpers.ts'

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'Publish the reference', '--task'])
  decs(root, ['add', 'Migrate the webhooks', '--task'])
  return root
}

const get = (root: string, id: number) => JSON.parse(decs(root, ['get', String(id), '--json'])) as Record<string, unknown>

/** The check-back day passes, written straight into the file as time would. */
function passTheDay(root: string, id: number) {
  const file = String(get(root, id).file)
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^waiting_until: .*$/m, 'waiting_until: 2020-01-01T00:00:00+00:00'))
}

test('hold needs a day to check back; --until alone moves it on a waiting node', (t) => {
  const root = project(t)
  const r = decsResult(root, ['hold', '1', '--on', 'Carol'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--until <date>: the day to check back/)
  assert.match(decs(root, ['hold', '1', '--on', 'Carol', '--until', '2030-01-15']), /waiting on Carol · check back/)
  assert.match(String(get(root, 1).waiting_until), /^2030-01-15T00:00:00/)
  decs(root, ['hold', '1', '--until', '2030-02-01'])
  const d = get(root, 1)
  assert.match(String(d.waiting_until), /^2030-02-01/)
  assert.equal(d.waiting_on, 'Carol')
  assert.equal(d.wait_due, false)
})

test('a wait whose day has come is due: first in Waiting and counted apart', (t) => {
  const root = project(t)
  decs(root, ['hold', '1', '--on', 'Carol', '--until', '2030-01-15'])
  decs(root, ['hold', '2', '--on', 'the vendor', '--until', '2030-01-15'])
  passTheDay(root, 2)
  const bench = JSON.parse(decs(root, ['bench', '--json', root])) as { views: { view: string; due_count: number; count: number; rows: { ref: string; wait_due: boolean }[] }[] }
  const waiting = bench.views.find((v) => v.view === 'waiting')!
  assert.equal(waiting.due_count, 1)
  assert.equal(waiting.count, 2)
  assert.deepEqual(waiting.rows.map((r) => [r.ref, r.wait_due]), [['X2', true], ['X1', false]])
})

test('the reminder is written once per hold; a new day starts over', (t) => {
  const root = project(t)
  decs(root, ['hold', '2', '--on', 'the vendor', '--until', '2030-01-15'])
  passTheDay(root, 2)
  const store = new Store([initLayout(root)])
  assert.equal(store.remindDueWaits().length, 1)
  assert.equal(store.remindDueWaits().length, 0, 'once')
  assert.match(String(get(root, 2).body), /到了回来看的日子：问问 the vendor。/)
  decs(root, ['hold', '2', '--until', '2030-03-01'])
  passTheDay(root, 2)
  assert.equal(new Store([initLayout(root)]).remindDueWaits().length, 1, 'a moved day reminds again')
})

test('a node waiting from before check-back days counts as due', (t) => {
  const root = project(t)
  decs(root, ['hold', '1', '--on', 'Carol', '--until', '2030-01-15'])
  const file = String(get(root, 1).file)
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^waiting_until: .*\n/m, ''))
  assert.equal(get(root, 1).wait_due, true)
})
