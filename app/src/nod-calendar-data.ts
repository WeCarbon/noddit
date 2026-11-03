import type { NodsDay } from './types.ts'

/**
 * `history` (oldest first, one entry per day) chunked into GitHub-style
 * columns: each column is one Sunday-through-Saturday week, oldest first.
 * The last column may be shorter than 7 if the window ends mid-week —
 * padded with `null` (today or earlier always has a real day; the rest of
 * that week hasn't happened yet).
 */
export function historyWeeks(history: NodsDay[]): (NodsDay | null)[][] {
  const weeks: (NodsDay | null)[][] = []
  for (let i = 0; i < history.length; i += 7) {
    const week: (NodsDay | null)[] = history.slice(i, i + 7)
    while (week.length < 7) week.push(null)
    weeks.push(week)
  }
  return weeks
}

/** 0 (no Nods that day) through `steps` (the window's busiest day) —
 *  mirrors `core/nods.ts`'s own `nodsLevel` (app/src can't import it). */
export function nodsLevel(count: number, max: number, steps = 4): number {
  if (count <= 0 || max <= 0) return 0
  return Math.min(steps, Math.ceil((count / max) * steps))
}

/**
 * One label per column of `weeks`, shown only where a new month starts
 * within that week's first 7 days — `null` everywhere else, including an
 * all-empty leading/trailing column. `monthShort` formats a `Date` as this
 * viewer's own short month name (`Intl.DateTimeFormat` with the app's
 * language); passed in so this stays a pure function of its arguments.
 */
export function monthLabels(weeks: (NodsDay | null)[][], monthShort: (d: Date) => string): (string | null)[] {
  let last = ''
  return weeks.map((week) => {
    const first = week.find((d): d is NodsDay => d !== null)
    if (!first) return null
    const d = new Date(`${first.date}T00:00:00`)
    if (d.getDate() > 7) return null
    const label = monthShort(d)
    if (label === last) return null
    last = label
    return label
  })
}
