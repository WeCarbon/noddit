import { parseRef } from './ref.ts'
import { t } from '../i18n/index.ts'
import type { Item, ItemStatus } from './types.ts'

/**
 * Status helpers for nodes (节点) — the one entity that is sometimes a task,
 * sometimes a decision.
 *
 * A node's **status** (decision state while a question is open, execution
 * state otherwise) and whether it's **startable** (everything it's `after`
 * is done) are independent: a node can be 待决策 *and* not yet startable,
 * since the owner may answer early while what it depends on still runs.
 */

export { ITEM_STATUSES } from './types.ts'

export function statusLabel(s: ItemStatus): string {
  return t(`common.status.${s}`)
}

/** Done with, one way or another; lives in archived/. */
export function isTerminal(s: ItemStatus): boolean {
  return s === 'completed' || s === 'closed'
}

/** 延迟 and not finished. A flag left on a node that later completed means nothing;
 *  one deferred `--until` a moment that has come is back, even before anything clears the flag. */
export function isDeferred(i: Pick<Item, 'deferredAt' | 'state'> & Partial<Pick<Item, 'deferredUntil'>>, now = Date.now()): boolean {
  return Boolean(i.deferredAt) && !isTerminal(i.state) && !deferralOver(i, now)
}

/** Deferred `--until` a moment that has now come. */
export function deferralOver(i: Partial<Pick<Item, 'deferredAt' | 'deferredUntil'>>, now = Date.now()): boolean {
  if (!i.deferredAt || !i.deferredUntil) return false
  const until = Date.parse(i.deferredUntil)
  return !Number.isNaN(until) && until <= now
}

const nodeKey = (i: Pick<Item, 'project' | 'id'>) => `${i.project}\u0000${i.id}`

/**
 * Nodes out of the working lists because of 延迟: the deferred ones and
 * everything under them — deferring a parent puts its whole subtree off.
 * Returns a predicate; build it once per item list.
 */
export function deferHidden(items: Item[]): (i: Pick<Item, 'project' | 'id'>) => boolean {
  const byKey = new Map(items.map((i) => [nodeKey(i), i]))
  const memo = new Map<string, boolean>()
  const hidden = (i: Item | undefined, depth = 0): boolean => {
    if (!i) return false
    const k = nodeKey(i)
    const m = memo.get(k)
    if (m !== undefined) return m
    const v = isDeferred(i) || (i.parent !== undefined && depth < 64 && hidden(byKey.get(`${i.project}\u0000${i.parent}`), depth + 1))
    memo.set(k, v)
    return v
  }
  return (i) => hidden(byKey.get(nodeKey(i)))
}

/**
 * Finds the node a ref in `after` points at. Refs are read the way a person
 * means them from inside `from`'s project: `12` and the legacy `D12` are this
 * project, `W12` is the project lettered W, `web:12` is that project.
 */
export function findRef(raw: string, from: Pick<Item, 'project' | 'letter'>, items: Item[]): Item | undefined {
  let r
  try {
    r = parseRef(raw)
  } catch {
    return undefined
  }
  const pool = items.filter((i) => i.id === r.id)
  if (r.project) return pool.find((i) => i.project === r.project)
  if (r.letter) {
    const lettered = pool.filter((i) => i.letter === r.letter)
    if (lettered.length) return lettered.find((i) => i.project === from.project) ?? lettered[0]
    // A `D` that names no project is the legacy "decision N here".
    if (r.letter !== 'D') return undefined
  }
  return pool.find((i) => i.project === from.project)
}

/** The nodes `item` is `after`; a ref that resolves to nothing stays as its string. */
export function dependenciesOf(item: Item, items: Item[]): (Item | string)[] {
  return (item.after ?? []).map((ref) => findRef(ref, item, items) ?? ref)
}

/**
 * Everything this node is after is completed or closed. A ref that resolves
 * to nothing counts as unmet — a typo should hold a node back, not wave it
 * through.
 */
export function isStartable(item: Item, items: Item[]): boolean {
  return dependenciesOf(item, items).every((dep) => typeof dep !== 'string' && isTerminal(dep.state))
}

export interface Rollup {
  /** Every descendant, counted by status. The node itself is not included. */
  counts: Partial<Record<ItemStatus, number>>
  descendants: number
  /** Somewhere below, a node is 待决策 — the bench marks the parent so the owner can find it. */
  needsOwner: boolean
}

/** What a node's subtree looks like, for a collapsed row in the bench. */
export function rollup(node: Pick<Item, 'id' | 'project'>, items: Item[]): Rollup {
  const kids = new Map<number, Item[]>()
  for (const i of items) {
    if (i.project !== node.project || i.parent === undefined) continue
    kids.set(i.parent, [...(kids.get(i.parent) ?? []), i])
  }
  const counts: Partial<Record<ItemStatus, number>> = {}
  let descendants = 0
  let needsOwner = false
  const stack = [...(kids.get(node.id) ?? [])]
  while (stack.length) {
    const i = stack.pop()!
    descendants++
    counts[i.state] = (counts[i.state] ?? 0) + 1
    if (i.state === 'needs_decision') needsOwner = true
    stack.push(...(kids.get(i.id) ?? []))
  }
  return { counts, descendants, needsOwner }
}

/** 「AI 卡在等你」: the node is next in line and only the owner's answer is missing. */
export function waitingOnOwner(item: Item, items: Item[]): boolean {
  return item.state === 'needs_decision' && isStartable(item, items)
}

/** 「可以提前决」: it has a question, but the work before it is still going on. */
export function canDecideEarly(item: Item, items: Item[]): boolean {
  return item.state === 'needs_decision' && !isStartable(item, items)
}
