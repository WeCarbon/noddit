import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

import { decs, decsResult, scratch } from './helpers.ts'
import { dueMark } from '../src/tui/views.ts'
import type { Item } from '../src/core/types.ts'

function project(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  return root
}

const get = (root: string, id: number) => JSON.parse(decs(root, ['get', String(id), '--json'])) as Record<string, any>
const node = (due: string | undefined, extra: Partial<Item> = {}) => ({ id: 1, state: 'not_started', due, ...extra }) as Item

test('every live node with a due date says when; past it, overdue in red; a milestone keeps its own countdown', () => {
  const now = new Date(2026, 10, 3, 10, 0).getTime()
  const tomorrow = new Date(2026, 10, 4, 23, 59, 59).toISOString()
  const later = new Date(2026, 10, 10, 23, 59, 59).toISOString()
  const past = new Date(2026, 10, 3, 8, 0).toISOString()
  assert.match(dueMark(node(tomorrow), now)!.text, /^Due tomorrow$/)
  assert.equal(dueMark(node(later), now)!.color, 'yellow')
  const over = dueMark(node(past), now)!
  assert.match(over.text, /^Overdue 2 hours$/)
  assert.equal(over.color, 'red')
  assert.equal(dueMark(node(past, { state: 'completed' }), now), null, 'finished: nothing to chase')
  assert.equal(dueMark(node(past, { milestone: true }), now), null)
  assert.equal(dueMark(node(undefined), now), null)
})

test('--due on add takes a loose day (the end of it); nod edit --due moves or clears it; nod show due lists what is live', (t) => {
  const root = project(t)
  decs(root, ['add', '--task', 'review the contract', '--due', 'tomorrow'])
  decs(root, ['add', '--task', 'no date'])
  decs(root, ['add', '--task', 'done already', '--due', '3d'])
  decs(root, ['start', '3'])
  decs(root, ['done', '3'])
  const d = get(root, 1)
  const at = new Date(d.due)
  assert.deepEqual([at.getHours(), at.getMinutes()], [23, 59])
  assert.deepEqual(JSON.parse(decs(root, ['show', 'due', '--json'])).map((x: { id: number }) => x.id), [1])

  decs(root, ['edit', '2', '--due', '2026-12-01'])
  assert.match(String(get(root, 2).due), /^2026-12-01T23:59:59/)
  decs(root, ['edit', '1', '--due', 'off'])
  assert.equal(get(root, 1).due, null)
  assert.notEqual(decsResult(root, ['edit', '1', '--due', 'whenever']).code, 0)
})

test('an old "answer by" due reads as the node\'s due date, unchanged on disk', (t) => {
  const root = project(t)
  decs(root, ['add', 'ship it?', '-o', '1=yes', '2=no', '--default', '1', '--due', '4h'])
  const d = get(root, 1)
  const file = String(d.file)
  const old = readFileSync(file, 'utf8').replace(/^due: .*$/m, 'due: 2026-10-30T18:00:00+08:00')
  writeFileSync(file, old)
  assert.equal(get(root, 1).due, '2026-10-30T18:00:00+08:00')
  assert.deepEqual(JSON.parse(decs(root, ['show', 'due', '--json'])).map((x: { id: number }) => x.id), [1])
  decs(root, ['note', '1', 'still thinking'])
  assert.match(readFileSync(file, 'utf8'), /^due: 2026-10-30T18:00:00\+08:00$/m, 'the key and value survive a write')
})
