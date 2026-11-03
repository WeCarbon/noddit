import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { benchOrder } from '../src/core/order.ts'
import { milestoneDue } from '../src/cli/commands/flag.ts'
import { nodeRowSegments, rowsFor } from '../src/tui/views.ts'
import { decs, decsResult, scratch } from './helpers.ts'

const owner = { CLAUDECODE: undefined, DECS_ROLE: 'human' }
const json = (out: string) => JSON.parse(out) as Record<string, unknown> & { notes: { text: string; role: string }[] }

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'Ship the release', '--task'])
  return root
}

test('the owner marks a node important; normal takes it off again', (t) => {
  const root = project(t)
  assert.match(decs(root, ['flag', '1', 'important'], owner), /X1 important/)
  const d = json(decs(root, ['get', '1', '--json']))
  assert.equal(d.important, true)
  assert.equal(d.urgency, 'high')
  decs(root, ['flag', '1', 'normal'], owner)
  assert.equal(json(decs(root, ['get', '1', '--json'])).important, false)
})

test('a milestone needs a date and keeps it; a date alone means the end of that day', (t) => {
  const root = project(t)
  const r = decsResult(root, ['flag', '1', 'milestone'], owner)
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /needs a date/)
  decs(root, ['flag', '1', 'milestone', '--due', '2026-11-15'], owner)
  const d = json(decs(root, ['get', '1', '--json']))
  assert.equal(d.milestone, true)
  assert.match(String(d.due), /^2026-11-15T23:59:59/)
  const file = readFileSync(String(d.file), 'utf8')
  assert.match(file, /^milestone: true$/m)
  decs(root, ['flag', '1', 'off'], owner)
  assert.doesNotMatch(readFileSync(String(d.file), 'utf8'), /^milestone:/m)
})

test('an agent only proposes: a note for the owner, nothing changed — unless --force', (t) => {
  const root = project(t)
  assert.match(decs(root, ['flag', '1', 'important']), /proposed to the owner/)
  const d = json(decs(root, ['get', '1', '--json']))
  assert.equal(d.important, false)
  assert.ok(d.notes.some((n) => n.role === 'agent' && /Proposed: mark this important/.test(n.text)))
  decs(root, ['flag', '1', 'important', '--force'])
  assert.equal(json(decs(root, ['get', '1', '--json'])).important, true)
})

test('flagged nodes sort first: important or a milestone before normal, the nearer date first', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const A = 'lane · test'
  const plain = store.create({ title: 'plain', author: A, task: true })
  const later = store.flag(store.create({ title: 'milestone later', author: A, task: true }), { milestone: true, due: '2026-12-01T18:00:00+08:00' })
  const soon = store.flag(store.create({ title: 'milestone soon', author: A, task: true }), { milestone: true, due: '2026-11-10T18:00:00+08:00' })
  const important = store.flag(store.create({ title: 'important', author: A, task: true }), { important: true })
  const order = [plain, later, soon, important].sort(benchOrder).map((d) => d.title)
  assert.deepEqual(order, ['milestone soon', 'milestone later', 'important', 'plain'])
})

test('bench: ★ after the ref, flagged siblings first — a milestone still sorts first but N250 dropped its ⚑', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const A = 'lane · test'
  const now = Date.parse('2026-11-01T12:00:00+08:00')
  const P = store.start(store.create({ title: 'parent', author: A, task: true }))
  store.create({ title: 'plain child', author: A, task: true, parent: `${P.id}` })
  store.flag(store.create({ title: 'important child', author: A, task: true, parent: `${P.id}` }), { important: true })
  store.flag(store.create({ title: 'milestone child', author: A, task: true, parent: `${P.id}` }), { milestone: true, due: '2026-11-04T12:00:00+08:00' })
  const items = store.all()
  const rows = rowsFor('all', items)
  assert.deepEqual(rows.filter((r) => r.node).map((r) => r.node!.title).slice(1), ['important child', 'milestone child', 'plain child'], 'a milestone still sorts ahead of a plain node')
  const line = (title: string, at = now) => nodeRowSegments(rows.find((r) => r.node?.title === title)!, items, 110, at).map((s) => s.text).join('')
  assert.match(line('important child'), /X3 ★ important child/)
  assert.doesNotMatch(line('milestone child'), /[★⚑]/, 'the milestone data is read (it still sorted first above), just not shown as a flag')
  assert.doesNotMatch(line('plain child'), /[★⚑]/)
  assert.doesNotMatch(line('milestone child', Date.parse('2026-11-05T12:00:00+08:00')), /⚑/, 'even overdue, no countdown shows')
})

test('milestoneDue reads a date, a time or a span', () => {
  assert.match(milestoneDue('2026-11-15'), /^2026-11-15T23:59:59[+-]\d\d:\d\d$/)
  assert.equal(milestoneDue('2026-11-15T09:00:00+08:00'), '2026-11-15T09:00:00+08:00')
  const in3d = Date.parse(milestoneDue('3d', new Date('2026-11-01T00:00:00Z')))
  assert.equal(in3d, Date.parse('2026-11-04T00:00:00Z'))
})

test('a brief can be filed as important (what ⌘K in the window does)', (t) => {
  const root = project(t)
  const d = json(decs(root, ['add', 'Export orders as CSV', '--brief', '--urgency', 'high', '--json'], owner))
  assert.equal(d.important, true)
  assert.equal(d.intake, true)
})

test('nod show flagged lists what the owner marked, nothing else', (t) => {
  const root = project(t)
  decs(root, ['add', 'Unmarked', '--task'])
  decs(root, ['add', 'Launch day', '--task'])
  decs(root, ['flag', '1', 'important'], owner)
  decs(root, ['flag', '3', 'milestone', '--due', '3d'], owner)
  const list = JSON.parse(decs(root, ['show', 'flagged', '--json'])) as { title: string }[]
  assert.deepEqual(list.map((d) => d.title).sort(), ['Launch day', 'Ship the release'])
})
