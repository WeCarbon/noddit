import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyOps, newer, nextStamp, patchNode, pendingOver, readBench, type PendingOp, type Read } from '../app/src/optimistic.ts'
import type { Bench } from '../app/src/types.ts'

const benchWith = (status: Record<string, string>): Bench =>
  ({ nodes: Object.fromEntries(Object.entries(status).map(([key, s]) => [key, { key, status: s }])), views: [] }) as unknown as Bench

const answered = (key: string) => patchNode(key, (n) => ({ ...n, status: 'decided' }))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** What the window does with each read that comes back: keep the newest, drop the ops it shows. */
function window0(first: Bench) {
  let shown: Read = { bench: first, startedAt: 0 }
  let ops: PendingOp[] = []
  return {
    act: (id: number, patch: (b: Bench) => Bench) => (ops = [...ops, { id, patch }]),
    finish: (id: number) => (ops = ops.map((o) => (o.id === id ? { ...o, doneAt: nextStamp() } : o))),
    arrive: (r: Read) => {
      shown = newer(shown, r)
      ops = pendingOver(ops, shown.startedAt)
    },
    status: (key: string) => applyOps(shown.bench, ops, shown.startedAt).nodes[key].status,
    pending: () => ops.length,
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
