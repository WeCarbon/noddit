import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { LANGUAGES, setLang, t } from '../src/i18n/index.ts'
import { fit, stringWidth, wrapToWidth } from '../src/tui/width.ts'
import { buildFrame, caretFromColumn, geometry, hitTest, repaintRows, type FrameInput } from '../src/tui/app.ts'
import { isMouse, parseMouse } from '../src/tui/mouse.ts'
import { imageProtocol, renderImage } from '../src/tui/image.ts'
import {
  bodyLines,
  condense,
  firstHtmlAttachmentIndex,
  styleLine,
} from '../src/tui/model.ts'
import { VIEWS, nearestSelectable, rowsFor, type View } from '../src/tui/views.ts'
import { buildOverview } from '../src/core/overview.ts'
import { RESET, ZOOM_MAX, ZOOM_MIN, cropRect, imageLayout, pan, zoomHintText, zoomIn, zoomOut } from '../src/tui/zoom.ts'
import type { Attachment, Decision } from '../src/core/types.ts'

function fixture(): { store: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-'))
  const store = new Store([initLayout(root)])
  store.create({
    title: 'how strict should the deploy gate be: one new check would block 4 of the last 6 runs',
    author: 'deploy-lane · local deploy path',
    body: Array.from({ length: 40 }, (_, i) => `**Paragraph ${i}.** This paragraph exists only to make the body long enough that it needs to scroll.`).join('\n\n'),
    options: [
      { key: '1', label: 'strict: the tree must match exactly' },
      { key: '2', label: 'only check files that will ship' },
      { key: '3', label: 'warn only, don’t block' },
    ],
    default: '2',
  })
  // No -o given: this is the acceptance shape, a single "accept" option.
  store.create({ title: 'an acceptance entry: just one option', author: 'ui-lane · map view' })
  return { store, root }
}

/** The nodes a view lists, in order. */
function listFor(store: Store, view: View = 'decide'): Decision[] {
  return rowsFor(view, store.all())
    .filter((r) => r.kind === 'node')
    .map((r) => r.node!)
}

function frameInput(store: Store, over: Partial<FrameInput> = {}): FrameInput {
  const view = over.view ?? 'decide'
  const items = over.items ?? store.all()
  const list = over.list ?? rowsFor(view, items)
  const index = over.index ?? nearestSelectable(list, 0, 1)
  const now = over.now ?? Date.now()
  return {
    view,
    list,
    index,
    current: index >= 0 ? list[index]?.node : undefined,
    items,
    overview: buildOverview(items, now),
    now,
    rows: 24,
    width: 79,
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

function frameFor(store: Store, over: Partial<FrameInput> = {}) {
  return buildFrame(frameInput(store, over))
}

const lineWidth = (line: { text: string }[]): number => line.reduce((n, s) => n + stringWidth(s.text), 0)

test('stringWidth counts CJK as two columns', () => {
  assert.equal(stringWidth('abc'), 3)
  assert.equal(stringWidth('部署'), 4)
  assert.equal(stringWidth('D415 · 部署'), 'D415 · '.length + 4)
  assert.equal(stringWidth(''), 0)
})

test('wrapToWidth never exceeds the target and never drops characters', () => {
  const line = '这一段混着 ASCII and 中文，用来验证换行不会把字吃掉也不会超宽。'
  for (const w of [10, 17, 40]) {
    const parts = wrapToWidth(line, w)
    for (const p of parts) assert.ok(stringWidth(p) <= w, `"${p}" is ${stringWidth(p)} wide, limit ${w}`)
    assert.equal(parts.join('').replace(/\s/g, ''), line.replace(/\s/g, ''))
  }
})

/** Maximal non-space runs, in order — a space-delimited language's "words". */
function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}

/** Wrapping must never change which words exist, only where the breaks fall:
 *  re-joining with single spaces and re-splitting on whitespace must get back
 *  the original word list, whichever width forced the break. This is blind
 *  to *where* a line break landed (that's wrapToWidth's call), only to
 *  whether two words got glued together or a character went missing. CJK is
 *  out of scope here — it has no inter-word spaces, so "words" doesn't apply;
 *  its contract (every character survives, width never exceeded) is the
 *  test above. */
function assertWordsPreserved(line: string, w: number): void {
  const parts = wrapToWidth(line, w)
  for (const p of parts) assert.ok(stringWidth(p) <= w, `"${p}" is ${stringWidth(p)} wide, limit ${w}`)
  assert.deepEqual(words(parts.join(' ')), words(line), `width ${w}: ${JSON.stringify(parts)}`)
}

test('wrapToWidth keeps the bench’s "takes this if you don’t answer" hint intact — regression: a retreat used to swallow the space after the retreated word, gluing it to the next one (seen in docs/demo.gif)', () => {
  const line = '### 1 · Keep current CDN   ← takes this if you don’t answer'
  // 20–80 spans every detail-pane width a real terminal produces, including
  // the ~52–53 columns docs/demo.tape renders at, where this used to merge
  // "don’t" and "answer" into one word with no space between them.
  for (let w = 20; w <= 80; w++) assertWordsPreserved(line, w)
})

test('wrapToWidth never drops or merges words, for every space-delimited language’s default-decision hint', () => {
  // zh-Hans/zh-Hant have no inter-word spaces in their hint (CJK wraps
  // anywhere by design) — word preservation isn't a meaningful contract
  // there, so they're covered by the character-preservation test above instead.
  const spaceDelimited = LANGUAGES.filter((l) => l !== 'zh-Hans' && l !== 'zh-Hant')
  for (const lng of spaceDelimited) {
    setLang(lng)
    try {
      const line = `### 1 · Some Option Title${t('bench.detail.defaultHint')}`
      for (let w = 15; w <= 80; w++) assertWordsPreserved(line, w)
    } finally {
      setLang('en')
    }
  }
})

test('fit truncates on display width, not character count', () => {
  assert.equal(stringWidth(fit('部署守门规则要多严', 8)) <= 8, true)
  assert.equal(fit('short', 40), 'short')
})

test('the frame is exactly rows-1 lines and never reaches the last column', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // a line padded to the full width would wrap in the terminal and scroll the buffer on redraw
  for (const rows of [10, 24, 51]) {
    for (const width of [40, 79, 120]) {
      const frame = frameFor(store, { rows, width })
      assert.equal(frame.length, rows - 1, `${width}x${rows} produced ${frame.length} lines`)
      for (const line of frame) {
        assert.ok(lineWidth(line) <= width, `a line was ${lineWidth(line)} wide at width ${width}`)
      }
    }
  }
})

test('the scroll marker stays inside the frame at every offset', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const offset of [0, 5, 50, Number.MAX_SAFE_INTEGER]) {
    const frame = frameFor(store, { offset })
    for (const line of frame) assert.ok(lineWidth(line) <= 79)
  }
})

test('every mode and scope renders at the right height', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const mode of ['browse', 'confirm', 'note', 'attach', 'help'] as const) {
    const frame = frameFor(store, { mode, pendingKey: '2', draft: 'press 2 first' })
    assert.equal(frame.length, 23, `mode ${mode}`)
    for (const line of frame) assert.ok(lineWidth(line) <= 79, `mode ${mode} overflowed`)
  }
  for (const view of VIEWS) {
    const frame = frameFor(store, { view })
    assert.equal(frame.length, 23, `view ${view}`)
    for (const line of frame) assert.ok(lineWidth(line) <= 79, `view ${view} overflowed`)
  }
})

test('an empty queue renders calmly instead of crashing', () => {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-'))
  try {
    const store = new Store([initLayout(root)])
    const frame = frameFor(store)
    assert.equal(frame.length, 23)
    assert.ok(frame.some((l) => l.some((s) => s.text.includes('Nothing needs a decision'))))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the default option is marked so Enter is not a guess', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = frameFor(store)
    .map((l) => l.map((s) => s.text).join(''))
    .join('\n')
  assert.ok(text.includes('(⏎)'), 'the default option must be visibly marked')
})

test('an answered entry leaves Decide and Active, and waits in Available for an AI to pick it up', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = listFor(store)[0]
  store.answer(first, { choice: '2', note: 'press 2 first' })

  assert.ok(!listFor(store, 'decide').some((d) => d.id === first.id), 'no answered group in Decide any more')
  assert.ok(!listFor(store, 'active').some((d) => d.id === first.id), 'Active is running + Decide only')
  assert.ok(listFor(store, 'available').some((d) => d.id === first.id), 'Available has it, as answered — for AI')
  assert.ok(listFor(store, 'all').some((d) => d.id === first.id), 'All still shows it')
})

test('styleLine strips markdown emphasis rather than printing the asterisks', () => {
  assert.equal(styleLine('**What this is.** A gate.').text, 'What this is. A gate.')
  assert.equal(styleLine('## Section').text, 'Section')
  assert.equal(styleLine('## Section').bold, true)
})

test('condensed view keeps the framing paragraphs', () => {
  // condense() (src/tui/model.ts) only recognizes these paragraph markers in Chinese
  // (为什么/这是什么/…) — a source-level i18n gap, kept as-is here rather than worked around.
  const d = {
    body: '**这是什么.** keep-one.\n\n**stats.** drop-this.\n\n**为什么.** keep-two.',
  } as Decision
  const short = condense(d)
  assert.ok(short.includes('keep-one'))
  assert.ok(short.includes('keep-two'))
  assert.ok(!short.includes('drop-this'))
})

test('bodyLines wraps to the requested width', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const d = listFor(store)[0]
  for (const line of bodyLines(d, 50, false)) assert.ok(stringWidth(line) <= 50)
})

test('mouse sequences parse, and nothing else does', () => {
  assert.deepEqual(parseMouse('[<64;10;5M'), { kind: 'wheel-up', x: 10, y: 5, button: 64 })
  assert.deepEqual(parseMouse('[<65;10;5M'), { kind: 'wheel-down', x: 10, y: 5, button: 65 })
  assert.deepEqual(parseMouse('[<0;12;3M'), { kind: 'press', x: 12, y: 3, button: 0 })
  assert.equal(parseMouse('[<0;12;3m')?.kind, 'release')
  assert.equal(parseMouse('j'), null)
  assert.equal(parseMouse('[A'), null)
  assert.ok(isMouse('[<0;1;1M'))
  assert.ok(!isMouse('q'))
})

test('a click lands on whatever was drawn under it', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const s = frameInput(store)
  const g = geometry(s)
  const frame = buildFrame(s, g)

  // The first list row is the group header — not selectable; the nodes follow.
  assert.equal(hitTest(s, g, 3, g.listRow0 + 1), null, 'a group header is not a hit')
  assert.deepEqual(hitTest(s, g, 3, g.listRow0 + 2), { on: 'list', index: 1 })
  assert.deepEqual(hitTest(s, g, 3, g.listRow0 + 3), { on: 'list', index: 2 })
  assert.equal(hitTest(s, g, 3, g.listRow0 + 40), null, 'past the end of the list is not a hit')
  const waiting = g.tabSpans.find((t) => t.view === 'waiting')!
  assert.deepEqual(hitTest(s, g, waiting.from + 1, 1), { on: 'tab', view: 'waiting' })
  assert.ok(frame[0].map((x) => x.text).join('').includes('Waiting'), 'the tab is drawn where it is clickable')

  // each option must be clickable under the text actually drawn; options wrap across rows, so each span tracks its own row
  for (const span of g.optionSpans) {
    const hit = hitTest(s, g, span.from + 1, span.row! + 1)
    assert.deepEqual(hit, { on: 'option', key: span.key }, `column ${span.from + 1}`)
    const drawn = frame[span.row!].map((seg) => seg.text).join('')
    assert.ok(drawn.includes(span.key), 'the span names a key that is on screen')
    assert.ok(span.from + (span.to - span.from) <= 79, 'and it is inside the frame')
  }
  assert.ok(new Set(g.optionSpans.map((sp) => sp.row)).size > 1, 'the options wrapped at 79 columns')
  assert.equal(g.optionSpans.length, 3)
  assert.deepEqual(
    g.optionSpans.map((sp) => sp.key),
    ['1', '2', '3'],
  )

  const bodyHit = hitTest(s, g, g.lw + 5, g.bodyRow0 + 1)
  assert.deepEqual(bodyHit, { on: 'body' })
})

test('clicking in the note field puts the caret on the character you pointed at', () => {
  // Mixed width: each CJK glyph is two columns, so a naive index would drift.
  const draft = '先按 2 走'
  const x0 = 10
  assert.equal(caretFromColumn(draft, x0, x0), 0)
  assert.equal(caretFromColumn(draft, x0, x0 + 2), 1)
  assert.equal(caretFromColumn(draft, x0, x0 + 4), 2)
  assert.equal(caretFromColumn(draft, x0, x0 + 999), [...draft].length, 'past the end goes to the end')
})

test('the draft renders an insertion point without losing characters', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const s = frameInput(store, { mode: 'note', draft: '先按 2 走', caret: 2 })
  const line = buildFrame(s, geometry(s))[geometry(s).promptRow]
  const text = line.map((seg) => seg.text).join('')
  assert.ok(text.includes('先按 2 走'), text)
  assert.ok(line.some((seg) => seg.inverse), 'the caret cell is inverted')
})

test('image protocol detection refuses where a sequence would be mangled', () => {
  assert.equal(imageProtocol({ TERM_PROGRAM: 'iTerm.app' }), 'iterm')
  assert.equal(imageProtocol({ LC_TERMINAL: 'iTerm2' }), 'iterm')
  assert.equal(imageProtocol({ TERM: 'xterm-kitty' }), 'kitty')
  assert.equal(imageProtocol({ GHOSTTY_RESOURCES_DIR: '/x' }), 'kitty')
  assert.equal(imageProtocol({ TERM: 'xterm-256color' }), null)
  // a multiplexer eats the escape sequence, and half a sequence is garbage on screen
  assert.equal(imageProtocol({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/x' }), null)
  assert.equal(imageProtocol({ TERM_PROGRAM: 'iTerm.app', DECS_IMAGES: 'off' }), null)
})

test('the image sequence carries the file and the requested cell size', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-img-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAAhKDveWkH9passAAAAASUVORK5CYII=',
    'base64',
  )
  const file = join(root, 'shot.png')
  writeFileSync(file, png)

  const iterm = renderImage(file, { cols: 40 }, 'iterm')
  assert.ok(iterm.sequence.startsWith('\x1b]1337;File='))
  assert.ok(iterm.sequence.includes(`size=${png.length}`))
  assert.ok(iterm.sequence.includes('width=40'))
  assert.ok(iterm.sequence.includes(png.toString('base64')))
  assert.ok(iterm.sequence.endsWith('\x07'))

  const kitty = renderImage(file, { cols: 40, rows: 10 }, 'kitty')
  assert.ok(kitty.sequence.startsWith('\x1b_G'))
  assert.ok(kitty.sequence.includes('c=40,r=10'))
  assert.ok(kitty.sequence.endsWith('\x1b\\'))

  assert.equal(renderImage(file, {}, null).sequence, '')
  assert.match(renderImage(join(root, 'notes.txt'), {}, 'iterm').reason ?? '', /not an image/)
  assert.match(renderImage(join(root, 'missing.png'), {}, 'iterm').reason ?? '', /ENOENT/)
})

test('image mode renders a blank frame so the picture has somewhere to land', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const frame = frameFor(store, { mode: 'image', imageSel: 0, zoomable: true })
  assert.equal(frame.length, 23)
  const printed = frame.map((l) => l.map((s) => s.text).join('').trim()).filter(Boolean)
  assert.equal(printed.length, 1, 'everything but the caption must be blank')
  assert.match(printed[0], /q back/)
  assert.match(printed[0], /now 100%/)
})

test('the caption falls back to a plain return hint when the format cannot be zoomed', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const frame = frameFor(store, { mode: 'image', imageSel: 0, zoomable: false })
  const printed = frame.map((l) => l.map((s) => s.text).join('')).find((l) => l.trim())
  assert.match(printed ?? '', /format can’t zoom/)
  assert.match(printed ?? '', /q back/)
})

test('zoomIn/zoomOut stay within [ZOOM_MIN, ZOOM_MAX], and bottoming out resets the centre', () => {
  let z = RESET
  for (let i = 0; i < 20; i++) z = zoomIn(z)
  assert.ok(z.zoom <= ZOOM_MAX)

  z = { zoom: ZOOM_MAX, cx: 0.8, cy: 0.2 }
  for (let i = 0; i < 20; i++) z = zoomOut(z)
  assert.deepEqual(z, RESET, 'bottoming out re-centres, since fit has nowhere to pan')
})

test('cropRect covers the whole image at fit, and shrinks symmetrically as zoom increases', () => {
  const fit = cropRect(RESET, 200, 100)
  assert.deepEqual(fit, { x: 0, y: 0, width: 200, height: 100 })

  const z2 = cropRect({ zoom: 2, cx: 0.5, cy: 0.5 }, 200, 100)
  assert.deepEqual(z2, { x: 50, y: 25, width: 100, height: 50 })
})

test('cropRect clamps to the image bounds when the centre sits near an edge', () => {
  const nearCorner = cropRect({ zoom: 4, cx: 0.02, cy: 0.98 }, 200, 100)
  assert.ok(nearCorner.x >= 0 && nearCorner.x + nearCorner.width <= 200)
  assert.ok(nearCorner.y >= 0 && nearCorner.y + nearCorner.height <= 100)
  assert.equal(nearCorner.x, 0, 'clamped against the left edge')
  assert.equal(nearCorner.y, 100 - nearCorner.height, 'clamped against the bottom edge')
})

test('pan is a no-op at fit and otherwise stays inside the image', () => {
  const atFit = pan(RESET, 1, 0, 200, 100)
  assert.deepEqual(atFit, RESET)

  let z: typeof RESET = { zoom: 4, cx: 0.5, cy: 0.5 }
  // walk far past the right/bottom edge; the crop rectangle must never spill outside the image
  for (let i = 0; i < 50; i++) z = pan(z, 1, 1, 200, 100)
  const rect = cropRect(z, 200, 100)
  assert.ok(rect.x + rect.width <= 200)
  assert.ok(rect.y + rect.height <= 100)
  assert.equal(rect.x, 200 - rect.width)
  assert.equal(rect.y, 100 - rect.height)

  // And back the other way past the opposite edge.
  for (let i = 0; i < 50; i++) z = pan(z, -1, -1, 200, 100)
  const back = cropRect(z, 200, 100)
  assert.equal(back.x, 0)
  assert.equal(back.y, 0)
})

test('zoomHintText names the keys and the current percentage, or says the format is unsupported', () => {
  assert.match(zoomHintText(RESET, true), /now 100%/)
  assert.match(zoomHintText({ zoom: 2, cx: 0.5, cy: 0.5 }, true), /now 200%/)
  assert.doesNotMatch(zoomHintText(RESET, false), /%/)
  assert.match(zoomHintText(RESET, false), /format can’t zoom/)
})

// ---------------------------------------------------------------------------
// images: focus/cycle, label-group switch, HTML-in-browser, proportional big-view layout
// ---------------------------------------------------------------------------

function withAttachments(attachments: Attachment[]): Decision {
  return { attachments } as unknown as Decision
}

test('firstHtmlAttachmentIndex finds the first .html/.htm attachment, ignoring query/hash, -1 when none', () => {
  const withHtml = withAttachments([
    { label: 'a', target: 'a.png', image: true },
    { label: 'b', target: 'review.html?x=1#y', image: false },
    { label: 'c', target: 'c.htm', image: false },
  ])
  assert.equal(firstHtmlAttachmentIndex(withHtml), 1)
  const withoutHtml = withAttachments([{ label: 'a', target: 'a.png', image: true }])
  assert.equal(firstHtmlAttachmentIndex(withoutHtml), -1)
})

test('imageLayout: a tall, narrow image fills the box height and leaves most of the width for text', () => {
  const layout = imageLayout(100, 1000, 100, 40)
  assert.equal(layout.imageRows, 40, 'full height, same as preserveAspectRatio would do')
  assert.ok(layout.imageCols < 10, `expected a narrow sliver, got ${layout.imageCols} cols`)
  assert.ok(layout.textCols > 80, `expected most of the width left over, got ${layout.textCols}`)
  assert.equal(layout.textX + layout.textCols, 100)
})

test('imageLayout: a wide image fills the box width and leaves no side panel', () => {
  const layout = imageLayout(1000, 100, 100, 40)
  assert.equal(layout.imageCols, 100, 'fills the full width')
  assert.ok(layout.imageRows <= 40)
  assert.equal(layout.textCols, 0, 'nothing to the side of a wide image')
})

test('imageLayout never exceeds the box in either dimension, across a spread of aspect ratios', () => {
  for (const [w, h] of [[1, 1], [16, 9], [9, 16], [3, 4], [4, 3], [1, 100], [100, 1]]) {
    for (const [boxCols, boxRows] of [[20, 10], [80, 24], [10, 40]]) {
      const l = imageLayout(w, h, boxCols, boxRows)
      assert.ok(l.imageCols <= boxCols, `${w}x${h} in ${boxCols}x${boxRows}: imageCols ${l.imageCols} > box`)
      assert.ok(l.imageRows <= boxRows, `${w}x${h} in ${boxCols}x${boxRows}: imageRows ${l.imageRows} > box`)
      assert.ok(l.textCols >= 0)
      assert.equal(l.textX + l.textCols, boxCols)
    }
  }
})

test('imageLayout degrades to "no panel" rather than throwing on a zero-size box or image', () => {
  assert.deepEqual(imageLayout(0, 0, 50, 20), { imageCols: 50, imageRows: 20, textX: 50, textCols: 0, textRows: 20 })
  assert.deepEqual(imageLayout(100, 100, 0, 0), { imageCols: 0, imageRows: 0, textX: 0, textCols: 0, textRows: 0 })
})

test('image mode: the big view grows a text panel next to a tall, narrow image, and shows its caption', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const d = store.create({ title: 't', author: 'a · x' })
  store.attach(d, [(() => {
    const p = join(root, 'tall.png')
    writeFileSync(p, 'x')
    return p
  })()], { groups: ['Option 1'], captions: ['this is what it looked like before'] })
  const current = listFor(store)[0]

  const frame = buildFrame(
    frameInput(store, { current, mode: 'image', imageSel: 0, zoomable: true, imageSize: { width: 100, height: 1000 } }),
  )
  const text = frame.map((l) => l.map((s) => s.text).join('')).join('\n')
  assert.match(text, /Option 1/)
  assert.match(text, /what it looked like before/)
})

test('image mode: no panel (old single-caption-line behaviour) when the image size is unknown', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const frame = frameFor(store, { mode: 'image', imageSel: 0, zoomable: true, imageSize: null })
  const printed = frame.map((l) => l.map((s) => s.text).join('').trim()).filter(Boolean)
  assert.equal(printed.length, 1, 'unchanged from before imageLayout existed')
})

test('the attachment picker says which action a digit will take', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'a · x' })
  const current = listFor(store)[0]
  const text = (pickToOpen: boolean) => {
    const input = frameInput(store, { current, mode: 'attach', pickToOpen })
    return buildFrame(input, geometry(input)).flat().map((s) => s.text).join('')
  }
  // `O` with several attachments must not silently draw instead of opening.
  assert.match(text(true), /open that attachment in the system viewer/)
  assert.match(text(false), /view that attachment/)
})

test('the attachment row says where outbound content stands', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-tui-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  store.create({ title: 't', author: 'a · x' })
  const draft = join(root, 'draft.html')
  writeFileSync(draft, '<p>hi</p>')
  store.attach(listFor(store)[0], [draft], { approvalContent: true })
  const render = () => {
    const input = frameInput(store, { view: 'all', current: listFor(store, 'all')[0] })
    return buildFrame(input, geometry(input)).flat().map((s) => s.text).join('')
  }
  assert.match(render(), /draft\.html[^\n]*pending approval/)
  store.answer(listFor(store, 'all')[0], { choice: '1' })
  assert.match(render(), /approved/)
})

test('imageLayout: a real 2:1 screenshot fills the height and most of the width', () => {
  // a wide screenshot must fill the available height, not get squeezed by a wrong cell aspect ratio
  const l = imageLayout(2367, 1210, 180, 40)
  assert.equal(l.imageRows, 40, 'uses the full height')
  // 40 rows × (2367/1210) × 2 ≈ 156 columns.
  assert.ok(l.imageCols >= 150 && l.imageCols <= 160, `expected ~156 cols, got ${l.imageCols}`)
  assert.ok(l.textCols < 30, `only the true leftover goes to the side panel, got ${l.textCols}`)
})

test('repaintRows rewrites exactly the given frame rows, each at its own row and erased first', () => {
  const frame = [[{ text: 'head' }], [{ text: 'a', bold: true }, { text: 'b', color: 'cyan' }], [{ text: '' }], [{ text: 'tail' }]]
  const out = repaintRows(frame, 1, 3)
  assert.equal(out, '\x1b[2;1H\x1b[2K\x1b[1ma\x1b[0m\x1b[36mb\x1b[0m\x1b[3;1H\x1b[2K')
  assert.ok(!out.includes('head') && !out.includes('tail'))
})

test('a note heading too long for the pane still reads as "Agent | name | when" on every wrapped line, and the text decs wrote under it shows in the bench language — regression: an English bench showed the raw 等待 heading and 等 Carol', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const d = store.create({ title: 'dark mode polish', author: 'ui-lane · theming', task: true })
  store.hold(d, 'Carol: final icon set', 'demo-setup · mock data with a long author line')
  const held = store.all().find((x) => x.id === d.id)!
  const text = bodyLines(held, 30, false).join('\n')
  assert.match(text, /Agent \| demo-setup \|/)
  assert.match(text, /waiting on Carol: final icon/)
  assert.doesNotMatch(text, /等/)
})

test('writer marks and other HTML comments in a body never show in the bench — regression: "<!-- nod:by=lane-x -->" showed under notes', (t) => {
  const { store, root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const d = store.create({ title: 'marker', author: 'lane-x · test', task: true, body: 'first line\n<!-- nod:by=lane-x -->\nsecond line\n<!-- /分组 -->' })
  const text = bodyLines(d, 60, false).join('\n')
  assert.doesNotMatch(text, /<!--/)
  assert.match(text, /first line/)
  assert.match(text, /second line/)
})
