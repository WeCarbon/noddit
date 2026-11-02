import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { noteHeading } from '../src/core/serialize.ts'
import { Store } from '../src/core/store.ts'
import { NOTE_KIND } from '../src/core/format.ts'
import { benchJson } from '../src/tui/json.ts'
import { RECENT_OLDER_GROUP, VIEWS, inView, lastTouch, recentRows, suffixOf, viewFromArg } from '../src/tui/views.ts'

const A = 'lane-recent · test'
const opt = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]
const NOW = Date.parse('2026-06-30T12:00:00Z')
const at = (daysAgo: number, hour = 9) => new Date(NOW - daysAgo * 86_400_000 + (hour - 12) * 3_600_000).toISOString().replace(/\.\d+Z$/, '+00:00')

function store(t: { after: (fn: () => void) => void }, names = ['web']): Store {
  const layouts = names.map((n) => {
    const dir = mkdtempSync(join(tmpdir(), `noddit-recent-${n}-`))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    return initLayout(dir)
  })
  return new Store(layouts)
}

const ids = (rows: { node?: { id: number } }[]) => rows.filter((r) => r.node).map((r) => r.node!.id)

test('Recent sits after Waiting and is a valid --view', () => {
  assert.deepEqual(VIEWS, ['available', 'active', 'decide', 'all', 'waiting', 'recent'])
  assert.equal(viewFromArg('recent'), 'recent')
})

test('Recent lists only what the owner touched, latest touch first', (t) => {
  const s = store(t)
  const agentOnly = s.create({ title: 'agent notes only', author: A, task: true })
  s.append(agentOnly, noteHeading(NOTE_KIND.addendum, 'agent', A, at(0, 11)), 'progress')
  const replied = s.create({ title: 'owner replied', author: A, task: true })
  s.append(replied, noteHeading(NOTE_KIND.reply, 'human', 'owner', at(2)), 'please split this')
  const answered = s.create({ title: 'owner answered', author: A, options: opt })
  s.answer(answered, { choice: '2', by: 'owner', role: 'human' })
  const first = s.create({ title: 'touched long ago, then again', author: A, task: true })
  s.append(first, noteHeading(NOTE_KIND.reply, 'human', 'owner', at(9)), 'old')
  s.append(first, noteHeading(NOTE_KIND.reply, 'human', 'owner', at(1)), 'newer')

  const items = s.all()
  assert.equal(inView('recent', items.find((d) => d.id === agentOnly.id)!, items), false)
  // The answer was written just now, so it is the newest.
  assert.deepEqual(ids(recentRows(items, {}, NOW)), [answered.id, first.id, replied.id])
})

test('the row says what the owner did and when; an answer names the option', (t) => {
  const s = store(t)
  const d = s.answer(s.create({ title: 'pick one', author: A, options: opt }), { choice: '2', by: 'owner', role: 'human' })
  const items = s.all()
  const [row] = recentRows(items)
  assert.deepEqual(lastTouch(items[0]), { kind: 'answered', at: lastTouch(items[0])!.at, text: lastTouch(items[0])!.text, choice: '2' })
  const badge = suffixOf(d, items, Date.now(), row)[0].map((x) => x.text).join('')
  assert.match(badge, /^Answered 2 · /)
})

test('finished, archived and deferred nodes stay in Recent', (t) => {
  const s = store(t)
  const done = s.create({ title: 'done after a reply', author: A, task: true })
  s.note(done, { text: 'ship it', role: 'human', author: 'owner' })
  s.complete(s.all().find((d) => d.id === done.id)!, { author: A })
  const parked = s.create({ title: 'put off', author: A, task: true })
  s.defer(parked, { by: 'owner', role: 'human' })
  const byAgent = s.create({ title: 'deferred by an agent', author: A, task: true })
  s.defer(byAgent, { by: A, role: 'agent' })

  const items = s.all()
  assert.ok(items.find((d) => d.id === done.id)!.archived)
  const listed = ids(recentRows(items))
  assert.ok(listed.includes(done.id))
  assert.ok(listed.includes(parked.id))
  assert.ok(!listed.includes(byAgent.id), 'only the owner’s own actions count')
  assert.equal(lastTouch(items.find((d) => d.id === parked.id)!)?.kind, 'deferred')
})

test('touches older than 30 days fold into an "Older N" row', (t) => {
  const s = store(t)
  const fresh = s.create({ title: 'fresh', author: A, task: true })
  s.append(fresh, noteHeading(NOTE_KIND.reply, 'human', 'owner', at(3)), 'x')
  const old = s.create({ title: 'old', author: A, task: true })
  s.append(old, noteHeading(NOTE_KIND.reply, 'human', 'owner', at(45)), 'y')

  const shut = recentRows(s.all(), {}, NOW)
  assert.deepEqual(ids(shut), [fresh.id])
  assert.equal(shut.at(-1)!.key, RECENT_OLDER_GROUP)
  assert.match(shut.at(-1)!.text!, /Older 1/)
  const open = recentRows(s.all(), { openGroups: new Set([RECENT_OLDER_GROUP]) }, NOW)
  assert.deepEqual(ids(open), [fresh.id, old.id])
})

test('bench --json carries Recent across projects, with what the owner did', (t) => {
  const s = store(t, ['web', 'api'])
  const [web, api] = s.layouts
  const w = s.create({ title: 'web node', author: A, task: true }, web)
  s.note(w, { text: 'looks good, but rename the button', role: 'human', author: 'owner' })
  const a = s.create({ title: 'api node', author: A, options: opt }, api)
  s.answer(a, { choice: '1', by: 'owner', role: 'human' })

  const json = benchJson(s) as { views: { view: string; rows: Record<string, unknown>[] }[] }
  const recent = json.views.find((v) => v.view === 'recent')!
  assert.equal(recent.rows.length, 2)
  const reply = recent.rows.find((r) => r.title === 'web node')!
  assert.deepEqual((reply.touch as Record<string, unknown>).kind, 'replied')
  assert.equal((reply.touch as Record<string, unknown>).text, 'looks good, but rename the button')
  assert.match((reply.touch as Record<string, unknown>).label as string, /^Replied$/)
})
