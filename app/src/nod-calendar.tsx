import { useEffect } from 'preact/hooks'
import type { NodsDay } from './types.ts'
import { s } from './strings.ts'
import { historyWeeks, monthLabels, nodsLevel } from './nod-calendar-data.ts'

const docLang = () => document.documentElement.lang || 'en'
const monthShort = (d: Date) => new Intl.DateTimeFormat(docLang(), { month: 'short' }).format(d)

/** A Sunday, so `WEEKDAY_BASE + n` days is day `n` of the week whatever the
 *  viewer's own time zone — formatted with `timeZone: 'UTC'` so it never slips. */
const WEEKDAY_BASE = Date.UTC(2023, 0, 1)
const weekdayLabel = (n: number) => new Intl.DateTimeFormat(docLang(), { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(WEEKDAY_BASE + n * 86_400_000))
/** GitHub's own convention: every other row carries a label, to cut clutter. */
const WEEKDAY_ROWS = [0, 1, 2, 3, 4, 5, 6]
const LABELLED_ROWS = new Set([1, 3, 5])

/**
 * The calendar button next to ⚡ opens this: a GitHub-style heatmap of the
 * last ~year of Nods, weeks as columns, weekdays as rows, shaded in the
 * app's accent. Esc or a click outside closes it (`settings.tsx`'s own
 * overlay/sheet pattern). Mirrors the TUI's `c` key, in blocks instead of text.
 */
export function NodCalendar({ history, onClose }: { history: NodsDay[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onClose())
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const weeks = historyWeeks(history)
  const max = Math.max(1, ...history.map((d) => d.count))
  const months = monthLabels(weeks, monthShort)
  const today = history.at(-1)?.date
  return (
    <div class="overlay" onClick={onClose}>
      <div class="nod-cal" onClick={(e) => e.stopPropagation()}>
        <h3>{s('nodsCalendarTitle')}</h3>
        <div class="nod-cal-chart">
          <div class="nod-cal-weekdays">
            {WEEKDAY_ROWS.map((n) => (
              <span key={n}>{LABELLED_ROWS.has(n) ? weekdayLabel(n) : ''}</span>
            ))}
          </div>
          {weeks.map((week, wi) => (
            <div class="nod-cal-week" key={wi}>
              <span class="nod-cal-month">{months[wi] ?? ''}</span>
              {week.map((day, di) =>
                day ? (
                  <span
                    key={di}
                    class={`nod-cal-cell nod-cal-l${nodsLevel(day.count, max)} ${day.date === today ? 'today' : ''}`}
                    title={s('nodsCalendarHover', { date: day.date, count: String(day.count) })}
                  />
                ) : (
                  <span key={di} class="nod-cal-cell empty" />
                ),
              )}
            </div>
          ))}
        </div>
        <div class="nod-cal-legend">
          <span>{s('nodsCalendarLess')}</span>
          {[0, 1, 2, 3, 4].map((lv) => (
            <span key={lv} class={`nod-cal-cell nod-cal-l${lv}`} />
          ))}
          <span>{s('nodsCalendarMore')}</span>
        </div>
      </div>
    </div>
  )
}
