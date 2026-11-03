import { isHumanTask } from './assignee.ts'
import { isTerminal } from './status.ts'
import type { Item } from './types.ts'

/**
 * `--est` is the assignee's own time: the owner's hours on their to-do (人), the machine's
 * on an AI's node (AI). Free form on disk; these read the common shapes and leave the rest alone.
 */

const UNIT_MIN: Record<string, number> = { m: 1, min: 1, h: 60, hr: 60, d: 8 * 60, 人日: 8 * 60, 天: 8 * 60, 小时: 60, 分钟: 1, w: 5 * 8 * 60 }

/** `2h`, `30m`, `1h30m`, `1.5h`, `0.5 人日`, `1d` (a working day, 8h), a bare `45` (minutes); undefined when it can't be read. */
export function estMinutes(est: string | undefined): number | undefined {
  const s = est?.trim().toLowerCase()
  if (!s) return undefined
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const re = /(\d+(?:\.\d+)?)\s*(人日|小时|分钟|天|min|hr|[mhdw])/gy
  let total = 0
  let at = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    total += Number(m[1]) * UNIT_MIN[m[2]]
    at = re.lastIndex
    while (s[at] === ' ') at++
    re.lastIndex = at
  }
  return at === s.length && total > 0 ? Math.round(total) : undefined
}

/** `90` → `1h30m`, `30` → `30m`, `120` → `2h`. */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h && m ? `${h}h${m}m` : h ? `${h}h` : `${m}m`
}

export interface EstimateTotal {
  /** Minutes of the owner's own time still ahead. */
  human: number
  /** Minutes of AI time still ahead. */
  ai: number
}

/** Whose time a node's `est` is. */
export const estWho = (d: Pick<Item, 'assignee'>): 'human' | 'ai' => (isHumanTask(d) ? 'human' : 'ai')

const childCache = new WeakMap<Item[], Map<string, Item[]>>()

/** Each node's children, keyed `project#id`; built once per item list. */
function childrenOf(items: Item[]): Map<string, Item[]> {
  let kids = childCache.get(items)
  if (kids) return kids
  kids = new Map()
  for (const i of items) {
    if (i.parent === undefined) continue
    const key = `${i.project}#${i.parent}`
    const list = kids.get(key)
    if (list) list.push(i)
    else kids.set(key, [i])
  }
  childCache.set(items, kids)
  return kids
}

/** What is still ahead in `d` and everything under it, split by whose time — finished nodes count nothing. */
export function estimateTotal(d: Item, items: Item[]): EstimateTotal {
  const kids = childrenOf(items)
  const total: EstimateTotal = { human: 0, ai: 0 }
  const seen = new Set<string>()
  const stack = [d]
  while (stack.length) {
    const n = stack.pop()!
    const key = `${n.project}#${n.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const min = isTerminal(n.state) ? undefined : estMinutes(n.est)
    if (min) total[estWho(n)] += min
    stack.push(...(kids.get(key) ?? []))
  }
  return total
}
