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
  /** Mean of `days` (7 local days, today included); kept raw (not floored) —
   *  the app and the TUI header each floor it for display. */
  avg7: number
  /** Oldest first, 7 entries, the last one today. */
  days: NodsDay[]
  /** Oldest first, one entry per day across the calendar heatmap's window
   *  (53 Sunday-aligned weeks, same as GitHub's own contribution graph,
   *  ending today) — the app's calendar modal and the TUI's text heatmap. */
  history: NodsDay[]
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

/** Midnight local time, `n` days before `d`. */
function daysBefore(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n)
}

const HISTORY_WEEKS = 53

/**
 * `counts`: the same day → Nod-count map `computeNods` already built from one
 * pass over `items`'s notes — the heatmap window costs nothing beyond that.
 * Oldest first, from the Sunday that starts `HISTORY_WEEKS` weeks back through
 * today (not padded to a full week: the frontend chunks it into columns and
 * pads the last one itself, same as GitHub's own contribution graph).
 */
function computeHistory(counts: Map<string, number>, now: number): NodsDay[] {
  const todayLocal = daysBefore(new Date(now), 0)
  const thisWeekStart = daysBefore(todayLocal, todayLocal.getDay())
  const start = daysBefore(thisWeekStart, (HISTORY_WEEKS - 1) * 7)
  const history: NodsDay[] = []
  for (const d = new Date(start); d <= todayLocal; d.setDate(d.getDate() + 1)) {
    const date = dayKey(d)
    history.push({ date, count: counts.get(date) ?? 0 })
  }
  return history
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
  const history = computeHistory(counts, now)
  return { today, yesterday, avg7, days, history }
}

/** 0 (no Nods that day) through `steps` (the window's busiest day) — relative
 *  shading, GitHub-heatmap-style: the app's calendar modal and the TUI's text
 *  heatmap each map this to their own `steps`-step palette. */
export function nodsLevel(count: number, max: number, steps = 4): number {
  if (count <= 0 || max <= 0) return 0
  return Math.min(steps, Math.ceil((count / max) * steps))
}

/**
 * A local floor on today's count, ahead of whatever the last confirmed bench
 * read reported. Several owner actions that plainly belong on the ⚡ counter —
 * `start`, closing a node as obsolete, the app's own "done" on a node with no
 * note — change no note `computeNods` can see, so the real count behind them
 * never arrives; without a floor the header would simply never move for them.
 * Bumped the instant such an action fires; scoped to one calendar day, so a
 * new day starts over rather than inheriting yesterday's floor.
 */
export interface NodsBump {
  date: string
  count: number
}

/** Call the instant a counted action fires (answer/decide, done, start,
 *  reply, archive — once per node, so a batch of 5 calls this 5 times). */
export function bumpNodsToday(bump: NodsBump | null, nods: NodsSummary): NodsBump {
  const date = nods.days.at(-1)?.date ?? ''
  const base = bump && bump.date === date ? bump.count : nods.today
  return { date, count: base + 1 }
}

/**
 * `nods`, with today's count raised to `bump`'s floor when one is still ahead
 * of it — never below what a moment ago already showed. Once a fresh bench
 * read's own count catches up (or the real Nod it's for never arrives but
 * the day rolls over), the floor stops mattering and this is a no-op.
 */
export function displayNods(nods: NodsSummary, bump: NodsBump | null): NodsSummary {
  const date = nods.days.at(-1)?.date ?? ''
  if (!bump || bump.date !== date || bump.count <= nods.today) return nods
  const bumpLast = (arr: NodsDay[]): NodsDay[] => (arr.length && arr[arr.length - 1].date === date ? [...arr.slice(0, -1), { ...arr[arr.length - 1], count: bump.count }] : arr)
  const days = bumpLast(nods.days)
  const history = bumpLast(nods.history)
  const avg7 = days.reduce((sum, d) => sum + d.count, 0) / days.length
  return { ...nods, today: bump.count, days, history, avg7 }
}
