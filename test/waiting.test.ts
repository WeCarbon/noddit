import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildOverview } from '../src/core/overview.ts'
import { initLayout } from '../src/core/paths.ts'
import { noteHeading } from '../src/core/serialize.ts'
import { NOTE_KIND, NOTE_TEXT } from '../src/core/format.ts'
import { Store } from '../src/core/store.ts'
import type { Decision } from '../src/core/types.ts'
import { buildFrame, type FrameInput } from '../src/tui/app.ts'
import { VIEWS, VIEW_LABEL, nearestSelectable, nodeRowSegments, rowsFor, viewFromArg, waitingRows, waitingSince, type View } from '../src/tui/views.ts'
import { RESET } from '../src/tui/zoom.ts'

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-wait-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

function input(store: Store, view: View, now = Date.now()): FrameInput {
  const items = store.all()
  const list = rowsFor(view, items)
  const index = nearestSelectable(list, 0, 1)
  return {
    view, list, index, current: index >= 0 ? list[index]?.node : undefined, items,
    overview: buildOverview(items, now), now, rows: 30, width: 119, offset: 0, condensed: false,
    mode: 'browse', draft: '', caret: 0, imageSel: 0, pendingKey: null, banner: null, zoom: RESET,
    zoomable: false, detailFocus: false, imageSize: null,
  }
}

/** A waiting node whose `decs hold` happened at `heldAt` (and maybe was written to later). */
function held(id: number, heldAt: string, on: string, updatedAt = heldAt): Decision {
  return {
    id, project: 'p', title: `waiting ${id}`, state: 'waiting', status: 'open', waitingOn: on, waitingUntil: '2099-01-01T00:00:00+00:00',
    body: `body text\n\n## ${noteHeading(NOTE_KIND.waiting, 'agent', 'lane', heldAt)}\n\n${NOTE_TEXT.waitingOn(on)}\n`,
    created: '2026-10-01T09:00:00+08:00', updatedAt, attachments: [], approvals: [], options: [],
  } as unknown as Decision
}

test('the tabs are Available Active Human-work Waiting Live All, with counts on all but Live and All', (t) => {
  const store = tmpStore(t)
  store.create({ title: 'needs a call', author: 'a · x', options: [{ key: '1', label: 'ok' }], default: '1' })
  const running = store.create({ title: 'running', author: 'a · x', task: true })
  store.start(running)
  const w1 = store.create({ title: 'waiting on the customer', author: 'a · x', task: true })
  store.hold(w1, 'a reply from the customer', 'a · x', { until: '2099-01-01T00:00:00+00:00' })
  const w2 = store.create({ title: 'waiting on the service', author: 'a · x', task: true })
  store.hold(w2, 'ADO to recover', 'a · x', { until: '2099-01-01T00:00:00+00:00' })

  assert.deepEqual(VIEWS.map((v) => VIEW_LABEL[v]), ['Available', 'Active', 'Human work', 'Waiting', 'Live', 'All'])
  const header = text(buildFrame(input(store, 'available'))[0])
  assert.match(header, /^decs +Available 4 +Active 2 +Human work 1 +Waiting 2 +Live +All +[○●] Main agent *$/)
  assert.doesNotMatch(header, /waiting for you|finished|working|timeline/)
  assert.equal(viewFromArg('waiting'), 'waiting')
})

test('waitingSince is when it was put on hold, not its last write', () => {
  const d = held(1, '2026-10-20T10:00:00+08:00', 'the customer', '2026-10-27T18:00:00+08:00')
  assert.equal(new Date(waitingSince(d)).toISOString(), new Date('2026-10-20T10:00:00+08:00').toISOString())
  const noNote = { ...d, body: 'no hold note here' } as Decision
  assert.equal(waitingSince(noNote), d.updatedAt, 'without the hold note, its last write')
})

test('Waiting lists only waiting nodes, the longest wait first, each with whom and since when', () => {
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  const items = [
    held(1, '2026-10-26T10:00:00+08:00', 'Bob to send evidence'),
    // Written to yesterday, but waiting since a week ago: it goes first.
    held(2, '2026-10-21T10:00:00+08:00', 'the vendor quote', '2026-10-27T10:00:00+08:00'),
    held(3, '2026-10-27T10:00:00+08:00', 'ADO to recover'),
    { ...held(4, '2026-10-01T10:00:00+08:00', 'x'), state: 'in_progress' } as Decision,
  ]
  const rows = waitingRows(items)
  assert.deepEqual(rows.map((r) => r.node!.id), [2, 1, 3])
  assert.deepEqual(rowsFor('waiting', items).map((r) => r.node!.id), [2, 1, 3])
  const row2 = text(nodeRowSegments(rows[0], items, 70, now))
  assert.match(row2, /Waiting on the vendor quote · back /, 'whom, and the day to check back')
  assert.match(row2, /⏸/)
})

test('an empty Waiting says so', (t) => {
  const store = tmpStore(t)
  store.create({ title: 'x', author: 'a · x', task: true })
  const frame = buildFrame(input(store, 'waiting'))
  assert.ok(frame.some((l) => text(l).includes('Nothing waiting outside.')))
})

test('Decide replaces the old wording in what the bench says about owner questions', (t) => {
  const store = tmpStore(t)
  store.create({ title: 'needs a call', author: 'a · x', options: [{ key: '1', label: 'ok' }], default: '1' })
  for (const view of ['all', 'decide'] as View[]) {
    const all = buildFrame(input(store, view)).map(text).join('\n')
    assert.doesNotMatch(all, /waiting for you/, `${view}: no old wording left`)
    assert.match(all, /Decide/)
  }
})
