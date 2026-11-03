import { basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ATTACHMENT_GROUP_END } from './serialize.ts'
import { isAnswerKind } from './format.ts'
import { ENTRY_NAME_RE } from './paths.ts'
import { parseQuestions } from './questions.ts'
import {
  ACCEPTANCE_OPTION,
  ITEM_STATUSES,
  type Attachment,
  type AttachmentApproval,
  type Decision,
  type DecisionKind,
  type DecisionNote,
  type DecisionOption,
  type DecisionStatus,
  type ItemStatus,
  type NoteRole,
  type PreviousRound,
} from './types.ts'

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/** Headings that open the options block. `## 选项（第 2 轮）` is what `decs ask`
 *  writes for a re-decision; only the highest round counts. */
export const OPTIONS_HEADING_RE = /^##[ \t]+(?:选项|各选项|选项与代价|可选项|Options)(?:[（(]第[ \t]*(\d+)[ \t]*轮[）)])?[ \t　]*[:：]?[ \t]*$/
/** `### 1 · 严格：树必须一致` — the ` · <label>` half is optional; separator
 *  also accepts `——`/`--`, since hand-written entries use those too. */
const OPTION_RE = /^###[ \t]+([A-Za-z0-9]{1,4})[ \t]*(?:[·:：．.\-—–]{1,2}[ \t]*(.*))?$/
const H2_RE = /^##[ \t]+\S/
export const ATTACHMENTS_HEADING_RE = /^##[ \t]+(附件|Attachments)[ \t　]*[:：]?[ \t]*$/
export const ATTACHMENT_RE = /^[-*][ \t]+(!)?\[([^\]]*)\]\(([^)]+)\)/
/** `**选项 1**` on its own line — a group heading over the attachments below it. */
export const ATTACHMENT_GROUP_RE = /^\*\*([^*]+)\*\*[ \t]*$/
/** `  *caption text*` right under an attachment line — single `*`, not `**`. */
export const ATTACHMENT_CAPTION_RE = /^\*([^*].*[^*]|[^*])\*[ \t]*$/

/**
 * `\r\n` (Windows editors, `git config core.autocrlf true`) and a lone `\r`
 * both become `\n` — every heading/option/note regex below is anchored with
 * `$` on a single line and would otherwise fail to match a line that still
 * carries its `\r`.
 */
export function normalizeNewlines(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

/**
 * An attachment link committed from Windows (or written before this build
 * normalised it, see `core/paths.ts#toPosixPath`) may still carry `\`
 * separators. Windows' own file APIs accept `/` just as well, so turning
 * `\` into `/` on read is safe everywhere and makes the link resolve on
 * any OS that opens the repo. A URL's backslash, if ever intentional, is
 * left alone.
 */
function normalizeTargetSlashes(target: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : target.replace(/\\/g, '/')
}

export function splitFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = FM_RE.exec(text)
  if (!m) return { data: {}, body: text }
  let data: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1]) as unknown
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch (e) {
    throw new Error(`front matter is not valid YAML: ${(e as Error).message}`)
  }
  return { data, body: text.slice(m[0].length) }
}

/** The node's current options round: 0 with no `## 选项` block at all, 1 for
 *  a plain one, higher once `decs ask` has renumbered it. Drives which
 *  `## 子问题` block (if any) is still live — see `core/questions.ts`. */
export function optionsRoundOf(body: string): number {
  let max = 0
  for (const line of body.split('\n')) {
    const m = OPTIONS_HEADING_RE.exec(line)
    if (m) max = Math.max(max, Number(m[1] ?? 1))
  }
  return max
}

/**
 * Pulls options out of the body's `## 选项` block — the label lives only
 * here, never duplicated into front matter. With no `round`, only the
 * highest-numbered block counts (the node's live options); passing one
 * pulls that specific round instead, for history (`parsePreviousRounds`).
 */
export function parseOptions(body: string, round?: number): DecisionOption[] {
  const lines = body.split('\n')
  let out: DecisionOption[] = []
  let curRound = 0
  let inBlock = false
  let current: DecisionOption | null = null
  let buf: string[] = []

  const flush = () => {
    if (current) {
      current.body = buf.join('\n').trim()
      out.push(current)
    }
    current = null
    buf = []
  }

  for (const line of lines) {
    const head = OPTIONS_HEADING_RE.exec(line)
    if (head) {
      flush()
      const r = Number(head[1] ?? 1)
      if (round === undefined) {
        if (r > curRound) {
          curRound = r
          out = []
        }
        inBlock = r === curRound
      } else {
        inBlock = r === round
      }
      continue
    }
    if (inBlock && H2_RE.test(line)) {
      flush()
      inBlock = false
      continue
    }
    if (!inBlock) continue
    const m = OPTION_RE.exec(line)
    if (m) {
      flush()
      current = { key: m[1], label: (m[2] ?? '').trim(), body: '' }
      continue
    }
    if (current) buf.push(line)
  }
  flush()
  return out
}

/**
 * Attachments are plain markdown links under `## 附件`. A `**<group>**` line
 * groups the attachments below it (`decs attach --label`); a `  *<caption>*`
 * line under a link is its caption (`--caption`).
 */
export function parseAttachments(body: string): Attachment[] {
  const out: Attachment[] = []
  let inBlock = false
  let group: string | undefined
  let last: Attachment | null = null
  for (const line of body.split('\n')) {
    if (ATTACHMENTS_HEADING_RE.test(line)) {
      inBlock = true
      group = undefined
      last = null
      continue
    }
    if (inBlock && H2_RE.test(line)) break
    if (!inBlock) continue

    const trimmed = line.trim()
    if (!trimmed) {
      last = null
      continue
    }
    if (trimmed === ATTACHMENT_GROUP_END) {
      group = undefined
      last = null
      continue
    }
    const g = ATTACHMENT_GROUP_RE.exec(trimmed)
    if (g) {
      group = g[1].trim()
      last = null
      continue
    }
    const m = ATTACHMENT_RE.exec(trimmed)
    if (m) {
      const a: Attachment = { image: Boolean(m[1]), label: m[2].trim(), target: normalizeTargetSlashes(m[3].trim()) }
      if (group) a.group = group
      out.push(a)
      last = a
      continue
    }
    const c = ATTACHMENT_CAPTION_RE.exec(trimmed)
    if (c && last) {
      last.caption = c[1].trim()
      last = null
      continue
    }
    last = null
  }
  return out
}

/** `decs attach --approval-content` bookkeeping (see `AttachmentApproval`).
 *  A malformed shape reads as "no approvals yet" rather than throwing. */
export function parseApprovals(data: Record<string, unknown>): AttachmentApproval[] {
  if (!Array.isArray(data.approvals)) return []
  const out: AttachmentApproval[] = []
  for (const raw of data.approvals) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const target = str(r.target)
    const hash = str(r.hash)
    if (!target || !hash) continue
    out.push({
      target,
      hash,
      approvedHash: str(r.approved_hash),
      approvedAt: str(r.approved_at),
      approvedBy: str(r.approved_by),
      approveOn: Array.isArray(r.approve_on) ? r.approve_on.map(String) : undefined,
      declined: str(r.declined),
    })
  }
  return out
}

/**
 * Matches `## 追问（human · owner · 2026-10-28 10:51:30）` and the pre-roles
 * `## 追问（owner · 2026-10-27 13:08）`. The timestamp in the last ` · ` slot
 * is what makes a heading a note, not just any `## Title (parenthetical)`.
 */
const NOTE_HEADING_RE = /^##[ \t]+([^\n（(]+?)[ \t]*[（(]([^\n]+)[）)][ \t]*$/
const NOTE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/
const ROLES: readonly string[] = ['human', 'agent']

export interface NoteHeading {
  kind: string
  role: NoteRole
  author: string
  /** ISO with offset; `precisionMs` says how much the heading rounded away. */
  at: string
  precisionMs: number
}

/** Local wall-clock time from a heading, as an ISO string with this machine's offset. */
function headingTime(date: string, hm: string, sec?: string): string {
  const d = new Date(`${date}T${hm}${sec ?? ':00'}`)
  const off = -d.getTimezoneOffset()
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return `${date}T${hm}${sec ?? ':00'}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}

export function parseNoteHeading(line: string): NoteHeading | null {
  const m = NOTE_HEADING_RE.exec(line)
  if (!m) return null
  const parts = m[2].split(/[ \t]*·[ \t]*/).map((p) => p.trim())
  const t = NOTE_TIME_RE.exec(parts[parts.length - 1] ?? '')
  if (!t || parts.length < 2) return null
  const who = parts.slice(0, -1)
  // Before roles existed the only signature was the name, and the only name
  // the owner ever signed with was `owner` — so that is what human means there.
  const role: NoteRole = ROLES.includes(who[0]) ? (who.shift() as NoteRole) : who[0] === 'owner' ? 'human' : 'agent'
  return {
    kind: m[1].trim(),
    role,
    author: who.join(' · ') || (role === 'human' ? 'owner' : ''),
    at: headingTime(t[1], t[2], t[3]),
    precisionMs: t[3] ? 1000 : 60_000,
  }
}

/** `<!-- nod:by=<identity> -->` on its own trailing line — see `serialize.ts`'s `appendSection`. */
const WRITER_MARKER_RE = /\n?<!--[ \t]*nod:by=([^\n]*?)[ \t]*-->[ \t]*$/

/** Every appended section, in body order. */
export function parseNotes(body: string): DecisionNote[] {
  const lines = body.split('\n')
  const sections = sectionAttachments(body)
  const out: DecisionNote[] = []
  let noteIndex = 0
  for (let i = 0; i < lines.length; i++) {
    const h = parseNoteHeading(lines[i])
    if (!h) continue
    let end = i + 1
    while (end < lines.length && !H2_RE.test(lines[end])) end++
    let text = lines.slice(i + 1, end).join('\n').trim()
    const m = WRITER_MARKER_RE.exec(text)
    const writer = m?.[1]
    if (m) text = text.slice(0, m.index).trim()
    out.push({
      kind: h.kind,
      role: h.role,
      author: h.author,
      at: h.at,
      text,
      heading: lines[i].replace(/^##[ \t]+/, ''),
      ...(writer ? { writer } : {}),
      attachments: sections.notes[noteIndex] ?? [],
    })
    noteIndex++
  }
  return out
}

/** `- Q1 = B —— change it back to Amount [%]（默认）` — one line of the
 *  per-question breakdown `Store.answer` writes under `## 已答`. */
const SUB_ANSWER_LINE_RE = /^-[ \t]+(\S+)[ \t]*=[ \t]*(\S+)[ \t]*——/

/**
 * Earlier `## 选项（第 N 轮）` rounds — history, never the node's live state.
 * Each round's own `## 已答` note is the only copy of what it was answered,
 * so this is reconstructed from the body on every read rather than stored:
 * no file ever needs rewriting for a round to show up here. N161: an older
 * round's sub-questions must not leak into a newer round's live `answer`;
 * this is where they stay visible instead, labelled by their own round.
 */
export function parsePreviousRounds(body: string): PreviousRound[] {
  const currentRound = optionsRoundOf(body)
  if (currentRound < 2) return []
  const lines = body.split('\n')
  const starts = new Map<number, number>()
  for (let i = 0; i < lines.length; i++) {
    const m = OPTIONS_HEADING_RE.exec(lines[i])
    if (m) starts.set(Number(m[1] ?? 1), i)
  }
  const out: PreviousRound[] = []
  for (let r = 1; r < currentRound; r++) {
    const start = starts.get(r)
    if (start === undefined) continue
    const later = [...starts.values()].filter((s) => s > start)
    const limit = Math.min(lines.length, ...later)

    let answerAt = -1
    let heading: NoteHeading | null = null
    for (let i = start + 1; i < limit; i++) {
      const h = parseNoteHeading(lines[i])
      if (h && isAnswerKind(h.kind)) {
        heading = h
        answerAt = i
      }
    }

    let headline: string | undefined
    const subAnswers: Record<string, string> = {}
    if (answerAt !== -1) {
      let end = answerAt + 1
      while (end < limit && !H2_RE.test(lines[end])) end++
      let text = lines.slice(answerAt + 1, end).join('\n').trim()
      const wm = WRITER_MARKER_RE.exec(text)
      if (wm) text = text.slice(0, wm.index).trim()
      for (const line of text.split('\n')) {
        const sm = SUB_ANSWER_LINE_RE.exec(line.trim())
        if (sm) subAnswers[sm[1]] = sm[2]
        else if (!headline && line.trim()) headline = line.trim()
      }
    }

    out.push({
      round: r,
      options: parseOptions(body, r),
      questions: parseQuestions(body, {}, r),
      ...(headline ? { answer: headline } : {}),
      ...(Object.keys(subAnswers).length ? { subAnswers } : {}),
      ...(heading ? { by: heading.author, at: heading.at } : {}),
    })
  }
  return out
}

/**
 * Splits every `## 附件` block in the body by which section it belongs to —
 * the body's own top prose, or whichever note heading most recently came
 * before it (any other heading in between, e.g. `## 选项`, doesn't change
 * the owner). A section's attachments block may sit right after a later
 * `## 附件` of a different owner too; only a note heading switches owners.
 * `notes[i]` lines up with `parseNotes(body)[i]`.
 */
export function sectionAttachments(body: string): { body: Attachment[]; notes: Attachment[][] } {
  const lines = body.split('\n')
  const noteHeadingAt = new Set<number>()
  for (let i = 0; i < lines.length; i++) if (parseNoteHeading(lines[i])) noteHeadingAt.add(i)

  const noteCount = noteHeadingAt.size
  const buckets: string[][] = Array.from({ length: noteCount + 1 }, () => [])
  let owner = 0
  let noteSeen = 0
  let inAttachments = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (noteHeadingAt.has(i)) {
      noteSeen++
      owner = noteSeen
      inAttachments = false
      continue
    }
    if (H2_RE.test(line)) {
      inAttachments = ATTACHMENTS_HEADING_RE.test(line)
      if (inAttachments) buckets[owner].push(line)
      continue
    }
    if (inAttachments) buckets[owner].push(line)
  }
  const [bodyLines, ...noteLines] = buckets
  return { body: parseAttachments(bodyLines.join('\n')), notes: noteLines.map((b) => parseAttachments(b.join('\n'))) }
}

/** `fyi` is stored; otherwise: no options → task, lone 验收通过 → acceptance, else decision. */
function kindOf(raw: unknown, options: DecisionOption[]): DecisionKind {
  if (raw === 'fyi') return 'fyi'
  if (!options.length) return 'task'
  return options.length === 1 && options[0].label === ACCEPTANCE_OPTION.label ? 'acceptance' : 'decision'
}

/**
 * Maps legacy `open`/`answered` status onto an ItemStatus: archived is
 * `completed`, `open` is `needs_decision`, `answered`+queued is `decided`,
 * `answered`+collected is `in_progress`. Never rewrites the file.
 */
export function stateOf(raw: unknown, ctx: { archived: boolean; answered: boolean; queued?: boolean }): ItemStatus {
  if (typeof raw === 'string' && (ITEM_STATUSES as readonly string[]).includes(raw)) return raw as ItemStatus
  if (ctx.archived) return 'completed'
  const answered = raw === 'answered' || (raw !== 'open' && ctx.answered)
  if (!answered) return 'needs_decision'
  return ctx.queued ? 'decided' : 'in_progress'
}

/** The bench's two-valued view, derived so it can never disagree with `state`. */
export function legacyStatus(state: ItemStatus, answered: boolean): DecisionStatus {
  if (state === 'needs_decision') return 'open'
  return answered ? 'answered' : 'open'
}

/** Every front matter key this version reads; anything else is kept verbatim in `extra`. */
const KNOWN_KEYS = new Set([
  'id', 'title', 'author', 'status', 'created', 'updated_at', 'default', 'order', 'pin', 'pinned_at',
  'urgency', 'due', 'milestone', 'if_no_answer', 'reversible', 'kind', 'session', 'superseded_by', 'supersedes',
  'close_reason', 'waiting_on', 'waiting_until', 'deferred_at', 'deferred_by', 'deferred_until', 'assignee', 'answer', 'answered_by', 'answered_at', 'archived_at', 'reopened_at', 'tags',
  'question_defaults', 'progress', 'progress_msg', 'after', 'est', 'every', 'when', 'stale_after', 'steps', 'owner_agent',
  'approvals', 'intake', 'claimed_by', 'claimed_at',
])

function strMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
}

/** `ai` (or nothing) is the default and reads as absent. */
function assigneeOf(v: unknown): string | undefined {
  const s = str(v)?.trim()
  return !s || s.toLowerCase() === 'ai' ? undefined : s
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  return String(v)
}

export function parseDecision(
  text: string,
  file: string,
  archived: boolean,
  project = '',
  ctx: { queued?: boolean } = {},
): Decision {
  const { data, body } = splitFrontMatter(normalizeNewlines(text))
  const name = basename(file)
  const fromName = ENTRY_NAME_RE.exec(name)

  const id = Number(data.id ?? fromName?.[1] ?? NaN)
  if (!Number.isInteger(id)) throw new Error(`${name}: cannot determine id`)

  const rawAnswer = (data.answer ?? {}) as Record<string, unknown>
  const hasAnswer =
    typeof data.answer === 'string' ||
    (data.answer && typeof data.answer === 'object' && Object.keys(rawAnswer).length > 0)

  const state = stateOf(data.status, { archived, answered: Boolean(hasAnswer), queued: ctx.queued })
  const options = parseOptions(body)
  const notes = parseNotes(body)
  const bodyAttachments = sectionAttachments(body).body
  const extra = Object.fromEntries(Object.entries(data).filter(([k]) => !KNOWN_KEYS.has(k)))
  const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? undefined : [String(v)])
  const progress = Number(data.progress)

  return {
    id,
    title: str(data.title) ?? `${id}`,
    author: str(data.author) ?? '',
    state,
    status: legacyStatus(state, Boolean(hasAnswer)),
    closeReason: str(data.close_reason),
    waitingOn: str(data.waiting_on),
    waitingUntil: str(data.waiting_until),
    deferredAt: str(data.deferred_at),
    deferredBy: data.deferred_at ? str(data.deferred_by) : undefined,
    deferredUntil: data.deferred_at ? str(data.deferred_until) : undefined,
    assignee: assigneeOf(data.assignee),
    created: str(data.created) ?? '',
    updatedAt: str(data.updated_at),
    progress: data.progress !== undefined && Number.isFinite(progress) ? progress : undefined,
    progressMsg: str(data.progress_msg),
    after: strList(data.after),
    est: str(data.est),
    every: str(data.every),
    when: str(data.when),
    staleAfter: str(data.stale_after),
    steps: data.steps ?? undefined,
    ownerAgent: str(data.owner_agent),
    intake: data.intake === true || undefined,
    claimedBy: str(data.claimed_by),
    claimedAt: str(data.claimed_at),
    extra: Object.keys(extra).length ? extra : undefined,
    default: str(data.default),
    order: orderOf(data),
    urgency: data.urgency === 'high' || data.urgency === 'low' ? data.urgency : undefined,
    due: str(data.due),
    milestone: data.milestone === true || undefined,
    ifNoAnswer: str(data.if_no_answer),
    reversible: typeof data.reversible === 'boolean' ? data.reversible : undefined,
    kind: kindOf(data.kind, options),
    session: str(data.session),
    supersededBy: Number.isInteger(Number(data.superseded_by)) && data.superseded_by != null ? Number(data.superseded_by) : undefined,
    supersedes: Array.isArray(data.supersedes) ? data.supersedes.map(Number).filter(Number.isInteger) : undefined,
    answer: hasAnswer
      ? typeof data.answer === 'string'
        ? { choice: data.answer, by: str(data.answered_by) ?? 'owner', at: str(data.answered_at) ?? '' }
        : {
            choice: str(rawAnswer.choice),
            ...(strMap(rawAnswer.answers) ? { answers: strMap(rawAnswer.answers) } : {}),
            ...(strMap(rawAnswer.answer_notes) ? { answerNotes: strMap(rawAnswer.answer_notes) } : {}),
            note: str(rawAnswer.note),
            by: str(rawAnswer.by) ?? 'owner',
            at: str(rawAnswer.at) ?? '',
          }
      : undefined,
    archivedAt: str(data.archived_at),
    reopenedAt: str(data.reopened_at),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    body,
    options,
    questions: parseQuestions(body, strMap(data.question_defaults) ?? {}, Math.max(1, optionsRoundOf(body))),
    previousRounds: parsePreviousRounds(body),
    attachments: [...bodyAttachments, ...notes.flatMap((n) => n.attachments)],
    bodyAttachments,
    notes,
    approvals: parseApprovals(data),
    file,
    slug: fromName?.[2] ?? '',
    archived,
    project,
  }
}

/** `order:`, or a pin from before manual order: pinned to the top sits above the rest, to the bottom below. */
function orderOf(data: Record<string, unknown>): number | undefined {
  const n = Number(data.order)
  if (data.order != null && Number.isFinite(n) && n !== 0) return n
  return data.pin === 'top' ? -1 : data.pin === 'bottom' ? 1 : undefined
}
