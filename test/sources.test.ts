import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import {
  ackSourceItems,
  heartbeatSource,
  isCleared,
  listSourceNames,
  listSources,
  parseIncomingItemsJsonl,
  parseWaitingOnRef,
  projectLetterOf,
  pushSourceItem,
  readSourceState,
  registerSource,
  sourceEventsSince,
  syncSourceItems,
  waitingOnBlocks,
  waitingOnBucket,
  type SourceItem,
} from '../src/core/sources.ts'

const BIN = fileURLToPath(new URL('../bin/decs.ts', import.meta.url))

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'decs-sources-test-'))
}

function mkItem(over: Partial<SourceItem> = {}): SourceItem {
  return {
    id: '1',
    title: 't',
    firstSeen: '2026-01-01T00:00:00+08:00',
    updatedAt: '2026-01-01T00:00:00+08:00',
    handled: false,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

test('register: first call sets everything, a later partial call does not blank fields', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)

  registerSource(layout, { name: 'github-issues', title: 'github-issues v2.4 manual test', kind: 'github', adapter: 'python3 sync.py', staleAfter: '10m' })
  const again = registerSource(layout, { name: 'github-issues', adapter: 'python3 sync2.py' })

  assert.equal(again.title, 'github-issues v2.4 manual test', 're-registering without --title must not blank it')
  assert.equal(again.kind, 'github')
  assert.equal(again.adapter, 'python3 sync2.py', 'a given field does update')
  assert.equal(again.staleAfter, '10m')
})

test('register: rejects a bad stale-after format', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  assert.throws(() => registerSource(layout, { name: 'x', staleAfter: 'soon' }), /not a valid duration/)
})

test('register: rejects a name with path-unsafe characters', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  assert.throws(() => registerSource(layout, { name: '../escape' }), /is not valid/)
})

// ---------------------------------------------------------------------------
// sync diff
// ---------------------------------------------------------------------------

test('sync: classifies new, changed, gone and unchanged correctly', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })

  const first = syncSourceItems(layout, 'github-issues', [
    { id: '1', title: 'item 1', url: 'https://x/1', state: 'open' },
    { id: '2', title: 'item 2' },
  ])
  assert.deepEqual(first.new.map((i) => i.id).sort(), ['1', '2'])
  assert.equal(first.changed.length, 0)
  assert.equal(first.gone.length, 0)

  // Same content again: nothing should fire.
  const second = syncSourceItems(layout, 'github-issues', [
    { id: '1', title: 'item 1', url: 'https://x/1', state: 'open' },
    { id: '2', title: 'item 2' },
  ])
  assert.equal(second.new.length, 0)
  assert.equal(second.changed.length, 0)
  assert.equal(second.gone.length, 0)
  assert.equal(second.unchanged, 2)

  // id 2 disappears, id 1's state changes.
  const third = syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'item 1', url: 'https://x/1', state: 'resolved' }])
  assert.deepEqual(third.changed.map((i) => i.id), ['1'])
  assert.deepEqual(third.gone.map((i) => i.id), ['2'])

  const state = readSourceState(layout, 'github-issues')
  assert.equal(state.items['2'].gone, true, 'gone items are kept, marked gone — not deleted')
  assert.equal(state.items['1'].state, 'resolved')
})

test('sync: a changed item resets handled/waiting_on — new content needs another look', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'item 1', state: 'open' }])
  ackSourceItems(layout, 'github-issues', ['1'], { by: 'lane', waitingOn: 'owner' })

  let state = readSourceState(layout, 'github-issues')
  assert.equal(state.items['1'].handled, true)

  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'item 1', state: 'resolved' }])
  state = readSourceState(layout, 'github-issues')
  assert.equal(state.items['1'].handled, false, 'content changed — the old ack no longer applies')
  assert.equal(state.items['1'].waitingOn, undefined)
})

test('sync: an item that reappears after going gone is treated as a fresh change', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'item 1' }])
  syncSourceItems(layout, 'github-issues', []) // goes gone
  assert.equal(readSourceState(layout, 'github-issues').items['1'].gone, true)

  const back = syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'item 1' }])
  assert.deepEqual(back.changed.map((i) => i.id), ['1'])
  assert.equal(readSourceState(layout, 'github-issues').items['1'].gone, false)
})

test('sync: refuses an unregistered source', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  assert.throws(() => syncSourceItems(layout, 'nope', []), /is not registered yet/)
})

test('push: new/changed/unchanged, one item at a time', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'support-inbox', title: 'support-inbox' })

  const a = pushSourceItem(layout, 'support-inbox', { id: '1', title: 'hello' })
  assert.equal(a.kind, 'new')
  const b = pushSourceItem(layout, 'support-inbox', { id: '1', title: 'hello' })
  assert.equal(b.kind, 'unchanged')
  const c = pushSourceItem(layout, 'support-inbox', { id: '1', title: 'hello (edited)' })
  assert.equal(c.kind, 'changed')
})

// ---------------------------------------------------------------------------
// concurrent push — the O_EXCL lock must not lose a write
// ---------------------------------------------------------------------------

test('concurrent pushes from several processes never lose an item or corrupt state.json', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })

  const N = 16
  const procs = Array.from({ length: N }, (_, i) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [BIN, 'source', 'push', 'github-issues', '--id', String(i), '--title', `item ${i}`],
        { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
      )
      child.once('error', reject)
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    }),
  )

  return Promise.all(procs).then(() => {
    const state = readSourceState(layout, 'github-issues')
    const ids = Object.keys(state.items).sort((a, b) => Number(a) - Number(b))
    assert.deepEqual(ids, Array.from({ length: N }, (_, i) => String(i)), 'every concurrent push must land')
    for (let i = 0; i < N; i++) assert.equal(state.items[String(i)].title, `item ${i}`)
  })
})

// ---------------------------------------------------------------------------
// ack / waiting_on / cleared
// ---------------------------------------------------------------------------

test('ack: marks handled, records who/why, and the waiting_on value is stored verbatim', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'x' }])

  const [acked] = ackSourceItems(layout, 'github-issues', ['1'], { by: 'lane · triage', note: 'handed off to Bob', waitingOn: 'Bob' })
  assert.equal(acked.handled, true)
  assert.equal(acked.handledBy, 'lane · triage')
  assert.equal(acked.handledNote, 'handed off to Bob')
  assert.equal(acked.waitingOn, 'Bob', 'stored exactly as given — no parsing on write')
})

test('ack: throws naming any id that does not exist', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'x' }])
  assert.throws(() => ackSourceItems(layout, 'github-issues', ['1', '99'], { by: 'lane' }), /99/)
})

test('parseWaitingOnRef: owner/us literals, node refs (plain, legacy D, project-letter), and a person', () => {
  assert.deepEqual(parseWaitingOnRef('owner'), { raw: 'owner', kind: 'owner' })
  assert.deepEqual(parseWaitingOnRef('us'), { raw: 'us', kind: 'us' })
  assert.deepEqual(parseWaitingOnRef('304'), { raw: '304', kind: 'ref', projectLetter: undefined, refId: 304 })
  assert.deepEqual(parseWaitingOnRef('D304'), { raw: 'D304', kind: 'ref', projectLetter: 'D', refId: 304 })
  assert.deepEqual(parseWaitingOnRef('T304'), { raw: 'T304', kind: 'ref', projectLetter: 'T', refId: 304 })
  assert.deepEqual(parseWaitingOnRef('Bob'), { raw: 'Bob', kind: 'person' })
})

test('waitingOnBlocks: owner/us/a node ref block cleared; a person does not', () => {
  assert.equal(waitingOnBlocks('owner'), true)
  assert.equal(waitingOnBlocks('us'), true)
  assert.equal(waitingOnBlocks('T304'), true)
  assert.equal(waitingOnBlocks('D304'), true)
  assert.equal(waitingOnBlocks('304'), true)
  assert.equal(waitingOnBlocks('Bob'), false)
  assert.equal(waitingOnBlocks(undefined), false)
})

test('waitingOnBucket: owner/us collapse, everything else (ref or person) shown as-is', () => {
  assert.equal(waitingOnBucket('owner'), 'owner')
  assert.equal(waitingOnBucket('us'), 'us')
  assert.equal(waitingOnBucket('T304'), 'T304')
  assert.equal(waitingOnBucket('Bob'), 'Bob')
  assert.equal(waitingOnBucket(undefined), 'unhandled')
})

test('isCleared: no unhandled items, and nothing parked on owner/us/a node ref', () => {
  assert.equal(isCleared([]), true, 'no items at all is cleared')
  assert.equal(isCleared([mkItem({ handled: true })]), true)
  assert.equal(isCleared([mkItem({ handled: false })]), false, 'an unhandled item blocks')
  assert.equal(isCleared([mkItem({ handled: true, waitingOn: 'owner' })]), false, 'handled but parked on owner still blocks')
  assert.equal(isCleared([mkItem({ handled: true, waitingOn: 'us' })]), false)
  assert.equal(isCleared([mkItem({ handled: true, waitingOn: 'T304' })]), false, 'parked on an open node still blocks')
  assert.equal(isCleared([mkItem({ handled: true, waitingOn: 'Bob' })]), true, 'parked on a person does not block — handed off')
})

// ---------------------------------------------------------------------------
// stale heartbeat
// ---------------------------------------------------------------------------

test('listSources: flags a source stale when its heartbeat is older than stale_after', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues', staleAfter: '1m' })
  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'x' }]) // sets heartbeat to "now"

  const store = new Store([layout])
  const fresh = listSources(store).find((s) => s.name === 'github-issues')!
  assert.equal(fresh.stale, false)

  // Rewrite state.json with an old heartbeat, as if the adapter died an hour ago.
  const statePath = join(layout.root, 'sources', 'github-issues', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.heartbeatAt = '2000-01-01T00:00:00+08:00'
  writeFileSync(statePath, JSON.stringify(state))

  const stale = listSources(store).find((s) => s.name === 'github-issues')!
  assert.equal(stale.stale, true)
})

test('listSources: a source that never heartbeated is judged by its registration age', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues', staleAfter: '1m' })
  mkdirSync(join(layout.root, 'sources', 'github-issues'), { recursive: true })
  // Pretend it was registered long ago and never once heartbeated.
  const cfgPath = join(layout.root, 'sources', 'github-issues', 'source.md')
  writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(/created: .*/, 'created: 2000-01-01T00:00:00+08:00'))

  const store = new Store([layout])
  const s = listSources(store).find((x) => x.name === 'github-issues')!
  assert.equal(s.stale, true)
})

// ---------------------------------------------------------------------------
// decs source wait — exits once an unhandled item shows up
// ---------------------------------------------------------------------------

test('cli: `decs source wait` blocks, then exits as soon as a new item appears', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })

  const child = spawn(process.execPath, [BIN, 'source', 'wait', 'github-issues', '--timeout', '15', '--json'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  child.stdout.on('data', (c) => (out += c))

  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? -1))
  })

  // Give `wait` a moment to be blocked on the empty queue, then push an item.
  await new Promise((r) => setTimeout(r, 300))
  pushSourceItem(layout, 'github-issues', { id: '1', title: 'brand new' })

  const code = await exited
  assert.equal(code, 0)
  const parsed = JSON.parse(out.trim())
  assert.equal(parsed.updates, true)
  assert.equal(parsed.count_at_wake, 1)
})

test('cli: `decs source wait` returns instantly when something is already unhandled', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'already there' }])

  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'source', 'wait', 'github-issues', '--timeout', '5', '--json'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let buf = ''
    child.stdout.on('data', (c) => (buf += c))
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve(buf) : reject(new Error(`exit ${code}`))))
  })
  assert.equal(JSON.parse(out.trim()).updates, true)
})

test('cli: `decs source wait` times out with exit code 2 when nothing shows up', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'source', 'wait', 'github-issues', '--timeout', '1'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.once('error', reject)
    child.once('exit', (c) => resolve(c ?? -1))
  })
  assert.equal(code, 2)
})

// ---------------------------------------------------------------------------
// events since
// ---------------------------------------------------------------------------

test('sourceEventsSince: only events strictly after the given timestamp come back', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  const store = new Store([layout])

  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'first' }])
  const before = sourceEventsSince(store, undefined)
  assert.equal(before.length, 1)
  const cursor = before[0].at

  // `at` has millisecond resolution; force a gap so two calls don't race the same millisecond
  await new Promise((r) => setTimeout(r, 10))

  syncSourceItems(layout, 'github-issues', [
    { id: '1', title: 'first' },
    { id: '2', title: 'second' },
  ])

  const since = sourceEventsSince(store, cursor)
  assert.deepEqual(since.map((e) => e.id), ['2'])
  assert.equal(since[0].kind, 'new')
  assert.equal(since[0].project, basename(root))

  const all = sourceEventsSince(store, undefined)
  assert.equal(all.length, 2)
})

test('sourceEventsSince: can filter to one source by name', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  registerSource(layout, { name: 'support-inbox', title: 'support-inbox' })
  const store = new Store([layout])

  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'a' }])
  syncSourceItems(layout, 'support-inbox', [{ id: '1', title: 'm' }])

  const githubOnly = sourceEventsSince(store, undefined, { name: 'github-issues' })
  assert.equal(githubOnly.length, 1)
  assert.equal(githubOnly[0].source, 'github-issues')
})

// ---------------------------------------------------------------------------
// cli end-to-end — the `decs source <verb>` dispatcher itself, not just core
// ---------------------------------------------------------------------------

function run(root: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

test('cli: register → sync → list/items --json → ack → events --json, end to end', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await run(root, ['init', '--no-register'])

  const reg = await run(root, ['source', 'register', 'github-issues', '--title', 'github-issues release', '--kind', 'github', '--json'])
  assert.equal(reg.code, 0)
  assert.equal(JSON.parse(reg.stdout).name, 'github-issues')

  const sync = await run(
    root,
    ['source', 'sync', 'github-issues', '--json'],
    '{"id":"1","title":"work item 1"}\n{"id":"2","title":"work item 2"}\n',
  )
  assert.equal(sync.code, 0)
  const diff = JSON.parse(sync.stdout)
  assert.deepEqual(diff.new.map((i: { id: string }) => i.id).sort(), ['1', '2'])

  const list = await run(root, ['source', 'list', '--json'])
  assert.equal(list.code, 0)
  const summaries = JSON.parse(list.stdout)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].unhandled, 2)
  assert.equal(summaries[0].cleared, false)

  const items = await run(root, ['source', 'items', 'github-issues', '--unhandled', '--json'])
  assert.equal(items.code, 0)
  assert.equal(JSON.parse(items.stdout).length, 2)

  const ack = await run(root, ['source', 'ack', 'github-issues', '1', '2', '--by', 'test · e2e', '--json'])
  assert.equal(ack.code, 0)
  assert.equal(JSON.parse(ack.stdout).length, 2)

  const listAfter = await run(root, ['source', 'list', '--json'])
  assert.equal(JSON.parse(listAfter.stdout)[0].cleared, true, 'everything acked with no owner/us/node parking → cleared')

  const events = await run(root, ['source', 'events', '--json'])
  assert.equal(events.code, 0)
  assert.equal(JSON.parse(events.stdout).length, 2, 'two new-item events, no changed/gone yet')
})

test('cli: push updates heartbeat and reports kind; a bad --stale-after is rejected with a clear error', async (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await run(root, ['init', '--no-register'])
  await run(root, ['source', 'register', 'support-inbox', '--title', 'support-inbox'])

  const push = await run(root, ['source', 'push', 'support-inbox', '--id', '1', '--title', 'hi', '--json'])
  assert.equal(push.code, 0)
  assert.equal(JSON.parse(push.stdout).kind, 'new')

  const bad = await run(root, ['source', 'register', 'support-inbox', '--stale-after', 'soon'])
  assert.notEqual(bad.code, 0)
  assert.match(bad.stderr, /not a valid duration/)
})

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

test('listSourceNames: only directories that have a parseable source.md count', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  mkdirSync(join(layout.root, 'sources', 'half-written'), { recursive: true }) // no source.md
  assert.deepEqual(listSourceNames(layout), ['github-issues'])
})

test('projectLetterOf: reads decisions/decs.json, defaults to X', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  assert.equal(projectLetterOf(layout), 'X')
  writeFileSync(join(layout.root, 'decs.json'), JSON.stringify({ letter: 'W' }))
  assert.equal(projectLetterOf(layout), 'W')
})

test('parseIncomingItemsJsonl: requires id and title, names the bad line number', () => {
  assert.deepEqual(parseIncomingItemsJsonl('{"id":"1","title":"a"}\n\n{"id":"2","title":"b","url":"u"}\n'), [
    { id: '1', title: 'a', url: undefined, state: undefined, from: undefined },
    { id: '2', title: 'b', url: 'u', state: undefined, from: undefined },
  ])
  assert.throws(() => parseIncomingItemsJsonl('{"title":"missing id"}'), /line 1 is missing "id"/)
  assert.throws(() => parseIncomingItemsJsonl('not json'), /line 1 is not valid JSON/)
})

test('heartbeatSource: refuses an unregistered source, otherwise bumps heartbeatAt', (t) => {
  const root = scratch()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  assert.throws(() => heartbeatSource(layout, 'nope'), /is not registered yet/)
  registerSource(layout, { name: 'github-issues', title: 'github-issues' })
  const at = heartbeatSource(layout, 'github-issues')
  assert.equal(readSourceState(layout, 'github-issues').heartbeatAt, at)
})

test('integration: buildOverview carries listSources, and decs changes lists source events', async (t) => {
  const { overviewOf } = await import('../src/core/overview.ts')
  const { decs } = await import('./helpers.ts')
  const root = mkdtempSync(join(tmpdir(), 'decs-ov-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  const store = new Store([layout])
  registerSource(layout, { name: 'github-issues', title: 'github-issues', kind: 'github', ownerAgent: 'lead' })
  registerSource(layout, { name: 'support-inbox', title: 'support-inbox', kind: 'email', ownerAgent: 'support-lane' })
  const cut = new Date(Date.now() - 1000).toISOString()
  syncSourceItems(layout, 'github-issues', [{ id: '12345', title: 'blank page', state: 'active' }])
  syncSourceItems(layout, 'support-inbox', [{ id: 'm1', title: 'mail from Carol' }])

  const ov = overviewOf(store)
  assert.deepEqual(ov.sources.map((s) => [s.name, s.unhandled, s.cleared]).sort(), [['github-issues', 1, false], ['support-inbox', 1, false]])

  const all = JSON.parse(decs(root, ['changes', '--since', cut, '--json']))
  assert.deepEqual(all.source_events.map((e: { source: string; id: string; kind: string }) => [e.source, e.id, e.kind]).sort(), [
    ['github-issues', '12345', 'new'],
    ['support-inbox', 'm1', 'new'],
  ])
  const mine = JSON.parse(decs(root, ['changes', '--since', cut, '--json', '--author', 'lead']))
  assert.deepEqual(mine.source_events.map((e: { source: string }) => e.source), ['github-issues'], 'filtered by owner_agent')
  const human = JSON.parse(decs(root, ['changes', '--since', cut, '--json', '--role', 'human']))
  assert.deepEqual(human.source_events, [], 'source events have no role')
  assert.match(decs(root, ['changes', '--since', cut]), /github-issues#12345 · new source entry · source · blank page/)
  // next_since is second-precision, so same-second events may repeat once
  // (documented); a cut after them returns none.
  const later = JSON.parse(decs(root, ['changes', '--since', new Date(Date.now() + 2000).toISOString(), '--json']))
  assert.deepEqual(later.source_events, [])
})

test('bench --json carries listSources too, for a window with no summary strip to read it from', async (t) => {
  const { benchJson } = await import('../src/tui/json.ts')
  const root = mkdtempSync(join(tmpdir(), 'decs-bench-sources-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = initLayout(root)
  const store = new Store([layout])
  registerSource(layout, { name: 'github-issues', title: 'github-issues v2', kind: 'github' })
  registerSource(layout, { name: 'support-inbox', title: 'support-inbox', kind: 'email' })
  syncSourceItems(layout, 'github-issues', [{ id: '1', title: 'blank page' }])

  const out = benchJson(store) as {
    sources: { project: string; name: string; title: string; total: number; unhandled: number; cleared: boolean; stale: boolean }[]
  }
  const byName = new Map(out.sources.map((s) => [s.name, s]))
  assert.equal(byName.get('github-issues')!.title, 'github-issues v2')
  assert.equal(byName.get('github-issues')!.unhandled, 1)
  assert.equal(byName.get('github-issues')!.cleared, false)
  assert.equal(byName.get('support-inbox')!.cleared, true, 'nothing pushed yet — nothing to clear')
})
