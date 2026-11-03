import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { noteHeading } from '../src/core/serialize.ts'
import { Store } from '../src/core/store.ts'
import { NOTE_KIND } from '../src/core/format.ts'
import { loadViews, validateView } from '../src/core/view-defs.ts'
import { benchJson } from '../src/tui/json.ts'
import { bench, has } from './tui-harness.ts'
import { RECENT_OLDER_GROUP, VIEWS, inView, lastChange, rowsFor, suffixOf, viewFromArg } from '../src/tui/views.ts'
import { decs, scratch } from './helpers.ts'

const A = 'lane-live · test'
const opt = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]
const NOW = Date.parse('2026-06-30T12:00:00Z')
const at = (daysAgo: number, hour = 9) => new Date(NOW - daysAgo * 86_400_000 + (hour - 12) * 3_600_000).toISOString().replace(/\.\d+Z$/, '+00:00')

function store(t: { after: (fn: () => void) => void }, names = ['web']): Store {
  const layouts = names.map((n) => {
    const dir = mkdtempSync(join(tmpdir(), `noddit-live-${n}-`))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    return initLayout(dir)
  })
  return new Store(layouts)
}

const ids = (rows: { node?: { id: number } }[]) => rows.filter((r) => r.node).map((r) => r.node!.id)
/** Backdates a node's last write: what `updated_at` would say if it was written then. */
const writtenAt = (s: Store, id: number, iso: string) => {
  const d = s.get(id)!
  writeFileSync(d.file, readFileSync(d.file, 'utf8').replace(/^updated_at: .*$/m, `updated_at: ${iso}`))
}

test('Live sits after Waiting; recent still names it', () => {
  assert.deepEqual(VIEWS, ['available', 'active', 'decide', 'waiting', 'live', 'all'])
  assert.equal(viewFromArg('live'), 'live')
  assert.equal(viewFromArg('recent'), 'live')
})

test('Live lists every node that changed, by anyone, newest write first', (t) => {
  const s = store(t)
  const agentOnly = s.create({ title: 'agent notes only', author: A, task: true })
  s.note(agentOnly, { text: 'halfway there', role: 'agent', author: A })
  const answered = s.create({ title: 'owner answered', author: A, options: opt })
  s.answer(answered, { choice: '2', by: 'owner', role: 'human' })
  const quiet = s.create({ title: 'nobody touched it since', author: A, task: true })
  writtenAt(s, quiet.id, at(3))
  writtenAt(s, answered.id, at(1))
  const items = s.all()
  assert.ok(inView('live', items.find((d) => d.id === agentOnly.id)!, items), 'an agent’s write counts')
  assert.deepEqual(ids(rowsFor('live', items, {}, NOW)), [agentOnly.id, answered.id, quiet.id])
})

test('the row says what changed and when: a reply, progress, an answer, a state', (t) => {
  const s = store(t)
  const r = s.create({ title: 'replied', author: A, task: true })
  s.note(r, { text: 'please split this', role: 'human', author: 'owner' })
  const p = s.create({ title: 'running', author: A, task: true })
  s.start(p)
  s.progress(s.get(p.id)!, { progress: 62, progressMsg: 'migrating' })
  const a = s.answer(s.create({ title: 'pick one', author: A, options: opt }), { choice: '1', by: 'owner', role: 'human' })
  const items = s.all()
  const of = (id: number) => lastChange(items.find((d) => d.id === id)!)
  assert.equal(of(r.id).kind, 'replied')
  assert.equal(of(r.id).text, 'please split this')
  assert.deepEqual([of(p.id).kind, of(p.id).pct], ['progress', 62])
  assert.deepEqual([of(a.id).kind, of(a.id).choice], ['answered', '1'])
  const row = rowsFor('live', items).find((x) => x.node?.id === p.id)!
  assert.match(suffixOf(row.node!, items, Date.now(), row)[0].map((x) => x.text).join(''), /^Progress 62% · /)
  const arow = rowsFor('live', items).find((x) => x.node?.id === a.id)!
  assert.match(suffixOf(arow.node!, items, Date.now(), arow)[0].map((x) => x.text).join(''), /^Picked 1 · /)
})

test('finished, archived and deferred nodes stay in Live; writes older than 30 days fold into "Older N"', (t) => {
  const s = store(t)
  const done = s.create({ title: 'done', author: A, task: true })
  s.complete(done, { author: A })
  const parked = s.create({ title: 'put off', author: A, task: true })
  s.defer(parked, { by: 'owner', role: 'human' })
  const old = s.create({ title: 'old', author: A, task: true })
  writtenAt(s, old.id, at(45))
  const items = s.all()
  assert.ok(items.find((d) => d.id === done.id)!.archived)
  const shut = rowsFor('live', items, {}, NOW + 0)
  const listed = ids(shut)
  assert.ok(listed.includes(done.id) && listed.includes(parked.id))
  assert.ok(!listed.includes(old.id))
  assert.equal(shut.at(-1)!.key, RECENT_OLDER_GROUP)
  assert.ok(ids(rowsFor('live', items, { openGroups: new Set([RECENT_OLDER_GROUP]) }, NOW)).includes(old.id))
})

test('bench --json carries Live across projects, with what changed', (t) => {
  const s = store(t, ['web', 'api'])
  const [web, api] = s.layouts
  const w = s.create({ title: 'web node', author: A, task: true }, web)
  s.note(w, { text: 'looks good, but rename the button', role: 'human', author: 'owner' })
  s.create({ title: 'api node', author: A, options: opt }, api)
  const json = benchJson(s) as { views: { view: string; rows: Record<string, unknown>[] }[] }
  const live = json.views.find((v) => v.view === 'live')!
  assert.equal(live.rows.length, 2)
  const reply = live.rows.find((r) => r.title === 'web node')!
  assert.equal((reply.touch as Record<string, unknown>).kind, 'replied')
  assert.equal((reply.touch as Record<string, unknown>).label, 'Reply')
})

test('a views.json that still holds 最近 as shipped gets 实时; nod view show recent answers for it', (t) => {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(home, { recursive: true })
  const file = join(home, 'views.json')
  writeFileSync(file, JSON.stringify({ views: [{ id: 'available', layout: 'tree' }, { id: 'recent', layout: 'list', sort: ['touched'], filter: 'is:touched', window: { days: 30 } }] }))
  assert.deepEqual(loadViews(file).map((v) => [v.id, v.sort]), [['available', undefined], ['live', ['changed']]])
  assert.equal(validateView({ id: 'recent', name: 'Mine', sort: ['touched'] }).id, 'live', 'an edited one keeps its edits under the new id')
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const shown = JSON.parse(decs(root, ['view', 'show', 'recent', '--json'], { NODDIT_HOME: home }))
  assert.equal(shown.id, 'live')
})

test('App: h jumps to Live and back', async (t) => {
  const s = store(t)
  s.note(s.create({ title: 'changed node', author: A, task: true }), { text: 'x', role: 'agent', author: A })
  const b = bench(t, s, { view: 'all' })
  await b.until(has(b, /changed node/))
  await b.press('h')
  await b.until(has(b, /Live/))
})
