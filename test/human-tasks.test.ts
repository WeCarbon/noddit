import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { askIfDue, staleNagDue, staleTasksOf } from '../src/core/checkins.ts'
import { initLayout } from '../src/core/paths.ts'
import { stalenessOf } from '../src/core/staleness.ts'
import { isDeferred } from '../src/core/status.ts'
import { DEFERRAL_CLOCK, nowStamp, Store } from '../src/core/store.ts'
import { isUnclaimedBrief } from '../src/core/intake.ts'
import { benchJson } from '../src/tui/json.ts'
import { inView, nodeRowSegments, ownerQueue, rowsFor, suffixOf, viewFromArg } from '../src/tui/views.ts'
import { bench, has } from './tui-harness.ts'
import { decs, decsResult, scratch } from './helpers.ts'

const owner = { CLAUDECODE: undefined, DECS_ROLE: 'human' }
const A = 'lead · human tasks'
type Json = Record<string, unknown> & { notes: { text: string; role: string; author: string }[] }
const json = (out: string) => JSON.parse(out) as Json

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  return root
}

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-human-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')

test('the owner adds a to-do of their own: a task for a person, not a brief, stored as assignee: human', (t) => {
  const root = project(t)
  const d = json(decs(root, ['add', 'Call the vendor', '--for', 'me', '--json'], owner))
  assert.equal(d.assignee, 'human')
  assert.equal(d.human_task, true)
  assert.equal(d.status, 'not_started')
  assert.equal(d.intake, false, 'not a brief for an AI')
  assert.equal(d.author, 'owner')
  assert.match(readFileSync(String(d.file), 'utf8'), /^assignee: human$/m)
  const plain = json(decs(root, ['add', 'Write the tests', '--task', '--json']))
  assert.equal(plain.assignee, 'ai')
  assert.doesNotMatch(readFileSync(String(plain.file), 'utf8'), /^assignee:/m, 'the default is never written')
})

test('--human-task is the same; --for me does not mix with options or --brief', (t) => {
  const root = project(t)
  assert.equal(json(decs(root, ['add', 'Sign the lease', '--human-task', '--json'], owner)).human_task, true)
  const r = decsResult(root, ['add', 'Pick one', '--for', 'me', '-o', '1=a', '2=b'], owner)
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /to-do for you/)
  assert.notEqual(decsResult(root, ['add', 'Huh', '--for', 'someone'], owner).code, 0)
})

test('an agent may file a to-do for the owner, but never starts or claims it without --force', (t) => {
  const root = project(t)
  const d = json(decs(root, ['add', 'Call the vendor', '--for', 'me', '--json']))
  assert.equal(d.author, 'cli-test · lane')
  assert.equal(d.human_task, true)
  const start = decsResult(root, ['start', '1'])
  assert.notEqual(start.code, 0)
  assert.match(start.stderr, /owner's own to-do/)
  const claim = decsResult(root, ['claim', '1'])
  assert.notEqual(claim.code, 0)
  assert.match(claim.stderr, /not a brief/)
  assert.match(decs(root, ['start', '1'], owner), /In progress/, 'the owner starts their own')
})

test('nod assign: an agent hands the owner a task, but taking one back for an AI is the owner\'s call', (t) => {
  const root = project(t)
  decs(root, ['add', 'Renew the domain', '--task'])
  assert.match(decs(root, ['assign', '1', 'me']), /yours now/)
  assert.equal(json(decs(root, ['get', '1', '--json'])).assignee, 'human')
  const back = decsResult(root, ['assign', '1', 'ai'])
  assert.notEqual(back.code, 0)
  assert.match(back.stderr, /only when the owner says so/)
  assert.match(decs(root, ['assign', '1', 'ai'], owner), /for an AI now/)
  assert.equal(json(decs(root, ['get', '1', '--json'])).assignee, 'ai')
})

test('a to-do for the owner is never checked in on, nagged about as stale, or offered as a brief', (t) => {
  const store = tmpStore(t)
  const mine = store.create({ title: 'Call the vendor', author: 'owner', task: true, assignee: 'human' })
  const ai = store.create({ title: 'Write the tests', author: A, task: true })
  const old = Date.now() + 10 * 86_400_000
  assert.equal(staleNagDue(store.primary, mine, old), undefined)
  assert.ok(staleNagDue(store.primary, ai, old), 'the AI task is nagged')
  assert.deepEqual(staleTasksOf(store.all()).map((d) => d.id), [ai.id])
  const running = store.start(mine)
  assert.equal(askIfDue(store.primary, running, old), undefined)
  assert.equal(stalenessOf(running, old), 'fresh')
  assert.equal(isUnclaimedBrief({ ...running, intake: true }), false)
})

test('Needs you lists decisions and the owner\'s startable to-dos; AI-blocking first, then ★/⚑, then the rest', (t) => {
  const store = tmpStore(t)
  const early = store.create({ title: 'Early question', author: A, options: [{ key: '1', label: 'a' }, { key: '2', label: 'b' }], after: ['99'] })
  const todo = store.create({ title: 'Plain to-do', author: 'owner', task: true, assignee: 'human' })
  const starred = store.flag(store.create({ title: 'Starred to-do', author: 'owner', task: true, assignee: 'human' }), { important: true })
  const gate = store.create({ title: 'Grant API access', author: 'owner', task: true, assignee: 'human' })
  store.create({ title: 'Deploy', author: A, task: true, after: [String(gate.id)] })
  const stuck = store.create({ title: 'Stuck question', author: A, options: [{ key: '1', label: 'a' }, { key: '2', label: 'b' }] })
  const later = store.create({ title: 'Later to-do', author: 'owner', task: true, assignee: 'human', after: [String(stuck.id)] })
  store.create({ title: 'AI work', author: A, task: true })
  const items = store.all()
  const ids = ownerQueue(items).map((d) => d.id)
  assert.deepEqual(ids.slice(0, 2).sort(), [gate.id, stuck.id].sort(), 'what holds an AI up comes first')
  assert.equal(ids[2], starred.id, 'then the flagged')
  assert.deepEqual(ids.slice(3).sort(), [early.id, todo.id].sort(), 'then the rest')
  assert.ok(!ids.includes(later.id), 'a to-do still waiting on other work is not listed yet')
  assert.ok(inView('available', items.find((d) => d.id === todo.id)!, items), 'it is live work in Available too')
  const rows = rowsFor('decide', items)
  assert.match(rows[0].text ?? '', /Needs you 5/)
  const todoRow = rows.find((r) => r.node?.id === todo.id)!
  assert.match(text(nodeRowSegments(todoRow, items, 80, Date.now())), /For you/)
  const decisionRow = rows.find((r) => r.node?.id === stuck.id)!
  assert.match(text(nodeRowSegments(decisionRow, items, 80, Date.now())), /Decide/, 'a question still says Decide')
})

test('the view key stays decide; old names still map onto it', () => {
  assert.equal(viewFromArg('decide'), 'decide')
  assert.equal(viewFromArg('owner'), 'decide')
})

test('defer --until: hidden until that day, the return date on the row, then back on its own exactly once', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'Renew the domain', author: A, task: true })
  const until = new Date(Date.now() + 3 * 86_400_000)
  const deferred = store.defer(d, { by: 'owner', role: 'human', until: nowStamp(until) })
  assert.ok(deferred.deferredUntil)
  assert.match(readFileSync(deferred.file, 'utf8'), /^deferred_until: /m)
  let items = store.all()
  assert.ok(!inView('available', items[0], items))
  const rows = rowsFor('waiting', items, { openGroups: new Set(['fold:deferred']) })
  const row = rows.find((r) => r.node?.id === d.id)!
  assert.match(text(suffixOf(row.node!, items, Date.now(), row)[0]), /Deferred until .* · in 3 days/)

  const later = until.getTime() + 1000
  assert.equal(isDeferred(items[0], later), false, 'past the date it is back even before anything clears the flag')
  assert.deepEqual(store.returnDueDeferrals(Date.now()), [], 'not yet')
  const back = store.returnDueDeferrals(later)
  assert.deepEqual(back.map((x) => x.id), [d.id])
  assert.equal(back[0].deferredAt, undefined)
  assert.equal(back[0].deferredUntil, undefined)
  assert.ok(back[0].notes.some((n) => n.author === DEFERRAL_CLOCK && /到期/.test(n.text)))
  assert.deepEqual(store.returnDueDeferrals(later), [], 'once')
  items = store.all()
  assert.ok(inView('available', items[0], items))
})

test('nod defer --until reads loose dates, refuses a day already begun, and undefer drops the date', (t) => {
  const root = project(t)
  decs(root, ['add', 'Renew the domain', '--task'])
  const out = decs(root, ['defer', '1', '--until', '3d'], owner)
  assert.match(out, /deferred until/)
  const d = json(decs(root, ['get', '1', '--json']))
  assert.ok(d.deferred_until)
  assert.equal(new Date(String(d.deferred_until)).getHours(), 0, 'the start of that day')
  assert.match(decs(root, ['get', '1']), /Deferred until/)
  const past = decsResult(root, ['defer', '1', '--until', 'yesterday'], owner)
  assert.notEqual(past.code, 0)
  assert.match(past.stderr, /already begun/)
  assert.notEqual(decsResult(root, ['defer', '1', '--until', 'whenever'], owner).code, 0)
  decs(root, ['defer', '1', '--until', 'next month'], owner)
  assert.notEqual(json(decs(root, ['get', '1', '--json'])).deferred_until, d.deferred_until, 'deferring again moves the date')
  decs(root, ['undefer', '1'], owner)
  const off = json(decs(root, ['get', '1', '--json']))
  assert.equal(off.deferred_at, null)
  assert.equal(off.deferred_until, null)
  decs(root, ['defer', '1'], owner)
  assert.equal(json(decs(root, ['get', '1', '--json'])).deferred_until, null, 'plain defer is still indefinitely')
})

test('nod add --important / --milestone --due fri reach the owner\'s marks; flag --due reads loose dates', (t) => {
  const root = project(t)
  const a = json(decs(root, ['add', 'Pay the invoice', '--for', 'me', '--important', '--json'], owner))
  assert.equal(a.important, true)
  const b = json(decs(root, ['add', 'Launch day', '--for', 'me', '--milestone', '--due', 'fri', '--json'], owner))
  assert.equal(b.milestone, true)
  assert.match(String(b.due), /T23:59:59/)
  assert.notEqual(decsResult(root, ['add', 'No date', '--milestone'], owner).code, 0)
  decs(root, ['flag', '1', 'milestone', '--due', 'next mon'], owner)
  assert.match(String(json(decs(root, ['get', '1', '--json'])).due), /T23:59:59/)
})

test('nod date --json: the day, how each language writes it, and suggestions for a live preview', (t) => {
  const root = project(t)
  const r = JSON.parse(decs(root, ['date', 'tomorrow', '--json']))
  assert.equal(r.ok, true)
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(r.relative, 'tomorrow')
  assert.ok(Array.isArray(r.suggestions) && r.suggestions[0].key === 'parsed')
  const zh = JSON.parse(decs(root, ['date', '3天后', '--json'], { DECS_LANG: 'zh-Hans' }))
  assert.equal(zh.relative, '3天后')
  const bad = decsResult(root, ['date', 'whenever', '--json'])
  assert.equal(bad.code, 1)
  assert.equal(JSON.parse(bad.stdout).ok, false)
  assert.ok(JSON.parse(decs(root, ['date', '--json'])).suggestions.length >= 3)
})

test('bench --json: rows say who does it and when a deferral ends; a project view is the live tree on its own', (t) => {
  const store = tmpStore(t)
  const parent = store.create({ title: 'Launch', author: A, task: true })
  store.create({ title: 'Call the vendor', author: 'owner', task: true, assignee: 'human', parent: String(parent.id) })
  const done = store.create({ title: 'Old work', author: A, task: true, parent: String(parent.id) })
  store.complete(done)
  const off = store.create({ title: 'Later', author: A, task: true })
  store.defer(off, { by: 'owner', role: 'human', until: nowStamp(new Date(Date.now() + 86_400_000 * 2)) })
  const out = benchJson(store) as {
    views: { view: string; label: string; rows: Record<string, unknown>[] }[]
    project_views: { project: string; count: number; rows: Record<string, unknown>[] }[]
    back_from_deferral: unknown[]
  }
  const decide = out.views.find((v) => v.view === 'decide')!
  assert.equal(decide.label, 'Needs you')
  const row = decide.rows.find((r) => r.title === 'Call the vendor')!
  assert.equal(row.assignee, 'human')
  assert.equal(row.human_task, true)
  assert.equal(row.blocks_ai, false)
  const waiting = out.views.find((v) => v.view === 'waiting')!
  assert.ok(waiting.rows.find((r) => r.title === 'Later')!.deferred_until)
  assert.equal(out.project_views.length, 1)
  const pv = out.project_views[0]
  assert.equal(pv.count, 3)
  assert.deepEqual(pv.rows.map((r) => r.title), ['Launch', 'Call the vendor', 'Later'], 'live nodes as a tree, finished ones left out')
  assert.equal(pv.rows[1].depth, 1)
  assert.deepEqual(out.back_from_deferral, [])
})

test('bench: ⇥ in the p prompt files a to-do for the owner instead of a brief', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'Existing work', author: A, task: true })
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /Existing work/))
  await b.press('P')
  await b.until(has(b, /New brief for an AI/))
  await b.press('\t')
  await b.until(has(b, /New to-do for you/))
  await b.press('Call the vendor', '\r')
  await b.until(has(b, /Call the vendor +For you/))
  const d = store.all().find((x) => x.title === 'Call the vendor')!
  assert.equal(d.assignee, 'human')
  assert.equal(d.intake, undefined)
  assert.equal(d.author, 'owner')
})
