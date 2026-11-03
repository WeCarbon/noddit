import { test } from 'node:test'
import assert from 'node:assert/strict'

import { historyWeeks, monthLabels, nodsLevel } from '../app/src/nod-calendar-data.ts'
import { bumpNodsToday, displayNods } from '../app/src/nod-bump.ts'
import { fr } from '../app/src/locales/fr.ts'
import type { NodsDay, NodsSummary } from '../app/src/types.ts'

/**
 * `historyWeeks`, `nodsLevel`, `monthLabels` build the calendar modal's grid; `bumpNodsToday`
 * and `displayNods` are the floor that keeps ⚡ moving the moment the owner acts. All five are
 * plain functions of their arguments — no DOM, no fetch — so they're tested directly, the same
 * way `app/src/sounds.ts` is.
 */

const day = (date: string, count = 0): NodsDay => ({ date, count })

test('historyWeeks chunks into Sunday-through-Saturday columns, padding a short last week with null', () => {
  const history = Array.from({ length: 10 }, (_, i) => day(`2026-10-2${i}`, i))
  const weeks = historyWeeks(history)
  assert.equal(weeks.length, 2)
  assert.equal(weeks[0].length, 7)
  assert.deepEqual(weeks[0], history.slice(0, 7))
  assert.equal(weeks[1].length, 7)
  assert.deepEqual(weeks[1].slice(0, 3), history.slice(7, 10))
  assert.deepEqual(weeks[1].slice(3), [null, null, null, null])
})

test('historyWeeks on an empty history is no columns at all', () => {
  assert.deepEqual(historyWeeks([]), [])
})

test('nodsLevel: 0 with no Nods or an empty window, the busiest day in view tops out, the rest scale between', () => {
  assert.equal(nodsLevel(0, 10), 0)
  assert.equal(nodsLevel(3, 0), 0)
  assert.equal(nodsLevel(10, 10), 4)
  assert.equal(nodsLevel(1, 10), 1)
  assert.equal(nodsLevel(5, 10), 2)
})

test('monthLabels marks only the column where a new month starts in its first week, never repeating', () => {
  const week = (dates: string[]): (NodsDay | null)[] => dates.map((d) => day(d))
  const weeks = [
    week(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']), // October didn't begin inside this column
    week(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']), // November does — 2 Nov is in its first 7 days
    week(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']), // still November — not repeated
  ]
  const short = (d: Date) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  assert.deepEqual(monthLabels(weeks, short), [null, 'Nov', null])
})

test('monthLabels skips an empty column (every day padded null)', () => {
  assert.deepEqual(monthLabels([[null, null, null, null, null, null, null]], () => 'Nov'), [null])
})

const nods = (today: number, days: NodsDay[], history: NodsDay[] = days): NodsSummary => ({
  today,
  yesterday: days.at(-2)?.count ?? 0,
  avg7: days.reduce((sum, d) => sum + d.count, 0) / days.length,
  days,
  history,
})

test('bumpNodsToday climbs by one per call and resets once the date moves on', () => {
  const todayNods = nods(2, [day('2026-11-02', 1), day('2026-11-03', 2)])
  const once = bumpNodsToday(null, todayNods)
  assert.deepEqual(once, { date: '2026-11-03', count: 3 })
  const twice = bumpNodsToday(once, todayNods)
  assert.deepEqual(twice, { date: '2026-11-03', count: 4 })
  const tomorrow = nods(0, [day('2026-11-03', 2), day('2026-11-04', 0)])
  assert.deepEqual(bumpNodsToday(twice, tomorrow), { date: '2026-11-04', count: 1 })
})

test('displayNods raises today, its day entry and the heatmap\'s last day together, and recomputes the average', () => {
  const base = nods(1, [day('2026-11-02', 0), day('2026-11-03', 1)], [day('2026-08-01', 0), day('2026-11-02', 0), day('2026-11-03', 1)])
  const shown = displayNods(base, { date: '2026-11-03', count: 4 })
  assert.equal(shown.today, 4)
  assert.equal(shown.days.at(-1)!.count, 4)
  assert.equal(shown.history.at(-1)!.count, 4)
  assert.equal(shown.avg7, (0 + 4) / 2)
})

test('displayNods leaves `nods` as it was once the real count has caught up (or the bump is stale/missing)', () => {
  const base = nods(3, [day('2026-11-02', 0), day('2026-11-03', 3)])
  assert.equal(displayNods(base, null), base)
  assert.equal(displayNods(base, { date: '2026-11-03', count: 3 }), base)
  assert.equal(displayNods(base, { date: '2026-11-02', count: 9 }), base)
})

test('French: the new Nod-calendar strings follow the project\'s no-break-space typography', () => {
  for (const [key, value] of Object.entries(fr)) {
    if (!key.startsWith('nodsCalendar')) continue
    assert.doesNotMatch(value, / [:;?!»]|« /, `fr.${key}: use \\u00A0 (node scripts/fr-typography.ts)`)
  }
})
