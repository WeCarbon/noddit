import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { buildSchedule, dependentsOf, findCycles } from '../src/core/sequence.ts'
import { buildOverview } from '../src/core/overview.ts'
import {
  isPossiblyObsolete,
  isStale,
  minutesSince,
  stalenessOf,
} from '../src/core/staleness.ts'
import { decs, decsResult, scratch } from './helpers.ts'
import type { Decision as Item } from '../src/core/types.ts'

function scratchStore(t: { after: (fn: () => void) => void }): { root: string; store: Store } {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  return { root, store }
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<Item>): Item {
  const now = new Date().toISOString()
  return {
    id: 1,
    title: 't',
    author: 'a',
    state: 'in_progress',
    status: 'answered',
    created: now,
    updatedAt: now,
    tags: [],
    body: '',
    options: [],
    attachments: [],
    notes: [],
    file: '/x/active/1-t.md',
    slug: 't',
    archived: false,
    project: 'p',
    kind: 'task',
    ...overrides,
  } as Item
}

test('stalenessOf: only in_progress can be stale; default threshold is the checkin-after setting (1h)', (t) => {
  // Pin it: the real ~/.decs/config.json on whatever machine runs this must never leak in.
  const prev = process.env.NODDIT_CHECKIN_AFTER
  process.env.NODDIT_CHECKIN_AFTER = '1h'
  t.after(() => {
    if (prev === undefined) delete process.env.NODDIT_CHECKIN_AFTER
    else process.env.NODDIT_CHECKIN_AFTER = prev
  })

  const fresh = makeItem({ updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() })
  assert.equal(stalenessOf(fresh), 'fresh')

  const needsDecision = makeItem({ state: 'needs_decision', updatedAt: new Date(Date.now() - 90 * 60_000).toISOString() })
  assert.equal(stalenessOf(needsDecision), 'fresh', 'needs_decision not moving is expected, not stuck')

  const almost = makeItem({ updatedAt: new Date(Date.now() - 59 * 60_000).toISOString() })
  assert.equal(stalenessOf(almost), 'fresh', 'not past the default 1h threshold yet')
  assert.equal(isStale(almost), false)

  const stale = makeItem({ updatedAt: new Date(Date.now() - 61 * 60_000).toISOString() })
  assert.equal(stalenessOf(stale), 'stale')
  assert.equal(isStale(stale), true)
})

test('stalenessOf: a custom stale_after changes the threshold', () => {
  const almost = makeItem({ staleAfter: '90m', updatedAt: new Date(Date.now() - 80 * 60_000).toISOString() })
  assert.equal(stalenessOf(almost), 'fresh', 'not past its own 90m threshold yet')
  const past = makeItem({ staleAfter: '90m', updatedAt: new Date(Date.now() - 95 * 60_000).toISOString() })
  assert.equal(stalenessOf(past), 'stale')
})

test('minutesSince is Infinity for an unparseable timestamp, not NaN', () => {
  assert.equal(minutesSince({ updatedAt: 'nonsense', created: '' }), Infinity)
})

test('isPossiblyObsolete: N days with no update, never for completed/closed', () => {
  const old = makeItem({ state: 'not_started', updatedAt: new Date(Date.now() - 4 * 86_400_000).toISOString() })
  assert.equal(isPossiblyObsolete(old), true)
  assert.equal(isPossiblyObsolete(old, { staleDays: 5 }), false, 'a looser threshold is not yet met')
  const done = makeItem({ state: 'completed', updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })
  assert.equal(isPossiblyObsolete(done), false)
})

// ---------------------------------------------------------------------------
// buildSchedule / dependentsOf / findCycles — on items read back from a real
// store, so ref-resolution (after, project, letter) is exercised for real.
// ---------------------------------------------------------------------------

test('buildSchedule: a not_started leaf is next; a needs_decision node after it can be decided early', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', 'prep the data', '--task'])
  decs(root, ['add', 'how to word the title', '-o', '1=a', '2=b', '--after', '1'])

  const rows = buildSchedule(store.all())
  const [r1, r2] = rows
  assert.equal(r1.id, 1)
  assert.equal(r1.state, 'next')
  assert.deepEqual(r1.deps, [])
  assert.equal(r2.id, 2)
  assert.equal(r2.state, 'can_decide_early', 'owner can answer it even though node 1 has not started')
  assert.equal(r2.deps[0].ref, 'X1')
  assert.equal(r2.deps[0].done, false)
})

test('buildSchedule: starting (not finishing) the dependency still leaves the decision answerable early', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', 'prep the data', '--task'])
  decs(root, ['add', 'how to word the title', '-o', '1=a', '2=b', '--after', '1'])
  decs(root, ['start', '1'])

  const rows = buildSchedule(store.all())
  assert.equal(rows.find((r) => r.id === 1)!.state, 'current')
  assert.equal(rows.find((r) => r.id === 2)!.state, 'can_decide_early', 'isStartable needs 1 terminal, not just started')
})

test('buildSchedule: completing the dependency flips the decision to waiting_on_owner', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', 'prep the data', '--task'])
  decs(root, ['add', 'how to word the title', '-o', '1=a', '2=b', '--after', '1'])
  decs(root, ['done', '1'])

  const rows = buildSchedule(store.all())
  assert.equal(rows.find((r) => r.id === 1), undefined, 'completed node is archived, out of the open schedule')
  assert.equal(rows.find((r) => r.id === 2)!.state, 'waiting_on_owner', 'nothing left but the owner')
})

test('buildSchedule: two next nodes with the same deps are flagged parallelWith each other', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', 'A', '--task'])
  decs(root, ['add', 'B', '--task'])
  const rows = buildSchedule(store.all())
  assert.deepEqual(rows.find((r) => r.id === 1)!.parallelWith, [2])
  assert.deepEqual(rows.find((r) => r.id === 2)!.parallelWith, [1])
})

test('node 1 (task), nodes 2 & 3 after it (each a pending decision), owner answers 3 early', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', 'prep the data', '--task'])
  decs(root, ['add', 'how to word the title', '-o', '1=a', '2=b', '--after', '1', '--urgency', 'high'])
  decs(root, ['add', 'which region to use', '-o', '1=a', '2=b', '--after', '1'])
  decs(root, ['push', '3', '1']) // answered early, not yet collected

  const items = store.all()
  const ov = buildOverview(items)

  // §1: only node 2 still needs the owner; node 3 dropped off once answered.
  assert.deepEqual(ov.needsOwner.map((n) => n.id), [2])
  assert.equal(ov.needsOwner[0].urgency, 'high')
  assert.deepEqual(ov.needsOwner[0].blocks, [], 'nothing depends on node 2')

  // §2 (in-progress): nothing running yet.
  assert.deepEqual(ov.inProgress, [])

  // decided-but-not-collected: node 3.
  assert.equal(ov.decidedNotCollected, 1)

  // §3: schedule order — node 1 ready, node 2 can be decided early, node 3 decided but parked behind node 1
  const byId = new Map(ov.schedule.map((r) => [r.id, r]))
  assert.equal(byId.get(1)!.state, 'next')
  assert.equal(byId.get(2)!.state, 'can_decide_early')
  assert.equal(byId.get(3)!.state, 'waiting', 'decided, but its dependency is not done yet')

  decs(root, ['read', '3'])
  assert.equal(store.get(3)!.state, 'not_started', 'decided+collected, parked until 1 is done')
  decs(root, ['done', '1'])
  assert.equal(store.get(3)!.state, 'in_progress', "store.complete()'s own wake-up — this lane changed nothing there")

  const after = buildOverview(store.all())
  assert.equal(after.schedule.find((r) => r.id === 3)!.state, 'current', 'now running, reflected in the schedule')
  assert.equal(after.schedule.find((r) => r.id === 1), undefined, 'node 1 is completed/archived — out of the open schedule')
})

test('dependentsOf: transitive — T3 after T2 after T1 means T1 blocks both', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', '1', '-o', '1=a'])
  decs(root, ['add', '2', '--task', '--after', '1'])
  decs(root, ['add', '3', '--task', '--after', '2'])
  const items = store.all()
  const deps = dependentsOf(items.find((i) => i.id === 1)!, items)
  assert.deepEqual(deps.map((d) => d.id).sort(), [2, 3])
})

test('findCycles: no cycle is an empty array', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', 'A', '--task'])
  decs(root, ['add', 'B', '--task', '--after', '1'])
  assert.deepEqual(findCycles(store.all()), [], 'no cycle yet')
  assert.equal(decsResult(root, ['check']).code, 0, 'an empty body is a warning, not an error')
})

test('decs check reports an after-cycle as an error', (t) => {
  const { root, store } = scratchStore(t)
  decs(root, ['add', 'A', '--task'])
  decs(root, ['add', 'B', '--task', '--after', '1'])
  // Force a cycle the CLI would not let you create directly: A after B too.
  const file = store.get(1)!.file
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace('status: not_started', 'status: not_started\nafter:\n  - "2"'))

  const cycles = findCycles(store.all())
  assert.equal(cycles.length, 1)
  assert.deepEqual([...new Set(cycles[0].map((c) => c.ref))].sort(), ['X1', 'X2'])

  // decs check's own message for this is English in the source.
  const result = decsResult(root, ['check'], { DECS_LANG: 'en' })
  assert.equal(result.code, 1)
  assert.match(result.stdout, /dependency cycle/)
})
