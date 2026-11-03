import { refOf } from './ref.ts'
import { canDecideEarly, dependenciesOf, findRef, isStartable, isTerminal, waitingOnOwner } from './status.ts'
import type { Decision as Item, ItemStatus } from './types.ts'

/** The most recent note's first line — "现在在做什么" alongside `progressMsg`. */
function lastNoteLine(item: Item): string | undefined {
  const last = item.notes[item.notes.length - 1]
  return last?.text.split('\n')[0]?.trim() || undefined
}

/**
 * "接下来任务时序是什么？" — the planned order of open nodes, built on top of
 * `after`/`isStartable`/`waitingOnOwner`/`canDecideEarly`.
 */

export interface ScheduleDep {
  ref: string
  title?: string
  done: boolean
}

export type ScheduleState = 'current' | 'waiting_on_owner' | 'can_decide_early' | 'next' | 'waiting'

export interface ScheduleRow {
  id: number
  project: string
  ref: string
  title: string
  status: ItemStatus
  state: ScheduleState
  deps: ScheduleDep[]
  est?: string
  when?: string
  progress?: number
  progressMsg?: string
  /** `progressMsg` plus the latest note — "现在在做什么" for a `current` row. */
  currentLine?: string
  /** Other row ids at the same "next, nothing left to wait on" step — render these as 同时. */
  parallelWith: number[]
}

function rowState(item: Item, items: Item[]): ScheduleState {
  if (item.state === 'in_progress') return 'current'
  if (waitingOnOwner(item, items)) return 'waiting_on_owner'
  if (canDecideEarly(item, items)) return 'can_decide_early'
  if ((item.state === 'not_started' || item.state === 'decided') && isStartable(item, items)) return 'next'
  return 'waiting'
}

export function buildSchedule(items: Item[]): ScheduleRow[] {
  const open = items.filter((i) => !isTerminal(i.state))

  const rows: ScheduleRow[] = open.map((item) => {
    const deps: ScheduleDep[] = dependenciesOf(item, items).map((dep) =>
      typeof dep === 'string'
        ? { ref: dep, done: false }
        : { ref: refOf(dep), title: dep.title, done: isTerminal(dep.state) },
    )
    const state = rowState(item, items)
    const currentLine =
      state === 'current' ? [item.progressMsg, lastNoteLine(item)].filter(Boolean).join(' · ') || undefined : undefined
    return {
      id: item.id,
      project: item.project,
      ref: refOf(item),
      title: item.title,
      status: item.state,
      state,
      deps,
      est: item.est,
      when: item.when,
      progress: item.progress,
      progressMsg: item.progressMsg,
      currentLine,
      parallelWith: [],
    }
  })

  rows.sort((a, b) => {
    const rank = (r: ScheduleRow) => (r.state === 'current' ? 0 : r.state === 'waiting_on_owner' ? 1 : r.state === 'next' ? 2 : r.state === 'can_decide_early' ? 3 : 4)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.id - b.id
  })

  // Two "next" rows with the same dep set are not ordered relative to each
  // other — nothing says one goes first — so flag them as parallel instead of
  // implying a false order.
  for (const row of rows) {
    if (row.state !== 'next') continue
    const sig = row.deps.map((d) => d.ref).sort().join(',')
    row.parallelWith = rows
      .filter((r) => r.id !== row.id && r.project === row.project && r.state === 'next' && r.deps.map((d) => d.ref).sort().join(',') === sig)
      .map((r) => r.id)
  }

  return rows
}

/** Who waits on whom, built once per items array: resolving every `after` for every node was quadratic. */
const dependentsIndex = new WeakMap<Item[], Map<string, Item[]>>()

function directDependents(item: Item, items: Item[]): Item[] {
  let index = dependentsIndex.get(items)
  if (!index) {
    index = new Map()
    for (const y of items) {
      const seen = new Set<string>()
      for (const raw of y.after ?? []) {
        const d = findRef(raw, y, items)
        if (!d) continue
        const key = `${d.project}#${d.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const list = index.get(key)
        if (list) list.push(y)
        else index.set(key, [y])
      }
    }
    dependentsIndex.set(items, index)
  }
  return index.get(`${item.project}#${item.id}`) ?? []
}

/**
 * Every node that depends on `item`, directly or through another node —
 * "不上线的话，下面这些都卡着": what answering/finishing this one would unstick.
 */
export function dependentsOf(item: Item, items: Item[]): Item[] {
  const out: Item[] = []
  const seen = new Set<string>()
  const queue = [item]
  while (queue.length) {
    const cur = queue.shift()!
    for (const y of directDependents(cur, items)) {
      const key = `${y.project}#${y.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(y)
      queue.push(y)
    }
  }
  return out
}

export interface Cycle {
  ref: string
  id: number
  project: string
}

/**
 * Cycles in the `after` graph make every node in them permanently
 * unstartable (`isStartable` never finds a terminal node); `decs check`
 * reports this as an error.
 */
export function findCycles(items: Item[]): Cycle[][] {
  const key = (i: Item) => `${i.project}#${i.id}`
  const byKey = new Map(items.map((i) => [key(i), i]))
  const cycles: Cycle[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (k: string) => {
    if (state.get(k) === 'done') return
    if (state.get(k) === 'visiting') {
      const start = stack.indexOf(k)
      cycles.push(
        [...stack.slice(start), k].map((kk) => {
          const i = byKey.get(kk)!
          return { ref: refOf(i), id: i.id, project: i.project }
        }),
      )
      return
    }
    const item = byKey.get(k)
    if (!item) return
    state.set(k, 'visiting')
    stack.push(k)
    for (const dep of dependenciesOf(item, items)) {
      if (typeof dep !== 'string') visit(key(dep))
    }
    stack.pop()
    state.set(k, 'done')
  }

  for (const i of items) visit(key(i))
  return cycles
}
