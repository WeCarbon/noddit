import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { staleTasksOf } from '../src/core/checkins.ts'
import type { Decision } from '../src/core/types.ts'
import { decs, decsResult, scratch } from './helpers.ts'

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  return root
}

const get = (root: string, id: number) => JSON.parse(decs(root, ['get', String(id), '--json'])) as Record<string, any>

test('nod after <id> <dep>... queues one node behind others; --clear lets it start freely', (t) => {
  const root = project(t)
  decs(root, ['add', '--task', 'dep one'])
  decs(root, ['add', '--task', 'dep two'])
  decs(root, ['add', '--task', 'the work'])
  assert.match(decs(root, ['after', '3', '1', '2']), /X3 now waits for X1, X2/)
  assert.deepEqual(get(root, 3).after, ['X1', 'X2'])
  assert.match(decs(root, ['after', '3', '--clear']), /X3 no longer waits/)
  assert.deepEqual(get(root, 3).after, [])
})

test('nod after --before <dep> <id> <id>... hangs the same dependency on several nodes at once', (t) => {
  const root = project(t)
  decs(root, ['add', '--task', 'the dependency'])
  decs(root, ['add', '--task', 'child A'])
  decs(root, ['add', '--task', 'child B'])
  decs(root, ['add', '--task', 'child C'])
  const out = decs(root, ['after', '--before', '1', '2', '3', '4'])
  assert.match(out, /X2, X3, X4 now wait for X1/)
  assert.deepEqual(get(root, 2).after, ['X1'])
  assert.deepEqual(get(root, 3).after, ['X1'])
  assert.deepEqual(get(root, 4).after, ['X1'])
})

test('nod after --before needs at least one id, and a real dependency', (t) => {
  const root = project(t)
  decs(root, ['add', '--task', 'solo'])
  assert.notEqual(decsResult(root, ['after', '--before', '1']).code, 0)
  assert.notEqual(decsResult(root, ['after', '--before', '999', '1']).code, 0)
})

test('a not-started child whose parent is needs_decision, or the owner\'s own open to-do, is not a stale task', () => {
  const base = { project: 'p', created: '2026-01-01T00:00:00Z' } as const
  const items: Decision[] = [
    { ...base, id: 1, state: 'needs_decision' } as Decision,
    { ...base, id: 2, state: 'not_started', parent: 1 } as Decision,
    { ...base, id: 3, state: 'not_started', parent: 4 } as Decision,
    { ...base, id: 4, state: 'not_started', assignee: 'human' } as Decision,
    { ...base, id: 5, state: 'not_started' } as Decision,
  ]
  // 2 is queued behind needs_decision parent 1; 3 is queued behind the owner's own to-do (4);
  // 4 itself is the owner's to-do, excluded by isHumanTask already; 5 has no such parent.
  assert.deepEqual(staleTasksOf(items).map((d) => d.id), [5])
})
