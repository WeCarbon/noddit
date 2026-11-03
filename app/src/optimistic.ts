import type { Bench, Node, Row, ViewName } from './types.ts'

/**
 * An action shown before the CLI has done it. Its patch is laid over every bench that
 * arrives until the write has finished and a bench whose read began after it has come in —
 * so a refresh landing mid-flight never flickers the old state back. A failed write drops
 * its patch, which is the rollback.
 */
export interface PendingOp {
  id: number
  patch: (b: Bench) => Bench
  /** `nextStamp()` when the CLI call returned; a read begun after this shows the result. */
  doneAt?: number
}

/** A bench and the `nextStamp()` its read began at: it shows every write finished before then. */
export interface Read {
  bench: Bench
  startedAt: number
}

let stamps = 0
/** Strictly increasing, so a write's end and a read's start never tie. */
export const nextStamp = (): number => ++stamps

export async function readBench(load: () => Promise<Bench>): Promise<Read> {
  const startedAt = nextStamp()
  return { bench: await load(), startedAt }
}

/** The read to show: a slower, older one arriving late never replaces a newer one. */
export const newer = (shown: Read | null, next: Read): Read => (!shown || next.startedAt > shown.startedAt ? next : shown)

/** The ops a bench read at `startedAt` doesn't show yet. */
export const pendingOver = (ops: PendingOp[], startedAt: number): PendingOp[] => ops.filter((op) => !op.doneAt || op.doneAt > startedAt)

export function applyOps(b: Bench, ops: PendingOp[], startedAt: number): Bench {
  return pendingOver(ops, startedAt).reduce((acc, op) => op.patch(acc), b)
}

/** The node at `key`, changed by `fn`, wherever it is listed. */
export const patchNode =
  (key: string, fn: (n: Node) => Node) =>
  (b: Bench): Bench =>
    b.nodes[key] ? { ...b, nodes: { ...b.nodes, [key]: fn(b.nodes[key]) } } : b

/** The rows for `key`, changed by `fn`, in every view. */
export const patchRows =
  (key: string, fn: (r: Row) => Row, only?: ViewName[]) =>
  (b: Bench): Bench => ({
    ...b,
    views: b.views.map((v) => (only && !only.includes(v.view) ? v : { ...v, rows: v.rows.map((r) => (r.kind === 'node' && r.node === key ? fn(r) : r)) })),
  })

/** Takes `key`'s row out of every view but `keep`, with the number on those views. */
export const dropRows =
  (key: string, keep: ViewName[]) =>
  (b: Bench): Bench => ({
    ...b,
    views: b.views.map((v) => {
      if (keep.includes(v.view)) return v
      const listed = v.rows.some((r) => r.kind === 'node' && r.node === key && !r.context)
      if (!listed) return v
      return { ...v, rows: v.rows.filter((r) => !(r.kind === 'node' && r.node === key)), count: v.count === null ? null : Math.max(0, v.count - 1) }
    }),
  })

export const both =
  (...patches: ((b: Bench) => Bench)[]) =>
  (b: Bench): Bench =>
    patches.reduce((acc, p) => p(acc), b)

/** Where the rows under `rows[i]` (deeper than it) end. */
function blockEnd(rows: Row[], i: number): number {
  let j = i + 1
  while (j < rows.length && rows[j].depth > rows[i].depth) j++
  return j
}

function movedRows(rows: Row[], key: string, target: string, after: boolean): Row[] {
  const i = rows.findIndex((r) => r.key === key)
  const t = rows.findIndex((r) => r.key === target)
  if (i < 0 || t < 0 || !rows[i].scope || rows[i].scope !== rows[t].scope) return rows
  const piece = rows.slice(i, blockEnd(rows, i))
  const rest = [...rows.slice(0, i), ...rows.slice(blockEnd(rows, i))]
  const ti = rest.findIndex((r) => r.key === target)
  const at = after ? blockEnd(rest, ti) : ti
  return [...rest.slice(0, at), ...piece, ...rest.slice(at)]
}

/** `key`'s row, with the rows under it, moved before or after `target`'s, in every list that has both in one scope. */
export const moveRow =
  (key: string, target: string, after: boolean) =>
  (b: Bench): Bench => ({
    ...b,
    views: b.views.map((v) => ({ ...v, rows: movedRows(v.rows, key, target, after) })),
    project_views: b.project_views?.map((p) => ({ ...p, rows: movedRows(p.rows, key, target, after) })),
  })

/** The row of the node the owner just acted on, kept in `where` (a list) until they pick another. */
export interface Held {
  row: Row
  /** Its neighbours when it was acted on, and its index should both have gone too. */
  above: string | null
  below: string | null
  index: number
  where: string
}

export function heldAt(rows: Row[], i: number, where: string): Held {
  return { row: rows[i], above: rows[i - 1]?.key ?? null, below: rows[i + 1]?.key ?? null, index: i, where }
}

/** `rows` with `held` back in its place if it has left them: dimmed, with the look its node has in the other lists now. */
export function keepHeld(rows: Row[], held: Held | null, where: string, b: Bench): Row[] {
  if (!held || held.where !== where || rows.some((r) => r.key === held.row.key)) return rows
  const now = b.views.flatMap((v) => v.rows).find((r) => r.kind === 'node' && r.node === held.row.node)
  const look = now ? { state: now.state, glyph: now.glyph, badge: now.badge, badge_short: now.badge_short, deferred: now.deferred } : {}
  const row: Row = { ...held.row, ...look, context: true, scope: null }
  const below = rows.findIndex((r) => r.key === held.below)
  const above = rows.findIndex((r) => r.key === held.above)
  const at = below >= 0 ? below : above >= 0 ? above + 1 : Math.min(held.index, rows.length)
  return [...rows.slice(0, at), row, ...rows.slice(at)]
}

/** `rows` with every held row back in its place, the earliest first so each finds its neighbours. */
export const keepAllHeld = (rows: Row[], held: Held[], where: string, b: Bench): Row[] =>
  [...held].sort((x, y) => x.index - y.index).reduce((acc, h) => keepHeld(acc, h, where, b), rows)

/** One node's share of a batch action: what it shows at once, and the write behind it. */
export interface BatchItem {
  ref: string
  patch: (b: Bench) => Bench
  write: () => Promise<unknown>
  /** Running it is a Nod (the ⚡ counter goes up by one). */
  nod?: boolean
}

/**
 * Shows every item's patch at once, then writes them `limit` at a time. A write that
 * finishes stamps its own patch; one that fails drops only its own (the rollback).
 * Resolves to the items that failed, with why.
 */
export async function runBatch(
  items: BatchItem[],
  update: (fn: (ops: PendingOp[]) => PendingOp[]) => void,
  firstId: number,
  limit = 3,
): Promise<{ ref: string; error: Error }[]> {
  const ids = items.map((_, i) => firstId + i)
  update((ops) => [...ops, ...items.map((item, i) => ({ id: ids[i], patch: item.patch }))])
  const failed: { at: number; ref: string; error: Error }[] = []
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const at = next++
      try {
        await items[at].write()
        update((ops) => ops.map((op) => (op.id === ids[at] ? { ...op, doneAt: nextStamp() } : op)))
      } catch (e) {
        update((ops) => ops.filter((op) => op.id !== ids[at]))
        failed.push({ at, ref: items[at].ref, error: e instanceof Error ? e : new Error(String(e)) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
  return failed.sort((a, b) => a.at - b.at).map(({ ref, error }) => ({ ref, error }))
}
