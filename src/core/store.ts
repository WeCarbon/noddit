import { replaceDescription, replaceNoteText } from './edit.ts'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { checkinsFileExists, readCheckinsMap, resetCheckin, UNANSWERED_AFTER } from './checkins.ts'
import { createFileAtomic, withFileLock, writeFileAtomic } from './lock.ts'
import { collapseDuplicateOptions, type DuplicateOptionsBlock } from './repair.ts'
import { attachmentDir, childDirOf, entryFileName, listEntryFiles, toPosixPath, type EntryFile, type Layout } from './paths.ts'
import { benchOrder } from './order.ts'
import { projectDisplayName, projectLetter, readProjectConfig } from './project.ts'
import { parseBodyRefs, parseRef, refOf } from './ref.ts'
import { dequeue, enqueue, readQueue } from './queue.ts'
import { HEADING, NOTE_KIND, NOTE_TEXT, isAnswerKind, optionsHeading } from './format.ts'
import { OPTIONS_HEADING_RE, optionsRoundOf, parseDecision, parseNoteHeading, parseNotes, parseOptions, sectionAttachments } from './parse.ts'
import { WAIT_ON_MAX_COLS, awaitsDecision, deferralOver, findRef, isDeferred, isStartable, isTerminal, isWaitDue, statusLabel, withOpenQuestion } from './status.ts'
import { checkSummary } from './summary.ts'
import { isHumanTask } from './assignee.ts'
import { everyUntil, untilDay } from './fuzzy-date.ts'
import { stringWidth } from '../tui/width.ts'
import { withDescription } from './intake.ts'
import { list, t } from '../i18n/index.ts'
import {
  checkQuestions,
  OTHER_KEY,
  parseAnswerTokens,
  parseQuestions,
  questionOptions,
  renderAnswerLines,
  renderQuestionsBlock,
  type DecisionQuestion,
} from './questions.ts'
import {
  appendSection,
  isImagePath,
  noteHeading,
  relinkBody,
  relinkTarget,
  renderAttachmentsBlock,
  renderOptionsBlock,
  serializeDecision,
  slugify,
  upsertSectionScoped,
} from './serialize.ts'
import {
  ACCEPTANCE_OPTION,
  type Attachment,
  type AttachmentApproval,
  type Decision,
  type DecisionNote,
  type DecisionOption,
  type ItemStatus,
  type NewDecision,
  type NoteRole,
} from './types.ts'

export interface ListFilter {
  /** Old vocabulary: `open` = 待决策, `answered` = has an answer on file. Ignored when `states` is given. */
  status?: 'open' | 'answered' | 'all'
  states?: ItemStatus[]
  archived?: boolean | 'all'
  author?: string
  project?: string
}

/** The AI's turn to act on this node, regardless of what state the file says. */
function onQueue(d: Decision): Decision {
  return { ...d, queued: true, state: d.state === 'needs_decision' ? 'decided' : d.state }
}

export interface AttachOpts {
  link?: boolean
  name?: string
  replace?: boolean
  groups?: string[]
  captions?: string[]
  approvalContent?: boolean
  /** `--approve-on 1,3` / `Q2:1`: which answers approve this content. */
  approveOn?: string[]
  /**
   * Which section this lands in: `'body'`, `'last'` (whichever section is
   * newest, any author), a 1-based index into `d.notes`, or text matched
   * against a note's heading or timestamp. Default (`undefined`): the same
   * author's (`by`) own latest note, else the body — see `resolveAttachAnchor`.
   */
  to?: string
  /** Who is attaching, for the default `to` resolution; not stored. */
  by?: string
}

/**
 * Resolves `AttachOpts.to` to a `DecisionNote.heading` string (the section
 * `upsertSectionScoped` writes into), or `undefined` for the body.
 */
function resolveAttachAnchor(d: Decision, to: string | undefined, by: string | undefined): number | undefined | typeof NEW_SECTION {
  const notes = d.notes
  if (to === undefined) {
    if (!by) return undefined
    const mine = notes.findLastIndex((n) => sameAgent(n.author, by) || sameAgent(by, n.author))
    const human = notes.findLastIndex((n) => n.role === 'human')
    // Still this round: the author's own latest section.
    if (mine !== -1 && mine > human) return mine
    // Nobody has answered yet and the author wrote nothing since: the body, as when it was filed.
    if (human === -1) return undefined
    // A new round began after the author last wrote: a section of its own, never the body.
    return NEW_SECTION
  }
  if (to === 'body') return undefined
  if (to === 'last') return notes.length ? notes.length - 1 : undefined
  if (/^\d+$/.test(to)) {
    const idx = Number(to) - 1
    if (idx < 0 || idx >= notes.length) throw new Error(t('core.store.attachToOutOfRange', { n: to, count: notes.length }))
    return idx
  }
  const hit = notes.findIndex((n) => n.heading.includes(to) || n.at.startsWith(to))
  if (hit === -1) throw new Error(t('core.store.attachToNotFound', { to }))
  return hit
}

/** `resolveAttachAnchor`'s answer when the files need a new section by the attaching author. */
const NEW_SECTION = Symbol('new section')

/** Where note `idx` is, as upsertSectionScoped finds it: its heading, which of the same headings, and the next note's. */
function sectionAt(d: Decision, idx: number | undefined): { anchor: string | undefined; nth: number; stop: string | undefined } {
  if (idx === undefined) return { anchor: undefined, nth: 0, stop: d.notes[0]?.heading }
  const anchor = d.notes[idx].heading
  return { anchor, nth: d.notes.slice(0, idx).filter((n) => n.heading === anchor).length, stop: d.notes[idx + 1]?.heading }
}

/** The attachments already in the section `anchor` names (see `resolveAttachAnchor`). */
function sectionAttachmentsOf(d: Decision, anchor: string | undefined): Attachment[] {
  return anchor === undefined ? d.bodyAttachments : d.notes.find((n) => n.heading === anchor)?.attachments ?? []
}

/**
 * Where `anchor`'s own span ends, for `upsertSectionScoped`: the next
 * note's heading (notes are already in file order), or `undefined` for
 * "whatever comes after is this section's own" (the last note, or the body
 * when there are no notes at all).
 */
export function sectionStopBefore(d: Decision, anchor: string | undefined): string | undefined {
  if (anchor === undefined) return d.notes[0]?.heading
  const idx = d.notes.findIndex((n) => n.heading === anchor)
  return idx === -1 ? undefined : d.notes[idx + 1]?.heading
}

/**
 * Copies/links `sources` beside the entry (or just records a URL/link) and
 * returns the updated attachments for ONE section plus the node's approvals
 * (global, keyed by target — not scoped to a section). Writes nothing; the
 * caller places the result into the body.
 */
function resolveAttachments(
  d: Decision,
  layout: Layout,
  sources: string[],
  opts: Pick<AttachOpts, 'link' | 'name' | 'replace' | 'groups' | 'captions' | 'approvalContent' | 'approveOn'>,
  baseAttachments: Attachment[],
): { attachments: Attachment[]; approvals: AttachmentApproval[] } {
  const attachments = [...baseAttachments]
  const approvals = [...d.approvals]
  // Settled before copying anything, so a refusal leaves no partial state.
  if (opts.approveOn) checkApproveOn(d, opts.approveOn)
  const fallbackApproveOn = opts.approveOn ?? defaultApproveOn(d)
  if (opts.approvalContent && !fallbackApproveOn) {
    const known = (src: string) => approvals.find((ap) => basename(ap.target) === basename(src))?.approveOn?.length
    if (!sources.every(known))
      throw new Error(
        t('core.store.approveOnAmbiguous', {
          ref: refOf(d),
          what: d.questions?.length ? t('core.store.subQuestionsWord') : t('core.store.optionsCountWord', { count: d.options.length }),
          example: d.questions?.length ? `${d.questions[0].key}:${d.questions[0].options[0]?.key ?? '1'}` : d.options[0]?.key ?? '1',
        }),
      )
  }

  const upsert = (target: string, image: boolean, defaultLabel: string, group?: string, caption?: string) => {
    const i = attachments.findIndex((x) => x.target === target)
    const prev = i >= 0 ? attachments[i] : undefined
    const entry: Attachment = {
      label: opts.name ?? prev?.label ?? defaultLabel,
      target,
      image,
      group: group ?? prev?.group,
      caption: caption ?? prev?.caption,
    }
    if (i >= 0) attachments[i] = entry
    else attachments.push(entry)
  }
  const recordApproval = (target: string, hash: string) => {
    const i = approvals.findIndex((x) => x.target === target)
    const approveOn = opts.approveOn ?? (i >= 0 ? approvals[i].approveOn : undefined) ?? fallbackApproveOn!
    if (i >= 0) approvals[i] = { ...approvals[i], hash, approveOn }
    else approvals.push({ target, hash, approveOn })
  }

  sources.forEach((src, i) => {
    const group = opts.groups?.[i]
    const caption = opts.captions?.[i]

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
      upsert(src, isImagePath(src), src, group, caption)
      return
    }

    const abs = resolve(src)
    if (opts.link) {
      upsert(abs, isImagePath(abs), basename(abs), group, caption)
      if (opts.approvalContent) recordApproval(abs, sha256File(abs))
      return
    }

    const destDir = attachmentDir(layout, d.id)
    mkdirSync(destDir, { recursive: true })
    const destName = basename(abs)
    let dest = join(destDir, destName)

    if (opts.replace && existsSync(dest)) {
      // Old bytes move to .history/ rather than disappearing.
      const histDir = join(destDir, '.history')
      mkdirSync(histDir, { recursive: true })
      const n = Math.max(0, ...historyVersions(histDir, destName)) + 1
      renameSync(dest, join(histDir, `${destName}.${n}`))
    } else if (!opts.replace) {
      dest = uniquePath(dest)
    }
    copyFileSync(abs, dest)

    const target = toPosixPath(relative(dirname(d.file), dest))
    upsert(target, isImagePath(dest), basename(dest), group, caption)
    if (opts.approvalContent) recordApproval(target, sha256File(dest))
  })

  return { attachments, approvals }
}

/** Checked before taking the lock, so a typo fails without touching anything. */
function checkAttachSources(sources: string[], approvalContent: boolean | undefined): void {
  for (const src of sources) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
      if (approvalContent) throw new Error(t('core.store.approvalContentNoUrl'))
    } else if (!existsSync(resolve(src))) throw new Error(t('core.store.noSuchFile', { path: src }))
  }
}

/** Local time with an explicit offset; `ms` adds milliseconds, for ordering same-second answers. */
export function nowStamp(d = new Date(), opts: { ms?: boolean } = {}): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const millis = opts.ms ? `.${String(d.getMilliseconds()).padStart(3, '0')}` : ''
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${millis}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  )
}

/** Reads and writes decision files, across one or more projects. */
export class Store {
  readonly layouts: Layout[]

  constructor(layouts: Layout[] | Layout) {
    this.layouts = Array.isArray(layouts) ? layouts : [layouts]
    if (!this.layouts.length) throw new Error('Store needs at least one project')
  }

  /** Where `decs send` writes. */
  get primary(): Layout {
    return this.layouts[0]
  }

  /** The stable key: the folder name. Shown to people as `displayName`. */
  projectName(l: Layout): string {
    return basename(l.projectRoot)
  }

  displayName(l: Layout): string {
    return projectDisplayName(l)
  }

  /** The key for whatever the user called a project: its folder name or its display name. */
  projectKey(name: string | undefined): string | undefined {
    if (!name) return name
    const l =
      this.layouts.find((x) => this.projectName(x) === name) ??
      this.layouts.find((x) => this.displayName(x) === name) ??
      this.layouts.find((x) => this.displayName(x).toLowerCase() === name.toLowerCase())
    return l ? this.projectName(l) : name
  }

  /** Cached by path while mtime/size/queue-membership match; `mutate()` re-reads on write so this never feeds one. */
  private parsed = new Map<string, { mtimeMs: number; size: number; queued: boolean; archived: boolean; d: Decision }>()
  /** The last `all()` result, handed back as the same array while nothing on disk changed. */
  private lastAll: { out: Decision[]; misses: number; paths: string } | null = null

  /**
   * Off by default: every `all()`/`queue()` walks disk fresh, exactly as
   * before (a one-shot CLI command's Store, or a test's, never calls
   * `rescan()` — so this never changes what either sees). A monitor pass
   * calling `rescan()` once up front turns it on for that pass: every
   * `listEntryFiles` call inside shares the one walk instead of re-walking
   * per `store.all()` call (N255: readdir+stat was most of its CPU). The
   * *next* `rescan()` (the next pass) starts over, so another process's
   * write between passes is never missed; our own writes clear the layout
   * they touched (`invalidateScan`) so a later read *in the same pass*
   * still sees what was just written.
   */
  private scanCache: Map<Layout, EntryFile[]> | null = null

  private scanned(l: Layout): EntryFile[] {
    if (!this.scanCache) return listEntryFiles(l)
    let files = this.scanCache.get(l)
    if (!files) {
      files = listEntryFiles(l)
      this.scanCache.set(l, files)
    }
    return files
  }

  private invalidateScan(l: Layout): void {
    this.scanCache?.delete(l)
  }

  /** Opens (or reopens) a scan window: every `all()`/`queue()` call shares
   *  one directory walk per layout until the next `rescan()`. Call once per
   *  monitor pass; nothing else needs it. */
  rescan(): void {
    this.scanCache = new Map()
  }

  all(): Decision[] {
    return this.withCheckins(this.allCore())
  }

  /**
   * `core/checkins.ts`'s ask count can change independent of any node file
   * (a span elapsing, or the monitor recording an ask), so it's re-read on
   * every `all()` regardless of `allCore()`'s own cache — but cheaply:
   * when nobody anywhere has ever been asked (the common case), this is
   * one tiny file read per layout and the very same array/objects back.
   */
  private withCheckins(items: Decision[]): Decision[] {
    let patched: Decision[] | undefined
    const perLayout = new Map<string, Record<string, { asked: number; lastAskedAt: string }>>()
    items.forEach((d, i) => {
      const layout = this.layoutOf(d)
      let map = perLayout.get(layout.root)
      if (map === undefined) {
        map = checkinsFileExists(layout) ? readCheckinsMap(layout) : {}
        perLayout.set(layout.root, map)
      }
      const entry = map[String(d.id)]
      if (!entry) return
      patched ??= [...items]
      patched[i] = { ...d, checkin: { ...entry, unanswered: entry.asked >= UNANSWERED_AFTER } }
    })
    return patched ?? items
  }

  private allCore(): Decision[] {
    const out: Decision[] = []
    const seen = new Set<string>()
    let misses = 0
    for (const l of this.layouts) {
      const queued = new Set(readQueue(l))
      for (const f of this.scanned(l)) {
        seen.add(f.path)
        try {
          const q = queued.has(f.id)
          const hit = this.parsed.get(f.path)
          let d: Decision
          if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size && hit.queued === q && hit.archived === f.archived) {
            d = hit.d
          } else {
            const loaded = this.load(f.path, f.archived, l, q)
            d = q ? onQueue(loaded) : loaded
            misses++
            if (f.mtimeMs !== undefined && f.size !== undefined)
              this.parsed.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, queued: q, archived: f.archived, d })
          }
          out.push(d)
        } catch (e) {
          process.emitWarning(`skipping ${f.path}: ${(e as Error).message}`)
        }
      }
    }
    for (const p of this.parsed.keys()) if (!seen.has(p)) this.parsed.delete(p)
    // Unchanged: return the same array by identity so callers can skip recomputing.
    const paths = out.map((d) => d.file).join('\n')
    if (!misses && this.lastAll && this.lastAll.paths === paths) return this.lastAll.out

    const kids = new Map<string, number[]>()
    for (const d of out) {
      if (d.parent === undefined) continue
      const k = `${d.project}#${d.parent}`
      kids.set(k, [...(kids.get(k) ?? []), d.id])
    }
    // Newest write in the subtree, so a parent isn't shown stalled while children move.
    const byKey = new Map(out.map((d) => [`${d.project}#${d.id}`, d]))
    const active = new Map<string, string>()
    const activeOf = (d: Decision, depth = 0): string => {
      const k = `${d.project}#${d.id}`
      const hit = active.get(k)
      if (hit !== undefined) return hit
      let best = d.updatedAt || d.created || ''
      if (depth < 50) {
        for (const id of kids.get(k) ?? []) {
          const c = byKey.get(`${d.project}#${id}`)
          if (!c) continue
          const t = activeOf(c, depth + 1)
          if (Date.parse(t) > Date.parse(best || '0')) best = t
        }
      }
      active.set(k, best)
      return best
    }
    const result = out.map((d) => ({ ...d, children: kids.get(`${d.project}#${d.id}`) ?? [], activeAt: activeOf(d) }))
    this.lastAll = { out: result, misses, paths }
    return result
  }

  list(filter: ListFilter = {}): Decision[] {
    const { status = 'open', states } = filter
    const archived = filter.archived ?? (status === 'open' && !states ? false : 'all')
    const keep = (d: Decision) =>
      states
        ? states.includes(d.state)
        : status === 'all'
          ? true
          : status === 'open'
            ? d.state === 'needs_decision'
            : d.status === 'answered'
    return this.all()
      .filter(keep)
      .filter((d) => (archived === 'all' ? true : d.archived === archived))
      .filter((d) => (filter.author ? ownedBy(d, filter.author) : true))
      .filter((d) => (filter.project ? d.project === this.projectKey(filter.project) : true))
      .sort(benchOrder)
  }

  /** Nodes in the given statuses, active and archived alike, in bench order. */
  byStatus(states: ItemStatus[], filter: Omit<ListFilter, 'states' | 'status'> = {}): Decision[] {
    return this.list({ archived: 'all', ...filter, states })
  }

  get(id: number, project?: string): Decision | null {
    const key = this.projectKey(project)
    const hits = this.all().filter((d) => d.id === id && (!key || d.project === key))
    if (hits.length > 1) {
      const where = hits.map((h) => refOf(h)).join(', ')
      throw new Error(t('core.store.idInMultipleProjects', { id, where, example: refOf(hits[0]) }))
    }
    return hits[0] ?? null
  }

  /** Reserves the next free id atomically, then writes the entry. */
  create(input: NewDecision, layout = this.primary): Decision {
    if (!input.author?.trim()) throw new Error(t('core.store.authorRequired'))
    if (!input.title?.trim()) throw new Error(t('core.store.titleRequired'))

    // A question needs ≥1 option; 验收 gets the 验收通过 option; a task/fyi has none.
    const questions = input.questions ?? []
    if (questions.length) {
      checkQuestions(questions)
      if (input.options?.length) throw new Error(t('core.store.questionsAndOptionsMixed'))
      if (input.task || input.kind === 'fyi') throw new Error(t('core.store.taskOrFyiNoQuestions'))
    }
    const given = questions.length
      ? questionOptions(questions)
      : (input.options ?? []).map((o) => ({ key: o.key, label: o.label, body: o.body ?? '' }))
    if (questions.length) input = { ...input, default: '1' }
    const bare = input.task || input.kind === 'fyi'
    if (bare && given.length) throw new Error(input.task ? t('core.store.taskNoOptions') : t('core.store.fyiNoOptions'))
    // No -o: options already laid out in the body under ## 选项 count too.
    const inBody = !given.length && !bare && !questions.length ? parseOptions((input.body ?? '').trim()) : []
    if (inBody.length && input.default === undefined) input = { ...input, default: bodyDefault(inBody) }
    const options = given.length || bare ? given : inBody.length ? inBody : [{ ...ACCEPTANCE_OPTION, body: '' }]
    checkOptionKeys(options, input.default)
    const slug = slugify(input.title)
    // An fyi needs nobody's input, so it's filed as done immediately.
    const state: ItemStatus = input.kind === 'fyi' ? 'completed' : input.task ? 'not_started' : 'needs_decision'
    // Child nodes live in their parent's folder, created on demand.
    const parent = input.parent ? this.resolve(input.parent) : undefined
    if (parent && this.layoutOf(parent) !== layout) throw new Error(t('core.store.parentInAnotherProject', { ref: refOf(parent) }))
    if (parent?.archived) throw new Error(t('core.store.parentTreeArchived', { ref: refOf(parent), id: parent.id }))
    if (parent && input.kind === 'fyi') throw new Error(t('core.store.fyiIsRoot'))
    const dir = parent ? childDirOf(parent.file) : isTerminal(state) ? layout.archivedDir : layout.activeDir

    let body = (input.body ?? '').trim()
    const created = nowStamp()
    if (input.intake) {
      if (!bare || !input.task) throw new Error(t('core.store.briefIsTask'))
      // The owner's words are the record; the description an agent writes goes above them.
      body = `## ${noteHeading(NOTE_KIND.original, roleOf(input.author.trim()), input.author.trim(), created)}\n\n${body || input.title.trim()}`
    }
    if (questions.length) {
      // Must read back exactly as written, like the options block below.
      if (parseQuestions(body).length) throw new Error(t('core.store.bodyHasQuestionsSection'))
      body = body ? `${body}\n\n${renderQuestionsBlock(questions)}` : renderQuestionsBlock(questions)
      const back = parseQuestions(body)
      const same = (a: DecisionQuestion[], b: DecisionQuestion[]) =>
        a.length === b.length && a.every((q, i) => q.key === b[i].key && q.label === b[i].label && q.options.map((o) => `${o.key}${o.label}`).join() === b[i].options.map((o) => `${o.key}${o.label}`).join())
      if (!same(back, questions)) throw new Error(t('core.store.questionsBlockMismatch'))
    }
    const optionsBlock = renderOptionsBlock(options)
    if (optionsBlock) {
      // Use parseOptions itself (not a separate regex) to check for an existing block.
      const already = parseOptions(body)
      const matches =
        already.length === options.length && already.every((o, i) => o.key === options[i].key && o.label === options[i].label)
      if (!matches) {
        if (already.length) {
          throw new Error(t('core.store.bodyOptionsMismatch', { diff: optionDiff(already, options) }))
        }
        body = body ? `${body}\n\n${optionsBlock}` : optionsBlock
      }
    }

    // Take the id only after validation, so a failed create doesn't burn a number.
    const id = this.reserveId(layout)
    const file = join(dir, entryFileName(id, slug))
    const d: Decision = {
      id,
      title: input.title.trim(),
      author: input.author.trim(),
      state,
      status: 'open',
      created,
      after: input.after?.length ? input.after : undefined,
      est: input.est,
      every: input.every,
      when: input.when,
      staleAfter: input.staleAfter,
      archivedAt: isTerminal(state) ? created : undefined,
      default: input.default,
      kind: input.kind ?? (options.length ? 'decision' : 'task'),
      urgency: input.urgency && input.urgency !== 'normal' ? input.urgency : undefined,
      due: input.due,
      remindAt: input.remindAt,
      ifNoAnswer: input.ifNoAnswer?.trim() || undefined,
      reversible: input.reversible,
      session: input.session,
      intake: input.intake || undefined,
      assignee: input.assignee || undefined,
      milestone: input.milestone || undefined,
      tags: input.tags ?? [],
      body: body + '\n',
      options,
      questions,
      attachments: [],
      bodyAttachments: [],
      notes: [],
      approvals: [],
      file,
      slug,
      archived: isTerminal(state),
      project: this.projectName(layout),
      updatedAt: created,
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      createFileAtomic(file, serializeDecision(d))
      this.invalidateScan(layout)
    } catch (e) {
      // The write itself failed: give the number back, same reason as above.
      rmSync(join(layout.idsDir, String(id)), { force: true })
      throw e
    }
    return this.reread(d)
  }

  /** Records the owner's answer; does not archive (that happens on delivery). `choice` must match an existing option. */
  answer(
    d: Decision,
    a: {
      choice?: string
      note?: string
      by?: string
      role?: NoteRole
      /** Sub-question answers; missing ones fall back to their defaults. */
      answers?: Record<string, string>
      answerNotes?: Record<string, string>
    },
  ): Decision {
    if (!a.choice && !a.note?.trim() && !a.answers) throw new Error(t('core.store.answerNeedsChoiceOrNote'))
    const written = this.mutate(d, (d) => {
      let choice = a.choice
      let answers: Record<string, string> | undefined
      let answerNotes: Record<string, string> | undefined
      const qs = d.questions ?? []
      if (qs.length) {
        // Normalizes "1 / 2 / Q1=B / Q1=*:text" into per-question answers from any input source.
        const fromNote = a.answers ? { answers: {}, notes: {} } : parseAnswerTokens(a.note ?? '', qs)
        const given: Record<string, string> = choice === '1' ? {} : { ...fromNote.answers, ...a.answers }
        const notes = { ...fromNote.notes, ...a.answerNotes }
        for (const [k, v] of Object.entries(given)) {
          const q = qs.find((x) => x.key === k)
          if (!q) throw new Error(t('core.store.noSubQuestion', { ref: refOf(d), key: k, keys: qs.map((x) => x.key).join(' ') }))
          if (v === OTHER_KEY) {
            if (!notes[k]?.trim()) throw new Error(t('core.store.subQuestionOtherNeedsText', { key: k }))
            continue
          }
          if (!q.options.some((o) => o.key === v)) throw new Error(t('core.store.subQuestionNoOption', { key: k, value: v, keys: q.options.map((o) => o.key).join(' ') }))
        }
        answers = Object.fromEntries(qs.map((q) => [q.key, given[q.key] ?? q.default!]))
        answerNotes = Object.keys(notes).length ? notes : undefined
        choice = qs.every((q) => answers![q.key] === q.default) && !answerNotes ? '1' : '2'
      }
      if (choice && d.options.length && !d.options.some((o) => o.key === choice)) {
        const keys = d.options.map((o) => o.key).join(' ')
        throw new Error(t('core.store.noOption', { ref: refOf(d), choice, keys }))
      }
      const at = nowStamp(new Date(), { ms: true })
      const by = a.by ?? 'owner'
      const role = a.role ?? roleOf(by)
      const chosen = d.options.find((o) => o.key === choice)
      const headline = choice ? `${choice}${chosen?.label ? ` —— ${chosen.label}` : ''}` : ''
      const perQuestion = answers ? renderAnswerLines(qs, answers, answerNotes) : ''
      const text = [headline, perQuestion, a.note?.trim()].filter(Boolean).join('\n\n')

      const next: Decision = {
        ...d,
        state: 'decided',
        answer: { choice, ...(answers ? { answers } : {}), ...(answerNotes ? { answerNotes } : {}), note: a.note?.trim(), by, at },
        approvals: role === 'human' ? approveAttachments(d, { choice, answers }, by, at) : d.approvals,
        body: appendSection(d.body, noteHeading(NOTE_KIND.answered, role, by, at), text),
        reopenedAt: d.archived ? at : d.reopenedAt,
      }
      // Re-answering reopens it into active/ and re-queues it.
      return { next, move: d.archived ? 'unarchive' : undefined }
    })
    enqueue(this.layoutOf(written), written.id)
    return { ...written, queued: true }
  }

  /**
   * Copies files in beside the entry (or records a link) and updates the
   * `## 附件` block of whichever section they're attached to — the body, or
   * one note's own appended section (`opts.to`). `opts.groups`/`opts.captions`
   * line up with `sources` by position. `--replace` overwrites the
   * same-named attachment in place (old bytes move to
   * `attachments/<id>/.history/`) instead of creating `name-2.ext`.
   */
  attach(d: Decision, sources: string[], opts: AttachOpts = {}): Decision {
    if (opts.approveOn && !opts.approvalContent) throw new Error(t('core.store.approveOnNeedsApprovalContent'))
    checkAttachSources(sources, opts.approvalContent)
    const layout = this.layoutOf(d)

    return this.mutate(d, (d) => {
      const found = resolveAttachAnchor(d, opts.to, opts.by)
      let base = d.body
      let at: { anchor: string | undefined; nth: number; stop: string | undefined }
      let own: Attachment[]
      if (found === NEW_SECTION) {
        // A short section by the attaching author, written now, so the files sit with this round.
        const anchor = noteHeading(NOTE_KIND.addendum, roleOf(opts.by!), opts.by!, nowStamp())
        base = appendSection(d.body, anchor, NOTE_TEXT.attachedHere)
        at = { anchor, nth: d.notes.filter((n) => n.heading === anchor).length, stop: undefined }
        own = []
      } else {
        at = sectionAt(d, found)
        own = found === undefined ? d.bodyAttachments : (d.notes[found].attachments ?? [])
      }
      const { attachments, approvals } = resolveAttachments(d, layout, sources, opts, own)
      const body = upsertSectionScoped(base, at.anchor, at.stop, HEADING.attachments, renderAttachmentsBlock(attachments), at.nth)
      return { next: { ...d, approvals, body } }
    })
  }

  /**
   * Moves one attachment (matched by file name) to another section — `to` as `attach --to`
   * takes it. The file and its approval stay as they are; only where it is listed changes.
   */
  moveAttachment(d: Decision, name: string, to: string): Decision {
    return this.mutate(d, (d) => {
      const want = basename(name)
      const sections: { idx: number | undefined; list: Attachment[] }[] = [{ idx: undefined, list: d.bodyAttachments }, ...d.notes.map((n, i) => ({ idx: i as number | undefined, list: n.attachments ?? [] }))]
      const from = sections.find((x) => x.list.some((a) => basename(a.target) === want || a.label === want))
      if (!from) throw new Error(t('core.store.attachmentNotFound', { name, ref: refOf(d) }))
      const item = from.list.find((a) => basename(a.target) === want || a.label === want)!
      const target = resolveAttachAnchor(d, to, undefined)
      if (target === NEW_SECTION || target === from.idx) return { next: d }
      const a = sectionAt(d, from.idx)
      let body = upsertSectionScoped(d.body, a.anchor, a.stop, HEADING.attachments, renderAttachmentsBlock(from.list.filter((x) => x !== item)), a.nth)
      const reread = parseBodyFor(d, body)
      const b = sectionAt(reread, target)
      const there = target === undefined ? reread.bodyAttachments : (reread.notes[target].attachments ?? [])
      body = upsertSectionScoped(body, b.anchor, b.stop, HEADING.attachments, renderAttachmentsBlock([...there, item]), b.nth)
      return { next: { ...d, body } }
    })
  }

  /**
   * How many older versions `decs attach --replace` kept for this attachment
   * (files in its `.history/`); 0 for a `--link`ed file or URL. Matches both
   * the `305/` and legacy `D305/` attachment-folder spelling.
   */
  historyCount(d: Decision, a: Attachment): number {
    if (a.target.includes('://')) return 0
    const layout = this.layoutOf(d)
    const abs = resolve(dirname(d.file), a.target)
    const dir = dirname(abs)
    if (dirname(dir) !== join(layout.root, 'attachments') || !new RegExp(`^D?${d.id}$`).test(basename(dir))) return 0
    return historyVersions(join(dir, '.history'), basename(abs)).length
  }

  /** Matches an attachment by filename — the path handed in need not equal the stored `target` exactly. */
  findApproval(d: Decision, fileOrName: string): AttachmentApproval | undefined {
    const name = basename(fileOrName)
    return d.approvals.find((ap) => basename(ap.target) === name)
  }

  /**
   * A follow-up/execution note with an auto-generated heading; `append`
   * takes a pre-written one. `n.attach.sources` copies files in (same rules
   * as `attach()`) and writes them into this same new section — the note
   * and its attachments land together, so the association never needs a
   * separate `--to`.
   */
  note(
    d: Decision,
    n: { text: string; role: NoteRole; author: string; kind?: string; summary?: string; attach?: AttachOpts & { sources: string[] } },
  ): Decision {
    if (n.role === 'human' && this.recentSameHumanNote(d, n.text)) return d
    // N203/N205: `summary`, if given, is already checked by the caller (`nod note`'s
    // CLI command) before it gets here — this is a shared primitive other writers use
    // too (`nod run`'s own failure note is routinely over the budget and has no
    // `--summary` of its own), so it never rejects a write on this account itself.
    const summary = n.summary
    const kind = n.kind ?? (n.role === 'human' ? NOTE_KIND.reply : NOTE_KIND.addendum)
    const heading = noteHeading(kind, n.role, n.author, nowStamp())
    if (!n.attach?.sources.length) return this.append(d, heading, n.text, n.author, n.role, summary)

    const { sources, ...opts } = n.attach
    if (opts.approveOn && !opts.approvalContent) throw new Error(t('core.store.approveOnNeedsApprovalContent'))
    checkAttachSources(sources, opts.approvalContent)
    const layout = this.layoutOf(d)
    const human = n.role === 'human'

    const written = this.mutate(d, (d) => {
      const { attachments, approvals } = resolveAttachments(d, layout, sources, opts, [])
      const block = renderAttachmentsBlock(attachments)
      return {
        next: {
          ...d,
          approvals,
          body: appendSection(d.body, heading, block ? `${n.text.trim()}\n\n${block}` : n.text, summary),
          state: human ? 'decided' : d.state,
          reopenedAt: human && d.archived ? nowStamp(new Date(), { ms: true }) : d.reopenedAt,
        },
        move: human && d.archived ? 'unarchive' : undefined,
      }
    })
    if (!human) return written
    enqueue(this.layoutOf(written), written.id)
    return { ...written, queued: true }
  }

  /**
   * The owner's words often arrive twice: typed in the bench or app, then
   * relayed by an agent that saw them come through its monitor. The same
   * text from the owner within ten minutes is the same message.
   */
  recentSameHumanNote(d: Decision, text: string, withinMs = 10 * 60_000, now = Date.now()): DecisionNote | undefined {
    const want = text.trim()
    return d.notes.find((x) => x.role === 'human' && x.text.trim() === want && now - Date.parse(x.at) <= withinMs)
  }

  /**
   * Appends a section under a caller-written heading. A human reply flips
   * the node to 待 AI 取走 (even from 待决策) and un-archives it; an agent's
   * own note does neither. `role` falls back to what the heading says, then to `by`.
   */
  append(d: Decision, heading: string, text: string, by = 'owner', role?: NoteRole, summary?: string): Decision {
    const human = (role ?? parseNoteHeading(`## ${heading}`)?.role ?? roleOf(by)) === 'human'
    const written = this.mutate(d, (d) => ({
      next: {
        ...d,
        body: appendSection(d.body, heading, text, summary),
        // A human reply means it's the AI's turn; `decs ask` is how the AI asks again.
        state: human ? 'decided' : d.state,
        reopenedAt: human && d.archived ? nowStamp(new Date(), { ms: true }) : d.reopenedAt,
      },
      move: human && d.archived ? 'unarchive' : undefined,
    }))
    if (!human) return written
    enqueue(this.layoutOf(written), written.id)
    return { ...written, queued: true }
  }

  /** What the owner has answered that no agent has collected yet, oldest first. */
  queue(filter: { author?: string; project?: string } = {}): Decision[] {
    const out: Decision[] = []
    for (const l of this.layouts) {
      const project = this.projectName(l)
      if (filter.project && project !== this.projectKey(filter.project)) continue
      // Only the queued entries are read; the array order is the FIFO order.
      const byId = new Map(this.scanned(l).map((f) => [f.id, f]))
      for (const id of readQueue(l)) {
        const f = byId.get(id)
        if (!f) continue
        try {
          const d = this.load(f.path, f.archived, l)
          if (filter.author && !ownedBy(d, filter.author)) continue
          out.push(onQueue(d))
        } catch {
          /* decs check reports unparseable entries */
        }
      }
    }
    return out
  }

  /**
   * Everything after `since`: answers, follow-ups, notes, archive moves.
   * Derived from the files themselves (headings + front matter) — there's
   * no event log, so a stale minute may duplicate rather than gap.
   */
  changes(since: string, filter: { author?: string; project?: string; role?: NoteRole } = {}): ChangeEvent[] {
    const cut = Date.parse(since)
    if (Number.isNaN(cut)) throw new Error(t('core.store.notATime', { since }))
    const out: ChangeEvent[] = []
    const after = (at: string | undefined, precisionMs = 1) => {
      const t = at ? Date.parse(at) : NaN
      return !Number.isNaN(t) && t + precisionMs > cut
    }
    for (const d of this.all()) {
      if (filter.project && d.project !== this.projectKey(filter.project)) continue
      if (filter.author && !ownedBy(d, filter.author)) continue
      const base = { id: d.id, ref: refOf(d), project: d.project, title: d.title, entry_author: d.author, file: d.file }
      if (after(d.created)) out.push({ ...base, at: d.created, event: 'created', role: 'agent', by: d.author })
      // The first agent note after a human post is the reply to it — an
      // owner-facing event the desktop app notifies on (see `cli/commands/
      // monitor.ts`'s `reportUpdates`). Later agent notes before the next
      // human post are just further work, not a fresh reply.
      const ownerFacing = ownerFacingFlags(d)
      d.notes.forEach((n, i) => {
        const precision = parseNoteHeading(`## ${n.heading}`)?.precisionMs ?? 60_000
        if (!after(n.at, precision)) return
        const isAnswer = isAnswerKind(n.kind)
        // Only the newest 已答 is the one front matter describes.
        const latest = isAnswer && !d.notes.slice(i + 1).some((m) => isAnswerKind(m.kind))
        out.push({
          ...base,
          at: latest && d.answer?.at ? d.answer.at : n.at,
          event: isAnswer ? 'answered' : 'note',
          role: n.role,
          by: n.author,
          kind: n.kind,
          text: n.text,
          ...(n.writer ? { writer: n.writer } : {}),
          ...(ownerFacing[i] ? { ownerFacing: true } : {}),
          ...(latest && d.answer ? { choice: d.answer.choice ?? null } : {}),
        })
      })
      if (after(d.archivedAt))
        out.push({ ...base, at: d.archivedAt!, event: d.state === 'closed' ? 'closed' : 'completed', role: 'agent', by: '', ...(d.closeReason ? { text: d.closeReason } : {}) })
      if (after(d.reopenedAt)) out.push({ ...base, at: d.reopenedAt!, event: 'reopened', role: 'human', by: '' })
    }
    // Headings are second-precision, answers millisecond — compare seconds,
    // then fall back to derivation order.
    const sec = (e: ChangeEvent) => Math.floor(Date.parse(e.at) / 1000)
    return out
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => (filter.role ? e.role === filter.role : true))
      .sort((a, b) => sec(a.e) - sec(b.e) || (a.e.id === b.e.id ? a.i - b.i : a.e.id - b.e.id))
      .map(({ e }) => e)
  }

  /** Just the numbers — what `decs wait` polls, at one small read per project. */
  queuedIds(): { layout: Layout; ids: number[] }[] {
    return this.layouts.map((layout) => ({ layout, ids: readQueue(layout) }))
  }

  /** Takes one off the queue (an agent has now seen it); does not archive. */
  deliver(d: Decision): Decision {
    dequeue(this.layoutOf(d), d.id)
    // Unless `after` something still running — then it stays decided until that finishes (see `complete`).
    const deps = d.after?.length ? this.all() : []
    // A queued-but-still-待决策 node predates the turn rule; collecting it is the AI's turn too.
    const wasQueued = d.queued
    const next = (d: Decision): Decision => {
      if (d.state !== 'decided' && !(wasQueued && d.state === 'needs_decision')) return d
      // A reply withdraws the round (the AI re-asks after acting on it); anything else
      // the owner wrote leaves the options open, so it is their turn again.
      if (awaitsDecision(d)) return { ...d, state: 'needs_decision' }
      return { ...d, state: isStartable(d, deps) ? 'in_progress' : 'not_started' }
    }
    return { ...this.mutate(d, (d) => ({ next: next(d) })), queued: undefined }
  }

  /** A lane picks the node up. Refused while the owner still owes it an answer. */
  start(d: Decision, opts: { force?: boolean } = {}): Decision {
    // Unanswered options keep it 待决策 whatever --force says.
    if (awaitsDecision(d)) throw new Error(t('core.store.cantStartOpenOptions', { ref: refOf(d) }))
    if (d.state === 'needs_decision' && !opts.force)
      throw new Error(t('core.store.cantStartNeedsDecision', { ref: refOf(d) }))
    if (!opts.force && d.after?.length && !isStartable(d, this.all()))
      throw new Error(t('core.store.cantStartAfter', { ref: refOf(d), after: d.after.join(' ') }))
    return this.mutate(d, (d) => ({ next: { ...d, state: 'in_progress', waitingOn: undefined }, move: d.archived ? 'unarchive' : undefined }))
  }

  /**
   * 接活: records `by` as the one expanding this brief, under the node's lock,
   * so two sessions can't both take it. Taking it again yourself is a no-op;
   * anyone else is refused with who has it (`ClaimedError`).
   */
  claim(d: Decision, by: string, opts: { force?: boolean } = {}): { node: Decision; already: boolean } {
    let already = false
    const node = this.mutate(d, (d) => {
      if (isTerminal(d.state)) throw new Error(t('core.store.claimFinished', { ref: refOf(d), state: statusLabel(d.state) }))
      if (isHumanTask(d) && !opts.force) throw new Error(t('core.store.humanTaskNoClaim', { ref: refOf(d) }))
      if (d.claimedBy && (sameAgent(d.claimedBy, by) || sameAgent(by, d.claimedBy))) {
        already = true
        return { next: d }
      }
      if (d.claimedBy && !opts.force) throw new ClaimedError(d)
      const at = nowStamp(new Date(), { ms: true })
      return {
        next: {
          ...d,
          claimedBy: by,
          claimedAt: at,
          ownerAgent: by,
          state: d.state === 'not_started' ? 'in_progress' : d.state,
          body: appendSection(d.body, noteHeading(NOTE_KIND.claimed, 'agent', by, at), NOTE_TEXT.claimed),
        },
      }
    })
    return { node, already }
  }

  /** Rewrites the description above `## 原话`; the owner's words and every note below stay as they are. */
  expand(d: Decision, e: { description: string; title?: string }): Decision {
    return this.mutate(d, (d) => {
      const original = noteHeading(NOTE_KIND.original, roleOf(d.author), d.author, d.created || nowStamp())
      return { next: { ...d, title: e.title?.trim() || d.title, body: withDescription(d.body, e.description, original) } }
    })
  }

  /**
   * 等待: held up on something outside — not the owner (待决策), not another node (`after`).
   * `until` (an ISO stamp) is the day to check back; on a node already waiting, `on` may be
   * left out to move only that day. `start` resumes it.
   */
  hold(d: Decision, on: string | undefined, author: string, opts: { until?: string; role?: NoteRole } = {}): Decision {
    const who = on?.trim() || (d.state === 'waiting' ? d.waitingOn : undefined)
    if (!who) throw new Error(t('core.store.holdNeedsOn'))
    if (on?.trim() && stringWidth(on.trim()) > WAIT_ON_MAX_COLS) throw new Error(t('core.store.waitOnTooLong', { cols: stringWidth(on.trim()), max: WAIT_ON_MAX_COLS, id: String(d.id) }))
    if (d.state === 'needs_decision') throw new Error(t('core.store.holdNotForOwner', { ref: refOf(d) }))
    const day = opts.until ? (untilDay(opts.until) ?? opts.until) : undefined
    const onlyDate = !on?.trim() && d.state === 'waiting'
    const text = onlyDate && day ? NOTE_TEXT.waitingMoved(day) : day ? NOTE_TEXT.waitingOnUntil(who, day) : NOTE_TEXT.waitingOn(who)
    return this.mutate(d, (d) => ({
      next: {
        ...d,
        state: 'waiting',
        waitingOn: who,
        waitingUntil: opts.until ?? (d.state === 'waiting' ? d.waitingUntil : undefined),
        // One 延迟 at a time: waiting on someone replaces a plain deferral.
        deferredAt: undefined,
        deferredBy: undefined,
        deferredUntil: undefined,
        body: appendSection(d.body, noteHeading(NOTE_KIND.waiting, opts.role ?? 'agent', author, nowStamp()), text),
      },
      move: d.archived ? 'unarchive' : undefined,
    }))
  }

  /** Waiting → back to 待开始: the wait was never on anyone outside. */
  unhold(d: Decision, author: string, opts: { role?: NoteRole } = {}): Decision {
    if (d.state !== 'waiting') throw new Error(t('core.store.unholdNotWaiting', { ref: refOf(d) }))
    return this.mutate(d, (d) => ({
      next: {
        ...d,
        state: 'not_started',
        waitingOn: undefined,
        waitingUntil: undefined,
        body: appendSection(d.body, noteHeading(NOTE_KIND.addendum, opts.role ?? 'agent', author, nowStamp()), NOTE_TEXT.notWaiting()),
      },
    }))
  }

  /**
   * Waiting nodes whose check-back day has come get one note signed `nod` — "time to check
   * on …" — the first time anything looks after that day (the monitor turns it into a
   * message for the node's agent). Once per hold: a new hold or a moved day starts over.
   */
  remindDueWaits(now = Date.now()): Decision[] {
    const out: Decision[] = []
    for (const d of this.all()) {
      if (d.state !== 'waiting' || !d.waitingUntil || !isWaitDue(d, now) || this.waitReminded(d)) continue
      let done = false
      const next = this.mutate(d, (d) => {
        if (d.state !== 'waiting' || !isWaitDue(d, now) || this.waitReminded(d)) return { next: d }
        done = true
        return { next: { ...d, body: appendSection(d.body, noteHeading(NOTE_KIND.addendum, 'agent', DEFERRAL_CLOCK, nowStamp()), NOTE_TEXT.checkBack(d.waitingOn ?? '')) } }
      })
      if (done) out.push(next)
    }
    return out
  }

  /** A `nod` reminder came after the latest hold. */
  private waitReminded(d: Decision): boolean {
    const notes = d.notes
    const hold = notes.findLastIndex((n) => n.kind === NOTE_KIND.waiting)
    const reminded = notes.findLastIndex((n) => n.author === DEFERRAL_CLOCK && n.kind === NOTE_KIND.addendum)
    return reminded > hold
  }

  /**
   * 延迟, the one verb behind `nod defer` and `nod hold`: with `on` (or on a node already
   * waiting) it is an active wait — `hold`; with only a day it is a passive deferral — `defer`.
   */
  delay(d: Decision, opts: { by: string; role: NoteRole; until?: string; on?: string; ownerSaid?: string }): Decision {
    const on = opts.on?.trim() || undefined
    if (on || (d.state === 'waiting' && opts.until)) return this.hold(d, on, opts.by, { until: opts.until, role: opts.role })
    return this.defer(d, opts)
  }

  /** 「延迟 R 天」: delayed to the start of the day `every` (or the node's own R) after today — a wait keeps its who. */
  delayEvery(d: Decision, opts: { by: string; role: NoteRole; every?: string; ownerSaid?: string }): Decision {
    const every = opts.every ?? d.every
    if (!every) throw new Error(t('core.store.noEvery', { ref: refOf(d) }))
    return this.delay(d, { by: opts.by, role: opts.role, until: nowStamp(everyUntil(every)), ownerSaid: opts.ownerSaid })
  }

  /** Front-matter fields set after the fact (`nod edit --every / --due / --est / --remind`); null clears one. Not a request: nothing is queued. */
  setFields(d: Decision, f: { every?: string | null; due?: string | null; est?: string | null; remindAt?: string | null }): Decision {
    const pick = <K extends 'every' | 'due' | 'est' | 'remindAt'>(k: K): string | undefined => (f[k] === undefined ? d[k] : (f[k] ?? undefined))
    return this.mutate(d, (d) => ({ next: { ...d, every: pick('every'), due: pick('due'), est: pick('est'), remindAt: pick('remindAt'), milestone: pick('due') ? d.milestone : undefined } }))
  }

  /** Lifts any 延迟: a plain deferral comes back as it was; a wait goes back to 待开始. */
  undelay(d: Decision, opts: { by: string; role: NoteRole }): Decision {
    let next = d
    if (next.state === 'waiting') next = this.unhold(next, opts.by, { role: opts.role })
    if (next.deferredAt) next = this.undefer(next, opts)
    return next
  }

  /**
   * 延迟 with no one to wait on: state is unchanged, so `undefer` restores it exactly — except a
   * node that was waiting, which stops waiting (one 延迟 at a time) and goes back to 待开始.
   * `until` (an ISO stamp) brings it back on its own at that moment; deferring again changes or drops it.
   */
  defer(d: Decision, opts: { by: string; role: NoteRole; until?: string; ownerSaid?: string }): Decision {
    if (d.state === 'completed' || d.state === 'closed') throw new Error(t('core.store.alreadyFinishedNoDefer', { ref: refOf(d) }))
    if (isDeferred(d) && d.deferredUntil === opts.until && d.state !== 'waiting') return d
    return this.mutate(d, (d) => {
      const at = nowStamp(new Date(), { ms: true })
      const day = opts.until ? untilDay(opts.until) : undefined
      const wasWaiting = d.state === 'waiting'
      return {
        next: {
          ...d,
          ...(wasWaiting ? { state: 'not_started' as const, waitingOn: undefined, waitingUntil: undefined } : {}),
          deferredAt: at,
          deferredBy: opts.by,
          deferredUntil: opts.until,
          body: appendSection(
            d.body,
            noteHeading(NOTE_KIND.deferred, opts.role, opts.by, nowStamp()),
            [day ? NOTE_TEXT.deferredUntil(day) : NOTE_TEXT.deferred, opts.ownerSaid?.trim() ? NOTE_TEXT.ownerSaid(opts.ownerSaid.trim()) : ''].filter(Boolean).join('\n\n'),
          ),
        },
      }
    })
  }

  /** Lifts `defer`: the node is back in the lists, in the state it had. */
  undefer(d: Decision, opts: { by: string; role: NoteRole }): Decision {
    if (!d.deferredAt) return d
    return this.mutate(d, (d) => ({
      next: {
        ...d,
        deferredAt: undefined,
        deferredBy: undefined,
        deferredUntil: undefined,
        body: appendSection(d.body, noteHeading(NOTE_KIND.undeferred, opts.role, opts.by, nowStamp()), NOTE_TEXT.undeferred),
      },
    }))
  }

  /**
   * Nodes deferred `--until` a moment that has come: the flag is cleared (once — under each
   * node's lock, so two processes racing return it once) with a 「解除延迟」 note signed `nod`.
   * Returns the nodes this call brought back.
   */
  returnDueDeferrals(now = Date.now()): Decision[] {
    const back: Decision[] = []
    for (const d of this.all()) {
      if (!deferralOver(d, now) || isTerminal(d.state)) continue
      let done = false
      const next = this.mutate(d, (d) => {
        if (!deferralOver(d, now)) return { next: d }
        done = true
        const day = untilDay(d.deferredUntil!) ?? d.deferredUntil!
        return {
          next: {
            ...d,
            deferredAt: undefined,
            deferredBy: undefined,
            deferredUntil: undefined,
            body: appendSection(d.body, noteHeading(NOTE_KIND.undeferred, 'agent', DEFERRAL_CLOCK, nowStamp()), NOTE_TEXT.backFromDeferral(day)),
          },
        }
      })
      if (done) back.push(next)
    }
    return back
  }

  /** A `nod` reminder note already went out for the `remind_at` currently on record —
   *  editing it to a later time starts over (same idea as `waitReminded`). */
  private reminderFired(d: Decision): boolean {
    if (!d.remindAt) return false
    const note = d.notes.findLast((n) => n.author === DEFERRAL_CLOCK && n.kind === NOTE_KIND.reminded)
    return Boolean(note) && Date.parse(note!.at) >= Date.parse(d.remindAt)
  }

  /**
   * Reminders (`nod add --remind` / `nod edit --remind`) whose clock has come: one note
   * signed `nod` — "time to tell the owner" (the monitor turns it into NODDIT-REMIND for
   * the node's own agent, and the app's own notification) — the first time anything looks
   * after that moment. Once per `remind_at`: moving it later starts over.
   */
  fireDueReminders(now = Date.now()): Decision[] {
    const out: Decision[] = []
    for (const d of this.all()) {
      if (!d.remindAt || isTerminal(d.state) || Date.parse(d.remindAt) > now || this.reminderFired(d)) continue
      let done = false
      const next = this.mutate(d, (d) => {
        if (!d.remindAt || isTerminal(d.state) || Date.parse(d.remindAt) > now || this.reminderFired(d)) return { next: d }
        done = true
        return { next: { ...d, body: appendSection(d.body, noteHeading(NOTE_KIND.reminded, 'agent', DEFERRAL_CLOCK, nowStamp()), NOTE_TEXT.reminded(d.title)) } }
      })
      if (done) out.push(next)
    }
    return out
  }

  /**
   * 「人开始后转给 AI」: the owner hands their own to-do to an AI. Like a reply it is a request —
   * a note signed by the owner, queued, so the monitor of whoever runs the node (or the lead's) hears it.
   */
  handToAi(d: Decision, opts: { by: string; text?: string }): Decision {
    if (isTerminal(d.state)) throw new Error(t('core.store.alreadyFinishedNoHand', { ref: refOf(d) }))
    const text = [NOTE_TEXT.handedToAi, opts.text?.trim() ?? ''].filter(Boolean).join('\n\n')
    const written = this.mutate(d, (d) => ({
      next: {
        ...d,
        assignee: undefined,
        state: d.state === 'needs_decision' ? d.state : 'decided',
        body: appendSection(d.body, noteHeading(NOTE_KIND.reply, 'human', opts.by, nowStamp()), text),
      },
    }))
    enqueue(this.layoutOf(written), written.id)
    return { ...written, queued: true }
  }

  /** Who does it: `human` (the owner's to-do) or undefined (an AI). Takes it
   *  out of being a milestone too — `nod assign <id> ai|me` is how one goes back. */
  assign(d: Decision, assignee: string | undefined): Decision {
    if ((d.assignee ?? undefined) === assignee && !d.milestone) return d
    return this.mutate(d, (d) => ({ next: { ...d, assignee, milestone: undefined } }))
  }

  /**
   * `nod assign <id> milestone`: the third kind, alongside human/AI — a goal,
   * never started or finished by itself (core/checkins.ts, core/tidy.ts skip
   * it). No `due` required, unlike `nod flag`'s own mark on the same field.
   * Turning it on clears whatever it was assigned to; `assign(d, …)` turns it
   * back off.
   */
  setMilestone(d: Decision, on: boolean): Decision {
    if (Boolean(d.milestone) === on) return d
    return this.mutate(d, (d) => ({ next: { ...d, milestone: on || undefined, assignee: on ? undefined : d.assignee } }))
  }

  /**
   * Files the node away as completed. Nodes only waiting on this one, and
   * already answered/parked, are started; nodes nobody picked up are left alone.
   */
  complete(d: Decision, opts: { note?: string; author?: string } = {}): Decision {
    dequeue(this.layoutOf(d), d.id)
    const done = this.mutate(d, (d) => {
      const at = nowStamp(new Date(), { ms: true })
      const body = opts.note?.trim() ? appendSection(d.body, noteHeading(NOTE_KIND.completed, 'agent', opts.author || d.author, at), opts.note) : d.body
      return { next: { ...d, body, state: 'completed', archivedAt: at }, move: d.archived ? undefined : 'archive' }
    })
    const items = this.all()
    for (const w of items) {
      if (w.state !== 'not_started' || !w.answer || w.queued) continue
      if (!(w.after ?? []).some((r) => findRef(r, w, items)?.id === done.id && findRef(r, w, items)?.project === done.project)) continue
      if (!isStartable(w, items)) continue
      this.mutate(w, (w) => ({
        next: {
          ...w,
          state: 'in_progress',
          body: appendSection(w.body, noteHeading(NOTE_KIND.addendum, 'agent', 'decs', nowStamp()), NOTE_TEXT.dependencyDone(refOf(done))),
        },
      }))
    }
    return { ...done, queued: undefined }
  }

  /** `old` is replaced by `by`: closed as superseded, link recorded on both sides. */
  supersede(old: Decision, by: Decision, author: string): Decision {
    if (old.id === by.id && old.project === by.project) throw new Error(t('core.store.cantSupersedeSelf'))
    this.mutate(by, (b) => ({ next: { ...b, supersedes: [...new Set([...(b.supersedes ?? []), old.id])] } }))
    dequeue(this.layoutOf(old), old.id)
    const at = nowStamp(new Date(), { ms: true })
    const done = this.mutate(old, (o) => ({
      next: {
        ...o,
        state: 'closed',
        closeReason: 'superseded',
        supersededBy: by.id,
        archivedAt: at,
        body: appendSection(o.body, noteHeading(NOTE_KIND.superseded, 'agent', author, at), NOTE_TEXT.supersededBy(refOf(by), by.title)),
      },
      move: o.archived ? undefined : 'archive',
    }))
    return { ...done, queued: undefined }
  }

  /** Nodes whose body mentions `d` — 「被 W301 引用」. Computed by scanning on read; no index to keep in step. */
  backlinks(d: Decision, items = this.all()): Decision[] {
    const letters = new Set(this.layouts.map((l) => this.letterOf(l)))
    return items.filter((o) => {
      if (o.id === d.id && o.project === d.project) return false
      return parseBodyRefs(o.body, letters).some((r) => {
        if (r.id !== d.id) return false
        // Legacy D-refs and a node's own letter mean "this project".
        if (r.letter === 'D' && !letters.has('D')) return o.project === d.project
        return r.letter === d.letter
      })
    })
  }

  /** Not done, but not happening either: superseded / obsolete / merged-into:W15. */
  close(d: Decision, reason: string): Decision {
    if (!reason.trim()) throw new Error(t('core.store.closeNeedsReason'))
    dequeue(this.layoutOf(d), d.id)
    const at = nowStamp(new Date(), { ms: true })
    const done = this.mutate(d, (d) => ({
      next: { ...d, state: 'closed', closeReason: reason.trim(), archivedAt: at },
      move: d.archived ? undefined : 'archive',
    }))
    return { ...done, queued: undefined }
  }

  /**
   * A running node gets a new question — 待决策 again, without a new entry.
   * New options go under `## 选项（第 N 轮）`, keeping earlier rounds as
   * history. Sub-questions belong to the round that asks them (N161): `q.questions`
   * is this round's own, never inherited from an earlier one — a round
   * asked with none has none, however many an earlier round had.
   */
  ask(
    d: Decision,
    q: {
      options: { key: string; label: string; body?: string }[]
      default?: string
      text?: string
      author: string
      /** This round's own `--question`s, if any. */
      questions?: DecisionQuestion[]
      /** N203/N205: `text`'s own one-line summary, when `text` is long enough to need one. */
      summary?: string
    },
  ): Decision {
    const questions = q.questions ?? []
    if (questions.length) checkQuestions(questions)
    // No new options = ask the same question again. The text may already
    // contain `## 选项`; that block is adopted (or must match -o exactly).
    const text = q.text?.trim() ? q.text : undefined
    const inText = text ? parseOptions(text) : []
    // N203/N205: only the plain explanatory text needs its own summary — `nod ask`
    // is always the AI's own words, never 'human'. A `text` that already carries its
    // whole `## 选项` block is a full document (e.g. piped from stdin), not a reply
    // being condensed, so it is exempt the same way a long `nod add` body is.
    const summary = text && !inText.length ? checkSummary(text, q.summary, 'agent') : undefined
    if (text && text.split('\n').filter((l) => OPTIONS_HEADING_RE.test(l)).length > 1)
      throw new Error(t('core.store.multipleOptionsBlocks'))
    if (questions.length && (q.options.length || inText.length)) throw new Error(t('core.store.questionsAndOptionsMixed'))
    if (inText.length && q.options.length) {
      const same = inText.length === q.options.length && inText.every((o, i) => o.key === q.options[i].key && o.label === q.options[i].label)
      if (!same) throw new Error(t('core.store.askTextOptionsMismatch', { diff: optionDiff(inText, q.options) }))
    }
    if (inText.length && !q.options.length && q.default === undefined) q = { ...q, default: bodyDefault(inText) }
    const given = questions.length ? questionOptions(questions) : inText.length ? inText : q.options.length ? q.options : d.options
    const options = given.map((o) => ({ key: o.key, label: o.label, body: o.body ?? '' }))
    if (questions.length) q = { ...q, default: '1' }
    else if (!inText.length && !q.options.length && q.default === undefined) q = { ...q, default: d.default }
    if (!options.length) throw new Error(t('core.store.askNoOptions'))
    checkOptionKeys(options, q.default)
    const written = this.mutate(d, (d) => {
      const at = nowStamp()
      let body = d.body
      const round = optionsRoundOf(d.body) + 1
      if (inText.length && text) {
        // Renumbered to this round, so it outranks every earlier block.
        const heading = `## ${optionsHeading(round)}`
        const own = text.split('\n').map((l) => (OPTIONS_HEADING_RE.test(l) ? heading : l)).join('\n')
        body = appendSection(body, noteHeading(NOTE_KIND.newQuestion, 'agent', q.author, at), own, summary)
      } else {
        if (text) body = appendSection(body, noteHeading(NOTE_KIND.newQuestion, 'agent', q.author, at), text, summary)
        body = `${body.replace(/\s+$/, '')}\n\n${renderOptionsBlock(options, round).trim()}\n`
      }
      if (questions.length) body = `${body.replace(/\s+$/, '')}\n\n${renderQuestionsBlock(questions, round).trim()}\n`
      const next: Decision = {
        ...d,
        body,
        state: 'needs_decision',
        default: q.default,
        // Old answer stays in the body; front matter now describes the new question.
        answer: undefined,
        // This round's own sub-questions, however many an earlier round had —
        // `frontMatterOf` writes `question_defaults` from this.
        questions,
        reopenedAt: d.archived ? nowStamp(new Date(), { ms: true }) : d.reopenedAt,
      }
      return { next, move: d.archived ? 'unarchive' : undefined }
    })
    const back = parseOptions(written.body)
    if (back.map((o) => `${o.key}·${o.label}`).join('\n') !== options.map((o) => `${o.key}·${o.label}`).join('\n'))
      throw new Error(t('core.store.optionsDidNotRoundTrip', { ref: refOf(written) }))
    if (questions.length) {
      const backQ = written.questions ?? []
      const sameQ =
        backQ.length === questions.length &&
        backQ.every(
          (wq, i) => wq.key === questions[i].key && wq.label === questions[i].label && wq.options.map((o) => `${o.key}${o.label}`).join() === questions[i].options.map((o) => `${o.key}${o.label}`).join(),
        )
      if (!sameQ) throw new Error(t('core.store.questionsBlockMismatch'))
    }
    dequeue(this.layoutOf(written), written.id)
    return { ...written, queued: undefined }
  }

  /** Drops an empty options block an older `decs ask` left behind (see core/repair.ts). */
  collapseDuplicateOptions(d: Decision): { node: Decision; removed: DuplicateOptionsBlock[] } {
    let removed: DuplicateOptionsBlock[] = []
    const node = this.mutate(d, (d) => {
      const r = collapseDuplicateOptions(d.body)
      removed = r.removed
      return { next: { ...d, body: r.body } }
    })
    return { node, removed }
  }

  /** "Looked, nothing to do" — files it away. Deliberately not queued: nobody needs to be told. */
  dismiss(d: Decision, by = 'owner'): Decision {
    dequeue(this.layoutOf(d), d.id)
    const done = this.mutate(d, (d) => {
      const at = nowStamp(new Date(), { ms: true })
      const next: Decision = {
        ...d,
        state: 'completed',
        answer: { note: NOTE_TEXT.seenAnswer, by, at },
        body: appendSection(d.body, noteHeading(NOTE_KIND.seen, roleOf(by), by, at), NOTE_TEXT.seen),
        archivedAt: d.archived ? d.archivedAt : at,
      }
      return { next, move: d.archived ? undefined : 'archive' }
    })
    return { ...done, queued: undefined }
  }

  /** Files a settled node away as completed — the older name for `complete`. */
  archive(d: Decision): Decision {
    if (d.archived) throw new Error(t('core.store.alreadyArchived', { ref: refOf(d) }))
    return this.complete(d)
  }

  /** Pulls one back out of the archive, e.g. because it turned out not to be done. */
  unarchive(d: Decision): Decision {
    if (!d.archived) throw new Error(t('core.store.notArchived', { ref: refOf(d) }))
    const state: ItemStatus = d.answer || !d.options.length ? 'in_progress' : 'needs_decision'
    return this.mutate(d, (d) => ({ next: { ...d, state, closeReason: undefined }, move: 'unarchive' }))
  }

  /**
   * The owner's marks: `important` (urgency high), `milestone` (a key date, needs `due`),
   * or `normal` (both off). Like a pin it is triage, not a request: nothing is queued.
   */
  flag(d: Decision, how: { important?: boolean; milestone?: boolean; due?: string }): Decision {
    const due = how.due ?? d.due
    if (how.milestone && !due) throw new Error(t('core.store.milestoneNeedsDue', { ref: refOf(d) }))
    return this.mutate(d, (d) => ({
      next: {
        ...d,
        urgency: how.important === undefined ? d.urgency : how.important ? 'high' : undefined,
        milestone: how.milestone === undefined ? d.milestone : how.milestone || undefined,
        due,
      },
    }))
  }

  /**
   * Rewrites the description, or the text of appended note `note` (1-based), and nothing
   * else in the file (core/edit.ts), then says so in a note of its own so whoever works
   * on the node sees it changed. `expect`: the node's `updatedAt` when the editor opened —
   * a write since then refuses, rather than overwrite it.
   */
  edit(d: Decision, how: { text: string; note?: number; expect?: string; by: string; role: NoteRole; force?: boolean }): Decision {
    if (how.expect && d.updatedAt !== how.expect) throw new Error(t('core.store.editStale', { ref: refOf(d) }))
    if (how.note !== undefined) {
      const target = d.notes[how.note - 1]
      if (!target) throw new Error(t('core.store.noSuchNote', { ref: refOf(d), n: how.note, count: d.notes.length }))
      if (target.role !== how.role && !how.force) throw new Error(t('core.store.notYourNote', { ref: refOf(d), n: how.note }))
      // Every 已答 is a record of what was decided then; changing the answer appends a new one.
      if (target.kind === NOTE_KIND.answered && !how.force) throw new Error(t('core.store.answerIsRecord', { ref: refOf(d), n: how.note }))
    }
    const body = how.note !== undefined ? replaceNoteText(d.body, how.note, how.text) : replaceDescription(d.body, how.text)
    if (body === null || body === d.body) return d
    const edited = this.mutate(d, (d) => ({ next: { ...d, body } }))
    const what = how.note !== undefined ? NOTE_TEXT.editedNote({ ...d.notes[how.note - 1], text: how.text }) : NOTE_TEXT.editedDescription
    return this.append(edited, noteHeading(NOTE_KIND.addendum, how.role, how.by, nowStamp()), what, how.by, how.role)
  }

  /**
   * Changes the title only; the filename keeps its slug, since the id is the stable reference.
   * Records who changed it, like `edit`. `expect`: the node's `updatedAt` when the editor
   * opened — a write since then refuses, rather than overwrite it.
   */
  retitle(d: Decision, title: string, opts: { by?: string; role?: NoteRole; expect?: string } = {}): Decision {
    const trimmed = title.trim()
    if (!trimmed) throw new Error(t('core.store.titleRequired'))
    if (opts.expect && d.updatedAt !== opts.expect) throw new Error(t('core.store.editStale', { ref: refOf(d) }))
    if (trimmed === d.title) return d
    const by = opts.by ?? 'owner'
    const role = opts.role ?? 'human'
    const from = d.title
    const renamed = this.mutate(d, (d) => ({ next: { ...d, title: trimmed } }))
    return this.append(renamed, noteHeading(NOTE_KIND.addendum, role, by, nowStamp()), NOTE_TEXT.retitled(from), by, role)
  }

  /** `nod after`: what this node waits for. An empty list clears it. */
  setAfter(d: Decision, after: string[]): Decision {
    return this.mutate(d, (d) => ({ next: { ...d, after: after.length ? after : undefined } }))
  }

  /** Writes the node back as it reads now — what `decs migrate --upgrade` uses to make read-time mappings permanent. */
  rewrite(d: Decision): Decision {
    return this.mutate(d, (d) => ({ next: d }))
  }

  /** For a one-off migration that rewrites a node's body text directly (and
   *  nothing else) — `transform` sees the fresh-off-disk node. */
  rewriteBody(d: Decision, transform: (fresh: Decision) => string): Decision {
    return this.mutate(d, (fresh) => ({ next: { ...fresh, body: transform(fresh) } }))
  }

  /**
   * Puts `ds` in this order, above the nodes listed with them that were never moved: the first
   * gets -n, the last -1. Only nodes whose number changes are written.
   */
  arrange(ds: Decision[]): Decision[] {
    return ds.map((d, i) => {
      const order = i - ds.length
      return d.order === order ? d : this.mutate(d, (d) => ({ next: { ...d, order } }))
    })
  }

  /** Back to the view's own order. */
  unarrange(d: Decision): Decision {
    return d.order === undefined ? d : this.mutate(d, (d) => ({ next: { ...d, order: undefined } }))
  }

  /**
   * Progress/steps updates. A bare numeric update writes no note — a
   * throttled run would otherwise bury the body in `## 补充` headings.
   */
  progress(d: Decision, patch: { progress?: number; progressMsg?: string; steps?: unknown; note?: string; by?: string }): Decision {
    return this.mutate(d, (d) => {
      if (isTerminal(d.state)) throw new Error(t('core.store.progressOnFinished', { ref: refOf(d), state: statusLabel(d.state) }))
      let body = d.body
      if (patch.note?.trim()) {
        const by = patch.by ?? d.ownerAgent ?? d.author
        body = appendSection(body, noteHeading(NOTE_KIND.addendum, 'agent', by, nowStamp()), patch.note.trim())
      }
      const next: Decision = {
        ...d,
        body,
        progress: patch.progress ?? d.progress,
        progressMsg: patch.progressMsg ?? d.progressMsg,
        steps: patch.steps ?? d.steps,
        // Progress moving counts as a start too, so piping into a 待开始 task needs no separate `decs start`.
        state: d.state === 'not_started' ? 'in_progress' : d.state,
      }
      return { next }
    })
  }

  /** Read-modify-write under the entry's lock, from a fresh copy — so two concurrent writers can't clobber each other. */
  private mutate(
    d: Decision,
    change: (fresh: Decision) => { next: Decision; move?: 'archive' | 'unarchive' },
  ): Decision {
    const layout = this.layoutOf(d)
    return withFileLock(join(layout.root, '.locks', `${d.id}.lock`), () => {
      const fresh = this.fresh(d, layout)
      const { next, move } = change(fresh)
      return this.write(next, move)
    })
  }

  /** The entry as it is on disk right now — it may have moved since `d` was read. */
  private fresh(d: Decision, layout = this.layoutOf(d)): Decision {
    const f = existsSync(d.file)
      ? { path: d.file, archived: d.archived }
      : listEntryFiles(layout).find((x) => x.id === d.id)
    if (!f) throw new Error(t('core.store.isGone', { ref: refOf(d), file: d.file }))
    return this.load(f.path, f.archived, layout)
  }

  /** Writes the node, then moves its whole tree between active/ and archived/ if asked. */
  private write(d: Decision, move?: 'archive' | 'unarchive'): Decision {
    d = { ...d, state: withOpenQuestion(d), updatedAt: nowStamp(new Date(), { ms: true }) }
    writeFileAtomic(d.file, serializeDecision(d))
    // A later read this same pass must see this write, not the walk cached before it.
    this.invalidateScan(this.layoutOf(d))
    // Any write is a reply — clears a pending check-in ask (core/checkins.ts).
    resetCheckin(this.layoutOf(d), d.id)
    if (!move) return this.reread(d)
    const layout = this.layoutOf(d)
    const from = d.archived ? layout.archivedDir : layout.activeDir
    const to = move === 'archive' ? layout.archivedDir : layout.activeDir
    const rel = relative(from, d.file)
    const isRoot = !rel.includes(sep)
    if (from === to || (move === 'archive' && !isRoot)) return this.reread(d)
    const top = rel.split(sep)[0]
    const rootFile = join(from, top.endsWith('.md') ? top : `${top}.md`)
    mkdirSync(to, { recursive: true })
    if (existsSync(childDirOf(rootFile))) renameSync(childDirOf(rootFile), join(to, basename(childDirOf(rootFile))))
    if (existsSync(rootFile)) renameSync(rootFile, join(to, basename(rootFile)))
    return this.reread({ ...d, file: join(to, rel), archived: move === 'archive' })
  }

  /** Re-parents a node and its subtree under `parent` (or roots it). Ids don't change; relative links in moved bodies are rewritten. */
  move(d: Decision, parent: Decision | null): Decision {
    const layout = this.layoutOf(d)
    if (parent && this.layoutOf(parent) !== layout) throw new Error(t('core.store.parentInAnotherProject', { ref: refOf(parent) }))
    if (parent && (parent.id === d.id || parent.file.startsWith(childDirOf(d.file) + sep)))
      throw new Error(t('core.store.parentInOwnSubtree', { parent: refOf(parent), ref: refOf(d) }))
    if (parent?.archived && !d.archived) throw new Error(t('core.store.parentTreeArchived', { ref: refOf(parent), id: parent.id }))
    const toDir = parent ? childDirOf(parent.file) : d.archived ? layout.archivedDir : layout.activeDir
    if (dirname(d.file) === toDir) return this.reread(d)

    const oldFile = d.file
    const oldKids = childDirOf(oldFile)
    const newFile = join(toDir, basename(oldFile))
    const newKids = childDirOf(newFile)
    const moved = existsSync(oldKids)
      ? listEntryFiles(layout).filter((f) => f.path.startsWith(oldKids + sep)).map((f) => f.path)
      : []
    withFileLock(join(layout.root, '.locks', `${d.id}.lock`), () => {
      mkdirSync(toDir, { recursive: true })
      if (existsSync(oldKids)) renameSync(oldKids, newKids)
      renameSync(oldFile, newFile)
    })
    this.invalidateScan(layout)
    for (const old of [oldFile, ...moved]) {
      const now = old === oldFile ? newFile : newKids + old.slice(oldKids.length)
      const node = this.load(now, existsSync(now) && now.startsWith(layout.archivedDir + sep), layout)
      if (dirname(old) === dirname(now)) continue
      this.mutate(node, (n) => ({
        next: {
          ...n,
          body: relinkBody(n.body, dirname(old), dirname(now)),
          approvals: n.approvals.map((ap) => ({ ...ap, target: relinkTarget(ap.target, dirname(old), dirname(now)) })),
        },
      }))
    }
    return this.reread({ ...d, file: newFile, archived: newFile.startsWith(layout.archivedDir + sep) })
  }

  private reread(d: Decision): Decision {
    return this.load(d.file, d.archived, this.layoutOf(d))
  }

  /** `queued` decides how a legacy `answered` reads (decided vs in_progress); read here if the caller didn't already. */
  private load(path: string, archived: boolean, l: Layout, queued?: boolean): Decision {
    const name = basename(path)
    const isQueued = queued ?? readQueue(l).includes(Number(/^D?(\d+)/.exec(name)?.[1]))
    // The path is the truth for both: which tree it is in, and under whom.
    const inArchive = path.startsWith(l.archivedDir + sep) || (archived && !path.startsWith(l.activeDir + sep))
    const d = parseDecision(readFileSync(path, 'utf8'), path, inArchive, this.projectName(l), { queued: isQueued })
    const up = dirname(path)
    const m = up === l.activeDir || up === l.archivedDir ? null : /^D?(\d+)(?:-.*)?$/.exec(basename(up))
    const shown = this.displayName(l)
    return { ...d, letter: this.letterOf(l), ...(shown !== d.project ? { projectName: shown } : {}), ...(m ? { parent: Number(m[1]) } : {}) }
  }

  private letters = new Map<Layout, string>()

  /** The project's display letter (`W` in `W305`); `X` when it has none. */
  letterOf(l: Layout): string {
    let v = this.letters.get(l)
    if (v === undefined) this.letters.set(l, (v = projectLetter(l)))
    return v
  }

  /** Letters claimed by more than one project in this store — refs using them are ambiguous. */
  letterClashes(): { letter: string; projects: string[] }[] {
    const by = new Map<string, string[]>()
    for (const l of this.layouts) {
      if (!readProjectConfig(l).letter) continue
      const k = this.letterOf(l)
      by.set(k, [...(by.get(k) ?? []), this.projectName(l)])
    }
    return [...by].filter(([, ps]) => ps.length > 1).map(([letter, projects]) => ({ letter, projects }))
  }

  /** Finds one decision from whatever the user typed — see `parseRef`. `project` (the `--project` flag) wins. */
  resolve(raw: string, project?: string): Decision {
    const r = parseRef(raw)
    let name = project ?? r.project
    if (r.letter && !name) {
      let hits = this.layouts.filter((l) => this.letterOf(l) === r.letter)
      // A letter the project used to have: refs written before the change keep working.
      if (!hits.length) hits = this.layouts.filter((l) => readProjectConfig(l).former_letters?.includes(r.letter!))
      const known = [...new Set(this.layouts.map((l) => `${this.letterOf(l)}=${this.projectName(l)}`))].join(' ')
      // `D305` from before project letters existed: "305, here". A project
      // that really is lettered D wins, because that is what its refs print.
      if (!hits.length && r.letter === 'D') return this.resolve(String(r.id), project)
      if (!hits.length) throw new Error(t('core.store.noProjectWithLetter', { letter: r.letter, known }))
      if (hits.length > 1)
        throw new Error(
          t('core.store.letterAmbiguous', { letter: r.letter, projects: list(hits.map((l) => this.projectName(l))), example: `${this.projectName(hits[0])}:${r.id}` }),
        )
      name = this.projectName(hits[0])
    }
    const d = this.get(r.id, name)
    if (!d) throw new Error(t('core.store.doesNotExist', { ref: raw }))
    return d
  }

  layoutOf(d: Decision): Layout {
    const l = this.layouts.find((x) => d.file.startsWith(x.root))
    if (!l) throw new Error(`cannot tell which project ${d.file} belongs to`)
    return l
  }

  private reserveId(layout: Layout): number {
    mkdirSync(layout.idsDir, { recursive: true })
    const used = listEntryFiles(layout).map((f) => f.id)
    let n = Math.max(0, ...used) + 1
    for (;;) {
      try {
        closeSync(openSync(join(layout.idsDir, String(n)), 'wx'))
        if (!existsSync(join(layout.activeDir, `D${n}.md`)) && !existsSync(join(layout.activeDir, `${n}.md`)) && !used.includes(n))
          return n
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      n++
    }
  }
}

export interface ChangeEvent {
  at: string
  /** `W305` — see core/ref.ts. */
  ref: string
  event: 'created' | 'answered' | 'note' | 'completed' | 'closed' | 'reopened'
  id: number
  project: string
  title: string
  /** Who proposed the entry — what `--mine` matches. */
  entry_author: string
  /** Who did this particular thing. */
  by: string
  role: NoteRole
  kind?: string
  text?: string
  choice?: string | null
  /** Who actually wrote this, process-wise (see `core/identity.ts`) — absent
   *  when the write carried no marker (older files, or no identity set). */
  writer?: string
  /** An agent's own note that is the first reply after a human post — the
   *  owner can see it, so it's an event worth notifying on, not just a
   *  record. Never set for a human-authored note. */
  ownerFacing?: boolean
  file: string
}

/** Whether an entry was proposed by `me` — compares the agent name before the first ` · `, or a plain substring. */
export function sameAgent(entryAuthor: string | undefined, me: string): boolean {
  if (!entryAuthor) return false
  const name = (s: string) => s.split(/[ \t]*·[ \t]*/)[0].trim()
  return entryAuthor.includes(me) || (name(me) !== '' && name(entryAuthor) === name(me))
}

/** Whether `me` answers for this node: it filed it, runs it (`owner_agent`), or claimed the brief the owner filed. */
export function ownedBy(d: Pick<Decision, 'author' | 'claimedBy' | 'ownerAgent'>, me: string): boolean {
  return (
    sameAgent(d.author, me) ||
    (d.ownerAgent !== undefined && (sameAgent(d.ownerAgent, me) || sameAgent(me, d.ownerAgent))) ||
    (d.claimedBy !== undefined && (sameAgent(d.claimedBy, me) || sameAgent(me, d.claimedBy)))
  )
}

/** A brief someone else has already claimed; carries the node so a caller can say who. */
export class ClaimedError extends Error {
  readonly node: Decision
  constructor(d: Decision) {
    super(t('core.store.alreadyClaimed', { ref: refOf(d), by: d.claimedBy ?? '', at: (d.claimedAt ?? '').slice(0, 16).replace('T', ' ') }))
    this.node = d
  }
}

/** Before roles, the owner signed as `owner` and nothing else did. */
export function roleOf(by: string): NoteRole {
  return by === 'owner' ? 'human' : 'agent'
}

/** When a human last said anything on this entry — the answer or latest follow-up, whichever is newer. */
export function lastHumanAt(d: Decision): string | undefined {
  const times = [d.answer?.at, ...d.notes.filter((n: DecisionNote) => n.role === 'human').map((n) => n.at)]
    .filter((t): t is string => Boolean(t) && !Number.isNaN(Date.parse(t!)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  return times[times.length - 1]
}

/**
 * Per note, in order: is this the first agent note after a human post —
 * the reply to it, an owner-facing event (see `changes()` / `cli/commands/
 * monitor.ts`'s `reportUpdates`)? By array order, not timestamps — two
 * notes written within the same second get identical second-precision
 * headings, so comparing `at` strings can't tell them apart.
 */
export function ownerFacingFlags(d: Pick<Decision, 'notes'>): boolean[] {
  let sawHuman = false
  let repliedSinceHuman = false
  return d.notes.map((n) => {
    if (n.role === 'human') {
      sawHuman = true
      repliedSinceHuman = false
      return false
    }
    if (!sawHuman || repliedSinceHuman) return false
    repliedSinceHuman = true
    return true
  })
}

/** Whether the latest note (if any) is the owner-facing reply — what a redrawing window checks per changed node. */
export function isLatestNoteOwnerFacing(d: Pick<Decision, 'notes'>): boolean {
  return ownerFacingFlags(d).at(-1) ?? false
}

/** 「归档后有新回复」: a human reply brought it back and it has not been filed again since. */
export function reopenedAfterArchive(d: Decision): boolean {
  if (d.archived || !d.reopenedAt) return false
  return !d.archivedAt || Date.parse(d.reopenedAt) > Date.parse(d.archivedAt)
}

/** Option keys must be digits 1-9 — the owner presses a number key. */
function checkOptionKeys(options: DecisionOption[], def?: string): void {
  const lettered = options.filter((o) => !/^[1-9]$/.test(o.key))
  if (lettered.length) {
    throw new Error(t('core.store.optionKeysMustBeDigits', { keys: lettered.map((o) => o.key).join(', ') }))
  }
  const dupe = options.map((o) => o.key).find((k, i, a) => a.indexOf(k) !== i)
  if (dupe) throw new Error(t('core.store.optionKeyUsedTwice', { key: dupe }))
  if (def && !options.some((o) => o.key === def))
    throw new Error(t('core.store.defaultNotAnOption', { default: def, keys: options.map((o) => o.key).join(', ') || t('core.store.noneWord') }))
}

/** Two screenshots both called `after.png` must not overwrite each other. */
function uniquePath(p: string): string {
  if (!existsSync(p)) return p
  const ext = extname(p)
  const stem = p.slice(0, p.length - ext.length)
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
}

/**
 * Approves attached content when the owner's answer matches its `approveOn`
 * keys; any other answer withdraws an earlier approval. Only the owner's own
 * answer reaches here — an agent's `answer` and `dismiss` approve nothing.
 */
function approveAttachments(
  d: Decision,
  ans: { choice?: string; answers?: Record<string, string> },
  by: string,
  at: string,
): AttachmentApproval[] {
  if (!d.approvals.length) return d.approvals
  return d.approvals.map((ap) => {
    const keys = ap.approveOn ?? defaultApproveOn(d) ?? []
    const approving = keys.some((k) => {
      const colon = k.indexOf(':')
      return colon === -1 ? ans.choice === k : ans.answers?.[k.slice(0, colon)] === k.slice(colon + 1)
    })
    if (approving) {
      if (ap.hash === ap.approvedHash) return { ...ap, declined: undefined }
      return { ...ap, approvedHash: ap.hash, approvedAt: at, approvedBy: by, declined: undefined }
    }
    const given = ans.answers ? Object.entries(ans.answers).map(([k, v]) => `${k}=${v}`).join(' ') : ans.choice
    return { ...ap, approvedHash: undefined, approvedAt: undefined, approvedBy: undefined, declined: given || NOTE_TEXT.declinedTextOnly }
  })
}

/** An acceptance-style node (one option, no sub-questions) is approved by that option. */
function defaultApproveOn(d: Decision): string[] | undefined {
  if (d.questions?.length || d.options.length !== 1) return undefined
  return [d.options[0].key]
}

/** `--approve-on` keys must name an option, or `Q2:1` a sub-question's option. */
function checkApproveOn(d: Decision, keys: string[]): void {
  if (!keys.length) throw new Error(t('core.store.approveOnEmpty'))
  for (const k of keys) {
    const colon = k.indexOf(':')
    if (colon === -1) {
      if (!d.options.some((o) => o.key === k))
        throw new Error(t('core.store.noSuchOption', { ref: refOf(d), key: k, keys: d.options.map((o) => o.key).join(' ') }))
      continue
    }
    const q = d.questions?.find((x) => x.key === k.slice(0, colon))
    if (!q) throw new Error(t('core.store.noSuchSubQuestion', { ref: refOf(d), key: k.slice(0, colon) }))
    if (!q.options.some((o) => o.key === k.slice(colon + 1)))
      throw new Error(t('core.store.subQuestionNoSuchOption', { key: q.key, option: k.slice(colon + 1), keys: q.options.map((o) => o.key).join(' ') }))
  }
}

export function sha256File(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The version numbers `decs attach --replace` has already used for this filename, e.g. `[1, 2]` for `foo.png.1` and `foo.png.2`. */
function historyVersions(histDir: string, baseName: string): number[] {
  if (!existsSync(histDir)) return []
  const re = new RegExp(`^${escapeRegExp(baseName)}\\.(\\d+)$`)
  return readdirSync(histDir)
    .map((f) => re.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
}

export { benchOrder } from './order.ts'

/** A label marked （默认） / (default) in a body's own options block. */
/** Who signs the note when a deferral runs out on its own. */
export const DEFERRAL_CLOCK = 'nod'

const BODY_DEFAULT_MARK = /[（(]\s*(默认|default)\s*[)）]/i

function bodyDefault(options: DecisionOption[]): string | undefined {
  return options.find((o) => BODY_DEFAULT_MARK.test(o.label))?.key
}

/** `1「上」≠「上线」; 3 only in the body` — which options disagree, not just their keys. */
export function optionDiff(body: DecisionOption[], given: Pick<DecisionOption, 'key' | 'label'>[]): string {
  const out: string[] = []
  for (const g of given) {
    const b = body.find((o) => o.key === g.key)
    if (!b) out.push(`${g.key}「${g.label}」only in -o`)
    else if (b.label !== g.label) out.push(`${g.key}: body「${b.label}」≠ -o「${g.label}」`)
  }
  for (const b of body) if (!given.some((g) => g.key === b.key)) out.push(`${b.key}「${b.label}」only in the body`)
  const bodyKeys = body.map((o) => o.key).join(',')
  const givenKeys = given.map((o) => o.key).join(',')
  if (!out.length && bodyKeys !== givenKeys) out.push(`order differs: body ${bodyKeys}, -o ${givenKeys}`)
  return out.join('; ')
}

/** `d` with `body` read again — its notes and their attachments — without touching the file. */
function parseBodyFor(d: Decision, body: string): Decision {
  return { ...d, notes: parseNotes(body), bodyAttachments: sectionAttachments(body).body }
}
