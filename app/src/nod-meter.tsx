import { useState } from 'preact/hooks'
import { CalendarDays, Zap } from 'lucide-preact'
import type { NodsSummary } from './types.ts'
import { s } from './strings.ts'
import { NodCalendar } from './nod-calendar.tsx'

function Bar({ label, value, max, display }: { label: string; value: number; max: number; display?: number }) {
  // A non-zero count always shows a sliver, even next to a much larger bar.
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0
  return (
    <div class="nod-bar-row">
      <span class="nod-bar-label">{label}</span>
      <span class="nod-bar-track">
        <span class="nod-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span class="nod-bar-value">{display ?? value}</span>
    </div>
  )
}

/**
 * The sidebar's ⚡ daily Nod counter, above 「视图」: today's count, then today
 * / yesterday / the 7-day average as three bars sized against the largest of
 * the three (the average shown floored to a whole number — the bar itself is
 * still sized off the raw value). A click expands the last 7 days, one thin
 * bar each; the calendar button opens a GitHub-style heatmap of the whole
 * year behind it (`nod-calendar.tsx`). The numbers come from `decs bench
 * --json`'s own `nods` field — no separate poll, it just rides along with
 * every other bench refresh.
 */
export function NodMeter({ nods }: { nods: NodsSummary }) {
  const [open, setOpen] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const max = Math.max(nods.today, nods.yesterday, nods.avg7, 1)
  const dayMax = Math.max(...nods.days.map((d) => d.count), 1)
  return (
    <div class="nod-meter">
      <div class="nod-meter-head">
        <button class="nod-meter-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={s('nodsLabel')} title={s('nodsExpand')}>
          <Zap size={13} strokeWidth={2} class="nod-bolt" />
          <span class="nod-today">{nods.today}</span>
        </button>
        <button class="nod-cal-btn" onClick={() => setCalendarOpen(true)} aria-label={s('nodsCalendarBtn')} title={s('nodsCalendarBtn')}>
          <CalendarDays size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div class="nod-bars">
        <Bar label={s('nodsToday')} value={nods.today} max={max} />
        <Bar label={s('nodsYesterday')} value={nods.yesterday} max={max} />
        <Bar label={s('nodsAvg7')} value={nods.avg7} max={max} display={Math.floor(nods.avg7)} />
      </div>
      {open && (
        <div class="nod-days">
          {nods.days.map((d) => (
            <Bar key={d.date} label={d.date.slice(5)} value={d.count} max={dayMax} />
          ))}
        </div>
      )}
      {calendarOpen && <NodCalendar history={nods.history} onClose={() => setCalendarOpen(false)} />}
    </div>
  )
}
