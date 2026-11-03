import type { NodsDay, NodsSummary } from './types.ts'

/**
 * A local floor on today's Nod count, ahead of whatever the last bench read
 * confirmed — mirrors `core/nods.ts`'s own `NodsBump` (app/src can't import
 * across that boundary, so the logic is copied, not shared). `start`, closing
 * a node as obsolete and the app's own "done" on a node with no note change
 * nothing `computeNods` can see, so the CLI write behind them never shows up
 * as a new Nod; without a floor the ⚡ counter would simply never move for
 * them. The owner also feels the usual network/CLI lag before any bench
 * read — including one that, this time, really would have counted — catches
 * up, so the same floor covers that too. Scoped to one calendar day: a new
 * day starts over rather than inheriting yesterday's.
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
 * `nods`, with today's count raised to `bump`'s floor when one is still
 * ahead of it — never below what a moment ago already showed. Once a fresh
 * bench read's own count catches up, the floor stops mattering and this is
 * a no-op.
 */
export function displayNods(nods: NodsSummary, bump: NodsBump | null): NodsSummary {
  const date = nods.days.at(-1)?.date ?? ''
  if (!bump || bump.date !== date || bump.count <= nods.today) return nods
  const bumpLast = (arr: NodsDay[]): NodsDay[] =>
    arr.length && arr[arr.length - 1].date === date ? [...arr.slice(0, -1), { ...arr[arr.length - 1], count: bump.count }] : arr
  const days = bumpLast(nods.days)
  const history = bumpLast(nods.history)
  const avg7 = days.reduce((sum, d) => sum + d.count, 0) / days.length
  return { ...nods, today: bump.count, days, history, avg7 }
}
