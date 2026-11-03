import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { initLayout, type Layout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { isMilestone } from '../src/core/assignee.ts'
import { askIfDue, staleNagDue, staleTasksOf } from '../src/core/checkins.ts'
import { tidyFindings } from '../src/core/tidy.ts'
import type { Decision } from '../src/core/types.ts'
import { MILESTONE_GLYPH, glyphOf, glyphText, inView, milestoneProgress, rowsFor, suffixOf } from '../src/tui/views.ts'
import { decs, decsResult, scratch } from './helpers.ts'

const owner = { CLAUDECODE: undefined, DECS_ROLE: 'human' }
const A = 'lane-milestone · test'
const json = (out: string) => JSON.parse(out) as Record<string, unknown>

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  return root
}

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')

// ---------------------------------------------------------------------------
// nod add --milestone
// ---------------------------------------------------------------------------

test('nod add --milestone needs no --due any more; it is a task, not a decision', (t) => {
  const root = project(t)
  const d = json(decs(root, ['add', 'Hardware: land the new order', '--milestone', '--json'], owner))
  assert.equal(d.milestone, true)
  assert.equal(d.due, null)
  assert.equal(d.kind, 'task')
  assert.equal(d.status, 'not_started')
  assert.equal(d.author, 'owner')
})

test('nod add --milestone --due still takes one, same as any other node', (t) => {
  const root = project(t)
  const d = json(decs(root, ['add', 'Ship v2', '--milestone', '--due', 'fri', '--json'], owner))
  assert.equal(d.milestone, true)
  assert.match(String(d.due), /T23:59:59/)
})

test('a milestone is not anyone\'s to-do, and not a decision', (t) => {
  const root = project(t)
  assert.notEqual(decsResult(root, ['add', 'Mixed', '--for', 'me', '--milestone'], owner).code, 0)
  assert.notEqual(decsResult(root, ['add', 'Mixed', '--milestone', '-o', '1=a', '2=b'], owner).code, 0)
  assert.notEqual(decsResult(root, ['add', 'Mixed', '--milestone', '--brief'], owner).code, 0)
})

// ---------------------------------------------------------------------------
// nod assign <id> milestone, and back
// ---------------------------------------------------------------------------

test('nod assign <id> milestone sets it, clearing whatever it was assigned to; ai/me go back', (t) => {
  const root = project(t)
  decs(root, ['add', 'Renew the lease', '--for', 'me'], owner)
  assert.match(decs(root, ['assign', '1', 'milestone'], owner), /milestone/)
  let d = json(decs(root, ['get', '1', '--json']))
  assert.equal(d.milestone, true)
  assert.equal(d.assignee, 'ai')

  decs(root, ['assign', '1', 'me'], owner)
  d = json(decs(root, ['get', '1', '--json']))
  assert.equal(d.milestone, false)
  assert.equal(d.assignee, 'human')

  decs(root, ['assign', '1', 'milestone'], owner)
  decs(root, ['assign', '1', 'ai'], owner)
  d = json(decs(root, ['get', '1', '--json']))
  assert.equal(d.milestone, false)
  assert.equal(d.assignee, 'ai')
})

test('store.assign and store.setMilestone agree on the same field', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'Warehouse: grid connection', author: A, task: true })
  const asMilestone = store.setMilestone(d, true)
  assert.equal(asMilestone.milestone, true)
  assert.equal(isMilestone(asMilestone), true)
  const backToAi = store.assign(asMilestone, undefined)
  assert.equal(backToAi.milestone, undefined)
  const asMilestoneAgain = store.setMilestone(backToAi, true)
  const toHuman = store.assign(asMilestoneAgain, 'human')
  assert.equal(toHuman.milestone, undefined)
  assert.equal(toHuman.assignee, 'human')
})

// ---------------------------------------------------------------------------
// Glyph and badge
// ---------------------------------------------------------------------------

test('glyph: a milestone is ⚑ whatever its state, dim once every child is finished', (t) => {
  const store = tmpStore(t)
  const goal = store.setMilestone(store.create({ title: 'Acme contract', author: A, task: true }), true)
  assert.equal(glyphText(goal, [goal]), MILESTONE_GLYPH)
  assert.deepEqual(glyphOf(goal, [goal]), { text: MILESTONE_GLYPH, dim: false })

  const kid1 = store.create({ title: 'sign the contract', author: A, task: true, parent: String(goal.id) })
  const kid2 = store.create({ title: 'ship the panels', author: A, task: true, parent: String(goal.id) })
  let items = store.all()
  let g = items.find((d) => d.id === goal.id)!
  assert.deepEqual(glyphOf(g, items), { text: MILESTONE_GLYPH, dim: false })
  assert.deepEqual(milestoneProgress(g, items), { done: 0, total: 2 })

  store.complete(store.start(kid1))
  items = store.all()
  g = items.find((d) => d.id === goal.id)!
  assert.deepEqual(milestoneProgress(g, items), { done: 1, total: 2 })
  assert.equal(glyphOf(g, items).dim, false, 'one of two done: not ready to archive yet')

  store.close(kid2, 'obsolete')
  items = store.all()
  g = items.find((d) => d.id === goal.id)!
  assert.deepEqual(milestoneProgress(g, items), { done: 2, total: 2 })
  assert.equal(glyphOf(g, items).dim, true, 'every child finished: dim, ready to archive')
})

test('badge: the right side shows done/total for a milestone, a due date still shown the normal way', (t) => {
  const store = tmpStore(t)
  const goal = store.setMilestone(store.create({ title: 'Platform rollout', author: A, task: true, due: '2026-12-01T00:00:00+08:00' }), true)
  store.create({ title: 'first pilot', author: A, task: true, parent: String(goal.id) })
  const kid2 = store.create({ title: 'second pilot', author: A, task: true, parent: String(goal.id) })
  store.complete(store.start(kid2))
  const items = store.all()
  const g = items.find((d) => d.id === goal.id)!
  assert.match(text(suffixOf(g, items, Date.now())[0]), /1\/2/)
  // A due date still shows up as its own lead segment, shared with every other node kind.
  const row = rowsFor('all', items).find((r) => r.node?.id === goal.id)!
  assert.match(text(suffixOf(g, items, Date.now(), row)[0]), /1\/2/)
})

// ---------------------------------------------------------------------------
// View membership
// ---------------------------------------------------------------------------

test('a milestone never lists in Human work (decide), whatever its own state', (t) => {
  const store = tmpStore(t)
  const goal = store.setMilestone(store.create({ title: 'Partner onboarding', author: A, task: true }), true)
  const items = [goal]
  assert.equal(inView('decide', goal, items), false)
})

test('a milestone is never a direct match in Available/Active — only dim context when a child is', (t) => {
  const store = tmpStore(t)
  const goal = store.setMilestone(store.create({ title: 'Partner onboarding', author: A, task: true }), true)
  let items = store.all()
  assert.equal(inView('available', items[0], items), false, 'nothing under it yet')
  assert.equal(inView('active', items[0], items), false)

  const kid = store.create({ title: 'collect the paperwork', author: A, task: true, parent: String(goal.id) })
  items = store.all()
  const g = items.find((d) => d.id === goal.id)!
  const k = items.find((d) => d.id === kid.id)!
  assert.equal(inView('available', g, items), false, 'the milestone itself still does not match')
  assert.equal(inView('available', k, items), true, 'its startable child does')
  const rows = rowsFor('available', items)
  const goalRow = rows.find((r) => r.node?.id === goal.id)!
  assert.equal(goalRow.context, true, 'shown only as the tree\'s dim ancestor-context')

  store.start(k)
  items = store.all()
  assert.equal(inView('active', items.find((d) => d.id === goal.id)!, items), false)
  assert.equal(inView('active', items.find((d) => d.id === kid.id)!, items), true)
})

// ---------------------------------------------------------------------------
// Monitor skip: NODDIT-CHECKIN / NODDIT-STALE / NODDIT-TIDY
// ---------------------------------------------------------------------------

test('monitor: a milestone is never checked in on or nagged as stale; its children are unaffected', (t) => {
  const store = tmpStore(t)
  const goal = store.setMilestone(store.create({ title: 'Launch readiness', author: A, task: true }), true)
  const kid = store.create({ title: 'line up financing', author: A, task: true, parent: String(goal.id) })
  const old = Date.now() + 10 * 86_400_000
  assert.equal(staleNagDue(store.primary, goal, old), undefined, 'not_started, but it is a milestone')
  assert.ok(staleNagDue(store.primary, kid, old), 'its child is nagged normally')
  assert.deepEqual(staleTasksOf(store.all()).map((d) => d.id), [kid.id])

  const started = store.start(kid)
  assert.ok(askIfDue(store.primary, started, old), 'its in_progress child still gets a check-in ask')
})

test('tidy: a milestone itself is never the subject, even once every child is finished', () => {
  const now = new Date().toISOString()
  const node = (overrides: Partial<Decision> & { id: number }): Decision =>
    ({
      project: 'p', title: 't', author: 'owner', state: 'not_started', status: 'open', created: now, updatedAt: now,
      kind: 'task', tags: [], body: '', options: [], attachments: [], bodyAttachments: [], notes: [], approvals: [],
      file: `/x/${overrides.id}.md`, slug: 't', archived: false, ...overrides,
    }) as Decision
  const goal = node({ id: 1, state: 'not_started', milestone: true, children: [2, 3] })
  const kids = [node({ id: 2, parent: 1, state: 'completed' }), node({ id: 3, parent: 1, state: 'closed' })]
  assert.deepEqual(tidyFindings([goal, ...kids], () => true), [], 'no childrenDone finding for the milestone')
})
