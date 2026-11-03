import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { buildOverview } from '../src/core/overview.ts'
import { renderDecision } from '../src/core/render.ts'
import { stalenessOf } from '../src/core/staleness.ts'
import { deferHidden } from '../src/core/status.ts'
import { Store } from '../src/core/store.ts'
import { readQueue } from '../src/core/queue.ts'
import { NOTE_KIND, NOTE_TEXT } from '../src/core/format.ts'
import { DEFERRED_GROUP, VIEWS, homeView, inView, rowsFor, viewCount, viewFromArg } from '../src/tui/views.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'
import { bench, has, KEY } from './tui-harness.ts'

const A = 'lane-defer · test'
const opt = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]
const owner = { by: 'owner', role: 'human' as const }

function tmpStore(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'decs-defer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new Store([initLayout(root)])
}

test('deferred_at / deferred_by round-trip through front matter and survive other writes', (t) => {
  const store = tmpStore(t)
  const d = store.defer(store.create({ title: 'do it later', author: A, task: true }), owner)
  const text = readFileSync(d.file, 'utf8')
  assert.match(text, /^deferred_at: .+$/m)
  assert.match(text, /^deferred_by: owner$/m)
  assert.match(text, new RegExp(`## ${NOTE_KIND.deferred}（human · owner · `))
  const again = store.note(store.get(d.id)!, { text: 'a note for later', role: 'agent', author: A })
  assert.equal(again.deferredAt, d.deferredAt)
  assert.equal(store.get(d.id)!.deferredBy, 'owner')
  const back = store.undefer(store.get(d.id)!, owner)
  assert.equal(back.deferredAt, undefined)
  assert.doesNotMatch(readFileSync(back.file, 'utf8'), /^deferred_/m)
  assert.match(back.body, new RegExp(`## ${NOTE_KIND.undeferred}（human · owner · `))
})

test('defer keeps the state (in progress, needs decision, waiting) and undefer brings it back as it was', (t) => {
  const store = tmpStore(t)
  const running = store.start(store.create({ title: 'running', author: A, task: true }))
  const asking = store.create({ title: 'needs a call', author: A, options: opt, default: '1' })
  const held = store.hold(store.create({ title: 'waiting on the customer', author: A, task: true }), 'customer', A)
  for (const d of [running, asking, held]) {
    const off = store.defer(d, owner)
    assert.equal(off.state, d.state, `${d.title}: defer leaves the state`)
    assert.equal(store.get(d.id)!.queued, undefined, `${d.title}: an owner's defer is not a request — nothing enqueued`)
    const on = store.undefer(store.get(d.id)!, owner)
    assert.equal(on.state, d.state, `${d.title}: undefer restores it`)
    assert.equal(on.waitingOn, d.waitingOn)
  }
  assert.deepEqual(readQueue(store.layouts[0]), [])
})

test('finished nodes cannot be deferred', (t) => {
  const store = tmpStore(t)
  const done = store.complete(store.start(store.create({ title: 'done', author: A, task: true })))
  const closed = store.close(store.create({ title: 'not doing it', author: A, task: true }), 'obsolete')
  assert.throws(() => store.defer(done, owner), /already finished/)
  assert.throws(() => store.defer(closed, owner), /already finished/)
})

test('an owner defer shows up in changes() as a human event; a lane doing it is agent', (t) => {
  const store = tmpStore(t)
  const since = new Date(Date.now() - 1000).toISOString()
  const a = store.start(store.create({ title: 'running', author: A, task: true }))
  store.defer(a, owner)
  const human = store.changes(since, { role: 'human' })
  assert.equal(human.length, 1)
  assert.equal(human[0].kind, NOTE_KIND.deferred)
  assert.equal(human[0].by, 'owner')
  const b = store.create({ title: 'another one', author: A, task: true })
  store.defer(b, { by: A, role: 'agent' })
  assert.equal(store.changes(since, { role: 'human' }).length, 1, 'a lane deferring does not wake anyone')
})

test('a deferred node is never stale', (t) => {
  const store = tmpStore(t)
  const d = store.defer(store.start(store.create({ title: 'running', author: A, task: true, staleAfter: '1m' })), owner)
  const later = Date.parse(d.updatedAt!) + 3 * 3600_000
  assert.equal(stalenessOf(d, later), 'fresh')
  assert.equal(stalenessOf({ ...d, deferredAt: undefined }, later), 'stale')
})

/**
 *   P  in progress, deferred
 *     c  needs decision (hidden by P)
 *     w  waiting (hidden by P)
 *   R  in progress
 *     x  needs decision, deferred
 *     y  needs decision
 *   H  waiting, deferred
 *   K  waiting
 *   F  completed (deferred before it finished)
 */
function fixture(t: { after: (fn: () => void) => void }) {
  const store = tmpStore(t)
  const task = (title: string, extra: Record<string, unknown> = {}) => store.create({ title, author: A, task: true, ...extra })
  const P = store.start(task('P parent'))
  const c = store.create({ title: 'c needs decision', author: A, options: opt, default: '1', parent: `${P.id}` })
  const w = store.hold(task('w waiting outside', { parent: `${P.id}` }), 'customer', A)
  store.defer(store.get(P.id)!, owner)
  const R = store.start(task('R parent'))
  const x = store.defer(store.create({ title: 'x needs decision', author: A, options: opt, default: '1', parent: `${R.id}` }), owner)
  const y = store.create({ title: 'y needs decision', author: A, options: opt, default: '1', parent: `${R.id}` })
  const H = store.defer(store.hold(task('H waiting and deferred'), 'vendor', A), owner)
  const K = store.hold(task('K waiting on customer'), 'customer', A)
  const F = store.defer(store.start(task('F done')), owner)
  store.complete(store.get(F.id)!)
  return { store, ids: { P: P.id, c: c.id, w: w.id, R: R.id, x: x.id, y: y.id, H: H.id, K: K.id, F: F.id } }
}

test('views: a deferred node and its subtree leave Available/Active/Decide; Waiting ends with a folded "Deferred N"; All keeps all', (t) => {
  const { store, ids } = fixture(t)
  const items = store.all()
  const get = (id: number) => items.find((d) => d.id === id)!
  const hidden = deferHidden(items)
  assert.deepEqual([ids.P, ids.c, ids.w, ids.x, ids.H].map((id) => hidden(get(id))), [true, true, true, true, true])
  assert.deepEqual([ids.R, ids.y, ids.K, ids.F].map((id) => hidden(get(id))), [false, false, false, false], 'a finished node is not deferred')
  for (const v of ['available', 'active', 'decide', 'waiting'] as const)
    for (const id of [ids.P, ids.c, ids.w, ids.x, ids.H]) assert.equal(inView(v, get(id), items), false, `${v} hides ${get(id).title}`)
  assert.ok(inView('decide', get(ids.y), items))
  assert.ok(rowsFor('all', items).some((r) => r.node?.id === ids.c))

  // Waiting: K, then the folded group — shut by default.
  const shut = rowsFor('waiting', items)
  assert.deepEqual(shut.map((r) => r.kind), ['node', 'fold'])
  assert.equal(shut[0].node!.id, ids.K)
  assert.equal(shut[1].key, DEFERRED_GROUP)
  assert.match(shut[1].text!, /Deferred 3  \+ expand/)
  const open = rowsFor('waiting', items, { openGroups: new Set([DEFERRED_GROUP]) })
  assert.match(open[1].text!, /Deferred 3  - collapse/)
  assert.deepEqual(open.slice(2).map((r) => r.node!.title), ['P parent', 'x needs decision', 'H waiting and deferred'], 'every deferred node, longest-deferred first')
  assert.equal(open.filter((r) => r.node?.id === ids.H).length, 1, 'a deferred Waiting node is listed once, under Deferred')

  assert.deepEqual(VIEWS, ['available', 'active', 'decide', 'all', 'waiting', 'live'], 'no Deferred tab')
  const counts = Object.fromEntries(VIEWS.map((v) => [v, viewCount(v, items)]))
  assert.deepEqual(counts, { available: 3, active: 2, decide: 1, all: undefined, waiting: 1, live: undefined })
  const ov = buildOverview(items)
  assert.deepEqual(ov.needsOwner.map((r) => r.id), [ids.y])
  assert.deepEqual(ov.inProgress.map((r) => r.id), [ids.R])

  assert.equal(homeView(get(ids.x), items, 'decide'), 'waiting', 'a jump to a deferred node lands in Waiting (under Deferred)')
  assert.equal(homeView(get(ids.x), items, 'waiting'), 'waiting')
  assert.equal(homeView(get(ids.c), items, 'available'), 'all', 'one under a deferred parent lands in All')
  assert.equal(viewFromArg('deferred'), 'waiting')
  assert.equal(viewFromArg('defer'), 'waiting')
})

test('decs get says Deferred (owner · … ago)', (t) => {
  const store = tmpStore(t)
  const d = store.defer(store.create({ title: 'do it later', author: A, task: true }), owner)
  // dayjs says "a few seconds ago" for anything under a minute.
  assert.match(renderDecision(d), /Deferred \(owner · (a few seconds ago|a minute ago|\d+ minutes ago)\)/)
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('decs defer / --off / undefer: role follows the shell; show deferred lists them; open hides them', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'ship it or not', '-o', '1=ship', '2=hold off', '--default', '1'])
  decs(root, ['add', 'later', '--task'])
  assert.match(decs(root, ['defer', '1', '2']), /X1 deferred · Needs decision\nX2 deferred · To do/)
  assert.match(decs(root, ['get', '1']), new RegExp(`## ${NOTE_KIND.deferred}（agent · cli-test · lane · `), 'a Claude Code shell writes as agent')
  assert.equal(decs(root, ['show']).trim(), 'No nodes need a decision.')
  assert.match(decs(root, ['show', 'deferred']), /X1[^\n]*Deferred/)
  assert.match(decs(root, ['defer', '1']), /was already deferred/)
  assert.match(decs(root, ['defer', '1', '--off']), /X1 lifted the defer · Needs decision/)
  assert.match(decs(root, ['show']), /ship it or not/)
  assert.match(decs(root, ['undefer', '2', '--json']), /"deferred_at":null/)

  decs(root, ['defer', '2'], { CLAUDECODE: undefined })
  assert.match(decs(root, ['get', '2']), new RegExp(`## ${NOTE_KIND.deferred}（human · owner · `), "the owner's own terminal is human")
  assert.match(decs(root, ['get', '2', '--json']), /"deferred_by": "owner"/)

  decs(root, ['add', 'wrap it up', '--task'])
  decs(root, ['start', '3'])
  decs(root, ['done', '3'])
  const r = decsResult(root, ['defer', '3'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /already finished, no need to defer it/)
})

test('decs monitor tells the lane "owner Deferred", and nothing is queued', async (t) => {
  const root = scratch()
  const home = scratch()
  decs(root, ['init', '--no-register'])
  decs(root, ['add', 'run the gate', '--task'])
  decs(root, ['start', '1'])
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [BIN, 'monitor', '--interval', '200', '--unclaimed-after', '0s'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', DECS_AUTHOR: 'cli-test · lane', CLAUDECODE: '1', DECS_HOME: home },
  })
  // Registered before the directory removals below: Windows won't remove a
  // directory that's still a live process's cwd (root) or holds a file it
  // has open (home), so the monitor must be dead first.
  t.after(() => killAndWait(child))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => (out += b))
  child.stderr.on('data', (b) => (err += b))
  // Wait on what the monitor says, not on a clock: a loaded machine made fixed sleeps flaky.
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}${err}`)
  }
  await until(() => err.includes('nod monitor: watching'), 'the monitor to start')
  // The cursor is set before that line is printed, so the defer is after it.
  // No DECS_AUTHOR: a real owner's own terminal has none — the monitor's write-marker
  // self-filter (core/identity.ts) must not mistake this for the lane's own write.
  decs(root, ['defer', '1', '--human'], { DECS_AUTHOR: undefined })
  await until(() => out.includes('owner Deferred'), 'the Deferred line')
  // A couple more passes, to be sure nothing else follows.
  await new Promise((r) => setTimeout(r, 500))
  const lines = out.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 1, out)
  assert.match(lines[0], new RegExp(`^X1 owner Deferred: run the gate —— ${NOTE_TEXT.deferred} → stop work on X1 until it comes back  since=\\S+$`))
  assert.equal(decs(root, ['queue']).includes('X1'), false)
  assert.match(decs(root, ['get', '1']), /In progress · Deferred/)
})

// ---------------------------------------------------------------------------
// Bench
// ---------------------------------------------------------------------------

test('App: d in Available defers the cursor node — it leaves, the cursor moves on, a banner says where it went', async (t) => {
  const store = tmpStore(t)
  const a = store.start(store.create({ title: 'a first one', author: A, task: true }))
  store.start(store.create({ title: 'b second one', author: A, task: true }))
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /a first one/))
  assert.match(b.frame()[0], /^decs +Available 2 +Active 2 +Needs you +All +Waiting +Live *$/)
  await b.press('d')
  await b.until(has(b, /deferred \(undo it in Waiting → Deferred\)/))
  const f = b.frame().join('\n')
  assert.match(f, new RegExp(`X${a.id} deferred`))
  assert.doesNotMatch(f.split('\n').slice(2).map((l) => l.split('│')[0]).join('\n'), /a first one/, 'gone from Available')
  assert.match(f, /b second one[^\n]*│[^\n]*X2/, 'the cursor moved on to b')
  assert.match(b.frame()[0], /Available 1 /)
  assert.ok(store.get(a.id)!.deferredAt)
  assert.equal(store.get(a.id)!.state, 'in_progress')
  assert.match(store.get(a.id)!.body, new RegExp(`## ${NOTE_KIND.deferred}（human · owner · `))
})

test('App: Waiting → + opens "Deferred N", d un-defers from there, - folds it; on a finished node d says so', async (t) => {
  const store = tmpStore(t)
  const a = store.defer(store.create({ title: 'a do it later', author: A, options: opt, default: '1' }), owner)
  store.defer(store.create({ title: 'b also later', author: A, task: true }), owner)
  const b = bench(t, store, { view: 'waiting' })
  await b.until(has(b, /Deferred 2  \+ expand/))
  const left = () => b.frame().slice(2).map((l) => l.split('│')[0]).join('\n')
  assert.doesNotMatch(left(), /a do it later/, 'folded by default')
  await b.press('+')
  await b.until(() => /a do it later/.test(left()))
  // Relative time goes through dayjs, which says "a few seconds ago" for a sub-minute span.
  assert.match(b.frame().join('\n'), /Deferred · (a few seconds ago|a minute ago|\d+ minutes ago)/)
  await b.press(KEY.down)
  await b.until(right(b, /a do it later/))
  await b.press('d')
  await b.until(has(b, /resumed · Needs decision/))
  assert.equal(store.get(a.id)!.deferredAt, undefined)
  assert.equal(store.get(a.id)!.state, 'needs_decision')
  await b.until(has(b, /Deferred 1  - collapse/))
  assert.match(b.frame()[0], /Needs you 1/, 'back in its views')
  await b.press('-')
  await b.until(has(b, /Deferred 1  \+ expand/))

  const done = store.complete(store.start(store.create({ title: 'z all done', author: A, task: true })))
  const c = bench(t, store, { view: 'all' })
  await c.until(has(c, /✓ Finished 1/))
  await c.press('g', ...`${done.id}`.split(''), '\r')
  await c.until(has(c, /z all done/))
  await c.press('d')
  await c.until(has(c, /need deferring/))
})

test('App: --view deferred opens Waiting with "Deferred N" unfolded', async (t) => {
  const store = tmpStore(t)
  store.defer(store.create({ title: 'x put it off', author: A, task: true }), owner)
  const b = bench(t, store, { view: 'waiting', openDeferred: true })
  await b.until(has(b, /x put it off/))
  assert.match(b.frame().join('\n'), /Deferred 1  - collapse/)
})

test('App: g is goto — g 64 ⏎ lands on 64, : still works, the old d+digits jump is gone, g no longer scrolls', async (t) => {
  const store = tmpStore(t)
  const long = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the body`).join('\n')
  store.start(store.create({ title: 'a running', author: A, task: true, body: long }))
  for (let i = 2; i < 64; i++) store.create({ title: `n${i}`, author: A, task: true })
  const t64 = store.start(store.create({ title: 'n64 target', author: A, task: true }))
  assert.equal(t64.id, 64)
  const x = store.defer(store.create({ title: 'x put it off', author: A, task: true }), owner)
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /a running/))
  assert.doesNotMatch(b.frame().join('\n'), /d\+[0-9]/)
  assert.ok(b.frame().some((l) => /g go to/.test(l)))

  // g on its own opens the prompt and does not scroll the body.
  await b.press('j', 'j', 'j', 'j', 'j', 'j', 'j', 'j')
  await b.until(() => !b.frame().join('\n').includes('line 1 of the body'))
  await b.press('g')
  await b.until(has(b, /Go to: /))
  assert.doesNotMatch(b.frame().join('\n'), /line 1 of the body/, 'g is not scroll-to-top any more')
  await b.press('\x1b')
  await b.until(() => !has(b, /Go to: /)())
  await b.press('\x1b[H')
  await b.until(has(b, /line 1 of the body/))

  await b.press('g', '6', '4', '\r')
  await b.until(right(b, /n64 target/))
  await b.press(':', ...`${x.id}`.split(''), '\r')
  await b.until(right(b, /x put it off/))
  assert.match(b.frame().join('\n'), /Deferred 1  - collapse/, 'jumping to a deferred node opens Waiting → Deferred')
  assert.match(b.frame().join('\n'), /Deferred \(owner/, 'the detail pane says it is deferred')
})

/** Whether the right pane (what the cursor is on) mentions `re`. */
const right = (b: { frame: () => string[] }, re: RegExp) => () => b.frame().some((l) => re.test(l.split('│').slice(1).join('│')))
