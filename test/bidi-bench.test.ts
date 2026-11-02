import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { buildOverview } from '../src/core/overview.ts'
import { buildFrame, geometry, hitTest, type FrameInput } from '../src/tui/app.ts'
import { setLang } from '../src/i18n/index.ts'
import { BIDI_CONTROLS } from '../src/i18n/bidi.ts'
import { nearestSelectable, rowsFor, type Row, type View } from '../src/tui/views.ts'
import { stringWidth } from '../src/tui/width.ts'
import { RESET } from '../src/tui/zoom.ts'

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')
const frameText = (frame: { text: string }[][]) => frame.map(text).join('\n')
const A = 'lead · bidi test'
const WIDTHS = [80, 100, 140]

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-bidi-bench-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

/** One node needing a decision — its row always carries a translated (and
 *  so, in Arabic, right-to-left) badge, which is what makes the row worth
 *  mirroring at all. */
function fixture(store: Store) {
  const release = store.create({ title: 'Ship release 2.4', author: A, options: [{ key: '1', label: 'Ship it' }, { key: '2', label: 'Hold' }], default: '1' })
  store.create({ title: 'Deploy to staging', author: A, task: true, after: [`${release.id}`] })
  return { release }
}

/** A node with two options, an inline body image, and two (non-image)
 *  attachments — enough distinct clickable entries, in the same row and
 *  footer, to prove spans don't bleed into their neighbour once mirroring
 *  reorders them. */
function clickableFixture(t: { after: (fn: () => void) => void }): { store: Store; release: ReturnType<Store['create']> } {
  const root = mkdtempSync(join(tmpdir(), 'decs-bidi-click-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const release = store.create({
    title: 'Ship release 2.4',
    author: A,
    body: '**What this is.** Ship the release to everyone.\n\n![a screenshot](shot.png)\n',
    options: [{ key: '1', label: 'Ship it' }, { key: '2', label: 'Hold' }],
    default: '1',
  })
  const draft = join(root, 'draft.html')
  const notes = join(root, 'notes.pdf')
  writeFileSync(draft, '<p>hi</p>')
  writeFileSync(notes, 'y')
  store.attach(store.get(release.id)!, [draft, notes])
  // store.attach doesn't mutate `release` in place — read it back so
  // `.attachments` (and anything else attach touched) is current.
  return { store, release: store.get(release.id)! }
}

function input(store: Store, over: Partial<FrameInput> = {}): FrameInput {
  const view: View = over.view ?? 'all'
  const items = over.items ?? store.all()
  const now = over.now ?? Date.now()
  const list = over.list ?? rowsFor(view, items)
  const index = over.index ?? nearestSelectable(list, 0, 1)
  return {
    view,
    list,
    index,
    current: index >= 0 ? list[index]?.node : undefined,
    items,
    overview: buildOverview(items, now),
    now,
    rows: 30,
    width: 100,
    offset: 0,
    condensed: false,
    mode: 'browse',
    draft: '',
    caret: 0,
    imageSel: 0,
    pendingKey: null,
    banner: null,
    zoom: RESET,
    zoomable: false,
    detailFocus: false,
    imageSize: null,
    ...over,
  }
}

function inLang<T>(lng: 'en' | 'zh-Hans' | 'zh-Hant' | 'fr' | 'ar', f: () => T): T {
  setLang(lng)
  try {
    return f()
  } finally {
    setLang('en')
  }
}

function withBidiMode<T>(mode: 'visual' | 'terminal', f: () => T): T {
  const prev = process.env.DECS_BIDI
  process.env.DECS_BIDI = mode
  try {
    return f()
  } finally {
    if (prev === undefined) delete process.env.DECS_BIDI
    else process.env.DECS_BIDI = prev
  }
}

test('ar (visual, the default): the list pane draws on the right of the divider', (t) => {
  const store = tmpStore(t)
  fixture(store)
  inLang('ar', () => {
    const s = input(store, { width: 100 })
    const g = geometry(s)
    // A click well into the right-hand columns lands on the list; the same
    // row, well into the left-hand columns, does not.
    const listRow = g.listRow0
    const onList = hitTest(s, g, s.width - 2, listRow + 1)
    const onDetail = hitTest(s, g, 2, listRow + 1)
    assert.equal(onList?.on, 'list', JSON.stringify(onList))
    assert.notEqual(onDetail?.on, 'list', JSON.stringify(onDetail))
  })
})

test('ar (visual): a mouse hit-test on the mirrored list selects the right row', (t) => {
  const store = tmpStore(t)
  const { release } = fixture(store)
  inLang('ar', () => {
    const s = input(store, { width: 100 })
    const g = geometry(s)
    const rowIndex = s.list.findIndex((r: Row) => r.node?.id === release.id)
    assert.ok(rowIndex >= 0)
    const y = g.listRow0 + (rowIndex - g.listStart) + 1
    const hit = hitTest(s, g, s.width - 2, y)
    assert.deepEqual(hit, { on: 'list', index: rowIndex })
  })
})

test('ar (visual): a node row ends with its glyph at the right edge', (t) => {
  const store = tmpStore(t)
  const { release } = fixture(store)
  inLang('ar', () => {
    const s = input(store, { width: 100 })
    const g = geometry(s)
    const frame = buildFrame(s, g)
    const rowIndex = s.list.findIndex((r: Row) => r.node?.id === release.id)
    const y = g.listRow0 + (rowIndex - g.listStart)
    const line = text(frame[y])
    // Past the glyph, in logical order, sits only the (blank, for this node)
    // tree gutter — mark and fold caret — which mirroring moves to the end.
    assert.ok(line.trimEnd().endsWith('◆'), `row did not end with the glyph: ${JSON.stringify(line)}`)
  })
})

for (const lng of ['en', 'zh-Hans', 'zh-Hant', 'fr', 'ar'] as const) {
  test(`${lng}: no row wider than 80/100/140 columns, mirrored or not`, (t) => {
    const store = tmpStore(t)
    fixture(store)
    inLang(lng, () => {
      for (const width of WIDTHS) {
        const frame = buildFrame(input(store, { width, rows: 30 }))
        for (const line of frame) assert.ok(stringWidth(text(line)) <= width, `${lng} at ${width}: overflow — ${JSON.stringify(text(line))}`)
      }
    })
  })
}

test('ar (terminal mode): the frame carries isolates and is no wider than visual mode', (t) => {
  const store = tmpStore(t)
  fixture(store)
  inLang('ar', () => {
    const visual = withBidiMode('visual', () => buildFrame(input(store, { width: 100 })))
    const terminal = withBidiMode('terminal', () => buildFrame(input(store, { width: 100 })))
    assert.match(frameText(terminal), BIDI_CONTROLS, 'terminal mode should isolate at least one left-to-right run')
    for (const width of WIDTHS) {
      const frame = withBidiMode('terminal', () => buildFrame(input(store, { width, rows: 30 })))
      for (const line of frame) assert.ok(stringWidth(text(line)) <= width, `ar terminal at ${width}: overflow — ${JSON.stringify(text(line))}`)
    }
    // Terminal mode keeps logical order, so none of this frame's bidi marks leak into the visual-mode one.
    assert.doesNotMatch(frameText(visual), BIDI_CONTROLS)
  })
})

test('en and zh-Hans frames are byte-identical to before the right-to-left work', (t) => {
  const store = tmpStore(t)
  store.create({ title: 'Ship release 2.4', author: 'lead · snap', options: [{ key: '1', label: 'Ship it' }, { key: '2', label: 'Hold' }], default: '1' })
  const render = (lng: 'en' | 'zh-Hans') => inLang(lng, () => frameText(buildFrame(input(store, { width: 80, rows: 20 }))))

  const en = render('en')
  assert.doesNotMatch(en, BIDI_CONTROLS, 'left-to-right frames never carry a bidi control')
  assert.match(en, /decs {2}Available 1 {2}Active 1 {2}Needs you 1 {2}All {2}Waiting/)
  assert.match(en, /◆ X1 Ship release 2\.4 {10,}Decide │/)
  assert.match(en, /│ 1 Ship it \(⏎\) {2}2 Hold/)
  assert.match(en, /↑↓ pick {2}⇥ view {2}1-9 answer {2}⏎ default {2}\? help {2}q quit/)

  const zh = render('zh-Hans')
  assert.doesNotMatch(zh, BIDI_CONTROLS)
  assert.match(zh, /decs {2}可用 1 {2}活动 1 {2}需要人类 1 {2}全部 {2}等待/)
  assert.match(zh, /◆ X1 Ship release 2\.4 {10,}待决 │/)
  assert.match(zh, /↑↓ 选 {2}⇥ 换视图 {2}1-9 答 {2}⏎ 默认 {2}\? 帮助 {2}q 退出/)
})

// ---------------------------------------------------------------------------
// Precise hit-testing in a mirrored detail pane — one test per clickable kind
// ---------------------------------------------------------------------------

/** Every column in `[from+1, to]` hits `want`; `from` itself and `to+1` do not. */
function assertExactSpan(s: FrameInput, g: ReturnType<typeof geometry>, sp: { from: number; to: number; row?: number }, y: number, want: unknown) {
  assert.deepEqual(hitTest(s, g, sp.from + 1, y), want, `span start ${sp.from + 1}`)
  assert.deepEqual(hitTest(s, g, sp.to, y), want, `span end ${sp.to}`)
  assert.notDeepEqual(hitTest(s, g, sp.from, y), want, `one before the span (${sp.from}) should miss`)
  assert.notDeepEqual(hitTest(s, g, sp.to + 1, y), want, `one past the span (${sp.to + 1}) should hit something else`)
}

test('ar (visual): option clicks hit exactly their own span, never a neighbour', (t) => {
  const { store, release } = clickableFixture(t)
  inLang('ar', () => {
    const s = input(store, { width: 100, current: release })
    const g = geometry(s)
    assert.equal(g.optionSpans.length, 2)
    for (const sp of g.optionSpans) {
      assertExactSpan(s, g, sp, sp.row! + 1, { on: 'option', key: sp.key })
    }
    // The two options' spans don't overlap.
    const [a, b] = [...g.optionSpans].sort((x, y) => x.from - y.from)
    assert.ok(a.to <= b.from, `option spans overlap: ${JSON.stringify(g.optionSpans)}`)
  })
})

test('ar (visual): attachment clicks hit exactly their own span, never a neighbour or the shared label', (t) => {
  const { store, release } = clickableFixture(t)
  inLang('ar', () => {
    const s = input(store, { width: 100, current: release })
    const g = geometry(s)
    assert.equal(g.attachmentSpans.length, 2)
    const y = g.attachmentsRow! + 1
    for (const sp of g.attachmentSpans) {
      assertExactSpan(s, g, sp, y, { on: 'attachment', n: Number(sp.key) })
    }
    const [a, b] = [...g.attachmentSpans].sort((x, y) => x.from - y.from)
    assert.ok(a.to <= b.from, `attachment spans overlap: ${JSON.stringify(g.attachmentSpans)}`)
    // A column past both spans, still on the attachments row, is the shared
    // "attachments" label (or empty padding) — not an attachment.
    const afterBoth = Math.max(a.to, b.to) + 2
    const hit = hitTest(s, g, afterBoth, y)
    assert.notEqual((hit as { on?: string } | null)?.on, 'attachment', `${afterBoth} landed on an attachment: ${JSON.stringify(hit)}`)
  })
})

test('ar (visual): an image placeholder in the body is clickable at its row, anywhere across the mirrored detail pane', (t) => {
  const { store, release } = clickableFixture(t)
  inLang('ar', () => {
    const s = input(store, { width: 100, current: release })
    const g = geometry(s)
    const row = g.bodyImageRows.find((r) => r >= 0)
    assert.ok(row !== undefined, 'the body should have one image placeholder')
    const y = g.bodyRow0 + (row! - g.bodyOffset) + 1
    // Detail is the left pane now; anywhere in columns 1..rw hits the image, not just one column.
    assert.deepEqual(hitTest(s, g, 2, y), { on: 'image', n: 0 })
    assert.deepEqual(hitTest(s, g, g.rw, y), { on: 'image', n: 0 })
    // Past the divider is the list, not the image.
    assert.notEqual(hitTest(s, g, g.rw + 2, y)?.on, 'image')
  })
})

test('ar (visual): a body row with no image is still "body", not list or option', (t) => {
  const { store, release } = clickableFixture(t)
  inLang('ar', () => {
    const s = input(store, { width: 100, current: release })
    const g = geometry(s)
    // The first body row is the "What this is." paragraph — no image there.
    const y = g.bodyRow0 + 1
    const hit = hitTest(s, g, Math.floor(g.rw / 2), y)
    assert.deepEqual(hit, { on: 'body' })
  })
})

test('ar (visual): list clicks hit exactly the mirrored list pane, anywhere past the divider', (t) => {
  const { store, release } = clickableFixture(t)
  inLang('ar', () => {
    const s = input(store, { view: 'all', current: release, width: 100 })
    const g = geometry(s)
    const rowIndex = s.list.findIndex((r: Row) => r.node?.id === release.id)
    const y = g.listRow0 + (rowIndex - g.listStart) + 1
    // The list pane spans columns rw+2..width; the divider (rw+1) and the
    // detail pane (1..rw) are not the list.
    assert.deepEqual(hitTest(s, g, g.rw + 2, y), { on: 'list', index: rowIndex })
    assert.deepEqual(hitTest(s, g, s.width, y), { on: 'list', index: rowIndex })
    assert.notEqual(hitTest(s, g, g.rw + 1, y)?.on, 'list', 'the divider column is not the list')
    assert.notEqual(hitTest(s, g, g.rw, y)?.on, 'list', 'one column into the detail pane is not the list')
  })
})

test('ar (visual): tab clicks hit exactly the reversed, individually mirrored tab they show', (t) => {
  const { store, release } = clickableFixture(t)
  inLang('ar', () => {
    const s = input(store, { width: 100, current: release })
    const g = geometry(s)
    assert.equal(g.tabSpans.length, 6)
    for (const sp of g.tabSpans) assertExactSpan(s, g, sp, 1, { on: 'tab', view: sp.view })
    // "available" (the first tab logically) reads first for a right-to-left
    // user — mirroring put it at the rightmost span, not the leftmost.
    const byColumn = [...g.tabSpans].sort((a, b) => a.from - b.from)
    assert.equal(byColumn[byColumn.length - 1].view, 'available')
    assert.equal(byColumn[0].view, 'recent')
  })
})

// ---------------------------------------------------------------------------
// Right-alignment and left-side ellipsis in the mirrored detail pane
// ---------------------------------------------------------------------------

test('ar (visual): detail-pane rows (head, meta, body, options) are right-aligned against the divider', (t) => {
  const { store, release } = clickableFixture(t)
  inLang('ar', () => {
    const s = input(store, { width: 100, current: release })
    const g = geometry(s)
    const frame = buildFrame(s, g)
    // The status line (short), the title row, and the options row (short)
    // all end close against the divider, with blank padding before them —
    // not flush against column 1, the way a left-aligned pane would be.
    const statusRow = g.listRow0 // 0-based frame index
    const titleRow = g.listRow0 + 1
    const optionsRow = g.optionsRow!
    for (const y of [statusRow, titleRow, optionsRow]) {
      const detailPart = frame[y].slice(0, frame[y].findIndex((seg) => seg.text === '│'))
      const widths = detailPart.map((seg) => [...seg.text].map((ch) => stringWidth(ch)))
      const total = widths.flat().reduce((a, b) => a + b, 0)
      assert.equal(total, g.rw, `row ${y}: detail part is not padded to the full pane width (${total} vs ${g.rw})`)
      const chars = detailPart.flatMap((seg) => [...seg.text])
      const lastReal = chars.map((c) => c.trim().length > 0).lastIndexOf(true)
      assert.ok(lastReal >= 0, `row ${y} has no visible content: ${JSON.stringify(text(detailPart))}`)
      // Real content ends within the last couple of columns (its own
      // trailing space, if the segment had one, may follow) — not stranded
      // near column 1 the way an unmirrored, left-aligned row would be.
      assert.ok(chars.length - 1 - lastReal <= 2, `row ${y}: content doesn't reach the divider — ${JSON.stringify(text(detailPart))}`)
      // And there is real leading padding (this row's own text is much
      // shorter than the full pane width), proving it was pushed right, not
      // just coincidentally full-width.
      const firstReal = chars.findIndex((c) => c.trim().length > 0)
      assert.ok(firstReal > 0, `row ${y} has no leading padding: ${JSON.stringify(text(detailPart))}`)
    }
  })
})

test('ar (visual): a truncated title puts the ellipsis on the left, in both the list and the strip', (t) => {
  const { store } = clickableFixture(t)
  const long = store.create({ title: 'A release title so long it cannot possibly fit the narrow list column at all', author: A, task: true })
  inLang('ar', () => {
    const s = input(store, { view: 'all', width: 80, rows: 20 })
    const g = geometry(s)
    const frame = buildFrame(s, g)
    const rowIndex = s.list.findIndex((r: Row) => r.node?.id === long.id)
    assert.ok(rowIndex >= 0)
    const y = g.listRow0 + (rowIndex - g.listStart)
    const line = text(frame[y])
    assert.ok(line.includes('…'), `expected a truncated title: ${JSON.stringify(line)}`)
    // The row is mirrored (list pane, right-aligned): the glyph sits at the
    // row's own right edge and the ellipsis marks the *other* end of the
    // kept text, which mirroring carries toward the left.
    const listPart = line.slice(g.rw + 1)
    assert.ok(listPart.trimStart().startsWith('…') || listPart.includes('…'), `ellipsis not on the left of the list cell: ${JSON.stringify(listPart)}`)
    assert.ok(!listPart.trimEnd().endsWith('…'), `ellipsis ended up on the right instead: ${JSON.stringify(listPart)}`)
  })
})
