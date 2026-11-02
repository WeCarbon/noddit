import { isAbsolute, relative, resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { ATTACHMENT_GROUP_END, HEADING, optionsHeading } from './format.ts'
import { currentIdentity } from './identity.ts'
import { toPosixPath } from './paths.ts'
import type { Attachment, Decision, DecisionOption, NoteRole, AttachmentApproval } from './types.ts'

/** Front matter key order — stable so diffs stay readable. */
const KEY_ORDER = [
  'id', 'title', 'author', 'status', 'close_reason', 'waiting_on', 'deferred_at', 'deferred_by', 'deferred_until', 'assignee', 'created', 'updated_at',
  'after', 'progress', 'progress_msg', 'est', 'when', 'stale_after', 'steps', 'owner_agent', 'intake', 'claimed_by', 'claimed_at',
  'kind', 'urgency', 'due', 'milestone', 'default', 'question_defaults', 'if_no_answer', 'reversible',
  'pin', 'pinned_at', 'tags', 'session', 'supersedes', 'superseded_by', 'answer', 'approvals',
  'archived_at', 'reopened_at',
]

export function frontMatterOf(d: Decision): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: d.id,
    title: d.title,
    author: d.author,
    status: d.state,
    created: d.created,
  }
  if (d.closeReason) fm.close_reason = d.closeReason
  if (d.waitingOn) fm.waiting_on = d.waitingOn
  if (d.deferredAt) fm.deferred_at = d.deferredAt
  if (d.deferredAt && d.deferredBy) fm.deferred_by = d.deferredBy
  if (d.deferredAt && d.deferredUntil) fm.deferred_until = d.deferredUntil
  if (d.assignee) fm.assignee = d.assignee
  if (d.updatedAt) fm.updated_at = d.updatedAt
  if (d.after?.length) fm.after = d.after
  if (d.progress !== undefined) fm.progress = d.progress
  if (d.progressMsg) fm.progress_msg = d.progressMsg
  if (d.est) fm.est = d.est
  if (d.when) fm.when = d.when
  if (d.staleAfter) fm.stale_after = d.staleAfter
  if (d.steps !== undefined) fm.steps = d.steps
  if (d.ownerAgent) fm.owner_agent = d.ownerAgent
  if (d.intake) fm.intake = true
  if (d.claimedBy) fm.claimed_by = d.claimedBy
  if (d.claimedAt) fm.claimed_at = d.claimedAt
  if (d.default) fm.default = d.default
  const qd = Object.fromEntries((d.questions ?? []).filter((q) => q.default).map((q) => [q.key, q.default!]))
  if (Object.keys(qd).length) fm.question_defaults = qd
  // Only what differs from the default is written, so an entry that never
  // used these fields stays byte-identical when the tool touches it.
  if (d.kind === 'fyi') fm.kind = 'fyi'
  if (d.urgency && d.urgency !== 'normal') fm.urgency = d.urgency
  if (d.due) fm.due = d.due
  if (d.milestone) fm.milestone = true
  if (d.ifNoAnswer) fm.if_no_answer = d.ifNoAnswer
  if (d.reversible !== undefined) fm.reversible = d.reversible
  if (d.session) fm.session = d.session
  if (d.supersedes?.length) fm.supersedes = d.supersedes
  if (d.supersededBy !== undefined) fm.superseded_by = d.supersededBy
  if (d.pin) fm.pin = d.pin
  if (d.pinnedAt) fm.pinned_at = d.pinnedAt
  if (d.tags.length) fm.tags = d.tags
  if (d.archivedAt) fm.archived_at = d.archivedAt
  if (d.reopenedAt) fm.reopened_at = d.reopenedAt
  if (d.answer) {
    const a: Record<string, unknown> = {}
    if (d.answer.choice) a.choice = d.answer.choice
    if (d.answer.answers && Object.keys(d.answer.answers).length) a.answers = d.answer.answers
    if (d.answer.answerNotes && Object.keys(d.answer.answerNotes).length) a.answer_notes = d.answer.answerNotes
    if (d.answer.note) a.note = d.answer.note
    a.by = d.answer.by
    a.at = d.answer.at
    fm.answer = a
  }
  if (d.approvals.length) {
    fm.approvals = d.approvals.map((ap) => {
      const a: Record<string, unknown> = { target: ap.target, hash: ap.hash }
      if (ap.approvedHash) a.approved_hash = ap.approvedHash
      if (ap.approvedAt) a.approved_at = ap.approvedAt
      if (ap.approvedBy) a.approved_by = ap.approvedBy
      if (ap.approveOn?.length) a.approve_on = ap.approveOn
      if (ap.declined) a.declined = ap.declined
      return a
    })
  }
  // Whatever a newer version wrote that this one does not understand.
  for (const [k, v] of Object.entries(d.extra ?? {})) if (!(k in fm)) fm[k] = v
  return fm
}

export function serializeDecision(d: Decision): string {
  const fm = frontMatterOf(d)
  const ordered: Record<string, unknown> = {}
  for (const k of KEY_ORDER) if (k in fm) ordered[k] = fm[k]
  for (const k of Object.keys(fm)) if (!(k in ordered)) ordered[k] = fm[k]

  const yaml = stringifyYaml(ordered, { lineWidth: 0, defaultKeyType: 'PLAIN' })
  const body = d.body.replace(/^\n+/, '')
  return `---\n${yaml}---\n\n${body.endsWith('\n') ? body : body + '\n'}`
}

/** Renders the `## 选项` block that `decs add` writes into a fresh entry. */
export function renderOptionsBlock(options: DecisionOption[], round = 1): string {
  if (!options.length) return ''
  const parts = [`## ${optionsHeading(round)}`, '']
  for (const o of options) {
    parts.push(`### ${o.key}${o.label ? ` · ${o.label}` : ''}`)
    if (o.body?.trim()) parts.push('', o.body.trim())
    parts.push('')
  }
  return parts.join('\n')
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$/i

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p.split(/[?#]/)[0])
}

export { ATTACHMENT_GROUP_END }

/** Images get `!` so they render inline. `group` gets a `**<group>**`
 *  sub-heading; `caption` gets an italic line under the link. */
export function renderAttachmentsBlock(items: Attachment[]): string {
  if (!items.length) return ''
  const lines = [`## ${HEADING.attachments}`, '']
  let group: string | undefined
  for (const a of items) {
    if (a.group !== group) {
      group = a.group
      if (lines.length > 2) lines.push('')
      lines.push(group ? `**${group}**` : ATTACHMENT_GROUP_END, '')
    }
    lines.push(`- ${a.image ? '!' : ''}[${a.label}](${a.target})`)
    if (a.caption) lines.push(`  *${a.caption}*`)
  }
  lines.push('')
  return lines.join('\n')
}

const HEADING_TAIL = '[ \\t\u3000]*[:\uff1a]?[ \\t]*$'
const NEXT_H2 = /^##[ \t]+\S/

/**
 * Replaces one `## <heading>` section in place, or appends it when absent.
 * Only the lines between that heading and the next `## ` move.
 */
export function upsertSection(body: string, heading: string, block: string): string {
  const re = new RegExp(`^##[ \\t]+${heading}${HEADING_TAIL}`)
  const lines = body.split('\n')
  const start = lines.findIndex((l) => re.test(l))

  if (start === -1) {
    if (!block.trim()) return body
    return `${body.replace(/\s+$/, '')}\n\n${block.trim()}\n`
  }

  let end = start + 1
  while (end < lines.length && !NEXT_H2.test(lines[end])) end++

  const head = lines.slice(0, start).join('\n').replace(/\s+$/, '')
  const tail = lines.slice(end).join('\n').replace(/^\s+/, '')
  const middle = block.trim() ? ['', block.trim(), ''] : ['']
  return [head, ...middle, tail].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
}

/**
 * `upsertSection`, confined to one section's own span: the body's top prose
 * (`anchor` undefined), or right after a `## <anchor>` heading — stopping
 * before `stopBefore` (the next *note's* heading, or `undefined` for "end of
 * body") rather than at the next `## ` of any kind, so a heading already
 * inside this section (`## 选项`, an existing `## 附件`) doesn't get read as
 * someone else's boundary. `anchor`/`stopBefore` are `DecisionNote.heading`
 * strings, found verbatim — see `core/store.ts#sectionStopBefore`.
 */
export function upsertSectionScoped(body: string, anchor: string | undefined, stopBefore: string | undefined, heading: string, block: string): string {
  const lines = body.split('\n')
  let start = 0
  if (anchor !== undefined) {
    const hi = lines.findIndex((l) => l === `## ${anchor}`)
    if (hi === -1) throw new Error(`no such section: ${anchor}`)
    start = hi + 1
  }
  let end = lines.length
  if (stopBefore !== undefined) {
    const si = lines.findIndex((l, i) => i >= start && l === `## ${stopBefore}`)
    if (si !== -1) end = si
  }

  const span = upsertSection(lines.slice(start, end).join('\n'), heading, block)
  return [...lines.slice(0, start), ...span.split('\n'), ...lines.slice(end)].join('\n')
}

/**
 * `已答（human · owner · 2026-10-28 10:51:30）` — the shape every appended
 * section is written in, so `parseNoteHeading` can read it back. Seconds,
 * not minutes, so a note just after a `decs changes --since` cutoff isn't
 * misordered.
 */
export function noteHeading(kind: string, role: NoteRole, author: string, at: string): string {
  const when = at.slice(0, 19).replace('T', ' ')
  return `${kind}（${role} · ${author.replace(/[（）()]/g, ' ').trim() || role} · ${when}）`
}

/**
 * Rewrites a body's relative links so they still resolve after it moved
 * from `fromDir` to `toDir`. `rename` also maps a target that itself moved
 * (`--strip-prefix`).
 */
export function relinkBody(body: string, fromDir: string, toDir: string, rename: (abs: string) => string = (p) => p): string {
  return body.replace(/(\]\()([^)\s]+)(\))/g, (_all, open: string, target: string, close: string) =>
    `${open}${relinkTarget(target, fromDir, toDir, rename)}${close}`,
  )
}

/** One link target, as `relinkBody` rewrites it; also used for
 *  `approvals[].target`, the join key with the body's link. */
export function relinkTarget(target: string, fromDir: string, toDir: string, rename: (abs: string) => string = (p) => p): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || isAbsolute(target)) return target
  const rel = toPosixPath(relative(toDir, rename(resolve(fromDir, target))))
  return rel === target ? target : rel
}

/** `relinkBody` for a whole file: the body's links plus front matter `approvals[].target`. */
export function relinkFile(text: string, fromDir: string, toDir: string, rename: (abs: string) => string = (p) => p): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text)
  if (!m) return relinkBody(text, fromDir, toDir, rename)
  const fm = m[0].replace(/^(\s*(?:-\s+)?target:\s*)(['"]?)([^'"\r\n]+)\2[ \t]*$/gm, (_all, lead: string, q: string, t: string) =>
    `${lead}${q}${relinkTarget(t.trim(), fromDir, toDir, rename)}${q}`,
  )
  return fm + relinkBody(text.slice(m[0].length), fromDir, toDir, rename)
}

/**
 * `<!-- nod:by=<identity> -->` on its own line — invisible in any markdown
 * viewer, stripped back out by `parse.ts`'s `parseNotes`. Records which
 * *process* wrote the section, regardless of whose name/role it's signed
 * as (a lead relaying the owner's own words still signs `--human --by
 * owner`, but writes the lead's identity here) — see `core/identity.ts`
 * and N41: a monitor skips its own marker so relaying never echoes back.
 */
function writerMarker(): string {
  const id = currentIdentity()
  return id ? `<!-- nod:by=${id} -->` : ''
}

/** Appends a `## <heading>` section without touching a byte of what came before. */
export function appendSection(body: string, heading: string, text: string): string {
  const base = body.replace(/\s+$/, '')
  const marker = writerMarker()
  const content = marker ? `${text.trim()}\n${marker}` : text.trim()
  return `${base}\n\n## ${heading}\n\n${content}\n`
}

const SLUG_STRIP = /[^0-9a-zA-Z\u4e00-\u9fff\u3040-\u30ff]+/g

export function slugify(title: string, max = 20): string {
  const s = title.toLowerCase().replace(SLUG_STRIP, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, max).replace(/-+$/, '') || 'entry'
}
