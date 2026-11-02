import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { targetPath } from '../src/cli/commands/open.ts'
import { buildOverview } from '../src/core/overview.ts'
import { initLayout } from '../src/core/paths.ts'
import { HEADING } from '../src/core/format.ts'
import { Store } from '../src/core/store.ts'
import type { Decision } from '../src/core/types.ts'
import { buildFrame, geometry, hitTest, type FrameInput } from '../src/tui/app.ts'
import { IMAGE_MARK, ensureVisible, imageName, nodeImages, placeholderText, selectableImages, splitImageLinks, stepImage, stepSelectable } from '../src/tui/images.ts'
import { bodyRows } from '../src/tui/model.ts'
import { nearestSelectable, rowsFor } from '../src/tui/views.ts'
import { RESET, zoomHintText } from '../src/tui/zoom.ts'
import { fit, graphemes, stringWidth, wrapToWidth } from '../src/tui/width.ts'
import { KEY, bench, has } from './tui-harness.ts'

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')

function tmpStore(t: { after: (fn: () => void) => void }): { store: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'decs-img-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { store: new Store([initLayout(root)]), root }
}

/** Writes `files` next to the node file (paths relative to it, as a body link would say). */
function besideNode(d: Decision, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dirname(d.file), rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
}

function frameInput(store: Store, over: Partial<FrameInput> = {}): FrameInput {
  const items = over.items ?? store.all()
  const list = over.list ?? rowsFor('all', items)
  const index = over.index ?? nearestSelectable(list, 0, 1)
  const now = Date.now()
  return {
    view: 'all', list, index, current: index >= 0 ? list[index]?.node : undefined, items,
    overview: buildOverview(items, now), now, rows: 30, width: 119, offset: 0, condensed: false,
    mode: 'browse', draft: '', caret: 0, imageSel: 0, pendingKey: null, banner: null, zoom: RESET,
    zoomable: false, detailFocus: false, imageSize: null,
    ...over,
  }
}

const LONG = Array.from({ length: 50 }, (_, i) => `line ${i}, padding out the body.`).join('\n')

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('splitImageLinks: prose around links, several per line, titles and <angle> targets', () => {
  assert.deepEqual(splitImageLinks('see ![a](x.png) and ![](<y z.png>) end'.replace('y z', 'yz')), [
    { text: 'see ' },
    { alt: 'a', target: 'x.png' },
    { text: ' and ' },
    { alt: '', target: 'yz.png' },
    { text: ' end' },
  ])
  assert.deepEqual(splitImageLinks('![t](a.png "title")'), [{ alt: 't', target: 'a.png' }])
  assert.deepEqual(splitImageLinks('[not an image](a.png)'), [{ text: '[not an image](a.png)' }])
})

test('nodeImages: body links in document order, then image attachments; code fences and the attachments heading are not body images', (t) => {
  const { store, root } = tmpStore(t)
  const att = join(root, 'att.png')
  const html = join(root, 'page.html')
  writeFileSync(att, 'p')
  writeFileSync(html, '<p>')
  let d = store.create({
    title: 't',
    author: 'a · x',
    body: ['![one](shots/1.png)', '```', '![example](nope.png)', '```', 'mid ![two](../up/2.png) tail', '## something else', '![](/abs/3.png)'].join('\n'),
  })
  d = store.attach(d, [att, html], { groups: ['Option 1'], captions: ['before'] })
  const imgs = nodeImages(d)
  assert.deepEqual(
    imgs.map((i) => [i.source, i.alt, i.target]),
    [
      ['body', 'one', 'shots/1.png'],
      ['body', 'two', '../up/2.png'],
      ['body', '', '/abs/3.png'],
      ['attachment', 'att.png', d.attachments[0].target],
    ],
    'the html attachment is not an image; the fenced example is not a picture',
  )
  assert.equal(imgs[3].attachment, 0)
  assert.equal(imgs[3].group, 'Option 1')
  assert.equal(imgs[3].caption, 'before')
  // Relative targets resolve against the node file, same as attachments.
  assert.equal(targetPath(d.file, 'shots/1.png'), join(dirname(d.file), 'shots/1.png'))
  assert.equal(targetPath(d.file, '../up/2.png'), join(dirname(dirname(d.file)), 'up/2.png'))
})

test('placeholderText: alt text, else the file name; a --label group rides along', () => {
  assert.equal(placeholderText({ alt: 'login page', target: 'a.png' }), '🖼️ login page')
  assert.equal(placeholderText({ alt: '', target: 'dir/shot.png?x=1' }), '🖼️ shot.png')
  assert.equal(placeholderText({ alt: 'a.png', target: 'a.png', group: 'Option 2' }), '🖼️ a.png（Option 2）')
  assert.equal(imageName({ alt: '', target: 'https://x.test/p/q.png' }), 'q.png')
})

test('bodyRows: each image link is its own placeholder line in place, prose keeps its lines, a body-level ## 附件 renders right where it sits, styled like any other heading', () => {
  const d = {
    body: `intro\n\nbefore ![first](a.png) after\n\n![](dir/b.png)\n\n## ${HEADING.attachments}\n\n![att.png](att.png)\n`,
    attachments: [{ label: 'att.png', target: 'att.png', image: true }],
  } as unknown as Decision
  const rows = bodyRows(d, 60, false)
  assert.deepEqual(
    rows.map((r) => [r.text, r.image]),
    [
      ['intro', undefined],
      ['', undefined],
      ['before', undefined],
      ['🖼️ first', 0],
      ['after', undefined],
      ['', undefined],
      ['🖼️ b.png', 1],
      ['', undefined],
      ['Attachments', undefined], // the same sectionLabel() styling as any other heading — not the raw "## 附件" text
      ['', undefined],
      ['🖼️ att.png', 2],
    ],
  )
  assert.equal(rows[8].style?.bold, true)
})

test('bodyRows: an attachment under a note renders right after that note, not bucketed with the body\'s own', () => {
  const d = {
    body: [
      'intro',
      '',
      `## ${HEADING.attachments}`,
      '',
      '![before.png](before.png)',
      '',
      '## 回复（human · owner · 2026-10-28 10:51:30）',
      '',
      'see this one',
      '',
      `## ${HEADING.attachments}`,
      '',
      '![after.png](after.png)',
      '',
    ].join('\n'),
    attachments: [
      { label: 'before.png', target: 'before.png', image: true },
      { label: 'after.png', target: 'after.png', image: true },
    ],
  } as unknown as Decision
  const rows = bodyRows(d, 60, false)
  const texts = rows.map((r) => [r.text, r.image])
  assert.match(String(texts[6][0]), /^User \| /, 'the note heading, whatever "ago" text it carries')
  texts[6][0] = 'User | …'
  assert.deepEqual(texts, [
    ['intro', undefined],
    ['', undefined],
    ['Attachments', undefined],
    ['', undefined],
    ['🖼️ before.png', 0],
    ['', undefined],
    ['User | …', undefined],
    ['', undefined],
    ['see this one', undefined],
    ['', undefined],
    ['Attachments', undefined],
    ['', undefined],
    ['🖼️ after.png', 1],
  ])
})

test('bodyRows: the condensed body still points each placeholder at its entry in the full list', (t) => {
  const { store } = tmpStore(t)
  // condense() (src/tui/model.ts) only recognizes these paragraph markers in Chinese
  // (为什么/这是什么/…) — a source-level i18n gap, kept as-is here rather than worked around.
  const d = store.create({
    title: 't',
    author: 'a · x',
    body: '![dropped](x.png)\n\n**是什么。** some text\n\n**为什么现在要决。** ![kept](y.png)',
  })
  const rows = bodyRows(d, 60, true)
  const placeholders = rows.filter((r) => r.image !== undefined)
  assert.deepEqual(placeholders.map((r) => [r.text, r.image]), [['🖼️ kept', 1]])
})

test('🖼️ is one grapheme, two columns, and a cut never separates it from its VS16', () => {
  assert.equal(IMAGE_MARK, '\u{1F5BC}\uFE0F', 'emoji presentation, so terminals and string-width agree on two columns')
  assert.equal(graphemes(IMAGE_MARK).length, 1)
  assert.equal(stringWidth(IMAGE_MARK), 2)
  const line = placeholderText({ alt: 'login page after deploy', target: 'a.png' })
  assert.equal(stringWidth(line), 2 + 1 + stringWidth('login page after deploy'))
  for (let w = 1; w <= stringWidth(line) + 1; w++) {
    const cut = fit(line, w)
    assert.ok(stringWidth(cut) <= w, `fit(…, ${w}) is ${stringWidth(cut)} wide: ${JSON.stringify(cut)}`)
    // Either the whole mark is kept or none of it: a stray U+1F5BC would be one column narrower than measured.
    if (cut.includes('\u{1F5BC}')) assert.ok(cut.startsWith(IMAGE_MARK), `split mark at width ${w}`)
  }
  for (const w of [3, 4, 7]) {
    const parts = wrapToWidth(`${IMAGE_MARK}${IMAGE_MARK} xy ${IMAGE_MARK}`, w)
    for (const p of parts) assert.ok(stringWidth(p) <= w, `${JSON.stringify(p)} over ${w}`)
    assert.equal(parts.join('').replace(/ /g, ''), `${IMAGE_MARK}${IMAGE_MARK}xy${IMAGE_MARK}`)
  }
})

test('a 🖼️ line in a narrow, scrolling pane is cut to the pane and keeps the scrollbar in its column, and is still clickable', (t) => {
  const { store } = tmpStore(t)
  store.create({ title: 't', author: 'a · x', body: `![${'a very long image caption '.repeat(10)}](a.png)\n\n${LONG}` })
  for (const width of [59, 79, 119]) {
    const s = frameInput(store, { width, detailFocus: true })
    const g = geometry(s)
    const frame = buildFrame(s, g)
    const y = frame.findIndex((l) => text(l).includes(IMAGE_MARK))
    assert.ok(y > 0, `placeholder drawn at width ${width}`)
    const row = text(frame[y])
    const below = text(frame[y + 1])
    assert.ok(stringWidth(row) <= width, `${stringWidth(row)} > ${width}`)
    assert.equal(stringWidth(row), stringWidth(below), 'same width as the prose line under it')
    assert.ok(row.endsWith('│') || row.endsWith('█'), 'the scrollbar column is still the last one')
    assert.ok(row.includes('…'), 'the long alt is cut, marked')
    assert.deepEqual(hitTest(s, g, width - 3, y + 1), { on: 'image', n: 0 })
  }
})

// ---------------------------------------------------------------------------
// Selection, scrolling
// ---------------------------------------------------------------------------

test('stepImage stops at either end and says which', () => {
  assert.deepEqual(stepImage(0, 3, 1), { index: 1 })
  assert.deepEqual(stepImage(2, 3, 1), { index: 2, edge: 'last' })
  assert.deepEqual(stepImage(0, 3, -1), { index: 0, edge: 'first' })
  assert.deepEqual(stepImage(9, 3, -1), { index: 1 }, 'a stale index is clamped first')
  assert.deepEqual(stepImage(0, 0, 1), { index: 0 })
})

test('stepSelectable walks only images whose placeholder is drawn, and gets back on track from a hidden one', () => {
  const rows = [-1, 5, -1, 9] // 0 and 2 dropped by the condensed body
  assert.deepEqual(selectableImages(rows), [1, 3])
  assert.deepEqual(stepSelectable(1, rows, 1), { index: 3 }, 'skips the hidden 2')
  assert.deepEqual(stepSelectable(3, rows, 1), { index: 3, edge: 'last' })
  assert.deepEqual(stepSelectable(1, rows, -1), { index: 1, edge: 'first' }, 'the hidden 0 is not "before" it')
  assert.deepEqual(stepSelectable(0, rows, 1), { index: 1 }, 'from a hidden one, the next shown one')
  assert.deepEqual(stepSelectable(2, rows, -1), { index: 1 })
  assert.deepEqual(stepSelectable(0, rows, -1), { index: 1, edge: 'first' })
  assert.deepEqual(stepSelectable(2, [-1, -1, -1], 1), { index: 2 }, 'nothing shown: stay put')
})

test('ensureVisible scrolls as little as possible, and clamps an offset that ran past the end', () => {
  assert.equal(ensureVisible(5, 0, 10, 40), 0, 'already on screen')
  assert.equal(ensureVisible(15, 0, 10, 40), 6, 'below: lands on the last row')
  assert.equal(ensureVisible(3, 20, 10, 40), 3, 'above: lands on the first row')
  assert.equal(ensureVisible(35, 999, 10, 40), 30, 'j kept counting past the end')
  assert.equal(ensureVisible(-1, 7, 10, 40), 7, 'not drawn: leave it')
  assert.equal(ensureVisible(2, 0, 10, 4), 0, 'short body never scrolls')
})

test('geometry: placeholder rows, selection highlight only while the detail pane has focus', (t) => {
  const { store } = tmpStore(t)
  store.create({ title: 't', author: 'a · x', body: 'x\n\n![a](a.png)\n\n![b](b.png)' })
  const s = frameInput(store, { detailFocus: true, imageSel: 1 })
  const g = geometry(s)
  const [ra, rb] = g.bodyImageRows
  assert.equal(text(g.body[ra]).trim(), '🖼️ a')
  assert.equal(text(g.body[rb]).trim(), '🖼️ b')

  const frame = buildFrame(s, g)
  const lineOf = (label: string) => frame.find((l) => text(l).includes(label))!
  const segOf = (label: string) => lineOf(label).find((seg) => seg.text.includes(label))!
  assert.ok(segOf('🖼️ b').inverse, 'selected one inverted')
  assert.ok(!segOf('🖼️ a').inverse, 'the other one not')
  assert.equal(segOf('🖼️ a').color, 'magenta', 'placeholders are styled apart from prose')

  const unfocused = buildFrame(frameInput(store, { detailFocus: false, imageSel: 1 }))
  assert.ok(!unfocused.flat().some((seg) => seg.text.includes('[Image]') && seg.inverse), 'no highlight with focus in the list')
  assert.match(text(frame[frame.length - 1]), /Pick image/, 'the prompt line says how to get out')
})

test('hitTest: a click on a placeholder is that image, scrolled or not; elsewhere in the body is just body', (t) => {
  const { store } = tmpStore(t)
  store.create({ title: 't', author: 'a · x', body: `![top](a.png)\n\n${LONG}\n\n![bottom](b.png)` })
  const s0 = frameInput(store)
  const g0 = geometry(s0)
  const x = g0.lw + 4
  const rowOf = (g: typeof g0, n: number) => g.bodyRow0 + (g.bodyImageRows[n] - g.bodyOffset) + 1 // 1-based terminal row
  assert.deepEqual(hitTest(s0, g0, x, rowOf(g0, 0)), { on: 'image', n: 0 })
  assert.deepEqual(hitTest(s0, g0, x, rowOf(g0, 0) + 1), { on: 'body' })
  assert.ok(g0.bodyImageRows[1] >= g0.bodyOffset + g0.bodyRows, 'the bottom image starts off screen')

  const off = ensureVisible(g0.bodyImageRows[1], 0, g0.bodyRows, g0.body.length)
  const s1 = frameInput(store, { offset: off })
  const g1 = geometry(s1)
  assert.equal(g1.bodyOffset, off)
  assert.deepEqual(hitTest(s1, g1, x, rowOf(g1, 1)), { on: 'image', n: 1 })
  assert.equal(rowOf(g1, 1), g1.bodyRow0 + g1.bodyRows, 'auto-scroll puts it on the last body row')
  assert.ok(text(buildFrame(s1, g1)[rowOf(g1, 1) - 1]).includes('🖼️ bottom'), 'and that is where it is drawn')
  assert.notEqual(hitTest(s1, g1, 2, rowOf(g1, 1))?.on, 'image', 'the same row in the left pane is not the image')
})

test('big view: names the image, counts n/total, and offers ←→ only when there is more than one', (t) => {
  const { store } = tmpStore(t)
  store.create({ title: 't', author: 'a · x', body: '![one](a.png) ![](dir/b.png)' })
  const frame = buildFrame(frameInput(store, { mode: 'image', imageSel: 1, banner: 'already the last image' }))
  const top = text(frame[0])
  assert.match(top, /X1 · b\.png/)
  assert.match(top, /2\/2/)
  assert.match(top, /←→ switch image/)
  assert.match(top, /already the last image/, 'the end-of-list hint is visible in the big view')
  assert.doesNotMatch(zoomHintText(RESET, true, false), /switch image/)
  assert.match(zoomHintText({ zoom: 2, cx: 0.5, cy: 0.5 }, true, true), /↑↓←→ move/, 'zoomed in, ←→ pan')
})

// ---------------------------------------------------------------------------
// The real App, on fake streams: keys in, frames and escape sequences out.
// ---------------------------------------------------------------------------

function threeImages(t: { after: (fn: () => void) => void }) {
  const { store, root } = tmpStore(t)
  let d = store.create({ title: 'has images', author: 'a · x', body: `intro\n\n![first](shots/a.png)\n\n${LONG}\n\ntail ![](shots/b.png)` })
  besideNode(d, { 'shots/a.png': 'AAA', 'shots/b.png': 'BBB' })
  const att = join(root, 'c.png')
  writeFileSync(att, 'CCC')
  d = store.attach(d, [att])
  return store
}

test('App: i focuses the detail pane, ↑↓ walk the placeholders and scroll to them, i opens that image, ←→ flip, q comes back to it', async (t) => {
  const b = bench(t, threeImages(t))
  await b.until(has(b, /🖼️ first/))
  await b.press('i')
  await b.until(has(b, /Pick image: /))
  assert.match(b.frame().join('\n'), /Pick image: ↑↓ select/)
  assert.ok(b.frame().some((l) => l.includes('🖼️ first')))
  assert.ok(!b.frame().some((l) => l.includes('🖼️ b.png')), 'the second image is below the fold')

  await b.press(KEY.down)
  await b.until(has(b, /🖼️ b\.png/))
  assert.ok(b.frame().some((l) => l.includes('🖼️ b.png')), 'auto-scrolled to the selection')

  let mark = b.out.chunks.length
  await b.press('i')
  await b.until(() => b.draws(mark).length > 0)
  assert.deepEqual(b.draws(mark), [{ row: 2, col: 1, data: 'BBB' }], 'exactly the selected image, under the caption row')
  assert.match(b.frame()[0], /b\.png +2\/3/)

  mark = b.out.chunks.length
  await b.press(KEY.right)
  await b.until(() => b.draws(mark).length > 0)
  assert.deepEqual(b.draws(mark).map((d) => d.data), ['CCC'], '→ goes on to the attachment image')
  assert.ok(b.order().frame < b.order().draw, 'flipping fast still draws after the new frame')
  assert.ok(b.out.chunks.slice(mark).some((c) => c.includes('\x1b_Ga=d')), 'the previous picture is deleted first')

  mark = b.out.chunks.length
  await b.press(KEY.right)
  await b.until(has(b, /already the last image/))
  await b.quiet()
  assert.deepEqual(b.draws(mark), [], 'nothing past the last one')
  assert.match(b.frame()[0], /already the last image/)

  await b.press(KEY.left, KEY.left)
  await b.until(has(b, /first +1\/3/))
  assert.match(b.frame()[0], /first +1\/3/)

  await b.press(KEY.right)
  await b.until(has(b, /b\.png +2\/3/))
  await b.press('q')
  await b.until(has(b, /Pick image: /))
  assert.match(b.frame().join('\n'), /Pick image: ↑↓ select/, 'still in the detail pane')
  assert.ok(b.frame().some((l) => l.includes('🖼️ b.png')), 'scrolled to the image last shown')
})

test('App: ← leaves the detail pane; → on a leaf enters it; ↑↓ move the list again once out', async (t) => {
  const store = threeImages(t)
  store.create({ title: 'second one', author: 'a · x' })
  const b = bench(t, store)
  await b.until(has(b, /🖼️ first/))
  await b.press(KEY.right)
  await b.until(has(b, /Pick image: /))
  assert.match(b.frame().join('\n'), /Pick image: /)
  await b.press(KEY.left)
  await b.until(() => !has(b, /Pick image: /)())
  assert.doesNotMatch(b.frame().join('\n'), /Pick image: /)
  await b.press(KEY.down)
  await b.until(has(b, /X2  .*\n.*second one/))
  assert.match(b.frame().join('\n'), /X2  .*\n.*second one/, 'the list cursor moved')
  await b.press('i')
  await b.until(has(b, /No images on this node/))
  assert.match(b.frame().join('\n'), /No images on this node/)
})

test('App: clicking a placeholder opens it in the big view', async (t) => {
  const b = bench(t, threeImages(t))
  await b.until(has(b, /🖼️ first/))
  const lines = b.frame()
  const y = lines.findIndex((l) => l.includes('🖼️ first'))
  assert.ok(y > 0)
  // Any column of the right pane on that row is the placeholder.
  const mark = b.out.chunks.length
  await b.press(`\x1b[<0;100;${y + 1}M`)
  await b.until(() => b.draws(mark).length > 0)
  assert.deepEqual(b.draws(mark).map((d) => d.data), ['AAA'])
  assert.match(b.frame()[0], /first +1\/3/)
  const o = b.order()
  assert.ok(o.frame < o.draw, 'the frame is on screen before the picture is drawn over it')
})

/**
 * condense() (src/tui/model.ts) only recognizes these paragraph markers in Chinese
 * (为什么/这是什么/…) — a source-level i18n gap, kept as-is here rather than worked around.
 * `dropped` goes, `kept` and the attachment stay.
 */
function condensable(t: { after: (fn: () => void) => void }, withAttachment = true) {
  const { store, root } = tmpStore(t)
  let d = store.create({
    title: 'condensed view',
    author: 'a · x',
    body: '![dropped](shots/a.png)\n\n**是什么。** one paragraph\n\n**为什么.** ![kept](shots/b.png)',
  })
  besideNode(d, { 'shots/a.png': 'AAA', 'shots/b.png': 'BBB' })
  if (withAttachment) {
    const att = join(root, 'c.png')
    writeFileSync(att, 'CCC')
    d = store.attach(d, [att])
  }
  return store
}

test('App, condensed: only images on screen are selectable — ↑↓, ←→ and the n/total all skip the hidden one', async (t) => {
  const b = bench(t, condensable(t))
  await b.until(has(b, /🖼️ dropped/))
  await b.press('Z')
  await b.until(() => !has(b, /🖼️ dropped/)())
  await b.press('i')
  await b.until(has(b, /Pick image: /))
  let mark = b.out.chunks.length
  await b.press('i')
  await b.until(() => b.draws(mark).length > 0)
  assert.deepEqual(b.draws(mark).map((d) => d.data), ['BBB'], 'i lands on the first image actually shown')
  assert.match(b.frame()[0], /kept +1\/2/, 'counted among the shown ones')

  mark = b.out.chunks.length
  await b.press(KEY.left)
  await b.until(has(b, /already the first image/))
  await b.quiet()
  assert.deepEqual(b.draws(mark), [], '← does not reach the hidden image')

  mark = b.out.chunks.length
  await b.press(KEY.right)
  await b.until(() => b.draws(mark).length > 0)
  assert.deepEqual(b.draws(mark).map((d) => d.data), ['CCC'])
  assert.match(b.frame()[0], /c\.png +2\/2/)

  await b.press('q')
  await b.until(has(b, /Pick image: /))
  await b.press(KEY.up, KEY.up)
  await b.until(has(b, /already the first image/))
  await b.press('i')
  await b.until(() => b.draws(mark).length > 1)
  assert.deepEqual(b.draws(mark).map((d) => d.data), ['CCC', 'BBB'], '↑ from the attachment stops at kept, not dropped')
})

test('App, condensed: Z hiding the selected image moves the selection to one still shown; none shown means no focus', async (t) => {
  const b = bench(t, condensable(t))
  await b.until(has(b, /🖼️ dropped/))
  await b.press('i')
  await b.until(has(b, /Pick image: /))
  await b.press('Z')
  await b.until(() => !has(b, /🖼️ dropped/)())
  const mark = b.out.chunks.length
  await b.press('i')
  await b.until(() => b.draws(mark).length > 0)
  assert.deepEqual(b.draws(mark).map((d) => d.data), ['BBB'], 'selection moved off the hidden image')
})

test('App, condensed: a node whose only image is hidden says so instead of focusing nothing', async (t) => {
  const store = condensable(t, false)
  store.create({ title: 'only a hidden image', author: 'a · x', body: '![hidden](shots/a.png)\n\n**是什么。** one paragraph' })
  const b = bench(t, store)
  await b.until(has(b, /🖼️ dropped/))
  await b.press('Z', KEY.down)
  await b.until(has(b, /only a hidden image/))
  await b.until(() => !has(b, /🖼️ hidden/)())
  await b.press('i')
  await b.until(has(b, /No images in the condensed body/))
  assert.match(b.frame().join('\n'), /No images in the condensed body/)
  assert.doesNotMatch(b.frame().join('\n'), /Pick image: /)
})
