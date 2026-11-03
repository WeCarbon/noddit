/**
 * The list's multi-selection, as pure functions over row keys in list order. The cursor
 * (`prefs.selected`) is separate: it is where ↑/↓ and the detail pane are; this is what a
 * batch action acts on.
 */
export interface Selection {
  keys: string[]
  /** Where a ⇧-click or ⇧↑/⇧↓ range runs from. */
  anchor: string | null
}

export const NONE: Selection = { keys: [], anchor: null }

const inOrder = (order: string[], keys: Iterable<string>): string[] => {
  const want = new Set(keys)
  return order.filter((k) => want.has(k))
}

/** The keys from `a` to `b` inclusive, whichever comes first; empty if either is not listed. */
export function between(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  if (i < 0 || j < 0) return []
  return order.slice(Math.min(i, j), Math.max(i, j) + 1)
}

/** ⌘-click: `key` in or out. The first ⌘-click also keeps the row the cursor is on. */
export function toggle(sel: Selection, order: string[], key: string, cursor: string | null): Selection {
  const base = sel.keys.length ? sel.keys : cursor && cursor !== key ? [cursor] : []
  const keys = base.includes(key) ? base.filter((k) => k !== key) : [...base, key]
  return { keys: inOrder(order, keys), anchor: key }
}

/** ⇧-click: everything from the anchor (or the cursor) to `key`; the anchor stays put. */
export function range(sel: Selection, order: string[], key: string, cursor: string | null): Selection {
  const anchor = sel.anchor ?? cursor ?? key
  const keys = between(order, anchor, key)
  return keys.length ? { keys, anchor } : { keys: [key], anchor: key }
}

/** ⇧↑ / ⇧↓: the cursor one row on, the range from the anchor to it selected. */
export function extend(sel: Selection, order: string[], cursor: string | null, delta: number): { sel: Selection; cursor: string | null } {
  if (!order.length) return { sel, cursor }
  const at = cursor ? order.indexOf(cursor) : -1
  const next = order[at < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + delta))]
  const anchor = sel.anchor ?? cursor ?? next
  return { sel: { keys: between(order, anchor, next), anchor }, cursor: next }
}

/** A row's vertical extent on screen. */
export interface Band {
  key: string
  top: number
  bottom: number
}

/** The rows a box dragged from y0 to y1 touches (rows span the list's width, so only y counts). */
export function boxHits(bands: Band[], y0: number, y1: number): string[] {
  const lo = Math.min(y0, y1)
  const hi = Math.max(y0, y1)
  return bands.filter((b) => b.bottom > lo && b.top < hi).map((b) => b.key)
}

/** A box drag's selection: the rows it touches, added to `base` when ⌘ is held. */
export function boxed(base: Selection, order: string[], hits: string[], add: boolean): Selection {
  const keys = inOrder(order, add ? [...base.keys, ...hits] : hits)
  return { keys, anchor: hits[0] ?? base.anchor }
}

/** The selection with rows no longer listed dropped. */
export const listed = (sel: Selection, order: string[]): string[] => inOrder(order, sel.keys)

/** What a node needs to say which batch actions fit it. */
export interface Actionable {
  terminal: boolean
  status: string
  urgency?: string
  every?: string | null
  assignee?: string | null
  project: string
}

/** The batch actions that fit every node in `nodes`. */
export interface BatchActions {
  /** true: 重要 (mark all); false: 取消重要 (all are already); null: not offered. */
  important: boolean | null
  /** 延迟 R 天: offered when every node has an R; `same` is that R when they all share it. */
  every: { same: string | null } | null
  /** 延迟到… */
  delay: boolean
  /** Who they can be handed to: 交给 AI when any is the owner's, 指给我 when any is an AI's. */
  assign: ('ai' | 'me')[]
  start: boolean
  archive: boolean
  /** 移到父节点…: all in one project. */
  move: boolean
}

export function batchActions(nodes: Actionable[]): BatchActions {
  const live = nodes.length > 0 && nodes.every((n) => !n.terminal)
  const everies = nodes.map((n) => n.every ?? null)
  const human = nodes.filter((n) => n.assignee === 'human').length
  return {
    important: live ? !nodes.every((n) => n.urgency === 'high') : null,
    every: live && everies.every(Boolean) ? { same: everies.every((e) => e === everies[0]) ? everies[0] : null } : null,
    delay: live,
    assign: live ? [...(human > 0 ? ['ai' as const] : []), ...(human < nodes.length ? ['me' as const] : [])] : [],
    start: live && nodes.every((n) => n.status === 'not_started'),
    archive: live,
    move: nodes.length > 0 && new Set(nodes.map((n) => n.project)).size === 1,
  }
}
