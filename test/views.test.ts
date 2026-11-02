import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { groupFoldKey, loadFolds } from '../src/tui/folds.ts'
import { GLYPH, VIEWS, doneGroupKey, glyphOf, glyphText, homeView, inView, nodeRowSegments, rowsFor, viewCount, type Row, type View } from '../src/tui/views.ts'
import { statusSegments } from '../src/tui/detail.ts'
import { helpText } from '../src/tui/app.ts'
import { stringWidth } from '../src/tui/width.ts'
import { bench, has, KEY } from './tui-harness.ts'

const A = 'lane-views · test'
const opt = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]

function tmp(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Every state, met and unmet deps, a finished ancestor over live work, a
 * not-matching ancestor over matching work, and finished roots and children.
 */
function fixture(t: { after: (fn: () => void) => void }) {
  const root = tmp(t, 'decs-views-')
  const store = new Store([initLayout(root)])
  const task = (title: string, extra: Record<string, unknown> = {}) => store.create({ title, author: A, task: true, ...extra })
  const P = store.start(task('P parent task'))
  const under = { parent: `${P.id}` }
  const a = task('a startable', under)
  const b = task('b waits on a', { ...under, after: [`${a.id}`] })
  const c = store.create({ title: 'c AI stuck', author: A, options: opt, default: '1', ...under })
  const d = store.create({ title: 'd early decidable', author: A, options: opt, default: '1', ...under, after: [`${b.id}`] })
  const e = store.answer(store.create({ title: 'e answered', author: A, options: opt, default: '1', ...under }), { choice: '1' })
  const f = store.hold(task('f waiting externally', under), 'the customer', A, { until: '2099-01-01T00:00:00+00:00' })
  const g = store.complete(store.start(task('g completed', under)))
  const h = store.close(task('h closed', under), 'obsolete')
  const Q = task('Q completed parent')
  const r = store.start(task('r under a completed parent', { parent: `${Q.id}` }))
  store.complete(store.start(store.get(Q.id)!), {})
  const U = task('U waits on b', { after: [`${b.id}`] })
  const v = store.start(task('v under a not-yet-up parent', { parent: `${U.id}` }), { force: true })
  const S = store.complete(store.start(task('S done long ago')))
  const T = store.close(task('T not doing it'), 'superseded')
  const n = { P, a, b, c, d, e, f, g, h, Q, r, U, v, S, T }
  const ids = Object.fromEntries(Object.entries(n).map(([k, x]) => [k, x.id])) as Record<keyof typeof n, number>
  return { store, root, ids }
}

const named = (rows: Row[]) => rows.filter((r) => r.kind === 'node').map((r) => r.node!.title.split(' ')[0])

test('fixture: every state is there', (t) => {
  const { store, ids } = fixture(t)
  const st = (id: number) => store.get(id)!.state
  assert.deepEqual(
    [ids.P, ids.a, ids.b, ids.c, ids.d, ids.e, ids.f, ids.g, ids.h, ids.Q, ids.r, ids.U, ids.v].map(st),
    ['in_progress', 'not_started', 'not_started', 'needs_decision', 'needs_decision', 'decided', 'waiting', 'completed', 'closed', 'completed', 'in_progress', 'not_started', 'in_progress'],
  )
})

test('Available: running, waiting, startable, needing a decision and answered-for-AI, with non-matching ancestors kept as dim context', (t) => {
  const { store } = fixture(t)
  const items = store.all()
  const rows = rowsFor('available', items)
  assert.deepEqual(named(rows).sort(), ['P', 'Q', 'U', 'a', 'c', 'd', 'e', 'f', 'r', 'v'].sort())
  const ctx = rows.filter((r) => r.context).map((r) => r.node!.title.split(' ')[0])
  assert.deepEqual(ctx.sort(), ['Q', 'U'], 'Q (finished) and U (not startable) are only there for what hangs below')
  // Children sit under their parent, as the tree.
  const at = (n: string) => rows.findIndex((r) => r.node?.title.startsWith(`${n} `))
  assert.ok(at('Q') < at('r') && rows[at('r')].depth === 1)
  // A context row is drawn dim, all but the ◆ gutter.
  const drawn = nodeRowSegments(rows[at('U')], items, 70, Date.now(), { tree: true })
  assert.ok(drawn.slice(1).every((s) => s.dim && !s.color && !s.bold), 'dim, no colour')
  assert.ok(!nodeRowSegments(rows[at('a')], items, 70, Date.now(), { tree: true }).slice(1).every((s) => s.dim))
})

test('Active: running and needs-decision only — not answered-for-AI, not to-do', (t) => {
  const { store } = fixture(t)
  const rows = rowsFor('active', store.all())
  assert.deepEqual(named(rows).sort(), ['P', 'Q', 'U', 'c', 'd', 'r', 'v'].sort())
  assert.deepEqual(rows.filter((r) => r.context).map((r) => r.node!.title[0]).sort(), ['Q', 'U'])
})

test('Needs you: needs_decision (and to-dos for the owner), a header per project, AI-stuck before can-decide-early', (t) => {
  const { store, ids } = fixture(t)
  const rows = rowsFor('decide', store.all())
  assert.equal(rows[0].kind, 'header')
  assert.match(rows[0].text!, /Needs you 2/)
  assert.deepEqual(rows.filter((r) => r.kind === 'node').map((r) => r.node!.id), [ids.c, ids.d])
  assert.ok(!rows.some((r) => r.kind === 'header' && /Answered/.test(r.text ?? '')), 'no answered group')
})

test('All: everything; finished children and roots fold into one row each, at the end', (t) => {
  const { store, ids } = fixture(t)
  const items = store.all()
  const rows = rowsFor('all', items)
  const shown = rows.filter((r) => r.kind === 'node').map((r) => r.node!.id)
  for (const k of ['g', 'h', 'S', 'T', 'Q', 'r'] as const) assert.ok(!shown.includes(ids[k]), `${k} folded`)
  const P = store.get(ids.P)!
  const childFold = rows.find((r) => r.key === doneGroupKey(P))!
  assert.match(childFold.text!, /^✓ Completed 2 \(of which 1 closed\)/)
  const last = rows.at(-1)!
  assert.equal(last.key, doneGroupKey({ project: P.project }))
  assert.match(last.text!, /^✓ Finished 3/, 'Q, S and T')

  const open = rowsFor('all', items, { openGroups: new Set([childFold.key, last.key]) })
  const all = open.filter((r) => r.kind === 'node').map((r) => r.node!.id)
  for (const k of ['g', 'h', 'S', 'T', 'Q'] as const) assert.ok(all.includes(ids[k]), `${k} listed once opened`)
  // Q is a finished root with children: folded on its own until → opens it.
  const qRow = open.find((r) => r.node?.id === ids.Q)!
  assert.ok(qRow.hasKids && qRow.collapsed)
})

test('Waiting: waiting only', (t) => {
  const { store, ids } = fixture(t)
  assert.deepEqual(rowsFor('waiting', store.all()).map((r) => r.node!.id), [ids.f])
})

test('tab counts: Available / Active / Decide / Waiting count what each lists; All and Recent have none', (t) => {
  const { store } = fixture(t)
  const items = store.all()
  const counts = Object.fromEntries(VIEWS.map((v) => [v, viewCount(v, items)]))
  assert.deepEqual(counts, { available: 8, active: 5, decide: 2, all: undefined, waiting: 1, recent: undefined })
  for (const v of VIEWS) {
    if (v === 'all' || v === 'recent') continue
    const listed = rowsFor(v, items).filter((r) => r.kind === 'node' && !r.context).length
    assert.equal(listed, (counts as Record<string, number | undefined>)[v], `${v}: the number is what the view lists (context rows aside)`)
  }
})

test('a jump lands in the current view when it lists the node, else Available, else All', (t) => {
  const { store, ids } = fixture(t)
  const items = store.all()
  const get = (k: keyof typeof ids) => items.find((d) => d.id === ids[k])!
  assert.equal(homeView(get('c'), items, 'decide'), 'decide')
  assert.equal(homeView(get('e'), items, 'decide'), 'available')
  assert.equal(homeView(get('b'), items, 'available'), 'all', 'a blocked "to do" node is only in All')
  assert.equal(homeView(get('S'), items, 'waiting'), 'all')
  assert.ok(inView('all', get('T'), items))
})

// ---------------------------------------------------------------------------
// The App
// ---------------------------------------------------------------------------

test('App: opens in Available, Tab walks Available Active Decide All Waiting Recent, and c does nothing', async (t) => {
  const { store } = fixture(t)
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /a startable/))
  const header = () => b.frame()[0]
  assert.match(header(), /^decs +Available 8 +Active 5 +Needs you 2 +All +Waiting 1/)
  const before = b.frame().join('\n')
  await b.press('c')
  await b.quiet()
  assert.equal(b.frame().join('\n'), before, 'c is gone: no banner, no change')

  const seen: string[] = []
  for (let i = 0; i < 6; i++) {
    await b.press('\t')
    await b.quiet()
    // Which view is up, read from the left pane alone.
    const left = b.frame().slice(2).map((l) => l.split('│')[0]).join('\n')
    const which = /Answered 1 ·/.test(left) ? 'recent'
      : /✓ Finished/.test(left) ? 'all'
      : /f waiting externally/.test(left) && !/c AI stuck/.test(left) ? 'waiting'
      : /c AI stuck/.test(left) && !/P parent task/.test(left) ? 'decide'
      : /e answered/.test(left) ? 'available'
      : /P parent task/.test(left) ? 'active' : '?'
    seen.push(which)
  }
  assert.deepEqual(seen, ['active', 'decide', 'all', 'waiting', 'recent', 'available'])
})

/** Whether the right pane (what the cursor is on) mentions `re`. */
const right = (b: { frame: () => string[] }, re: RegExp) => () => b.frame().some((l) => re.test(l.split('│').slice(1).join('│')))

async function downUntil(b: { press: (...k: string[]) => Promise<void>; frame: () => string[] }, ok: () => boolean) {
  for (let i = 0; i < 20 && !ok(); i++) {
    await b.press(KEY.down)
    await new Promise((r) => setTimeout(r, 60))
  }
}

test('App: in All, + opens "✓ Completed N" and - shuts it, remembered across sessions', async (t) => {
  const { store, ids } = fixture(t)
  const projectRoot = store.layoutOf(store.get(ids.P)!).projectRoot
  const home = tmp(t, 'decs-home-')
  const state = () => loadFolds(join(home, 'bench-state.json'))
  const b = bench(t, store, { view: 'all', home })
  await b.until(has(b, /✓ Completed 2/))
  await downUntil(b, right(b, /\+ or → to expand/))
  assert.ok(right(b, /✓ Completed 2/)(), 'the cursor rests on the fold row and the right pane says how to open it')
  await b.press('+')
  await b.until(has(b, /g completed/))
  assert.match(b.frame().join('\n'), /h closed/)
  assert.deepEqual(state(), { [groupFoldKey(projectRoot, ids.P)]: 'expanded' })
  b.unmount()

  const b2 = bench(t, store, { view: 'all', home })
  await b2.until(has(b2, /g completed/))
  assert.match(b2.frame().join('\n'), /- collapse/, 'still open after a restart')
  // - on a listed finished child shuts its group again.
  await downUntil(b2, right(b2, /g completed/))
  await b2.press('-')
  await b2.until(() => !b2.frame().some((line) => /g completed/.test(line.split('│')[0])))
  assert.deepEqual(state(), {}, 'shut is the default, so nothing stays stored')
  b2.unmount()

  // The project's "✓ Finished N" row is remembered under its own key.
  const b3 = bench(t, store, { view: 'all', home })
  await b3.until(has(b3, /✓ Finished 3/))
  await downUntil(b3, right(b3, /✓ Finished 3/))
  await b3.press('+')
  await b3.until(has(b3, /S done long ago/))
  assert.equal(state()[groupFoldKey(projectRoot)], 'expanded')
  await b3.press('-')
  await b3.until(() => !b3.frame().some((line) => /S done long ago/.test(line.split('│')[0])))
  assert.equal(state()[groupFoldKey(projectRoot)], undefined)
})

test('App: w finds the node an AI is stuck on from every view', async (t) => {
  const { store } = fixture(t)
  for (const view of VIEWS as View[]) {
    const b = bench(t, store, { view })
    await b.quiet()
    await b.press('w')
    await b.until(has(b, /c AI stuck[^\n]*│[^\n]*/))
    const f = b.frame().join('\n')
    assert.match(f, /Needs decision/, `${view}: the detail pane shows the Decide node`)
    assert.match(f, /c AI stuck/, `${view}`)
    b.unmount()
  }
})

test('App: jumping to a finished child in All opens its "✓ Completed N" row', async (t) => {
  const { store, ids } = fixture(t)
  const b = bench(t, store, { view: 'all' })
  await b.until(has(b, /✓ Completed 2/))
  await b.press(':', ...`${ids.g}`.split(''), '\r')
  await b.until(has(b, /g completed/))
  assert.match(b.frame().join('\n'), /✓ Completed 2 \(of which 1 closed\)  - collapse/)
})

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

test('one glyph per state: ○ ◐ ⏸ ◆ (bold / dim yellow, green when answered) ✓ ✕', (t) => {
  const { store, ids } = fixture(t)
  const items = store.all()
  const g = (k: keyof typeof ids) => glyphOf(items.find((d) => d.id === ids[k])!, items, Date.parse(items.find((d) => d.id === ids[k])!.updatedAt!))
  assert.deepEqual(g('a'), { text: '○', dim: true })
  assert.deepEqual(g('r'), { text: '◐', color: 'cyan' })
  assert.deepEqual(g('f'), { text: '⏸', color: 'magenta' })
  assert.deepEqual(g('c'), { text: '◆', color: 'yellow', bold: true }, 'an AI is stuck on it')
  assert.deepEqual(g('d'), { text: '◆', color: 'yellow', dim: true }, 'can be decided early: a dim ◆, no more ◇')
  assert.deepEqual(g('e'), { text: '◆', color: 'green' }, 'an answered decision keeps ◆, drawn green')
  assert.deepEqual(g('g'), { text: '✓', color: 'green', dim: true })
  assert.deepEqual(g('h'), { text: '✕', dim: true })
  // ◐ no longer colors by age alone — only 3 unanswered check-in asks (core/checkins.ts) turn it red.
  const r = items.find((d) => d.id === ids.r)!
  const at = Date.parse(r.updatedAt!)
  assert.equal(glyphOf(r, items, at + 61 * 60_000).color, 'cyan')
  assert.equal(glyphOf({ ...r, checkin: { asked: 3, lastAskedAt: r.updatedAt!, unanswered: true } }, items).color, 'red')
})

test('"answered, for AI" is a colour: a task the owner replied to stays ○ / ◐, drawn green', (t) => {
  const { store } = fixture(t)
  const reply = (d: ReturnType<typeof store.create>) => store.note(d, { text: "don't send yet, let me finish reading", role: 'human', author: 'owner' })
  const fresh = reply(store.create({ title: 'a task that hasn’t started', author: A, task: true }))
  const going = store.start(store.create({ title: 'a task half done', author: A, task: true }))
  const halfway = reply(store.progress(going, { progress: 40 }))
  const stepped = store.start(store.create({ title: 'a task with one step done', author: A, task: true }))
  const step1 = reply(store.progress(stepped, { steps: [{ title: 'a', done: true }, { title: 'b', done: false }] }))
  const items = store.all()
  const get = (d: { id: number }) => items.find((x) => x.id === d.id)!
  for (const d of [fresh, halfway, step1]) assert.equal(get(d).state, 'decided', `${d.title}: an owner reply makes a task "answered, for AI"`)
  assert.deepEqual(glyphOf(get(fresh), items), { text: '○', color: 'green' })
  assert.deepEqual(glyphOf(get(halfway), items), { text: '◐', color: 'green' }, 'it had progress')
  assert.deepEqual(glyphOf(get(step1), items), { text: '◐', color: 'green' }, 'it had a step done')
  assert.ok(inView('available', get(fresh), items), 'Available lists it for the AI to pick up')
})

test('the detail status line and the help use the same glyphs', (t) => {
  const { store, ids } = fixture(t)
  const items = store.all()
  for (const k of ['a', 'r', 'f', 'c', 'd', 'e', 'g', 'h'] as const) {
    const d = items.find((x) => x.id === ids[k])!
    assert.equal(statusSegments(d, items, Date.now())[0].text, glyphText(d), k)
  }
  const help = helpText().join('\n')
  for (const glyph of Object.values(GLYPH)) assert.ok(help.includes(glyph), `help shows ${glyph}`)
  assert.match(help, /green = answered, awaiting an AI \(you answered, an AI hasn't picked it up\)/)
  assert.doesNotMatch(help, /[▶◇⇢]/, 'the old glyphs are gone')
})

test('◐ is one column, like ◆ and ○, in our width helper and in the one ink lays out with', async () => {
  // all three are East Asian Ambiguous: one column unless a terminal draws ambiguous glyphs wide, breaking ◆/○ the same way
  const widest = (await import('widest-line')).default
  for (const glyph of Object.values(GLYPH)) {
    assert.equal(stringWidth(glyph), 1, `${glyph} in width.ts`)
    assert.equal(widest(glyph), 1, `${glyph} in ink`)
  }
})

test('a row with ◐ is exactly as wide as the pane, like every other state', (t) => {
  const { store } = fixture(t)
  const items = store.all()
  for (const view of ['available', 'all'] as View[]) {
    for (const row of rowsFor(view, items, { openGroups: new Set(rowsFor('all', items).filter((r) => r.kind === 'fold').map((r) => r.key)) })) {
      if (row.kind !== 'node') continue
      const w = stringWidth(nodeRowSegments(row, items, 60, Date.now(), { tree: true }).map((s) => s.text).join(''))
      assert.equal(w, 60, `${row.node!.title} in ${view}`)
    }
  }
})

test('Available lists a node held up outside (waiting) alongside the ones that can move', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'decs-avail-wait-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store([initLayout(root)])
  const held = store.hold(store.start(store.create({ title: 'waiting on the customer', author: 'lane · x', task: true })), 'Carol', 'lane')
  const items = store.all()
  assert.ok(inView('available', items.find((d) => d.id === held.id)!, items))
  assert.ok(!inView('active', items.find((d) => d.id === held.id)!, items), 'Active stays executing + Decide only')
})
