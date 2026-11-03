import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { rowsFor } from '../src/tui/views.ts'
import { buildFrame, type FrameInput } from '../src/tui/app.ts'
import { buildOverview } from '../src/core/overview.ts'
import { RESET } from '../src/tui/zoom.ts'
import { bench, has } from './tui-harness.ts'

const A = 'lead · previous rounds test'
const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')
const frameText = (frame: { text: string }[][]) => frame.map(text).join('\n')

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-prev-rounds-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

function input(store: Store, over: Partial<FrameInput> = {}): FrameInput {
  const items = over.items ?? store.all()
  const list = over.list ?? rowsFor('all', items)
  const index = over.index ?? 0
  return {
    view: 'all', list, index, current: list[index]?.node, items,
    overview: buildOverview(items, Date.now()), now: Date.now(),
    rows: 40, width: 119, offset: 0, condensed: false, mode: 'browse',
    draft: '', caret: 0, imageSel: 0, pendingKey: null, banner: null,
    zoom: RESET, zoomable: false, detailFocus: false, imageSize: null,
    ...over,
  }
}

test('a node with no previous rounds shows none in the detail pane', (t) => {
  const store = tmpStore(t)
  store.create({ title: 'fresh question', author: A, options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], default: '1' })
  const all = frameText(buildFrame(input(store)))
  assert.doesNotMatch(all, /Previous round/)
})

test('a re-asked node shows its earlier round, which option was chosen, by whom, and that it is history only', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'ship v1 or wait', author: A, options: [{ key: '1', label: 'ship now' }, { key: '2', label: 'wait a week' }], default: '1' })
  store.answer(store.get(d.id)!, { choice: '1', by: 'owner', role: 'human' })
  store.ask(store.get(d.id)!, { options: [{ key: '1', label: 'go live Monday' }, { key: '2', label: 'go live Friday' }], author: A })

  const items = store.all()
  const list = rowsFor('all', items)
  const index = list.findIndex((r) => r.node?.id === d.id)
  const all = frameText(buildFrame(input(store, { items, list, index })))
  assert.match(all, /Previous round\b/, 'singular for exactly one earlier round')
  assert.match(all, /Round 1 — answered 1 \(owner, .+\)/)
  assert.match(all, /1 ship now ✓ Answered {3}2 wait a week/)
  // The live options (round 2) are what you answer now — still in the footer, not confused with history.
  assert.match(all, /go live Monday/)
  assert.match(all, /go live Friday/)
})

test('App: previous rounds render in the running bench, newest first, across more than one re-ask', async (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'pick the vendor', author: A, options: [{ key: '1', label: 'Acme' }, { key: '2', label: 'Globex' }], default: '1' })
  store.answer(store.get(d.id)!, { choice: '2', by: 'owner', role: 'human' })
  store.ask(store.get(d.id)!, { options: [{ key: '1', label: 'sign now' }, { key: '2', label: 'sign later' }], author: A })
  store.answer(store.get(d.id)!, { choice: '1', by: 'owner', role: 'human' })
  store.ask(store.get(d.id)!, { options: [{ key: '1', label: 'wire the deposit' }, { key: '2', label: 'hold the deposit' }], author: A })

  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /pick the vendor/))
  await b.until(has(b, /2 previous rounds/))
  const frame = b.frame().join('\n')
  const roundTwoAt = frame.indexOf('Round 2')
  const roundOneAt = frame.indexOf('Round 1')
  assert.ok(roundTwoAt >= 0 && roundOneAt >= 0 && roundTwoAt < roundOneAt, 'newest round first')
  assert.match(frame, /Round 2 — answered 1 \(owner, .+\)/)
  assert.match(frame, /Round 1 — answered 2 \(owner, .+\)/)
})
