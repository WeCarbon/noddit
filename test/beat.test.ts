import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { askIfDue } from '../src/core/checkins.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { decs, decsResult, scratch } from './helpers.ts'

function tmpRoot(t: { after: (fn: () => void) => void }): string {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('nod beat with no --note silently touches updated_at — no visible note', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the long build', '--task'])
  decs(root, ['start', '1'])
  const before = JSON.parse(decs(root, ['get', '1', '--json']))

  decs(root, ['beat', '1'])
  const after = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(after.notes.length, before.notes.length, 'no note added')
  assert.notEqual(after.updated_at, before.updated_at, 'updated_at moved')
})

test('nod beat --note "…" writes a visible Heartbeat note (agent role)', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the long build', '--task'])
  decs(root, ['start', '1'])

  decs(root, ['beat', '1', '--note', 'still waiting on CI'])
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.notes.length, 1)
  assert.equal(d.notes[0].role, 'agent')
  assert.equal(d.notes[0].text, 'still waiting on CI')
})

test('nod beat with no <id> falls back to NODDIT_NODE, same as nod progress', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the long build', '--task'])
  decs(root, ['start', '1'])
  decs(root, ['beat'], { NODDIT_NODE: '1' })
  const d = JSON.parse(decs(root, ['get', '1', '--json']))
  assert.equal(d.id, 1)
})

test('nod beat with neither an id nor NODDIT_NODE is a clear error, not a silent no-op', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  const r = decsResult(root, ['beat'])
  assert.notEqual(r.code, 0)
})

test('nod beat resets a pending check-in, same as any other write (Store.write -> resetCheckin)', (t) => {
  const root = tmpRoot(t)
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the long build', '--task', '--stale-after', '10m'])
  decs(root, ['start', '1'])

  const store = new Store([initLayout(root)])
  const node = store.get(1)!
  const layout = store.layoutOf(node)
  const base = Date.now()
  const idleAt = new Date(base - 3600_000).toISOString()
  const asked = askIfDue(layout, { ...node, updatedAt: idleAt, activeAt: idleAt }, base)
  assert.equal(asked?.asked, 1)
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).checkin?.asked, 1)

  decs(root, ['beat', '1'])
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).checkin, null)
})
