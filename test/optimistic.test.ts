import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyOps, both, dropRows, heldAt, keepHeld, newer, nextStamp, patchNode, patchRows, pendingOver, readBench, type Held, type PendingOp, type Read } from '../app/src/optimistic.ts'
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
