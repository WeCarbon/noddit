import type { Bench, Node, Row, ViewName } from './types.ts'

/**
 * An action shown before the CLI has done it. Its patch is laid over every bench that
 * arrives until the write has finished and a bench read after it has come in — so a
 * refresh landing mid-flight never flickers the old state back. A failed write drops
 * its patch, which is the rollback.
 */
export interface PendingOp {
  id: number
  patch: (b: Bench) => Bench
  /** When the CLI call returned; a bench loaded after this already shows the result. */
  doneAt?: number
}

export function applyOps(b: Bench, ops: PendingOp[], loadedAt: number): Bench {
  return ops.filter((op) => !op.doneAt || op.doneAt > loadedAt).reduce((acc, op) => op.patch(acc), b)
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
