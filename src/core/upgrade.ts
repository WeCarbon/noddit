import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from './lock.ts'
import { HEADING } from './format.ts'
import { listEntryFiles, type Layout } from './paths.ts'
import { ATTACHMENTS_HEADING_RE, splitFrontMatter } from './parse.ts'
import { relinkFile, renderAttachmentsBlock, upsertSectionScoped } from './serialize.ts'
import { sectionStopBefore, type Store } from './store.ts'
import { ITEM_STATUSES, type Attachment, type Decision } from './types.ts'
import { list, t } from '../i18n/index.ts'

/**
 * One-off repository upgrades, run by a person after looking at a dry run.
 * Both are idempotent: running one twice does nothing the second time.
 */

export interface Step {
  what: string
  from: string
  to?: string
}

const D_ENTRY = /^D(\d+)(-.*)?\.md$/
const D_DIR = /^D(\d+)(-.*)?$/

/** Everything under `dir` that still carries the old `D` prefix, shallowest first. */
function prefixed(dir: string): { path: string; isDir: boolean }[] {
  const out: { path: string; isDir: boolean; depth: number }[] = []
  const walk = (d: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n)
      const isDir = statSync(p).isDirectory()
      if (isDir) {
        if (D_DIR.test(n)) out.push({ path: p, isDir, depth })
        if (/^D?\d+(-.*)?$/.test(n)) walk(p, depth + 1)
      } else if (D_ENTRY.test(n)) out.push({ path: p, isDir, depth })
    }
  }
  walk(dir, 0)
  return out.sort((a, b) => a.depth - b.depth || Number(b.isDir) - Number(a.isDir))
}

const strip = (name: string) => name.replace(/^D(?=\d)/, '')

/**
 * Drops the `D` prefix from entry files, folders and attachment dirs, and
 * rewrites attachment links to match. Refuses up front if an id exists in
 * both forms, since one would overwrite the other.
 */
export function stripPrefix(l: Layout, opts: { dryRun?: boolean } = {}): Step[] {
  const files = listEntryFiles(l)
  const byId = new Map<number, string[]>()
  for (const f of files) byId.set(f.id, [...(byId.get(f.id) ?? []), f.path])
  const both = [...byId].filter(([, ps]) => ps.length > 1)
  const att = join(l.root, 'attachments')
  const attPairs = existsSync(att)
    ? readdirSync(att).filter((n) => /^D\d+$/.test(n) && existsSync(join(att, strip(n))))
    : []
  if (both.length || attPairs.length) {
    const lines = [
      ...both.map(([id, ps]) => `  ${id}: ${list(ps.map((p) => relative(l.root, p)))}`),
      ...attPairs.map((n) => `  ${list([`attachments/${n}`, `attachments/${strip(n)}`])}`),
    ]
    throw new Error(t('core.upgrade.bothFormsExist', { lines: lines.join('\n') }))
  }

  const steps: Step[] = []
  const renamedAttachments = new Map<string, string>()
  if (existsSync(att)) {
    for (const n of readdirSync(att).filter((n) => /^D\d+$/.test(n))) {
      steps.push({ what: t('core.upgrade.rename'), from: join(att, n), to: join(att, strip(n)) })
      renamedAttachments.set(join(att, n), join(att, strip(n)))
      if (!opts.dryRun) renameSync(join(att, n), join(att, strip(n)))
    }
  }
  const mapAttachment = (abs: string) => {
    for (const [from, to] of renamedAttachments) if (abs === from || abs.startsWith(from + sep)) return to + abs.slice(from.length)
    return abs
  }

  for (const base of [l.activeDir, l.archivedDir]) {
    if (opts.dryRun) {
      for (const p of prefixed(base))
        steps.push({ what: p.isDir ? t('core.upgrade.renameFolder') : t('core.upgrade.rename'), from: p.path, to: join(dirname(p.path), strip(basename(p.path))) })
      continue
    }
    // Re-list after every rename: renaming a folder moves everything under it.
    for (;;) {
      const next = prefixed(base)[0]
      if (!next) break
      const to = join(dirname(next.path), strip(basename(next.path)))
      steps.push({ what: next.isDir ? t('core.upgrade.renameFolder') : t('core.upgrade.rename'), from: next.path, to })
      if (next.isDir) {
        renameSync(next.path, to)
        continue
      }
      const id = Number(D_ENTRY.exec(basename(next.path))![1])
      withFileLock(join(l.root, '.locks', `${id}.lock`), () => {
        renameSync(next.path, to)
        const text = readFileSync(to, 'utf8')
        const fixed = relinkFile(text, dirname(to), dirname(to), mapAttachment)
        if (fixed !== text) writeFileAtomic(to, fixed)
      })
    }
  }
  // Bodies already without the prefix can still link into a renamed attachment folder.
  if (!opts.dryRun && renamedAttachments.size) {
    for (const f of listEntryFiles(l)) {
      const text = readFileSync(f.path, 'utf8')
      const fixed = relinkFile(text, dirname(f.path), dirname(f.path), mapAttachment)
      if (fixed !== text) {
        withFileLock(join(l.root, '.locks', `${f.id}.lock`), () => writeFileAtomic(f.path, fixed))
        steps.push({ what: t('core.upgrade.relink'), from: f.path })
      }
    }
  }
  return steps
}

/** Rewrites legacy `status: open|answered` (or missing) into the mapped
 *  node status, permanently. Bodies are untouched. */
export function upgradeStatuses(store: Store, opts: { dryRun?: boolean } = {}): Step[] {
  const steps: Step[] = []
  for (const d of store.all()) {
    const raw = splitFrontMatter(readFileSync(d.file, 'utf8')).data.status
    if (typeof raw === 'string' && (ITEM_STATUSES as readonly string[]).includes(raw)) continue
    steps.push({ what: t('core.upgrade.status', { from: raw ?? t('core.upgrade.none'), to: d.state }), from: d.file })
    if (!opts.dryRun) store.rewrite(d)
  }
  return steps
}

const LIST_HEADING = /^##[ \t]+.*(?:选项|方案|代价)/
const LIST_ITEM = /^(\d{1,2})\.[ \t]+(.+)$/

/**
 * Rewrites an old numbered-list options block (`## 选项代价` /
 * `1. 标签：代价……`) into `### 1 · 标签` headings the parser recognises.
 * Pure: returns new text, or null if no such list. The last list-bearing
 * heading wins.
 */
export function rewriteOptionList(text: string): string | null {
  const lines = text.split('\n')
  let found: { head: number; from: number; to: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    if (!LIST_HEADING.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const from = j
    while (j < lines.length && (LIST_ITEM.test(lines[j]) || (j > from && lines[j].trim() && !/^#/.test(lines[j]) && /^[ \t]/.test(lines[j])))) j++
    const items = lines.slice(from, j).filter((l) => LIST_ITEM.test(l))
    if (items.length >= 2) found = { head: i, from, to: j }
  }
  if (!found) return null
  const out: string[] = []
  for (const l of lines.slice(found.from, found.to)) {
    const m = LIST_ITEM.exec(l)
    if (!m) {
      out.push(l.trim())
      continue
    }
    const rest = m[2].trim()
    const cut = rest.search(/[：:]/)
    const label = (cut === -1 ? rest : rest.slice(0, cut)).replace(/\*\*/g, '').trim()
    const body = cut === -1 ? '' : rest.slice(cut + 1).trim()
    out.push(`### ${m[1]} · ${label}`, '', ...(body ? [body, ''] : []))
  }
  return [...lines.slice(0, found.head), '## 选项', '', ...out, ...lines.slice(found.to)].join('\n')
}

/**
 * Entries with a `default` but no parseable options: a numbered list is
 * rewritten into headings; a finished node with nothing recognisable just
 * loses the stale `default`. Anything else is reported for a person to fix.
 */
export function upgradeOptionLists(store: Store, opts: { dryRun?: boolean } = {}): Step[] {
  const steps: Step[] = []
  for (const d of store.all()) {
    if (!d.default || d.options.length) continue
    const text = readFileSync(d.file, 'utf8')
    const fixed = rewriteOptionList(text)
    const l = store.layoutOf(d)
    if (fixed) {
      steps.push({ what: t('core.upgrade.numberedOptions'), from: d.file })
      if (!opts.dryRun) withFileLock(join(l.root, '.locks', `${d.id}.lock`), () => writeFileAtomic(d.file, fixed))
    } else if (d.state === 'completed' || d.state === 'closed') {
      steps.push({ what: t('core.upgrade.dropStaleDefault', { default: d.default }), from: d.file })
      if (!opts.dryRun) {
        const without = text.replace(/^default:[^\n]*\n/m, '')
        withFileLock(join(l.root, '.locks', `${d.id}.lock`), () => writeFileAtomic(d.file, without))
      }
    } else {
      steps.push({ what: t('core.upgrade.optionsNotRecognised', { default: d.default }), from: d.file })
    }
  }
  return steps
}

// --- attachments: split one old global `## 附件` back to the sections it belongs to ----

const BODY_KEY = '(body)'
const ANY_H2 = /^##[ \t]+\S/

/** Every `## 附件`-headed block removed, wherever it sits — the sections stay, just without their old attachment list. */
function stripAttachmentBlocks(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (ATTACHMENTS_HEADING_RE.test(line)) {
      skipping = true
      continue
    }
    if (skipping) {
      if (!ANY_H2.test(line)) continue
      skipping = false
    }
    out.push(line)
  }
  return out.join('\n')
}

interface AttachmentSection {
  /** `BODY_KEY`, or the `DecisionNote.heading` this section is. */
  key: string
  anchor: string | undefined
  /** Prose only — an existing `## 附件` block within it is stripped first,
   *  so an attachment doesn't "reference itself" by already being listed. */
  text: string
  at: string
}

function bodyProseText(d: Decision): string {
  const lines = d.body.split('\n')
  const first = d.notes[0]
  const stopAt = first ? lines.findIndex((l) => l === `## ${first.heading}`) : -1
  return stripAttachmentBlocks((stopAt === -1 ? lines : lines.slice(0, stopAt)).join('\n'))
}

function attachmentSections(d: Decision): AttachmentSection[] {
  return [
    { key: BODY_KEY, anchor: undefined, text: bodyProseText(d), at: d.created },
    ...d.notes.map((n) => ({ key: n.heading, anchor: n.heading, text: n.text, at: n.at })),
  ]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A section's own prose names this file — `](target)` (any link syntax) or the bare filename as a word. */
function referencesTarget(text: string, target: string): boolean {
  if (text.includes(`](${target})`)) return true
  const name = basename(target.split(/[?#]/)[0])
  return name ? new RegExp(`(?<![\\w.-])${escapeRe(name)}(?![\\w.-])`, 'i').test(text) : false
}

/** When this was (likely) copied in — `undefined` for a URL or a file no longer there to time. */
function attachedAtMs(d: Decision, target: string): number | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return undefined
  try {
    return statSync(resolve(dirname(d.file), target)).mtimeMs
  } catch {
    return undefined
  }
}

export interface AttachmentMove {
  target: string
  label: string
  /** `BODY_KEY` or a note heading — where it is today. */
  from: string
  /** Where the evidence says it belongs — same shape as `from`. */
  to: string
  reason: 'inline-reference' | 'timing' | 'kept-ambiguous' | 'no-signal-kept-body'
  /** Conflicting evidence, not just "no evidence" — worth a person's own look (see `candidates`). */
  ambiguous: boolean
  candidates: string[]
}

/**
 * Where one attachment belongs, by the best evidence available: an inline
 * reference to it in exactly one section's prose; failing that, which
 * section's own timestamp is clearly closest to when the file was copied in
 * (no author is recorded per attachment, so this is the whole signal —
 * see `AttachmentMove`); failing that, the body — the same default a fresh
 * `nod attach` with no `--to` would not have picked, but a safe, visible one.
 */
function classifyAttachment(d: Decision, sections: AttachmentSection[], a: Attachment, from: string): AttachmentMove {
  const base = { target: a.target, label: a.label, from }
  const refHits = sections.filter((s) => referencesTarget(s.text, a.target))
  if (refHits.length === 1) return { ...base, to: refHits[0].key, reason: 'inline-reference', ambiguous: false, candidates: [] }
  if (refHits.length > 1) return { ...base, to: from, reason: 'kept-ambiguous', ambiguous: true, candidates: refHits.map((s) => s.key) }

  const mtime = attachedAtMs(d, a.target)
  if (mtime !== undefined) {
    const scored = sections
      .map((s) => ({ s, gap: Math.abs(mtime - Date.parse(s.at)) }))
      .filter((x) => Number.isFinite(x.gap))
      .sort((x, y) => x.gap - y.gap)
    const [best, second] = scored
    if (best && (!second || best.gap <= second.gap / 2)) return { ...base, to: best.s.key, reason: 'timing', ambiguous: false, candidates: [] }
    if (best) return { ...base, to: from, reason: 'kept-ambiguous', ambiguous: true, candidates: scored.slice(0, 3).map((x) => x.s.key) }
  }
  return { ...base, to: BODY_KEY, reason: 'no-signal-kept-body', ambiguous: false, candidates: [] }
}

export interface NodeAttachmentPlan {
  file: string
  id: number
  project: string
  moves: AttachmentMove[]
  changedCount: number
  ambiguousCount: number
}

/** Pure — reads nothing but `d` (and, for the timing heuristic, the attachment files' mtimes). */
export function planAttachmentMoves(d: Decision): NodeAttachmentPlan {
  const sections = attachmentSections(d)
  const ownerOf = new Map<Attachment, string>()
  for (const s of sections) {
    const items = s.anchor === undefined ? d.bodyAttachments : (d.notes.find((n) => n.heading === s.anchor)?.attachments ?? [])
    for (const a of items) ownerOf.set(a, s.key)
  }
  const moves = d.attachments.map((a) => classifyAttachment(d, sections, a, ownerOf.get(a) ?? BODY_KEY))
  return {
    file: d.file,
    id: d.id,
    project: d.project,
    moves,
    changedCount: moves.filter((m) => m.to !== m.from).length,
    ambiguousCount: moves.filter((m) => m.ambiguous).length,
  }
}

/** Rewrites the body so every attachment sits in the section `moves` (aligned 1:1 with `d.attachments`) says it belongs to. */
function applyAttachmentMoves(d: Decision, moves: AttachmentMove[]): string {
  const byTo = new Map<string, Attachment[]>()
  d.attachments.forEach((a, i) => byTo.set(moves[i].to, [...(byTo.get(moves[i].to) ?? []), a]))

  let body = stripAttachmentBlocks(d.body)
  for (const [to, items] of byTo) {
    const anchor = to === BODY_KEY ? undefined : to
    body = upsertSectionScoped(body, anchor, sectionStopBefore(d, anchor), HEADING.attachments, renderAttachmentsBlock(items))
  }
  return body.replace(/\n{3,}/g, '\n\n')
}

/**
 * Splits every node's one old `## 附件` section back into the sections its
 * entries actually belong to (see `planAttachmentMoves`). A node where
 * nothing moves is left untouched byte-for-byte.
 */
export function upgradeAttachments(store: Store, opts: { dryRun?: boolean } = {}): { steps: Step[]; plans: NodeAttachmentPlan[] } {
  const steps: Step[] = []
  const plans: NodeAttachmentPlan[] = []
  for (const d of store.all()) {
    if (!d.attachments.length) continue
    const plan = planAttachmentMoves(d)
    plans.push(plan)
    if (!plan.changedCount) continue
    steps.push({ what: t('core.upgrade.attachmentsMoved', { count: plan.changedCount, total: d.attachments.length }), from: d.file })
    if (!opts.dryRun) store.rewriteBody(d, (fresh) => applyAttachmentMoves(fresh, planAttachmentMoves(fresh).moves))
  }
  return { steps, plans }
}
