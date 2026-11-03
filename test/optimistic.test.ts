import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyOps, both, dropRows, heldAt, keepAllHeld, keepHeld, newer, nextStamp, patchNode, patchRows, pendingOver, readBench, runBatch, type Held, type PendingOp, type Read } from '../app/src/optimistic.ts'
import type { Bench, Row } from '../app/src/types.ts'

const benchWith = (status: Record<string, string>): Bench =>
  ({ nodes: Object.fromEntries(Object.entries(status).map(([key, s]) => [key, { key, status: s }])), views: [] }) as unknown as Bench

const answered = (key: string) => patchNode(key, (n) => ({ ...n, status: 'decided' }))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * The window as main.tsx and bench.tsx run it: keep the newest read, drop the ops it shows; in
 * the first list, the node acted on holds its row until the cursor moves off it.
 */
function window0(first: Bench) {
  const where = '|available'
  let shown: Read = { bench: first, startedAt: 0 }
  let ops: PendingOp[] = []
  let held: Held | null = null
  let selected = first.views[0]?.rows[0]?.key
  const bench = () => applyOps(shown.bench, ops, shown.startedAt)
  const rows = () => keepHeld(bench().views[0].rows, held, where, bench())
  return {
    act: (id: number, patch: (b: Bench) => Bench) => {
      const i = first.views.length ? rows().findIndex((r) => r.key === selected) : -1
      if (i >= 0) held = heldAt(rows(), i, where)
      ops = [...ops, { id, patch }]
    },
    finish: (id: number) => (ops = ops.map((o) => (o.id === id ? { ...o, doneAt: nextStamp() } : o))),
    arrive: (r: Read) => {
      shown = newer(shown, r)
      ops = pendingOver(ops, shown.startedAt)
    },
    status: (key: string) => bench().nodes[key].status,
    pending: () => ops.length,
    rows: () => rows().map((r) => r.key),
    row: (key: string) => rows().find((r) => r.key === key),
    selected: () => selected,
    down: () => {
      const list = rows()
      selected = list[Math.min(list.length - 1, list.findIndex((r) => r.key === selected) + 1)].key
      if (held && held.row.key !== selected) held = null
    },
  }
}

test('answering two in a row: a read begun before the first write lands late and must not undo it', async () => {
  const before = benchWith({ a: 'open', b: 'open' })
  const w = window0(before)

  w.act(1, answered('a'))
  // A refresh (the file watcher, a focus, the minute tick) starts while `nod push a` is still running.
  const slow = deferred<Bench>()
  const stale = readBench(() => slow.promise)
  w.finish(1)
  w.act(2, answered('b'))
  slow.resolve(before)
  w.arrive(await stale)

  assert.equal(w.status('a'), 'decided', 'the first answer flickered back to open')
  assert.equal(w.status('b'), 'decided')

  // The read the first write triggered comes in: it shows a, so a's patch can go.
  w.arrive(await readBench(async () => benchWith({ a: 'decided', b: 'open' })))
  assert.equal(w.status('a'), 'decided')
  assert.equal(w.status('b'), 'decided')
  assert.equal(w.pending(), 1, "only b's patch is still needed")
})

test('an older read arriving after a newer one is not shown', async () => {
  const w = window0(benchWith({ a: 'open' }))
  const old = deferred<Bench>()
  const first = readBench(() => old.promise)
  w.arrive(await readBench(async () => benchWith({ a: 'decided' })))
  old.resolve(benchWith({ a: 'open' }))
  w.arrive(await first)
  assert.equal(w.status('a'), 'decided')
})

test("a finished write's patch goes once a read begun after it arrives", async () => {
  const w = window0(benchWith({ a: 'open' }))
  w.act(1, answered('a'))
  w.finish(1)
  w.arrive(await readBench(async () => benchWith({ a: 'decided' })))
  assert.equal(w.pending(), 0)
  assert.equal(w.status('a'), 'decided')
})

const row = (key: string, state = 'needs_decision'): Row => ({ key: `r:${key}`, kind: 'node', depth: 0, fold: null, node: key, state, scope: 's', badge: [] })

/** Two lists: `available` loses a node once it is answered; `all` keeps it. */
function listsOf(status: Record<string, string>): Bench {
  const keys = Object.keys(status)
  const view = (name: string, rows: Row[]) => ({ view: name, label: name, empty: '', count: null, rows })
  return {
    nodes: Object.fromEntries(keys.map((k) => [k, { key: k, status: status[k] }])),
    views: [view('available', keys.filter((k) => status[k] !== 'decided').map((k) => row(k))), view('all', keys.map((k) => row(k, status[k])))],
  } as unknown as Bench
}

/** As bench.tsx's `answered`: out of every list but `all`, with the answered badge where it stays. */
const answer = (key: string) =>
  both(
    patchNode(key, (n) => ({ ...n, status: 'decided' })),
    dropRows(key, ['all']),
    patchRows(key, (r) => ({ ...r, state: 'decided', badge: [{ text: 'answered', color: 'green' }] })),
  )

test('an answered row stays in place, dimmed with its new badge, until the cursor moves; then ↓ lands on the next one', () => {
  const w = window0(listsOf({ a: 'needs_decision', b: 'needs_decision', c: 'needs_decision' }))
  w.act(1, answer('a'))
  assert.deepEqual(w.rows(), ['r:a', 'r:b', 'r:c'])
  assert.equal(w.selected(), 'r:a')
  assert.equal(w.row('r:a')?.context, true, 'dimmed')
  assert.equal(w.row('r:a')?.state, 'decided')
  assert.deepEqual(w.row('r:a')?.badge, [{ text: 'answered', color: 'green' }])
  w.down()
  assert.equal(w.selected(), 'r:b', 'no node skipped')
  assert.deepEqual(w.rows(), ['r:b', 'r:c'], 'a leaves once the owner moves on')
})

test('answering three in quick succession, reads landing late in between: each holds until moving on, none reverts', async () => {
  const start = listsOf({ a: 'needs_decision', b: 'needs_decision', c: 'needs_decision', d: 'needs_decision' })
  const w = window0(start)

  w.act(1, answer('a'))
  const slow1 = deferred<Bench>()
  const r1 = readBench(() => slow1.promise) // begun before a's write
  w.finish(1)
  w.down()
  w.act(2, answer('b'))
  assert.deepEqual(w.rows(), ['r:b', 'r:c', 'r:d'], 'a gone, b held')
  slow1.resolve(start)
  w.arrive(await r1)
  assert.equal(w.status('a'), 'decided', 'a reverted when b was answered')
  assert.deepEqual(w.rows(), ['r:b', 'r:c', 'r:d'], 'a did not come back')

  const slow2 = deferred<Bench>()
  const r2 = readBench(() => slow2.promise) // begun after a's write, before b's
  w.finish(2)
  w.down()
  w.act(3, answer('c'))
  slow2.resolve(listsOf({ a: 'decided', b: 'needs_decision', c: 'needs_decision', d: 'needs_decision' }))
  w.arrive(await r2)
  assert.deepEqual([w.status('a'), w.status('b'), w.status('c')], ['decided', 'decided', 'decided'])
  assert.deepEqual(w.rows(), ['r:c', 'r:d'])

  w.finish(3)
  w.arrive(await readBench(async () => listsOf({ a: 'decided', b: 'decided', c: 'decided', d: 'needs_decision' })))
  assert.equal(w.pending(), 0)
  assert.deepEqual(w.rows(), ['r:c', 'r:d'], 'c still held once its write is read back')
  assert.equal(w.row('r:c')?.state, 'decided', 'with the look the CLI gives it')
  w.down()
  assert.deepEqual(w.rows(), ['r:d'])
  assert.equal(w.selected(), 'r:d')
})

test('a held row comes back only in its own list, never twice, and before the row that was under it', () => {
  const b = listsOf({ a: 'decided', b: 'decided', c: 'needs_decision' })
  const held = heldAt([row('a'), row('b'), row('c')], 1, '|available')
  const keys = (rows: Row[]) => rows.map((r) => r.key)
  assert.deepEqual(keys(keepHeld(b.views[0].rows, held, '|decide', b)), ['r:c'], 'another list')
  assert.deepEqual(keys(keepHeld(b.views[0].rows, held, '|available', b)), ['r:b', 'r:c'], 'the row above went too')
  assert.deepEqual(keys(keepHeld([row('a'), row('b'), row('c')], held, '|available', b)), ['r:a', 'r:b', 'r:c'], 'still listed: not added again')
})

test('runBatch: every patch shows at once; a failed write rolls back only its own node and is reported', async () => {
  const first = benchWith({ 'web#1': 'not_started', 'web#2': 'not_started', 'web#3': 'not_started' })
  let ops: PendingOp[] = []
  const update = (fn: (o: PendingOp[]) => PendingOp[]) => void (ops = fn(ops))
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
  const keys = ['web#1', 'web#2', 'web#3']
  const items = keys.map((key, i) => ({
    ref: `W${i + 1}`,
    patch: answered(key),
    write: async () => {
      await gates[i].promise
      if (i === 1) throw new Error('locked by another writer\nmore detail')
    },
  }))
  const done = runBatch(items, update, 100)

  const shown = (at = 0) => keys.map((k) => applyOps(first, ops, at).nodes[k].status)
  assert.deepEqual(shown(), ['decided', 'decided', 'decided'], 'all three show before any write returns')

  for (const g of gates) g.resolve()
  const failed = await done

  assert.deepEqual(failed.map((f) => f.ref), ['W2'])
  assert.match(failed[0].error.message, /^locked by another writer/)
  assert.deepEqual(ops.map((o) => o.id), [100, 102], 'only the failed node’s patch is gone')
  assert.ok(ops.every((o) => o.doneAt !== undefined), 'the others are stamped done')
  assert.deepEqual(shown(), ['decided', 'not_started', 'decided'])
  assert.deepEqual(shown(nextStamp()), ['not_started', 'not_started', 'not_started'], 'a read begun after the writes stands on its own')
})

test('runBatch: at most `limit` writes in flight at once, and every one runs', async () => {
  let inFlight = 0
  let peak = 0
  const ran: string[] = []
  const items = Array.from({ length: 7 }, (_, i) => ({
    ref: `W${i}`,
    patch: (b: Bench) => b,
    write: async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      ran.push(`W${i}`)
      inFlight--
    },
  }))
  let ops: PendingOp[] = []
  const failed = await runBatch(items, (fn) => void (ops = fn(ops)), 1, 3)
  assert.deepEqual(failed, [])
  assert.equal(peak, 3)
  assert.equal(ran.length, 7)
  assert.equal(ops.length, 7)
})

test('keepAllHeld: a batch’s rows that left the list all come back in their places, next to each other too', () => {
  const row = (key: string) => ({ key, kind: 'node', node: key, depth: 0 }) as Row
  const before = ['a', 'b', 'c', 'd', 'e'].map(row)
  const held = [heldAt(before, 2, '|x'), heldAt(before, 1, '|x'), heldAt(before, 4, '|x')]
  const empty = { nodes: {}, views: [] } as unknown as Bench
  const back = keepAllHeld([row('a'), row('d')], held, '|x', empty)
  assert.deepEqual(back.map((r) => r.key), ['a', 'b', 'c', 'd', 'e'])
  assert.ok(back.filter((r) => ['b', 'c', 'e'].includes(r.key)).every((r) => r.context), 'held rows show dimmed')
  assert.deepEqual(keepAllHeld([row('a'), row('d')], held, '|other', empty).map((r) => r.key), ['a', 'd'], 'only in the list they were held in')
})
