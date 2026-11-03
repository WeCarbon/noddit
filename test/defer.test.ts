import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLayout } from '../src/core/paths.ts'
import { buildOverview } from '../src/core/overview.ts'
import { renderDecision } from '../src/core/render.ts'
import { stalenessOf } from '../src/core/staleness.ts'
import { deferHidden, delayOf } from '../src/core/status.ts'
import { Store } from '../src/core/store.ts'
import { readQueue } from '../src/core/queue.ts'
import { NOTE_KIND, NOTE_TEXT } from '../src/core/format.ts'
import { VIEWS, homeView, inView, rowsFor, suffixOf, viewCount, viewFromArg } from '../src/tui/views.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'
import { bench, has, KEY } from './tui-harness.ts'

const A = 'lane-defer · test'
const opt = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]
const owner = { by: 'owner', role: 'human' as const }
const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('')

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

test('defer keeps the state (in progress, needs decision) and undefer brings it back as it was', (t) => {
  const store = tmpStore(t)
  const running = store.start(store.create({ title: 'running', author: A, task: true }))
  const asking = store.create({ title: 'needs a call', author: A, options: opt, default: '1' })
  for (const d of [running, asking]) {
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

test('views: a deferred node stays in Available (grey) and is listed in Waiting beside every wait; Active/Decide still leave it out; All keeps all', (t) => {
  const { store, ids } = fixture(t)
  const items = store.all()
  const get = (id: number) => items.find((d) => d.id === id)!
  const hidden = deferHidden(items)
  assert.deepEqual([ids.P, ids.c, ids.w, ids.x, ids.H].map((id) => hidden(get(id))), [true, true, true, true, true])
  assert.deepEqual([ids.R, ids.y, ids.K, ids.F].map((id) => hidden(get(id))), [false, false, false, false], 'a finished node is not deferred')
  for (const v of ['active', 'decide'] as const)
    for (const id of [ids.P, ids.c, ids.w, ids.x, ids.H]) assert.equal(inView(v, get(id), items), false, `${v} hides ${get(id).title}`)
  for (const id of [ids.P, ids.c, ids.w, ids.x, ids.H]) assert.equal(inView('available', get(id), items), true, `Available lists ${get(id).title}`)
  assert.equal(get(ids.H).state, 'not_started', 'a plain defer of a waiting node replaced the wait')
  assert.ok(inView('decide', get(ids.y), items))
  assert.ok(rowsFor('all', items).some((r) => r.node?.id === ids.c))

  // Waiting: every 延迟, passive and active, as plain rows — no fold.
  const rows = rowsFor('waiting', items)
  assert.deepEqual(rows.map((r) => r.kind), rows.map(() => 'node'))
  assert.deepEqual(new Set(rows.map((r) => r.node!.id)), new Set([ids.K, ids.w, ids.P, ids.x, ids.H]))

  assert.deepEqual(VIEWS, ['available', 'active', 'decide', 'waiting', 'live', 'all'], 'no Deferred tab')
  const counts = Object.fromEntries(VIEWS.map((v) => [v, viewCount(v, items)]))
  assert.deepEqual(counts, { available: 8, active: 2, decide: 1, all: undefined, waiting: 5, live: undefined })
  const ov = buildOverview(items)
  assert.deepEqual(ov.needsOwner.map((r) => r.id), [ids.y])
  assert.deepEqual(ov.inProgress.map((r) => r.id), [ids.R])

  assert.equal(homeView(get(ids.x), items, 'decide'), 'available', 'a jump to a deferred node lands in Available')
  assert.equal(homeView(get(ids.x), items, 'waiting'), 'waiting')
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
  const refused = decsResult(root, ['defer', '1'])
  assert.notEqual(refused.code, 0, 'an agent does not put work off on its own')
  assert.match(refused.stderr, /owner’s call[\s\S]*nod ask 1[\s\S]*--owner-said/)
  assert.match(decs(root, ['defer', '1', '2', '--owner-said', 'leave these until after the launch']), /X1 deferred · Needs decision\nX2 deferred · To do/)
  assert.match(decs(root, ['get', '1']), new RegExp(`## ${NOTE_KIND.deferred}（agent · cli-test · lane · `), 'an agent shell writes as agent')
  assert.match(decs(root, ['get', '1']), /负责人原话：「leave these until after the launch」/)
  assert.equal(JSON.parse(decs(root, ['get', '1', '--json'])).deferred_by_ai, true)
  assert.equal(decs(root, ['show']).trim(), 'No nodes need a decision.')
  assert.match(decs(root, ['show', 'deferred']), /X1[^\n]*Deferred/)
  assert.match(decs(root, ['defer', '1', '--owner-said', 'later']), /was already deferred/)
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
  const child = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '200', '--unclaimed-after', '0s'], {
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

test('App: d asks until when — blank defers (grey, stays in Available), a day and a name waits on them (purple)', async (t) => {
  const store = tmpStore(t)
  const a = store.start(store.create({ title: 'a first one', author: A, task: true }))
  const c = store.start(store.create({ title: 'b second one', author: A, task: true }))
  const b = bench(t, store, { view: 'available' })
  await b.until(has(b, /a first one/))
  assert.match(b.frame()[0], /^decs +Available 2 +Active 2 +Human work +Waiting +Live +All +[○●] Main agent +⚡/)
  await b.press('d')
  await b.until(has(b, new RegExp(`Delay X${a.id} until: `)))
  await b.press('\r')
  await b.until(has(b, /delayed — d again to lift it/))
  assert.match(b.frame().slice(2).map((l) => l.split('│')[0]).join('\n'), /a first one/, 'still in Available')
  assert.ok(store.get(a.id)!.deferredAt)
  assert.equal(store.get(a.id)!.state, 'in_progress')
  assert.match(store.get(a.id)!.body, new RegExp(`## ${NOTE_KIND.deferred}（human · owner · `))

  await b.press(KEY.down)
  await b.until(right(b, /b second one/))
  await b.press('d', ...'3d Carol to confirm'.split(''), '\r')
  await b.until(has(b, /waiting on Carol to confirm/))
  assert.equal(store.get(c.id)!.state, 'waiting')
  assert.equal(store.get(c.id)!.waitingOn, 'Carol to confirm')
  assert.ok(store.get(c.id)!.waitingUntil)
})

test('App: Waiting lists deferred nodes; d lifts one there; on a finished node d says so', async (t) => {
  const store = tmpStore(t)
  const a = store.defer(store.create({ title: 'a do it later', author: A, options: opt, default: '1' }), owner)
  store.defer(store.create({ title: 'b also later', author: A, task: true }), owner)
  const b = bench(t, store, { view: 'waiting' })
  const left = () => b.frame().slice(2).map((l) => l.split('│')[0]).join('\n')
  await b.until(() => /a do it later/.test(left()) && /b also later/.test(left()))
  // Relative time goes through dayjs, which says "a few seconds ago" for a sub-minute span.
  assert.match(b.frame().join('\n'), /Deferred · (a few seconds ago|a minute ago|\d+ minutes ago)/)
  while (!right(b, /a do it later/)()) await b.press(KEY.down)
  await b.press('d')
  await b.until(has(b, /resumed · Needs decision/))
  assert.equal(store.get(a.id)!.deferredAt, undefined)
  assert.equal(store.get(a.id)!.state, 'needs_decision')
  await b.until(() => !/a do it later/.test(left()))
  assert.match(b.frame()[0], /Human work 1/, 'back in its views')

  const done = store.complete(store.start(store.create({ title: 'z all done', author: A, task: true })))
  const c = bench(t, store, { view: 'all' })
  await c.until(has(c, /✓ Finished 1/))
  await c.press('g', ...`${done.id}`.split(''), '\r')
  await c.until(has(c, /z all done/))
  await c.press('d')
  await c.until(has(c, /need deferring/))
})

test('App: --view deferred opens Waiting, where deferred nodes are listed', async (t) => {
  const store = tmpStore(t)
  store.defer(store.create({ title: 'x put it off', author: A, task: true }), owner)
  const b = bench(t, store, { view: 'waiting', openDeferred: true })
  await b.until(has(b, /x put it off/))
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
  assert.match(b.frame().join('\n'), /Deferred \(owner/, 'the detail pane says it is deferred')
})

test('延迟 is one thing: --on makes it active (waiting), a day alone passive; hold and defer are two spellings', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  for (const title of ['chase Carol', 'look again later', 'also later']) decs(root, ['add', '--task', title])
  decs(root, ['defer', '1', '--on', 'Carol to confirm', '--until', 'fri'])
  decs(root, ['hold', '2', '--until', 'fri', '--human'])
  decs(root, ['defer', '3', '--until', 'fri', '--human'])
  const get = (id: number) => JSON.parse(decs(root, ['get', String(id), '--json']))
  const [a, b, c] = [get(1), get(2), get(3)]
  assert.equal(a.status, 'waiting')
  assert.deepEqual([a.delay.kind, a.delay.on], ['active', 'Carol to confirm'])
  assert.equal(b.status, 'not_started', 'hold without --on is a passive delay, not an error')
  assert.equal(b.delay.kind, 'passive')
  assert.equal(c.delay.kind, 'passive')
  assert.equal(b.delay.until, c.delay.until)
  // Either spelling lifts either kind.
  decs(root, ['hold', '2', '--off'])
  decs(root, ['defer', '1', '--off'])
  assert.equal(get(2).delay, null)
  assert.equal(get(1).delay, null)
  assert.equal(get(1).status, 'not_started')
  assert.notEqual(decsResult(root, ['defer', '3', '--on', 'Bob']).code, 0, 'an active delay needs a day')
  // An agent waiting on someone outside is not putting work off: allowed without the owner's word.
  decs(root, ['add', '--task', 'wait on the vendor'])
  assert.equal(decsResult(root, ['defer', '4', '--on', 'the vendor quote', '--until', 'fri']).code, 0)
  assert.equal(get(4).delay.kind, 'active')
  assert.equal(get(4).deferred_by_ai, false)
})

test('one delay at a time: waiting on someone replaces a passive delay, and a plain defer replaces a wait', (t) => {
  const store = tmpStore(t)
  const d = store.defer(store.create({ title: 'later', author: A, task: true }), { ...owner, until: '2099-01-01T00:00:00' })
  const held = store.delay(d, { ...owner, on: 'Carol', until: '2099-01-02T00:00:00' })
  assert.equal(held.state, 'waiting')
  assert.equal(held.deferredAt, undefined)
  const back = store.delay(held, { ...owner, until: undefined })
  assert.equal(back.state, 'not_started')
  assert.equal(back.waitingOn, undefined)
  assert.ok(back.deferredAt)
  const lifted = store.undelay(back, owner)
  assert.equal(lifted.deferredAt, undefined)
})

test('old records of either kind read as a delay: deferred_at → passive, state waiting → active; both in Waiting and Available', (t) => {
  const store = tmpStore(t)
  const passive = store.defer(store.start(store.create({ title: 'old defer', author: A, task: true })), owner)
  const active = store.hold(store.start(store.create({ title: 'old hold', author: A, task: true })), 'customer', A, { until: '2099-01-01T00:00:00' })
  const items = store.all()
  const get = (id: number) => items.find((i) => i.id === id)!
  assert.equal(delayOf(get(passive.id))?.kind, 'passive')
  assert.equal(delayOf(get(active.id))?.kind, 'active')
  for (const id of [passive.id, active.id]) {
    assert.equal(inView('waiting', get(id), items), true)
    assert.equal(inView('available', get(id), items), true)
  }
})

test('「等」 is a few words: --on past 30 columns (CJK counts two) is refused, pointing at nod note; an old long one shows cut to one line', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  decs(root, ['init', '--no-register'])
  decs(root, ['add', '--task', 'migrate the bucket'])
  const long = decsResult(root, ['hold', '1', '--on', '等 lead 明天白天执行：本机、容器、同步工具都切到新地址', '--until', 'fri'])
  assert.notEqual(long.code, 0)
  assert.match(long.stderr, /limit is 30[\s\S]*nod note 1/)
  assert.equal(decsResult(root, ['hold', '1', '--on', '等 lead 切到新地址', '--until', 'fri']).code, 0, '17 columns is fine')

  const store = tmpStore(t)
  const d = store.create({ title: 'old wait', author: A, task: true })
  const file = store.hold(d, 'x', A, { until: '2099-01-01T00:00:00' }).file
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^waiting_on: .*$/m, 'waiting_on: Carol to confirm the invoice amount and the second page as well'))
  const items = store.all()
  const row = text(suffixOf(items[0], items, Date.now())[0])
  assert.match(row, /Carol to confirm the invoice …/)
})

/** Whether the right pane (what the cursor is on) mentions `re`. */
const right = (b: { frame: () => string[] }, re: RegExp) => () => b.frame().some((l) => re.test(l.split('│').slice(1).join('│')))
