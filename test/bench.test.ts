import { test } from 'node:test'
import { noteHeadline } from '../src/tui/model.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLang } from '../src/i18n/index.ts'

import { askIfDue } from '../src/core/checkins.ts'
import { initLayout } from '../src/core/paths.ts'
import { OTHER_KEY } from '../src/core/questions.ts'
import { Store } from '../src/core/store.ts'
import { buildOverview } from '../src/core/overview.ts'
import type { SourceSummary } from '../src/core/sources.ts'
import { buildSchedule } from '../src/core/sequence.ts'
import { buildFrame, changeBanner, geometry, listWidth, type FrameInput } from '../src/tui/app.ts'
import { approvalLines, cycleOption, initialPicks, optionForKey, picksSummary, questionLines } from '../src/tui/detail.ts'
import { needsOwnerLine, sourcesLine, workingLine } from '../src/tui/summary.ts'
import {
  glyphOf,
  keyOf,
  VIEWS,
  doneGroupKey,
  isSelectable,
  nearestSelectable,
  nodeRowSegments,
  ownerRows,
  resolveIndex,
  rowsFor,
  stepIndex,
  treeRows,
  viewFromArg,
  type Row,
  type View,
} from '../src/tui/views.ts'
import { stringWidth } from '../src/tui/width.ts'
import { RESET } from '../src/tui/zoom.ts'
import { bench, has, KEY } from './tui-harness.ts'

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')
const frameText = (frame: { text: string }[][]) => frame.map(text).join('\n')

function tmpStore(t: { after: (fn: () => void) => void }): Store {
  const root = mkdtempSync(join(tmpdir(), 'decs-bench-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

const A = 'lead · bench test'

/** A lane mid-session: root task, ordered children, an early-answerable question, a release decision blocking the deploy, and a running gate. */
function session(store: Store) {
  const release = store.create({ title: 'ship v2.4', author: A, options: [{ key: '1', label: 'ship' }, { key: '2', label: 'hold' }], default: '1' })
  const root = store.create({ title: 'v2.4 release follow-up', author: A, task: true })
  const deploy = store.create({ title: 'deploy v2.4', author: A, task: true, parent: `${root.id}`, after: [`${release.id}`], est: '30m' })
  const form = store.create({
    title: 'Carol rewrites the onboarding copy',
    author: A,
    parent: `${root.id}`,
    after: [`${deploy.id}`],
    questions: [
      { key: 'Q1', label: 'how to word the heading', body: '', options: [{ key: 'A', label: 'just rewrite it', body: '' }, { key: 'B', label: 'ask first', body: '' }], default: 'A' },
      { key: 'Q2', label: 'home-screen load speed', body: '', options: [{ key: '1', label: 'pass', body: '' }, { key: '2', label: 'fail', body: '' }], default: '1' },
    ],
  })
  const notify = store.create({ title: 'tell Bob to retest', author: A, task: true, parent: `${root.id}`, after: [`${deploy.id}`] })
  const gate = store.create({ title: 'run the full gate', author: 'gate-lane · gate', task: true, staleAfter: '10m' })
  store.start(gate)
  store.progress(store.get(gate.id)!, { progress: 37, progressMsg: 'pytest' })
  return { release, root, deploy, form, notify, gate }
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
    width: 119,
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

const nodeKeys = (rows: Row[]) => rows.filter((r) => r.kind === 'node').map((r) => r.node!.id)

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

test('the tree nests children under their parent, in the order they will happen', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const rows = treeRows(store.all())
  const ids = nodeKeys(rows)
  assert.deepEqual(ids, [s.release.id, s.root.id, s.deploy.id, s.form.id, s.notify.id, s.gate.id])
  const depth = (id: number) => rows.find((r) => r.node?.id === id)!.depth
  assert.equal(depth(s.root.id), 0)
  assert.equal(depth(s.deploy.id), 1)
  assert.equal(depth(s.form.id), 1)
  assert.ok(rows.find((r) => r.node?.id === s.root.id)!.hasKids)
})

test('a sibling that is after another sibling is drawn below it, whatever their numbers', (t) => {
  const store = tmpStore(t)
  const root = store.create({ title: 'root', author: A, task: true })
  const second = store.create({ title: 'second step', author: A, task: true, parent: `${root.id}` })
  const first = store.create({ title: 'first step', author: A, task: true, parent: `${root.id}` })
  store.move(store.get(second.id)!, store.get(root.id)!)
  // Make `second` wait on `first`, which was created later.
  const items = store.all().map((d) => (d.id === second.id ? { ...d, after: [`${first.id}`] } : d))
  assert.deepEqual(nodeKeys(treeRows(items)), [root.id, first.id, second.id])
})

test('All folds finished children into "✓ Completed N" and finished roots into "✓ Finished N", opened by group', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  store.complete(store.get(s.notify.id)!)
  const done = store.create({ title: 'done a while ago', author: A, task: true })
  store.complete(done)
  const items = store.all()

  const rows = treeRows(items)
  assert.ok(!nodeKeys(rows).includes(s.notify.id), 'a completed child is folded away')
  const childFold = rows.find((r) => r.key === doneGroupKey(s.root))!
  assert.equal(childFold.kind, 'fold')
  assert.match(childFold.text!, /^✓ Completed 1/)
  assert.ok(!nodeKeys(rows).includes(done.id), 'a finished root is behind its project row')
  const rootFold = rows.at(-1)!
  assert.equal(rootFold.key, doneGroupKey({ project: done.project }), 'at the end of the project')
  assert.match(rootFold.text!, /^✓ Finished 1/)

  const opened = treeRows(items, { openGroups: new Set([childFold.key, rootFold.key]) })
  const ids = nodeKeys(opened)
  assert.ok(ids.includes(s.notify.id) && ids.includes(done.id), '+ lists them one by one')
  assert.ok(opened.findIndex((r) => r.node?.id === s.notify.id) > opened.findIndex((r) => r.key === childFold.key), 'under their fold row')
  assert.ok(isSelectable(childFold), 'a fold row takes the cursor so +/- can open it')
})

test('← folds an open node, and a folded row says how much is under it', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const items = store.all()
  const rows = treeRows(items, { collapsed: new Set([keyOf(s.root)]) })
  assert.ok(!nodeKeys(rows).includes(s.deploy.id))
  const row = rows.find((r) => r.node?.id === s.root.id)!
  assert.ok(row.collapsed)
  const drawn = text(nodeRowSegments(row, items, 80, Date.now(), { tree: true }))
  assert.match(drawn, /▸/)
  assert.match(drawn, /\+3/)
})

test('a node a lane adds above the cursor does not move the cursor off the node being read', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const before = treeRows(store.all())
  const reading = before.findIndex((r) => r.node?.id === s.form.id)
  const cursorKey = before[reading].key

  // A lane files an urgent question; it sorts to the top of the tree, above `form`.
  store.create({ title: 'back up prod first?', author: A, urgency: 'high', options: [{ key: '1', label: 'back it up' }] })
  const after = treeRows(store.all())
  const index = resolveIndex(after, cursorKey, reading)
  assert.equal(after[index].node?.id, s.form.id, 'still on the same node')
  assert.notEqual(index, reading, 'even though its row number changed')
})

test('when the node under the cursor is gone, the next one slides under it', (t) => {
  const store = tmpStore(t)
  session(store)
  store.create({ title: 'second thing you need to decide', author: A, options: [{ key: '1', label: 'x' }] })
  const rows = ownerRows(store.all())
  const first = nearestSelectable(rows, 0, 1)
  const second = rows[stepIndex(rows, first, 1)].key
  // Answering in Decide lets go of the node (it moves down to answered), keeping the position.
  store.answer(rows[first].node!, { choice: '1' })
  const next = ownerRows(store.all())
  assert.equal(next[resolveIndex(next, null, first)].key, second)
  // A node that vanished outright behaves the same.
  assert.equal(next[resolveIndex(next, 'p#99999', first)].key, second)
})

test('stepIndex skips group headers but stops on fold rows, which +/- open', () => {
  const rows: Row[] = [
    { key: 'h', kind: 'header', depth: 0 },
    { key: 'a', kind: 'node', depth: 0 },
    { key: 'f', kind: 'fold', depth: 1 },
    { key: 'b', kind: 'node', depth: 0 },
  ]
  assert.equal(nearestSelectable(rows, 0, 1), 1)
  assert.equal(stepIndex(rows, 1, 1), 2)
  assert.equal(stepIndex(rows, 2, 1), 3)
  assert.equal(stepIndex(rows, 3, -2), 1)
  assert.equal(stepIndex(rows, 1, -1), 1, 'stops at the top instead of landing on a header')
})

// ---------------------------------------------------------------------------
// Status, staleness, owner markers
// ---------------------------------------------------------------------------

test('a running node shows no coloring from age alone; only 3 unanswered check-in asks turn it red with a badge', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  let items = store.all()
  const gate = items.find((d) => d.id === s.gate.id)!
  const row = (d: typeof gate): Row => ({ key: keyOf(d), kind: 'node', node: d, depth: 0 })
  const updated = Date.parse(gate.updatedAt!)

  // Age by itself never colors the row now (core/checkins.ts replaced the old grey/red).
  const ageText = (mins: number) => text(nodeRowSegments(row(gate), items, 80, updated + mins * 60_000))
  assert.equal(nodeRowSegments(row(gate), items, 80, updated + 2 * 60_000).find((x) => /minutes? ago/.test(x.text))?.color, undefined)
  assert.doesNotMatch(ageText(25), /asked/, 'past the 2× mark used to mean something; now it means nothing on its own')
  assert.equal(glyphOf(gate, items, updated + 25 * 60_000).color, 'cyan')
  // The progress bar is there too.
  assert.match(text(nodeRowSegments(row(gate), items, 80, updated)), /███░+ 37%/)

  // 3 asks spaced a stale_after (10m) apart, with no write in between — the bench turns it red with a badge.
  const layout = store.layoutOf(gate)
  const base = Date.now()
  const idleAt = new Date(base - 3 * 3600_000).toISOString()
  const idle = { ...gate, updatedAt: idleAt, activeAt: idleAt }
  for (let i = 0; i < 3; i++) askIfDue(layout, idle, base + i * 15 * 60_000)
  items = store.all()
  const asked = items.find((d) => d.id === s.gate.id)!
  assert.equal(asked.checkin?.asked, 3)
  assert.equal(asked.checkin?.unanswered, true)
  assert.equal(glyphOf(asked, items).color, 'red')
  assert.match(text(nodeRowSegments(row(asked), items, 80, base)), /asked 3× · no reply/)

  // A write (any of them) resets it — `store.write` calls `resetCheckin`.
  store.progress(asked, { progress: 40 })
  assert.equal(store.get(asked.id)!.checkin, undefined)
})

test('◆ bold is an AI stuck on the owner; ◆ dim is a question that can be answered early', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const items = store.all()
  const get = (id: number) => items.find((d) => d.id === id)!
  assert.equal(glyphOf(get(s.release.id), items).text, '◆')
  assert.deepEqual(glyphOf(get(s.release.id), items), { text: '◆', color: 'yellow', bold: true })
  assert.deepEqual(glyphOf(get(s.form.id), items), { text: '◆', color: 'yellow', dim: true })

  const rows = ownerRows(items)
  const groups = rows.filter((r) => r.kind === 'header').map((r) => r.text)
  assert.deepEqual(groups, [`X · ${s.release.project}  Needs you 2`], 'one header per project')
  assert.deepEqual(nodeKeys(rows), [s.release.id, s.form.id], 'AI-stuck first, then the early one')
  const formRow = rows.find((r) => r.node?.id === s.form.id)!
  const drawn = text(nodeRowSegments(formRow, items, 70, Date.now()))
  assert.match(drawn, /Early · Waiting on X\d+/)
  const releaseRow = rows.find((r) => r.node?.id === s.release.id)!
  assert.match(text(nodeRowSegments(releaseRow, items, 70, Date.now())), /Decide · blocking 3/, 'with how many nodes it holds up')
})

test('a row whose subtree waits on the owner carries a ◆ in the gutter', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  let items = store.all()
  const rootRow = () => treeRows(items).find((r) => r.node?.id === s.root.id)!
  // Only an early question below: a quiet mark.
  let gutter = nodeRowSegments(rootRow(), items, 80, Date.now(), { tree: true })[0]
  assert.equal(gutter.text, '◆')
  assert.ok(gutter.dim && !gutter.bold)

  // Release answered and the deploy done: now the form question is what the AI waits on.
  store.answer(store.get(s.release.id)!, { choice: '1' })
  store.complete(store.get(s.release.id)!)
  store.complete(store.get(s.deploy.id)!)
  items = store.all()
  gutter = nodeRowSegments(rootRow(), items, 80, Date.now(), { tree: true })[0]
  assert.equal(gutter.text, '◆')
  assert.ok(gutter.bold, 'loud once an AI is actually stuck')

  const gateRow = treeRows(items).find((r) => r.node?.id === s.gate.id)!
  assert.equal(nodeRowSegments(gateRow, items, 80, Date.now(), { tree: true })[0].text, ' ')
})

// ---------------------------------------------------------------------------
// The strip: Decide / external sources / working
// ---------------------------------------------------------------------------

test('the strip lists what the AI waits on, with what each holds up, plus the early and collected counts', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const items = store.all()
  const line = text(needsOwnerLine(buildOverview(items), items, 160))
  assert.match(line, /Decide 1/)
  assert.match(line, new RegExp(`X${s.release.id} ship v2.4 \\(blocking 3\\)`))
  assert.match(line, /Early 1/)
  assert.ok(!line.includes('Carol'), 'an early question is counted, not listed as blocking')
})

test('the strip never cuts a title mid-way to squeeze another in: the rest become +N', (t) => {
  const store = tmpStore(t)
  for (let i = 0; i < 6; i++) store.create({ title: `decide item ${i}`, author: A, options: [{ key: '1', label: 'x' }] })
  const items = store.all()
  const line = needsOwnerLine(buildOverview(items), items, 90)
  assert.ok(stringWidth(text(line)) <= 90)
  assert.match(text(line), /\+\d/)
  assert.ok(!text(line).includes('…'))
})

test('the sources line says cleared or not, who holds what, and when an adapter went quiet', () => {
  const src = (over: Partial<SourceSummary>): SourceSummary => ({
    project: 'p', projectLetter: 'T', name: 'x', title: 'x', kind: 'github', total: 0, unhandled: 0, buckets: {}, stale: false, cleared: true, ...over,
  })
  const ov = buildOverview([])
  ov.sources = [
    src({ name: 'support-inbox' }),
    src({ name: 'github-issues', cleared: false, unhandled: 2, buckets: { unhandled: 2, Bob: 4, owner: 1 } }),
    src({ name: 'feedback', stale: true, heartbeatAgeMs: 3 * 3_600_000 }),
  ]
  const line = text(sourcesLine(ov, 160))
  assert.match(line, /support-inbox ✓ clear/)
  assert.match(line, /github-issues ✗ unhandled 2 decide 1 Bob 4/)
  assert.match(line, /feedback ✓ clear !adapter 3 hours with no heartbeat/)

  ov.sources = []
  assert.match(text(sourcesLine(ov, 160)), /none registered/)
  ov.sources = [src({ name: 'support-inbox' })]
  assert.match(text(sourcesLine(ov, 160)), /all clear/)
})

test('the working line shows what runs, freshest first, with progress', (t) => {
  const store = tmpStore(t)
  session(store)
  const items = store.all()
  const line = text(workingLine(buildOverview(items), items, 160, Date.now()))
  assert.match(line, /Working 1: ◐X\d+ run the full gate .*37%/)
})

// ---------------------------------------------------------------------------
// Sub-questions
// ---------------------------------------------------------------------------

test('step through: picks start at the defaults, keys and arrows change one question at a time', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const form = store.get(s.form.id)!
  const [q1, q2] = form.questions!
  const picks = initialPicks(form)
  assert.deepEqual(picks, { Q1: 'A', Q2: '1' })
  assert.equal(optionForKey(q1, 'b'), 'B', 'option keys are case-insensitive')
  assert.equal(optionForKey(q1, 'z'), undefined)
  assert.equal(cycleOption(q2, '2', 1), '1', 'wraps')
  assert.equal(picksSummary(form.questions!, { Q1: 'B', Q2: '1' }, { Q1: 'spell it out' }), 'Q1=B*✎ Q2=1')

  const { lines, focusRow } = questionLines(form.questions!, 1, { Q1: 'B', Q2: '1' }, {}, 60)
  const drawn = lines.map(text)
  assert.match(drawn[focusRow], /▶ Q2/)
  assert.ok(drawn.some((l) => l.includes('[B ask first]')), 'the pick is bracketed')
})

test('step-through answers land as per-question answers, not prose', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const answered = store.answer(store.get(s.form.id)!, { answers: { Q1: 'B', Q2: '1' }, answerNotes: { Q1: 'send the email first' }, by: 'owner' })
  assert.deepEqual(answered.answer?.answers, { Q1: 'B', Q2: '1' })
  assert.deepEqual(answered.answer?.answerNotes, { Q1: 'send the email first' })
  assert.equal(answered.answer?.choice, '2')
})

test('the frame swaps the body for the picker while answering, and the prompt shows what will be sent', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const list = rowsFor('all', store.all())
  const index = list.findIndex((r) => r.node?.id === s.form.id)
  const picker = frameText(buildFrame(input(store, { list, index, mode: 'questions', pendingKey: '2', qIndex: 0, qPicks: { Q1: 'B', Q2: '1' } })))
  assert.match(picker, /Step through/)
  assert.match(picker, /▶ Q1/)
  const confirm = frameText(buildFrame(input(store, { list, index, mode: 'confirm', pendingKey: '2', qPicks: { Q1: 'B', Q2: '1' } })))
  assert.match(confirm, /Submit X\d+: Q1=B\* Q2=1/)
})

// N186: a sub-question answered free-text ("other") instead of picking an option.

test('picksSummary and questionLines show an 「其他」 pick as itself, not a second asterisk tacked onto the sentinel', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const form = store.get(s.form.id)!

  assert.equal(
    picksSummary(form.questions!, { Q1: OTHER_KEY, Q2: '1' }, { Q1: 'wait for Dave to confirm the copy' }),
    `Q1=${OTHER_KEY} Q2=1`,
  )

  const { lines } = questionLines(form.questions!, 0, { Q1: OTHER_KEY, Q2: '1' }, { Q1: 'wait for Dave to confirm the copy' }, 60)
  const drawn = lines.map(text)
  assert.ok(drawn.some((l) => l.includes('[Other]')), 'the chip is bracketed like a chosen option')
  assert.ok(!drawn.some((l) => l.includes('[A just rewrite it]') || l.includes('[B ask first]')), 'no option looks chosen')
  assert.ok(drawn.some((l) => l.includes('other: wait for Dave to confirm the copy')), 'the typed text shows, not "change:"')
})

test('App: o opens a free-text box for the focused sub-question; typed text (with a comma) picks 「其他」, an option key collapses it back', async (t) => {
  const store = tmpStore(t)
  // Just this one node, so it is already the cursor — no navigating needed.
  const form = store.create({
    title: 'Carol rewrites the onboarding copy',
    author: A,
    questions: [
      { key: 'Q1', label: 'how to word the heading', body: '', options: [{ key: 'A', label: 'just rewrite it', body: '' }, { key: 'B', label: 'ask first', body: '' }], default: 'A' },
      { key: 'Q2', label: 'home-screen load speed', body: '', options: [{ key: '1', label: 'pass', body: '' }, { key: '2', label: 'fail', body: '' }], default: '1' },
    ],
  })
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /全部按默认（Q1=A Q2=1）/))
  await b.press('2')
  await b.until(has(b, /Step through/))
  await b.until(has(b, /▶ Q1/))

  await b.press('o')
  await b.until(has(b, /other answer/))
  await b.press('wait, let’s check with Dave first, 先别发')
  await b.press('\r')
  await b.until(has(b, /\[Other\]/))
  assert.match(b.frame().join('\n'), /other: wait, let’s check with Dave first, 先别发/)

  // An option key collapses 「其他」 back to a normal pick — and, like any pick, moves on to Q2.
  await b.press('b')
  await b.until(() => !/\[Other\]/.test(b.frame().join('\n')))
  assert.match(b.frame().join('\n'), /\[B ask first\]/)

  // Back to Q1 — reopening "其他" there and committing it for real carries through to the written answer.
  await b.press(KEY.up)
  await b.until(has(b, /▶ Q1/))
  await b.press('o')
  await b.until(has(b, /other answer/))
  await b.press('needs another pass，不急')
  await b.press('\r')
  await b.until(has(b, /\[Other\]/))
  await b.press('\r') // questions → confirm
  await b.until(has(b, /Submit/))
  await b.press('\r') // confirm → commit

  await b.until(() => store.get(form.id)!.answer?.answers?.Q1 === OTHER_KEY)
  const answered = store.get(form.id)!
  assert.deepEqual(answered.answer?.answers, { Q1: OTHER_KEY, Q2: '1' })
  assert.deepEqual(answered.answer?.answerNotes, { Q1: 'needs another pass，不急' })
  assert.match(answered.body, /- Q1 = \* —— 其他：needs another pass，不急/)
})

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test('a capped 32-column title is never cut at 100 or 140 columns, two levels deep', (t) => {
  const store = tmpStore(t)
  const title32 = '部署守门规则多严一条测试挡掉四次' // 16 × 2 = 32 columns
  assert.equal(stringWidth(title32), 32)
  const a = store.create({ title: title32, author: A, task: true })
  const b = store.create({ title: title32, author: A, task: true, parent: `${a.id}` })
  const c = store.create({ title: title32, author: A, task: true, parent: `${b.id}` })
  store.start(store.get(c.id)!)
  store.progress(store.get(c.id)!, { progress: 50 })
  for (const width of [100, 140]) {
    const frame = buildFrame(input(store, { width: width - 1 }))
    const g = geometry(input(store, { width: width - 1 }))
    const listRows = frame.slice(g.listRow0, g.listRow0 + 3).map((l) => text(l).slice(0, g.lw))
    for (const row of listRows) {
      assert.ok(row.includes(title32), `cut at ${width}: ${row}`)
      assert.ok(!row.includes('…'))
    }
    for (const line of frame) assert.ok(stringWidth(text(line)) <= width - 1)
  }
  assert.ok(listWidth(99) >= 44 && listWidth(139) >= 50)
})

test('every view renders at the right height, at narrow and wide sizes', (t) => {
  const store = tmpStore(t)
  session(store)
  for (const view of VIEWS) {
    for (const [width, rows] of [[60, 14], [119, 30], [179, 44]]) {
      const frame = buildFrame(input(store, { view, width, rows }))
      assert.equal(frame.length, rows - 1, `${view} ${width}x${rows}`)
      for (const line of frame) assert.ok(stringWidth(text(line)) <= width, `${view} at ${width} overflowed`)
    }
  }
})

test('the detail pane says where a node stands and how it is linked', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const list = rowsFor('all', store.all())
  const index = list.findIndex((r) => r.node?.id === s.deploy.id)
  const all = frameText(buildFrame(input(store, { list, index, rows: 40 })))
  assert.match(all, new RegExp(`To do · queued after X${s.release.id}`))
  assert.match(all, new RegExp(`Parent  ◐?○?X${s.root.id} v2.4 release follow-up`))
  assert.match(all, new RegExp(`After  ◆X${s.release.id}`))
  assert.match(all, /Blocking  ◆X\d+ ○X\d+/)
  assert.match(all, /you don’t need to answer it/)
})

test("the detail pane does not list a node's children (sub-nodes): the tree already shows them", (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const list = rowsFor('all', store.all())
  const index = list.findIndex((r) => r.node?.id === s.root.id)
  assert.ok(store.get(s.root.id)!.children?.length, 'the root does have children')
  const all = frameText(buildFrame(input(store, { list, index, rows: 40 })))
  assert.doesNotMatch(all, /Children/)
})

test("the owner's notes and an agent's read differently in the body", (t) => {
  const store = tmpStore(t)
  const s = session(store)
  store.note(store.get(s.release.id)!, { text: 'hold off for now', role: 'human', author: 'owner' })
  store.note(store.get(s.release.id)!, { text: 'got it', role: 'agent', author: 'lead' })
  const list = rowsFor('all', store.all())
  const index = list.findIndex((r) => r.node?.id === s.release.id)
  // The User/Agent tags are English regardless of UI language; pin it for this one check.
  setLang('en')
  const frame = buildFrame(input(store, { list, index, rows: 40 }))
  setLang('en')
  const human = frame.flat().find((x) => /User \| .+ ago/.test(x.text))
  const agent = frame.flat().find((x) => /Agent \| lead \| .+ ago/.test(x.text))
  assert.ok(human && agent, frameText(frame))
  assert.notEqual(human.color, agent.color)
})

test('changeBanner names new nodes and nodes that just started waiting on the owner', (t) => {
  const store = tmpStore(t)
  const s = session(store)
  const before = store.all()
  const added = store.create({ title: 'new', author: A, task: true })
  store.ask(store.get(s.gate.id)!, { options: [{ key: '1', label: 'continue' }], author: A })
  const msg = changeBanner(before, store.all())!
  assert.match(msg, new RegExp(`\\+1 new node X${added.id}`))
  assert.match(msg, new RegExp(`X${s.gate.id} now needs a decision`))
  assert.equal(changeBanner([], store.all()), null, 'the first read is not news')
})

test('--view names and --scope from before Available/Active map onto the nearest view', () => {
  assert.equal(viewFromArg(undefined), 'available', 'Available is where bench opens')
  for (const v of VIEWS) assert.equal(viewFromArg(v), v)
  const legacy = { tree: 'all', owner: 'decide', running: 'active', timeline: 'available', done: 'all', open: 'decide', queued: 'decide', all: 'all', archived: 'all' }
  for (const [raw, view] of Object.entries(legacy)) assert.equal(viewFromArg(raw), view, raw)
  assert.throws(() => viewFromArg('nope'))
})

test('a joined bench separates projects with a header row', (t) => {
  const r1 = mkdtempSync(join(tmpdir(), 'decs-bench-a-'))
  const r2 = mkdtempSync(join(tmpdir(), 'decs-bench-b-'))
  t.after(() => [r1, r2].forEach((r) => rmSync(r, { recursive: true, force: true })))
  const store = new Store([initLayout(r1), initLayout(r2)])
  store.create({ title: 'one', author: A, task: true }, store.layouts[0])
  store.create({ title: 'two', author: A, task: true }, store.layouts[1])
  const rows = treeRows(store.all())
  assert.equal(rows.filter((r) => r.kind === 'header').length, 2)
  assert.equal(rows[0].kind, 'header')
})


test("outbound content shows whether the owner's answer approved it", () => {
  const base = { approvals: [] } as unknown as Parameters<typeof approvalLines>[0]
  const line = (ap: object) => text(approvalLines({ ...base, approvals: [{ target: 'attachments/9/draft.html', hash: 'sha256:a', ...ap }] } as typeof base)[0])
  assert.match(line({ approveOn: ['1'] }), /draft\.html  pending approval \(approved by answering 1\)/)
  assert.match(line({ approvedHash: 'sha256:a' }), /approved \(owner\)/)
  assert.match(line({ declined: '2', approveOn: ['1'] }), /the answer was 2, which doesn't approve it \(approved by answering 1\)/)
  assert.match(line({ approvedHash: 'sha256:old' }), /content changed, needs re-approval/)
})

test('a bench answer approves attached content, because bench always answers as the owner', (t) => {
  const store = tmpStore(t)
  const d = store.create({ title: 'reply draft', author: A, options: [{ key: '1', label: 'send' }, { key: '2', label: 'hold off' }], default: '2' })
  const draft = join(mkdtempSync(join(tmpdir(), 'decs-draft-')), 'draft.html')
  writeFileSync(draft, '<p>hi</p>')
  store.attach(store.get(d.id)!, [draft], { approvalContent: true, approveOn: ['1'] })
  assert.match(text(approvalLines(store.get(d.id)!)[0]), /pending approval/)
  store.answer(store.get(d.id)!, { choice: '1', by: 'owner', role: 'human' }) // what commitAnswer does
  assert.match(text(approvalLines(store.get(d.id)!)[0]), /approved/)
})

test('note headlines are just who and how long ago', () => {
  // The User/Agent tags and the relative time are English regardless of UI language; pin it here.
  setLang('en')
  const now = Date.parse('2026-10-31T12:00:00+08:00')
  assert.equal(noteHeadline({ role: 'human', author: 'owner', at: '2026-10-29T12:00:00+08:00' }, now), 'User | 2 days ago')
  assert.equal(
    noteHeadline({ role: 'agent', author: 'decs-lead · fixed a bug', at: '2026-10-28T12:00:00+08:00' }, now),
    'Agent | decs-lead | 3 days ago',
  )
  assert.equal(noteHeadline({ role: 'agent', author: '', at: '2026-10-31T11:00:00+08:00' }, now), 'Agent | an hour ago')
  setLang('en')
})
