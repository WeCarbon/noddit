import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { rowsFor, type Row } from '../src/tui/views.ts'
import { decs, scratch } from './helpers.ts'
import { bench, KEY } from './tui-harness.ts'

function project(t: { after: (fn: () => void) => void }) {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  return { root, store }
}

const ids = (rows: Row[], depth = 0) => rows.filter((r) => r.kind === 'node' && r.depth === depth).map((r) => r.node!.id)

test('nod order puts nodes in that order above the ones never moved; --clear gives a node back to the view', (t) => {
  const { root, store } = project(t)
  for (const title of ['Alpha', 'Bravo', 'Charlie', 'Delta']) store.create({ title, author: 'a', task: true })
  decs(root, ['order', '3', '1'])
  assert.deepEqual(ids(rowsFor('all', store.all())), [3, 1, 2, 4])
  assert.match(readFileSync(store.get(3)!.file, 'utf8'), /^order: -2$/m)
  decs(root, ['order', '3', '--clear'])
  assert.deepEqual(ids(rowsFor('all', store.all())), [1, 2, 3, 4])
  assert.doesNotMatch(readFileSync(store.get(3)!.file, 'utf8'), /^order:/m)
})

test('the order counts among siblings: a child moves under its own parent only', (t) => {
  const { root, store } = project(t)
  const parent = store.create({ title: 'Parent', author: 'a', task: true })
  for (const title of ['One', 'Two', 'Three']) store.create({ title, author: 'a', task: true, parent: String(parent.id) })
  decs(root, ['order', '4', '2'])
  const rows = rowsFor('all', store.all())
  assert.deepEqual(ids(rows, 1), [4, 2, 3])
  const scopes = new Set(rows.filter((r) => r.depth === 1).map((r) => r.scope))
  assert.equal(scopes.size, 1, 'siblings share one scope')
  assert.notEqual(rows.find((r) => r.node?.id === 1)!.scope, [...scopes][0], 'the parent is in another')
})

test('a pin from before manual order still sorts, and the next write turns it into order', (t) => {
  const { root, store } = project(t)
  for (const title of ['Alpha', 'Bravo', 'Charlie']) store.create({ title, author: 'a', task: true })
  const top = store.get(3)!.file
  writeFileSync(top, readFileSync(top, 'utf8').replace(/^title: .*$/m, (l) => `${l}\npin: top\npinned_at: 2026-10-01T10:00:00+08:00`))
  const bottom = store.get(1)!.file
  writeFileSync(bottom, readFileSync(bottom, 'utf8').replace(/^title: .*$/m, (l) => `${l}\npin: bottom`))
  assert.deepEqual(ids(rowsFor('all', store.all())), [3, 2, 1])
  decs(root, ['note', '3', 'still first', '--agent'])
  const text = readFileSync(top, 'utf8')
  assert.match(text, /^order: -1$/m)
  assert.doesNotMatch(text, /^pin(ned_at)?:/m)
})

test('a list keeps what it sorts by first; the order decides within a band, and a date-sorted list has no scope', (t) => {
  const { store } = project(t)
  const ask = (title: string) => store.create({ title, author: 'a', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] })
  const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map(ask)
  store.flag(c, { important: true })
  store.arrange([store.get(b.id)!, store.get(a.id)!, store.get(c.id)!])
  const decide = rowsFor('decide', store.all()).filter((r) => r.kind === 'node')
  assert.deepEqual(decide.map((r) => r.node!.id), [c.id, b.id, a.id], '★ still leads; by hand below it')
  assert.notEqual(decide[0].scope, decide[1].scope, '★ and the rest are separate bands')
  assert.equal(decide[1].scope, decide[2].scope)
  store.note(store.get(a.id)!, { text: 'seen', role: 'human', author: 'owner' })
  assert.ok(rowsFor('recent', store.all()).filter((r) => r.kind === 'node').every((r) => r.scope === undefined))
})

test('nod bench --json gives each row its scope; nodes no longer carry can_pin', (t) => {
  const { root, store } = project(t)
  for (const title of ['Alpha', 'Bravo']) store.create({ title, author: 'a', task: true })
  const json = JSON.parse(decs(root, ['bench', '--json', '--dir', root]))
  const all = json.views.find((v: { view: string }) => v.view === 'all')
  const rows = all.rows.filter((r: { kind: string }) => r.kind === 'node')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r: { scope: string | null }) => typeof r.scope === 'string' && r.scope === rows[0].scope))
  const recent = json.views.find((v: { view: string }) => v.view === 'recent')
  assert.ok(recent.rows.every((r: { scope?: string | null }) => !r.scope))
  assert.ok(Object.values(json.nodes).every((n) => !('can_pin' in (n as object))))
})

test('bench: M, then ↓, moves the node below its neighbour and writes it; ⏎ leaves move mode', async (t) => {
  const { store } = project(t)
  for (const title of ['Alpha', 'Bravo', 'Charlie']) store.create({ title, author: 'a', task: true })
  const b = bench(t, store, { view: 'all' })
  await b.until(() => b.frame().some((l) => l.includes('Alpha')))
  await b.press('M')
  await b.until(() => b.frame().join('\n').includes('↑/↓'))
  await b.press(KEY.down)
  await b.until(() => ids(rowsFor('all', store.all())).join() === '2,1,3')
  await b.press('\r')
  await b.press(KEY.down)
  await b.quiet()
  assert.deepEqual(ids(rowsFor('all', store.all())), [2, 1, 3], 'after ⏎ the arrows move the cursor again')
})
