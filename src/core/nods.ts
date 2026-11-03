import { NOTE_KIND } from './format.ts'
import { dayKey } from './fuzzy-date.ts'
import type { Decision } from './types.ts'

/** One local calendar day's count. */
export interface NodsDay {
  date: string
  count: number
}

/**
 * `nod bench --json`'s `nods` field: how many Nods — owner actions, one per
 * reply / decision answered / node the owner filed themself — landed on
 * each of the last 7 local days.
 */
export interface NodsSummary {
  today: number
  yesterday: number
  /** Mean of `days` (7 local days, today included). */
  avg7: number
  /** Oldest first, 7 entries, the last one today. */
  days: NodsDay[]
}

type NodItem = Pick<Decision, 'notes' | 'created' | 'author'>

/**
 * Every timestamp this node earned a Nod at: its own creation, if the owner
 * made it directly (a brief, or any node authored `owner` — the same test
 * `core/store.ts`'s `roleOf` uses), plus each human-written note — a reply,
 * or an answer (sub-questions settle in one note, so one submit is one
 * Nod). `原话` is skipped: it's the brief's own words, stamped at `created`
 * — counting it too would double-count the Nod its creation already earned.
 */
function nodTimesOf(d: NodItem): string[] {
  const notes = d.notes.filter((n) => n.role === 'human' && n.kind !== NOTE_KIND.original).map((n) => n.at)
  return d.author === 'owner' ? [d.created, ...notes] : notes
}

/** The local-day bucket for one ISO timestamp, or null if it doesn't parse. */
function dayOf(at: string): string | null {
  const t = Date.parse(at)
  return Number.isNaN(t) ? null : dayKey(new Date(t))
}

/**
 * `items`: every node across every registered project, archived included —
 * a Nod never stops counting just because its node was filed away. `now`
 * anchors "today"; days are local-time, same as every other date in decs.
 */
export function computeNods(items: NodItem[], now = Date.now()): NodsSummary {
  const counts = new Map<string, number>()
  for (const d of items) {
    for (const at of nodTimesOf(d)) {
      const key = dayOf(at)
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const base = new Date(now)
  const days: NodsDay[] = []
  for (let i = 6; i >= 0; i--) {
    const date = dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i))
    days.push({ date, count: counts.get(date) ?? 0 })
  }
  const today = days.at(-1)!.count
  const yesterday = days.at(-2)!.count
  const avg7 = days.reduce((sum, d) => sum + d.count, 0) / days.length
  return { today, yesterday, avg7, days }
}
