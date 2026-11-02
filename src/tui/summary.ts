import type { Overview, SourceSummary } from '../core/overview.ts'
import { waitingOnOwner } from '../core/status.ts'
import type { Decision as Item } from '../core/types.ts'
import { isRtl, t } from '../i18n/index.ts'
import type { Segment } from './model.ts'
import { GLYPH, ago, agoSpan, bar, ownerQueue, progressOf } from './views.ts'
import { minutesSince } from '../core/staleness.ts'
import { refOf } from '../core/ref.ts'
import { isUnclaimedBrief } from '../core/intake.ts'
import { fit, stringWidth } from './width.ts'

/**
 * The strip under the tabs: 「有什么要我决的」「外部的都清了没」「现在在做什么」
 * answered in a few lines on every view. The fourth, 「接下来的时序」, is its
 * own view.
 */

type Line = Segment[]
/** A title in the strip is cut here, so one old over-long title cannot crowd out the rest. */
const STRIP_TITLE = 24
const w = (segs: Segment[]) => segs.reduce((n, s) => n + stringWidth(s.text), 0)

/** Fills `items` after `head`, keeping `tail` at the end; overflow becomes 「+N」. */
function packLine(head: Segment[], items: Segment[][], tail: Segment[], width: number): Line {
  const out = [...head]
  let used = w(head) + w(tail)
  let shown = 0
  for (const it of items) {
    const more = items.length - shown - 1
    const reserve = more > 0 ? stringWidth(`  +${more}`) : 0
    if (used + w(it) + reserve > width) break
    out.push(...it)
    used += w(it)
    shown++
  }
  if (shown < items.length) out.push({ text: `  +${items.length - shown}`, color: 'yellow' })
  return [...out, ...tail]
}

export function needsOwnerLine(ov: Overview, items: Item[], width: number): Line {
  const byKey = new Map(items.map((i) => [`${i.project}#${i.id}`, i]))
  const queue = ownerQueue(items)
  const blocking = queue.filter((i) => waitingOnOwner(i, items))
  const early = queue.filter((i) => i.state === 'needs_decision').length - blocking.length
  const todos = queue.filter((i) => i.state !== 'needs_decision').length
  const blocksOf = (i: Item) => ov.needsOwner.find((r) => r.id === i.id && r.project === i.project)?.blocks.length ?? 0

  const tail: Segment[] = []
  if (early) tail.push({ text: t('bench.summary.early', { glyph: GLYPH.needs_decision, count: early }), color: 'yellow', dim: true })
  if (todos) tail.push({ text: t('bench.summary.forYou', { count: todos }), color: 'blue' })
  if (ov.decidedNotCollected) tail.push({ text: t('bench.summary.answered', { count: ov.decidedNotCollected }), color: 'green' })

  if (!blocking.length) {
    return [{ text: t('bench.summary.decideNone'), bold: true }, { text: t('bench.summary.decideNoneText'), color: 'green' }, ...tail]
  }
  const head: Segment[] = [{ text: t('bench.summary.decide'), bold: true }, { text: `${blocking.length}`, color: 'yellow', bold: true }, { text: t('bench.summary.colon') }]
  const parts = blocking.map((i, n): Segment[] => {
    const blocks = blocksOf(byKey.get(`${i.project}#${i.id}`) ?? i)
    const extra = [i.urgency === 'high' ? t('bench.badge.urgent') : '', blocks ? t('bench.summary.blockingNote', { count: blocks }) : ''].filter(Boolean).join(t('bench.summary.extraSeparator'))
    return [
      { text: n ? '  ' : '' },
      { text: '◆', color: 'yellow', bold: true },
      { text: refOf(i), color: 'cyan' },
      { text: ` ${fit(i.title, STRIP_TITLE, isRtl())}` },
      ...(extra ? [{ text: t('bench.summary.extraParen', { text: extra }), color: i.urgency === 'high' ? 'red' : undefined, dim: i.urgency !== 'high' } as Segment] : []),
    ]
  })
  return packLine(head, parts, tail, width)
}

function bucketLabel(k: string): string {
  if (k === 'unhandled') return t('bench.summary.unhandled')
  if (k === 'owner') return t('bench.summary.owner')
  if (k === 'us') return t('bench.summary.us')
  return t('bench.summary.waitingOnBucket', { who: k })
}

export function sourceSegments(s: SourceSummary, withProject: boolean): Segment[] {
  const name = `${withProject ? `${s.projectLetter}·` : ''}${s.name}`
  const segs: Segment[] = [{ text: name, bold: true }]
  if (s.cleared) segs.push({ text: ` ${t('bench.summary.cleared')}`, color: 'green' })
  else {
    segs.push({ text: ' ✗', color: 'red', bold: true })
    const order = Object.entries(s.buckets).sort(([a], [b]) => rank(a) - rank(b))
    for (const [k, n] of order) {
      const color = k === 'unhandled' ? 'red' : k === 'owner' ? 'yellow' : undefined
      segs.push({ text: ` ${bucketLabel(k)} ${n}`, color, dim: !color })
    }
  }
  if (s.stale) {
    const text = s.heartbeatAgeMs !== undefined
      ? t('bench.summary.noHeartbeat', { age: agoSpan(s.heartbeatAgeMs / 60_000) })
      : t('bench.summary.noHeartbeatEver')
    segs.push({ text, color: 'red' })
  }
  return segs
}

const rank = (k: string) => (k === 'unhandled' ? 0 : k === 'owner' ? 1 : k === 'us' ? 2 : 3)

export function sourcesLine(ov: Overview, width: number): Line {
  const head: Segment[] = [{ text: t('bench.summary.sources'), bold: true }]
  if (!ov.sources.length) return [...head, { text: t('bench.summary.sourcesNone'), dim: true }]
  const multi = new Set(ov.sources.map((s) => s.project)).size > 1
  const all = ov.sources.every((s) => s.cleared && !s.stale)
  if (all) head.push({ text: t('bench.summary.sourcesAllClear'), color: 'green' })
  const parts = ov.sources.map((s, i): Segment[] => [{ text: i ? '   ' : '' }, ...sourceSegments(s, multi)])
  return packLine(head, parts, [], width)
}

export function workingLine(ov: Overview, items: Item[], width: number, now: number): Line {
  const byKey = new Map(items.map((i) => [`${i.project}#${i.id}`, i]))
  // Whatever moved most recently first: that is what is actually being worked on.
  const running = [...ov.inProgress]
    .sort((a, b) => a.minutesSinceUpdate - b.minutesSinceUpdate)
    .map((r) => byKey.get(`${r.project}#${r.id}`))
    .filter((i): i is Item => Boolean(i))
  if (!running.length) {
    const next = ov.schedule.filter((r) => r.state === 'next')
    if (!next.length) return [{ text: t('bench.summary.working'), bold: true }, { text: t('bench.summary.workingNone'), dim: true }]
    const parts = next.map((r, i): Segment[] => [{ text: i ? '  ' : '' }, { text: r.ref, color: 'cyan' }, { text: ` ${fit(r.title, STRIP_TITLE, isRtl())}` }])
    return packLine([{ text: t('bench.summary.working'), bold: true }, { text: t('bench.summary.workingNoneUpNext'), dim: true }], parts, [], width)
  }
  const head: Segment[] = [{ text: t('bench.summary.working'), bold: true }, { text: `${running.length}`, color: 'cyan', bold: true }, { text: t('bench.summary.colon') }]
  const parts = running.map((d, i): Segment[] => {
    const pct = progressOf(d)
    const alert = Boolean(d.checkin?.unanswered)
    const color = alert ? 'red' : undefined
    return [
      { text: i ? '  ' : '' },
      { text: GLYPH.in_progress, color: color ?? 'cyan' },
      { text: refOf(d), color: 'cyan' },
      { text: ` ${fit(d.title, STRIP_TITLE, isRtl())} `, color },
      ...(pct !== undefined ? [{ text: `${bar(pct, 6)} ${pct}% `, color: color ?? 'cyan' } as Segment] : []),
      { text: ago(minutesSince(d, now)), color, dim: !alert, bold: alert },
      ...(alert ? [{ text: ` ${t('bench.badge.checkinUnanswered', { count: d.checkin!.asked })}`, color: 'red', bold: true } as Segment] : []),
    ]
  })
  return packLine(head, parts, [], width)
}

export function cyclesLine(ov: Overview): Line | null {
  if (!ov.cycles.length) return null
  const c = ov.cycles[0]
  const more = ov.cycles.length > 1 ? t('bench.summary.cycleMore', { count: ov.cycles.length }) : ''
  return [{ text: t('bench.summary.cycle', { chain: c.map((x) => x.ref).join(' → '), more }), color: 'red', bold: true }]
}

/** N47: not_started, not deferred nodes — neither waiting on a decision nor being worked on. */
export function staleTasksLine(ov: Overview): Line | null {
  if (!ov.staleTasks) return null
  return [{ text: t('bench.summary.staleTasks', { count: ov.staleTasks }), color: 'yellow' }]
}

/**
 * The whole strip. On a short terminal only the first line survives — it is
 * the one question the owner opens bench to answer.
 */
/**
 * 「有没有 AI 在线」: one mark per project — ● a lead session's monitor is
 * running there, ○ none. Shown once anyone is connected or a brief waits,
 * since that is when it changes what the owner does next.
 */
function sessionsLine(ov: Overview, items: Item[], now: number): Line | null {
  const waiting = items.filter(isUnclaimedBrief)
  if (!ov.sessions.some((p) => p.sessions.length) && !waiting.length) return null
  const out: Line = []
  for (const p of ov.sessions) {
    if (out.length) out.push({ text: '   ' })
    const lead = p.sessions.find((s) => s.role === 'lead')
    const briefs = waiting.filter((d) => d.project === p.project).length
    const label = ov.sessions.length > 1 ? `${p.letter} ${p.project} ` : ''
    if (lead) {
      const who = lead.author?.split(/[ \t]*·[ \t]*/)[0] || lead.harness || t('bench.sessions.lead')
      out.push({ text: '● ', color: 'green' }, { text: `${label}${who} · ${agoSpan(minutesSince({ updatedAt: lead.started_at, created: lead.started_at }, now))}`, dim: true })
    } else out.push({ text: '○ ', color: briefs ? 'yellow' : undefined, dim: !briefs }, { text: `${label}${t('bench.sessions.none')}`, dim: !briefs, color: briefs ? 'yellow' : undefined })
    if (briefs) out.push({ text: ` · ${t('bench.sessions.briefs', { count: briefs })}`, color: 'blue' })
  }
  return out
}

export function summaryLines(ov: Overview, items: Item[], width: number, height: number, now: number): Line[] {
  // The tabs already cover owner/running counts; add only what they can't.
  const lines: Line[] = []
  const live = height >= 8 ? sessionsLine(ov, items, now) : null
  if (live) lines.push(live)
  if (ov.sources.length && height >= 12) lines.push(sourcesLine(ov, width))
  const cyc = cyclesLine(ov)
  if (cyc && height >= 12) lines.push(cyc)
  const stale = staleTasksLine(ov)
  if (stale && height >= 12) lines.push(stale)
  return lines.map((l) => l.map((s) => ({ ...s, text: s.text })).filter((s) => s.text.length)).map((l) => clip(l, width))
}

function clip(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const seg of line) {
    const room = width - used
    if (room <= 0) break
    const text = fit(seg.text, room, isRtl())
    out.push({ ...seg, text })
    used += stringWidth(text)
  }
  return out
}
