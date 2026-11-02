import { isRtl, t as i18n } from '../i18n/index.ts'
import { dayText, durationText, elapsed, fromNow } from '../i18n/time.ts'
import { stringWidth } from '../tui/width.ts'
import { parseNoteHeading } from './parse.ts'
import { isHumanTask } from './assignee.ts'
import { untilDay } from './fuzzy-date.ts'
import { briefState, originalWords } from './intake.ts'
import { overdue } from './order.ts'
import { isWaitDue } from './status.ts'
import { formatRef, refOf } from './ref.ts'
import { minutesSince, stalenessOf } from './staleness.ts'
import { isDeferred, statusLabel } from './status.ts'
import { lastHumanAt, reopenedAfterArchive } from './store.ts'
import { type Attachment, type AttachmentApproval, type Decision } from './types.ts'

function attachmentJSON(a: Attachment) {
  return { label: a.label, target: a.target, image: a.image, group: a.group ?? null, caption: a.caption ?? null }
}

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const wrap = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s)
export const bold = wrap('1')
export const dim = wrap('2')
export const cyan = wrap('36')
export const yellow = wrap('33')
export const green = wrap('32')

/** Pads on the left so the line's visible right edge lands at `width` columns — pure, so a test can drive it directly. */
export function padLeftToWidth(line: string, width: number): string {
  const pad = width - stringWidth(line)
  return pad > 0 ? ' '.repeat(pad) + line : line
}

/**
 * Right-aligns one row of a table-like listing (`decs show` / `queue` /
 * `tree` / `source items`) for Arabic on an interactive terminal, so the
 * list reads right to left as a block. Piped output and other languages are
 * untouched — a script must see the same bytes regardless of `--lang`.
 */
export function alignRow(line: string): string {
  if (!isRtl() || !process.stdout.isTTY) return line
  return padLeftToWidth(line, process.stdout.columns || 80)
}

/** 「已延迟（owner · 3 天前）」 — `decs get`'s status line and `decs show`'s tail. */
export function deferredLabel(d: Pick<Decision, 'deferredAt' | 'deferredBy' | 'deferredUntil'>, now = Date.now()): string {
  const when = d.deferredAt ? fromNow(d.deferredAt, now) : ''
  const who = [d.deferredBy, when].filter(Boolean).join(' · ')
  const until = d.deferredUntil ? untilDay(d.deferredUntil) : undefined
  if (until) return i18n(who ? 'core.render.deferredUntilWithWho' : 'core.render.deferredUntil', { who, date: dayText(until, new Date(now)) })
  return who ? i18n('core.render.deferredWithWho', { who }) : i18n('core.render.deferred')
}

export function summaryLine(d: Decision, opts: { project?: boolean } = {}): string {
  const bits = [cyan(refOf(d))]
  if (opts.project && d.project) bits.push(dim(d.projectName ?? d.project))
  if (d.pin === 'top') bits.push(yellow('↑'))
  if (d.pin === 'bottom') bits.push(dim('↓'))
  if (d.urgency === 'high') bits.push(yellow(bold(i18n('core.render.urgent'))))
  if (d.urgency === 'low') bits.push(dim(i18n('core.render.lowUrgency')))
  if (d.kind === 'fyi') bits.push(dim(i18n('core.render.fyi')))
  bits.push(d.author ? dim(d.author) : dim(i18n('core.render.noAuthor')))
  bits.push(d.title)
  const tail: string[] = []
  // 待决策 is what `decs show` lists by default, so saying it on every line is noise.
  if (d.state !== 'needs_decision') tail.push(statusLabel(d.state))
  if (d.state === 'needs_decision' && d.options.length) tail.push(i18n('core.render.optionsCount', { count: d.options.length }))
  if (stalenessOf(d) !== 'fresh') tail.push(yellow(i18n('core.render.staleFor', { duration: durationText(minutesSince(d) * 60_000) })))
  if (d.checkin?.unanswered) tail.push(yellow(bold(i18n('core.render.checkinUnanswered', { count: d.checkin.asked }))))
  if (reopenedAfterArchive(d)) tail.push(yellow(i18n('core.render.reopenedAfterArchive')))
  if (d.supersededBy !== undefined) tail.push(i18n('core.render.supersededBy', { ref: formatRef(d.supersededBy, d.letter) }))
  if (d.due && d.status === 'open')
    tail.push(
      overdue(d)
        ? yellow(i18n('core.render.overdueAt', { time: shortTime(d.due) }))
        : i18n('core.render.dueAt', { time: shortTime(d.due) }),
    )
  if (d.closeReason) tail.push(d.closeReason)
  if (d.state === 'waiting' && d.waitingOn) tail.push(i18n('core.render.waitingOn', { who: d.waitingOn }))
  if (isDeferred(d)) tail.push(deferredLabel(d))
  if (d.state === 'needs_decision') {
    if (d.queued) tail.push(yellow(i18n('core.render.queuedUnclaimed')))
    if (d.created) tail.push(i18n('core.render.waited', { duration: elapsed(d.created) }))
  } else {
    if (d.answer?.choice) tail.push(green(i18n('core.render.answeredChoice', { choice: d.answer.choice })))
    const since = lastHumanAt(d)
    if (d.queued)
      tail.push(
        yellow(
          since
            ? i18n('core.render.answeredAgoUncollected', { duration: elapsed(since) })
            : i18n('core.render.waitingForAi'),
        ),
      )
  }
  return `${bits.join(' · ')}${tail.length ? dim(`  — ${tail.join(' · ')}`) : ''}`
}

export function renderDecision(d: Decision): string {
  const head = [
    bold(`${refOf(d)}${d.project ? ` · ${d.project}` : ''} · ${d.title}`),
    dim(i18n('core.render.proposedBy', { author: d.author || i18n('core.render.noAuthor') })),
    dim(
      [
        d.state === 'needs_decision'
          ? `${statusLabel(d.state)} · ${i18n('core.render.waited', { duration: elapsed(d.created) })}`
          : statusLabel(d.state),
        d.closeReason ? i18n('core.render.closeReasonLabel', { reason: d.closeReason }) : null,
        isDeferred(d) ? deferredLabel(d) : null,
        d.after?.length ? i18n('core.render.after', { refs: d.after.join(' ') }) : null,
        d.parent !== undefined ? i18n('core.render.belongsTo', { ref: formatRef(d.parent, d.letter) }) : null,
        d.children?.length ? i18n('core.render.childrenCount', { count: d.children.length }) : null,
        d.urgency && d.urgency !== 'normal' ? i18n('core.render.urgencyLevel', { level: d.urgency }) : null,
        d.due ? i18n(overdue(d) ? 'core.render.overdueShort' : 'core.render.dueShort', { time: shortTime(d.due) }) : null,
        d.default ? i18n('core.render.defaultsTo', { default: d.default }) : null,
        d.kind === 'fyi' ? i18n('core.render.fyiNote') : null,
        d.archived ? i18n('core.render.archived') : null,
        reopenedAfterArchive(d) ? i18n('core.render.reopenedAfterArchive') : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  ]
  if (d.ifNoAnswer)
    head.push(
      dim(
        i18n('core.render.ifNoAnswer', { text: d.ifNoAnswer }) +
          (d.reversible === undefined ? '' : d.reversible ? i18n('core.render.reversible') : i18n('core.render.irreversible')),
      ),
    )
  const links = [
    d.supersededBy !== undefined ? i18n('core.render.supersededBy', { ref: formatRef(d.supersededBy, d.letter) }) : null,
    d.supersedes?.length ? i18n('core.render.supersedes', { refs: d.supersedes.map((n) => formatRef(n, d.letter)).join(' ') }) : null,
  ].filter(Boolean)
  if (links.length) head.push(dim(links.join(' · ')))
  return `${head.join('\n')}\n\n${markNotes(d.body.trim())}\n`
}

/**
 * Human and agent sections in two colours, so a lane's 补充 can never again be
 * read as the owner asking for something. Plain text when piped.
 */
function markNotes(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      const h = parseNoteHeading(line)
      if (!h) return line
      return h.role === 'human' ? yellow(bold(line)) : dim(line)
    })
    .join('\n')
}

/** `10-29 18:00` — the deadline at a glance, in this machine's time. */
function shortTime(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

/** The compact shape machines consume — `decs get --json` and friends. */
export function toJSON(d: Decision): Record<string, unknown> {
  return {
    id: d.id,
    ref: refOf(d),
    project: d.project,
    project_name: d.projectName ?? d.project,
    title: d.title,
    author: d.author,
    status: d.state,
    status_label: statusLabel(d.state),
    close_reason: d.closeReason ?? null,
    waiting_on: d.waitingOn ?? null,
    waiting_until: d.state === 'waiting' ? (d.waitingUntil ?? null) : null,
    wait_due: isWaitDue(d),
    deferred_at: d.deferredAt ?? null,
    deferred_by: d.deferredBy ?? null,
    /** `nod defer --until`: when it comes back on its own; null = deferred until undeferred (or not deferred). */
    deferred_until: d.deferredAt ? (d.deferredUntil ?? null) : null,
    /** Who does it: `human` (the owner's own to-do — agents don't work on it) or `ai`. */
    assignee: d.assignee ?? 'ai',
    human_task: isHumanTask(d),
    created: d.created,
    updated_at: d.updatedAt ?? null,
    after: d.after ?? [],
    progress: d.progress ?? null,
    progress_msg: d.progressMsg ?? null,
    est: d.est ?? null,
    when: d.when ?? null,
    stale_after: d.staleAfter ?? null,
    /** `fresh` unless `in_progress` and past its span (`stale_after`, else the `checkin-after` setting). */
    staleness: stalenessOf(d),
    /** core/checkins.ts: how many times `nod monitor` has asked for a status update since the
     *  last write, and whether 3 went unanswered. Absent if it's never been asked. */
    checkin: d.checkin ? { asked: d.checkin.asked, last_asked_at: d.checkin.lastAskedAt, unanswered: d.checkin.unanswered } : null,
    steps: d.steps ?? null,
    owner_agent: d.ownerAgent ?? d.author,
    intake: Boolean(d.intake),
    /** 派活: `unclaimed` (waiting for an AI), `claimed`, or null — see core/intake.ts. */
    brief: briefState(d),
    claimed_by: d.claimedBy ?? null,
    claimed_at: d.claimedAt ?? null,
    original: originalWords(d) ?? null,
    parent: d.parent ?? null,
    parent_ref: d.parent !== undefined ? formatRef(d.parent, d.letter) : null,
    children: d.children ?? [],
    default: d.default ?? null,
    pin: d.pin ?? null,
    kind: d.kind,
    urgency: d.urgency ?? 'normal',
    due: d.due ?? null,
    milestone: Boolean(d.milestone),
    important: d.urgency === 'high',
    if_no_answer: d.ifNoAnswer ?? null,
    reversible: d.reversible ?? null,
    session: d.session ?? null,
    supersedes: d.supersedes ?? [],
    superseded_by: d.supersededBy ?? null,
    options: d.options.map((o) => ({ key: o.key, label: o.label, body: o.body })),
    answer: d.answer ?? null,
    questions: (d.questions ?? []).map((q) => ({
      key: q.key,
      label: q.label,
      default: q.default ?? null,
      options: q.options.map((o) => ({ key: o.key, label: o.label, body: o.body })),
    })),
    answers: d.answer?.answers ?? null,
    answer_notes: d.answer?.answerNotes ?? null,
    // Earlier `## 选项（第 N 轮）` rounds — history, not live state (N161: an
    // older round's sub-questions must never apply to a newer one's answer).
    // A window/TUI shows these collapsed as "上一轮的答案".
    previous_rounds: (d.previousRounds ?? []).map((r) => ({
      round: r.round,
      options: r.options.map((o) => ({ key: o.key, label: o.label, body: o.body })),
      questions: r.questions.map((q) => ({
        key: q.key,
        label: q.label,
        default: q.default ?? null,
        options: q.options.map((o) => ({ key: o.key, label: o.label, body: o.body })),
      })),
      answer: r.answer ?? null,
      sub_answers: r.subAnswers ?? null,
      by: r.by ?? null,
      at: r.at ?? null,
    })),
    // `attachments` is every `## 附件` in the file, flat, file order — a lane
    // or the bench's own numbered picker wanting "everything" reads this.
    // To show them where they belong, read `body_attachments` for the body
    // and each note's own `attachments` below — never this flat list.
    notes: d.notes.map((n) => ({ kind: n.kind, role: n.role, author: n.author, at: n.at, text: n.text, attachments: n.attachments.map(attachmentJSON) })),
    queued: Boolean(d.queued),
    archived_at: d.archivedAt ?? null,
    reopened_at: d.reopenedAt ?? null,
    reopened_after_archive: reopenedAfterArchive(d),
    tags: d.tags,
    attachments: d.attachments.map(attachmentJSON),
    body_attachments: d.bodyAttachments.map(attachmentJSON),
    approvals: d.approvals.map((ap) => ({
      target: ap.target,
      hash: ap.hash,
      approve_on: ap.approveOn ?? null,
      approved_hash: ap.approvedHash ?? null,
      approved_by: ap.approvedBy ?? null,
      approved_at: ap.approvedAt ?? null,
      declined: ap.declined ?? null,
    })),
    body: d.body,
    file: d.file,
    archived: d.archived,
  }
}

/**
 * One phrase for where a piece of outbound content stands, shared by
 * `decs get` and the bench so the owner reads the same words in both.
 */
export function approvalLabel(ap: AttachmentApproval): string {
  const on = ap.approveOn?.length ? i18n('core.render.approveOnHint', { approveOn: ap.approveOn.join(' / ') }) : ''
  if (!ap.approvedHash) return ap.declined ? i18n('core.render.answerNotApproving', { answer: ap.declined, on }) : i18n('core.render.pendingApproval', { on })
  if (ap.approvedHash !== ap.hash) return i18n('core.render.contentChangedNeedsReapproval')
  return i18n('core.render.approved', { by: ap.approvedBy ?? 'owner' })
}
