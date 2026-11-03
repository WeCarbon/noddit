import { basename } from 'node:path'
import { overdue } from '../core/order.ts'
import { approvalLabel, deferredLabel } from '../core/render.ts'
import { refOf } from '../core/ref.ts'
import { dependentsOf } from '../core/sequence.ts'
import { minutesSince } from '../core/staleness.ts'
import { deferredByAgent, dependenciesOf, isDeferred, isTerminal, statusLabel, waitingOnOwner } from '../core/status.ts'
import { parseSteps } from '../core/steps.ts'
import { type Decision as Item } from '../core/types.ts'
import { OTHER_KEY, type DecisionQuestion } from '../core/questions.ts'
import { t } from '../i18n/index.ts'
import type { Segment } from './model.ts'
import { GLYPH, ago, agoSpan, bar, glyphOf, keyOf, progressOf, unmetDeps, waitingSince } from './views.ts'
import { stringWidth, wrapToWidth } from './width.ts'

type Line = Segment[]

/** Only the agent's name, not the whole "· what it was doing" clause. */
export function whoOf(d: Item): string {
  return (d.author || t('bench.detail.unsigned')).split(/\s*[·・]\s*/)[0].trim() || d.author
}

/** What the status means right now, in words, next to the glyph. */
export function statusSegments(d: Item, items: Item[], now: number): Segment[] {
  const g = glyphOf(d, items, now)
  const segs: Segment[] = [{ ...g }, { text: ` ${statusLabel(d.state)}`, color: g.color, bold: g.bold }]
  const add = (text: string, color?: string, bold?: boolean) => segs.push({ text: ` · ${text}`, color, bold, dim: !color })
  switch (d.state) {
    case 'needs_decision':
      if (waitingOnOwner(d, items)) add(t('bench.detail.aiStuck'), 'yellow', true)
      else add(t('bench.detail.decidableEarly', { deps: unmetDeps(d, items).join(' ') }), 'yellow')
      break
    case 'waiting':
      add(t('bench.detail.waitingSince', {
        who: d.waitingOn ?? t('bench.detail.waitingExternal'),
        since: ago(minutesSince({ updatedAt: waitingSince(d), created: d.created }, now)),
      }), 'magenta')
      break
    case 'in_progress': {
      add(t('bench.detail.updated', { since: ago(minutesSince(d, now)) }))
      if (d.checkin?.unanswered) add(t('bench.detail.checkinUnanswered', { count: d.checkin.asked }), 'red', true)
      break
    }
    case 'decided':
      add(d.answer?.choice ? t('bench.detail.answeredChoice', { choice: d.answer.choice }) : t('bench.detail.answeredNote'), 'green')
      break
    case 'not_started': {
      const deps = unmetDeps(d, items)
      add(deps.length ? t('bench.detail.queuedAfter', { deps: deps.join(' ') }) : t('bench.detail.readyToStart'))
      break
    }
    case 'closed':
      if (d.closeReason) add(d.closeReason)
      break
  }
  return segs
}

function refSeg(d: Item, items: Item[], now: number): Segment[] {
  const g = glyphOf(d, items, now)
  return [{ ...g }, { text: refOf(d), color: isTerminal(d.state) ? undefined : 'cyan', dim: isTerminal(d.state) }]
}

/** `label  T1 T2 …` — wraps onto continuation lines instead of running off the pane. */
function refRow(label: string, refs: Segment[][], width: number): Line[] {
  if (!refs.length) return []
  const out: Line[] = []
  const lead = ` ${label}  `
  const pad = ' '.repeat(stringWidth(lead))
  let cur: Line = [{ text: lead, dim: true }]
  let used = stringWidth(lead)
  for (const r of refs) {
    const rw = r.reduce((n, s) => n + stringWidth(s.text), 0) + 1
    if (used + rw > width && cur.length > 1) {
      out.push(cur)
      cur = [{ text: pad }]
      used = pad.length
    }
    cur.push(...r, { text: ' ' })
    used += rw
  }
  out.push(cur)
  return out
}

/** Everything bench knows about a node beyond its prose: where it is, how
 *  far along, what it waits on, who points at it. Drawn above the body. */
export function metaLines(d: Item, items: Item[], now: number, width: number, backlinks: Item[] = []): Line[] {
  const out: Line[] = []
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const waited =
    d.status === 'answered'
      ? t('bench.detail.answeredBy', { who: d.answer?.by ?? 'owner', since: ago(minutesSince({ updatedAt: d.answer?.at, created: d.created }, now)) })
      : d.state === 'needs_decision'
        ? t('bench.detail.waitingFor', { span: agoSpan(minutesSince({ created: d.created }, now)) })
        : t('bench.detail.createdAt', { since: ago(minutesSince({ created: d.created }, now)) })
  out.push([{ text: ` ${d.author || t('bench.detail.unsigned')}`, dim: true }, { text: `  ${waited}`, dim: true }])

  const flags: Segment[] = []
  if (isDeferred(d)) flags.push({ text: ` ${deferredByAgent(d) ? `${t('bench.badge.byAi')} · ` : ''}${t('bench.detail.undefer', { label: deferredLabel(d, now) })}`, color: deferredByAgent(d) ? 'red' : 'gray' })
  if (d.urgency === 'high') flags.push({ text: ` ★ ${t('bench.badge.urgent')}`, color: 'yellow', bold: true })
  if (d.urgency === 'low') flags.push({ text: ` ${t('bench.badge.notUrgent')}`, dim: true })
  if (d.every && !isTerminal(d.state)) flags.push({ text: ` ${t('bench.detail.every', { every: d.every })}`, color: 'magenta' })
  if (d.due) flags.push({ text: ` ${t('bench.detail.due', { date: d.due.slice(5, 16).replace('T', ' ') })}`, color: overdue(d, now) ? 'red' : undefined })
  if (d.ifNoAnswer && !isTerminal(d.state)) {
    const rev = d.reversible === undefined ? '' : d.reversible ? t('bench.detail.reversible') : t('bench.detail.irreversible')
    flags.push({ text: ` ${t('bench.detail.ifNoAnswer', { text: d.ifNoAnswer, rev })}`, color: d.reversible === false ? 'red' : undefined })
  }
  if (flags.length) out.push(flags)

  out.push(...approvalLines(d))

  const pct = progressOf(d)
  if (pct !== undefined && (d.state === 'in_progress' || pct > 0)) {
    const color = d.checkin?.unanswered ? 'red' : 'cyan'
    out.push([
      { text: ` ${t('bench.detail.progress')}`, dim: true },
      { text: bar(pct, Math.max(10, Math.min(30, width - 30))), color },
      { text: ` ${pct}%` },
      ...(d.progressMsg ? [{ text: `  ${d.progressMsg}`, dim: true } as Segment] : []),
    ])
  }
  const steps = parseSteps(d.steps)
  const nextStep = steps.findIndex((s) => !s.done)
  steps.forEach((s, i) => {
    const mark = s.done ? GLYPH.completed : i === nextStep && d.state === 'in_progress' ? GLYPH.in_progress : GLYPH.not_started
    out.push([{ text: `   ${mark} ${i + 1}. `, color: s.done ? 'green' : i === nextStep ? 'cyan' : undefined, dim: !s.done && i !== nextStep }, { text: s.label, dim: s.done }])
  })

  const parent = d.parent !== undefined ? byKey.get(`${d.project}#${d.parent}`) : undefined
  if (parent) out.push([{ text: ` ${t('bench.detail.parent')}`, dim: true }, ...refSeg(parent, items, now), { text: ` ${parent.title}`, dim: true }])
  // No children row: the children are right there in the tree, and a lane with
  // thirty sub-nodes turned it into a wall of refs above the body.
  const deps = dependenciesOf(d, items).map((dep): Segment[] =>
    typeof dep === 'string' ? [{ text: t('bench.detail.missingRef', { ref: dep }), color: 'red' }] : refSeg(dep, items, now),
  )
  out.push(...refRow(t('bench.detail.after'), deps, width))
  out.push(...refRow(t('bench.detail.blocking'), dependentsOf(d, items).map((b) => refSeg(b, items, now)), width))
  out.push(...refRow(t('bench.detail.referencedBy'), backlinks.map((b) => refSeg(b, items, now)), width))
  if (d.supersededBy !== undefined) out.push([{ text: ` ${t('bench.detail.supersededBy', { ref: `${d.letter ?? 'X'}${d.supersededBy}` })}`, dim: true }])
  out.push([{ text: ' ┄'.repeat(Math.max(1, Math.floor((width - 2) / 2))), dim: true }])
  return out
}

/** One line per outbound attachment the owner must approve (`decs attach
 *  --approval-content`): whether it's approved now, and which answer would. */
export function approvalLines(d: Item): Line[] {
  // The phrase is `decs get`'s, so the two never word the same state differently.
  return (d.approvals ?? []).map((ap): Line => {
    const name = basename(ap.target) || ap.target
    const ok = Boolean(ap.approvedHash) && ap.approvedHash === ap.hash
    const color = ok ? 'green' : ap.declined ? 'red' : 'yellow'
    return [{ text: ` ${t('bench.detail.outboundContent')}`, dim: true }, { text: `${name}  ` }, { text: approvalLabel(ap), color, bold: !ok && !ap.declined }]
  })
}

/** Starting picks for 逐条: the last answer if there is one, else every default. */
export function initialPicks(d: Item): Record<string, string> {
  const qs = d.questions ?? []
  return Object.fromEntries(qs.map((q) => [q.key, d.answer?.answers?.[q.key] ?? q.default ?? q.options[0]?.key ?? '']))
}

/** ←/→ on a sub-question: the neighbouring option, wrapping. */
export function cycleOption(q: DecisionQuestion, current: string | undefined, delta: 1 | -1): string {
  const keys = q.options.map((o) => o.key)
  const at = Math.max(0, keys.indexOf(current ?? ''))
  return keys[(at + delta + keys.length) % keys.length]
}

/** A typed key picks an option of the focused question if one has that key (case-insensitive). */
export function optionForKey(q: DecisionQuestion, input: string): string | undefined {
  return q.options.find((o) => o.key.toLowerCase() === input.toLowerCase())?.key
}

/** `Q1=B Q2=1(默认) Q3=*`, for the confirm line. An 「其他」 pick shows as the
 *  bare `*` token — the typed text is on the line above, not worth repeating here. */
export function picksSummary(qs: DecisionQuestion[], picks: Record<string, string>, notes: Record<string, string> = {}): string {
  return qs
    .map((q) => {
      const v = picks[q.key]
      if (v === OTHER_KEY) return `${q.key}=${OTHER_KEY}`
      return `${q.key}=${v}${v === q.default ? '' : '*'}${notes[q.key] ? '✎' : ''}`
    })
    .join(' ')
}

/** The 逐条 picker replacing the body while answering sub-questions one by
 *  one; `focusRow` is where the caller should scroll to. */
export function questionLines(
  qs: DecisionQuestion[],
  qIndex: number,
  picks: Record<string, string>,
  notes: Record<string, string>,
  width: number,
): { lines: Line[]; focusRow: number } {
  const lines: Line[] = [
    [{ text: ` ${t('bench.detail.subQuestions')}`, bold: true, color: 'cyan' }, { text: t('bench.detail.subQuestionsHint'), dim: true }],
    [{ text: ' ' }],
  ]
  let focusRow = 0
  qs.forEach((q, i) => {
    const focused = i === qIndex
    if (focused) focusRow = lines.length
    lines.push([
      { text: focused ? ' ▶ ' : '   ', color: 'cyan', bold: true },
      { text: q.key, bold: true, color: 'cyan' },
      { text: ` ${q.label}`, bold: focused },
    ])
    const other = picks[q.key] === OTHER_KEY
    const optSegs: Segment[] = [{ text: '     ' }]
    for (const o of q.options) {
      const chosen = !other && picks[q.key] === o.key
      const label = `${o.key} ${o.label}${o.key === q.default ? t('bench.detail.defaultMark') : ''}`
      optSegs.push({ text: chosen ? `[${label}]` : ` ${label} `, inverse: chosen && focused, bold: chosen, color: chosen ? 'green' : undefined, dim: !chosen })
      optSegs.push({ text: ' ' })
    }
    const otherLabel = t('bench.detail.otherOption')
    optSegs.push({ text: other ? `[${otherLabel}]` : ` ${otherLabel} `, inverse: other && focused, bold: other, color: other ? 'green' : undefined, dim: !other })
    // Long option lists wrap on option boundaries.
    let cur: Line = []
    let used = 0
    for (const seg of optSegs) {
      const sw = stringWidth(seg.text)
      if (used + sw > width && cur.length) {
        lines.push(cur)
        cur = [{ text: '     ' }]
        used = 5
      }
      cur.push(seg)
      used += sw
    }
    if (cur.length) lines.push(cur)
    if (notes[q.key]) {
      const line = other ? t('bench.detail.otherAnswer', { text: notes[q.key] }) : t('bench.detail.noteChange', { text: notes[q.key] })
      for (const l of wrapToWidth(line, width - 6)) lines.push([{ text: `     ${l}`, color: 'magenta' }])
    }
  })
  return { lines, focusRow }
}
