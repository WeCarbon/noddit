import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { bench } from './tui-harness.ts'

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-nods-cal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

/** `Today 3 · Yesterday 1 · 7d avg 2` → `{ today: 3, yesterday: 1, avg7: '2' }`. */
function nodsHeader(frame: string[]): { today: number; yesterday: number; avg7: string } | null {
  const m = /Today (\d+) · Yesterday (\d+) · 7d avg (\S+)/.exec(frame[0])
  return m ? { today: Number(m[1]), yesterday: Number(m[2]), avg7: m[3] } : null
}

test('the header floors the 7-day average instead of showing a decimal', async (t) => {
  const store = tmpStore(t)
  // 10 Nods, all today (10/7 ≈ 1.43), so avg7 is deliberately not a whole number.
  for (let i = 0; i < 10; i++) store.create({ title: `brief ${i}`, author: 'owner', task: true })
  const b = bench(t, store)
  await b.until(() => nodsHeader(b.frame()) !== null)
  assert.deepEqual(nodsHeader(b.frame()), { today: 10, yesterday: 0, avg7: '1' })
})

test('c opens a text calendar heatmap behind ⚡; Esc closes it back to the list', async (t) => {
  const store = tmpStore(t)
  store.create({ title: 'only task', author: 'lane-x · test', task: true })
  const b = bench(t, store)
  await b.until(() => b.frame().some((l) => l.includes('only task')))
  await b.press('c')
  await b.until(() => !b.frame().some((l) => l.includes('only task')))
  const opened = b.frame().join('\n')
  assert.match(opened, /░|▒|▓|█/, 'the heatmap draws its shaded blocks')
  await b.press('\x1b') // Esc
  await b.until(() => b.frame().some((l) => l.includes('only task')))
})

test('starting a node bumps today\'s Nod count at once, though `start` leaves no note of its own', async (t) => {
  const store = tmpStore(t)
  // Not authored by owner, and no notes: nothing here earns a Nod on its own — the header
  // starts at 0 so a bump from `s` is unambiguous.
  store.create({ title: 'only task', author: 'lane-x · test', task: true })
  const b = bench(t, store)
  await b.until(() => nodsHeader(b.frame()) !== null)
  assert.deepEqual(nodsHeader(b.frame()), { today: 0, yesterday: 0, avg7: '0' })
  await b.press('s')
  await b.until(() => nodsHeader(b.frame())?.today === 1)
  // A later reload (another node arriving) must not drop the floor back to 0 — `start`
  // still has no note of its own for `computeNods` to find.
  store.create({ title: 'another one', author: 'lane-y · test', task: true })
  await b.press('r')
  await b.until(() => nodsHeader(b.frame())?.today === 1)
})
