/**
 * Pure parsing for the old one-file-per-project convention (`DECISIONS.md` +
 * `DECISIONS.old.md`) into something `toDecision` can turn into a `Decision`.
 *
 * Headings and option blocks drifted in format over time, so every extractor
 * here is heuristic and fails closed: on doubt it emits nothing plus a
 * warning rather than a wrong option list.
 */
import { normalizeNewlines } from '../core/parse.ts'
import { renderOptionsBlock, slugify } from '../core/serialize.ts'
import { nowStamp } from '../core/store.ts'
import { ACCEPTANCE_OPTION, type Decision, type DecisionAnswer, type DecisionOption } from '../core/types.ts'
import { t } from '../i18n/index.ts'

export interface LegacyEntry {
  id: number
  title: string
  author: string
  body: string
  /** Only set for archived entries — the date on the `# <date> · D…` heading. */
  date?: string
  answer?: DecisionAnswer
  /** The legacy entry read as 「等你看一眼」 rather than a fork in the road. */
  isAcceptance: boolean
  options: DecisionOption[]
  /** Option key that happens if the owner never answers, best-effort. */
  default?: string
  /** Everything this entry's extraction had to guess at. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Heading parsing shared by active entries and archive entries' nested
// "original" heading.
// ---------------------------------------------------------------------------

/**
 * Splits what comes after `D<id>` in a heading into author + title.
 * Handles `（author）· title`, `· title`, or parens that are part of the
 * title itself (no trailing `·`).
 */
function parseIdRest(rest: string): { author?: string; title: string } {
  const trimmed = rest.replace(/^[ \t]+/, '')
  const paren = /^（([^）]*)）[ \t]*·[ \t]*([\s\S]*)$/.exec(trimmed)
  if (paren) return { author: paren[1].trim(), title: paren[2].trim() }
  const dot = /^[ \t]*·[ \t]*([\s\S]*)$/.exec(trimmed)
  if (dot) return { title: dot[1].trim() }
  return { title: trimmed.trim() }
}

/**
 * Splits a trailing resolution marker (`已答`/`已办`/`已撤回`) off an archive
 * heading: everything before it is the title, the matched tail becomes a
 * last-resort answer note (`answered`).
 */
const RESOLUTION_VERB_RE = /已答|已办|已撤回/
function stripAnsweredSuffix(rest: string): { rest: string; answered?: string } {
  const m = RESOLUTION_VERB_RE.exec(rest)
  if (!m) return { rest }
  const before = rest.slice(0, m.index).replace(/[ \t]*·[ \t]*$/, '')
  const tail = rest.slice(m.index).trim()
  return { rest: before, answered: tail || undefined }
}

const KIND_RE = /验收|看一眼|亲自(走|看|跑)|走一遍|请过目|等你看|你看看/

/** 「做完了，等你看一眼」 — no fork in the road, just needs a pair of eyes. */
function detectKind(title: string): boolean {
  return KIND_RE.test(title)
}

/** Finds a `> 提出者：…` blockquote (and its continuation lines) from `fromIdx`. */
function findAuthorBlock(lines: string[], fromIdx: number, maxScan = 12): { author?: string } {
  const limit = Math.min(lines.length, fromIdx + maxScan)
  for (let i = fromIdx; i < limit; i++) {
    const line = lines[i]
    const m = /^>[ \t]*提出者[：:][ \t]*(.*)$/.exec(line)
    if (m) {
      const parts = [m[1]]
      let j = i + 1
      while (j < lines.length && /^>/.test(lines[j]) && lines[j].replace(/^>[ \t]?/, '').trim() !== '') {
        parts.push(lines[j].replace(/^>[ \t]?/, ''))
        j++
      }
      let author = parts.join(' ').replace(/\s+/g, ' ').trim()
      if (author.length > 240) author = `${author.slice(0, 240)}…`
      return { author }
    }
    if (line.trim() && !line.startsWith('>')) break
  }
  return {}
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const OPTIONS_HEADER_RE = /^\*\*(选项|各选项|可选项)[^*]{0,40}\*\*[ \t]*$/
const OPT_BULLET_RE =
  /^[-*][ \t]+\*\*([A-Za-z0-9]{1,3})(?:[（(][^）)]*[）)])?[ \t]*[·:：][ \t]*(.+?)\*\*[ \t]*(.*)$/
const OPT_NUMBERED_RE = /^(\d{1,2})\.[ \t]+\*\*(.+?)\*\*[ \t]*(.*)$/
const OPT_INLINE_RE = /^\*\*选项[ \t]*([A-Za-z0-9]{1,3})[ \t]*[—–\-·:：]+[ \t]*(.+?)\*\*[ \t]*(.*)$/

function isSectionTerminator(line: string): boolean {
  if (/^#{1,6}[ \t]/.test(line)) return true
  if (/^\*\*[^*]+\*\*[ \t]*$/.test(line.trim())) return true
  return false
}

function tryStartOption(line: string): { key: string; label: string; rest: string } | null {
  let m = OPT_BULLET_RE.exec(line)
  if (m) return { key: m[1], label: m[2].trim(), rest: m[3] ?? '' }
  m = OPT_NUMBERED_RE.exec(line)
  if (m) return { key: m[1], label: m[2].trim(), rest: m[3] ?? '' }
  m = OPT_INLINE_RE.exec(line)
  if (m) return { key: m[1], label: m[2].trim(), rest: m[3] ?? '' }
  return null
}

interface ExtractedOptions {
  options: DecisionOption[]
  body: string
  warnings: string[]
}

/**
 * Replaces a confidently-matched `**选项**` block with the canonical
 * `## 选项` / `### key · label` form so it round-trips through
 * `parseOptions`. Anything less than confident leaves `body` untouched.
 */
function extractOptions(body: string): ExtractedOptions {
  const lines = body.split('\n')
  const warnings: string[] = []

  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (OPTIONS_HEADER_RE.test(lines[i])) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return { options: [], body, warnings }

  type Buf = { key: string; label: string; body: string[] }
  const opts: Buf[] = []
  let cur: Buf | null = null
  let sawNonOptionContentBeforeFirst = false
  let endLineIdx = lines.length

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (isSectionTerminator(line)) {
      endLineIdx = i
      break
    }
    const started = tryStartOption(line)
    if (started) {
      if (cur) opts.push(cur)
      cur = { key: started.key, label: started.label, body: started.rest.trim() ? [started.rest] : [] }
      continue
    }
    if (!cur) {
      if (line.trim()) sawNonOptionContentBeforeFirst = true
      continue
    }
    cur.body.push(line)
  }
  if (cur) opts.push(cur)

  if (opts.length < 2 || sawNonOptionContentBeforeFirst) {
    warnings.push(t('core.migrate.optionsNotExtracted', { count: opts.length }))
    return { options: [], body, warnings }
  }
  const keys = opts.map((o) => o.key)
  if (new Set(keys).size !== keys.length) {
    warnings.push(t('core.migrate.optionsDuplicateKeys', { keys: keys.join(',') }))
    return { options: [], body, warnings }
  }

  const options: DecisionOption[] = opts.map((o) => ({
    key: o.key,
    label: o.label.replace(/[。.]+$/, '').trim(),
    body: o.body.join('\n').trim(),
  }))

  const before = lines.slice(0, headerIdx).join('\n').replace(/[ \t]+$/, '')
  const after = lines.slice(endLineIdx).join('\n')
  const block = renderOptionsBlock(options).replace(/\n+$/, '\n')
  const newBody = [before, block, after].filter((s) => s.trim() !== '').join('\n\n')
  return { options, body: newBody, warnings }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Only accepts a key mention that's unambiguous — exactly one option key found nearby. */
function matchKeyNearStart(text: string, options: DecisionOption[], window: number): string | undefined {
  const head = text.slice(0, window)
  const hits = new Set(
    options.filter((o) => new RegExp(`(^|[^A-Za-z0-9])${escapeRe(o.key)}([^A-Za-z0-9]|$)`).test(head)).map((o) => o.key),
  )
  return hits.size === 1 ? [...hits][0] : undefined
}

const DEFAULT_MARKER_RE = /\*\*(如果[你我](?:们)?不回|默认(?:动作)?|你不回)[^*]*\*\*[ \t]*[:：]?[ \t]*/
function extractDefault(body: string, options: DecisionOption[]): string | undefined {
  if (!options.length) return undefined
  const m = DEFAULT_MARKER_RE.exec(body)
  if (!m) return undefined
  const tail = body.slice(m.index + m[0].length, m.index + m[0].length + 80)
  return matchKeyNearStart(tail, options, 80)
}

// ---------------------------------------------------------------------------
// Active file: `## D<id>…` entries, newest-first-ish, no dates.
// ---------------------------------------------------------------------------

function processActiveBlock(lines: string[], id: number, headingRest: string): LegacyEntry {
  const warnings: string[] = []
  const parsedHeading = parseIdRest(headingRest)
  let title = parsedHeading.title
  let author = parsedHeading.author

  const authorBlock = findAuthorBlock(lines, 1)
  if (authorBlock.author) author = authorBlock.author

  if (!title.trim()) {
    title = `D${id}`
    warnings.push(t('core.migrate.emptyTitleHeading'))
  }
  if (!author) {
    author = 'legacy'
    warnings.push(t('core.migrate.noAuthorHeading'))
  }

  const bodyRaw = lines.slice(1).join('\n')
  const extracted = extractOptions(bodyRaw)
  warnings.push(...extracted.warnings)
  const def = extractDefault(bodyRaw, extracted.options)

  return {
    id,
    title: title.trim(),
    author: author.trim(),
    body: extracted.body,
    isAcceptance: detectKind(title),
    options: extracted.options,
    default: def,
    warnings,
  }
}

export function parseLegacyActive(text: string): LegacyEntry[] {
  const lines = normalizeNewlines(text).split('\n')
  const boundaries: { idx: number; id: number; rest: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^##[ \t]+D(\d+)(.*)$/.exec(lines[i])
    if (m) boundaries.push({ idx: i, id: Number(m[1]), rest: m[2] })
  }
  return boundaries.map((b, bi) => {
    const end = bi + 1 < boundaries.length ? boundaries[bi + 1].idx : lines.length
    return processActiveBlock(lines.slice(b.idx, end), b.id, b.rest)
  })
}

// ---------------------------------------------------------------------------
// Archive file: two heading conventions seen —
//   style 1: `# <date> · D<id>（author）· title [· 已答「summary」]`   (H1)
//   style 2: `## [<date> 状态] D<id> title`                             (H2)
// A nested `## D<id>（author）· title` heading, when present, is the
// authoritative source for title/author; the outer heading mostly
// contributes the date and sometimes an answer summary.
// ---------------------------------------------------------------------------

function matchArchiveBoundary(line: string): { date: string; id: number; rest: string } | null {
  let m = /^#[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*·[ \t]*D(\d+)(.*)$/.exec(line)
  if (m) return { date: m[1], id: Number(m[2]), rest: m[3] }
  m = /^##[ \t]+\[(\d{4}-\d{2}-\d{2})[^\]]*\][ \t]*D(\d+)(.*)$/.exec(line)
  if (m) return { date: m[1], id: Number(m[2]), rest: m[3] }
  return null
}

function findAllNestedHeadings(lines: string[], fromIdx: number): { idx: number; id: number; rest: string }[] {
  const out: { idx: number; id: number; rest: string }[] = []
  for (let i = fromIdx; i < lines.length; i++) {
    const m = /^##[ \t]+D(\d+)(.*)$/.exec(lines[i])
    if (m) out.push({ idx: i, id: Number(m[1]), rest: m[2] })
  }
  return out
}

function findFirstBlockquoteParagraph(lines: string[], fromIdx: number, toIdx: number): string | null {
  for (let i = fromIdx; i < toIdx; i++) {
    if (/^>/.test(lines[i])) {
      const parts: string[] = []
      let j = i
      while (j < toIdx && /^>/.test(lines[j])) {
        parts.push(lines[j].replace(/^>[ \t]?/, ''))
        j++
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim()
    }
    if (lines[i].trim()) return null
  }
  return null
}

function extractDateish(s: string): string {
  const m = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(s)
  return m ? m[0] : ''
}

function splitByAt(s: string): { by: string; at: string } {
  const at = extractDateish(s)
  let by = s.replace(at, '').replace(/[，,]/g, ' ').trim()
  by = by.split(/\s+/)[0] || 'owner'
  return { by, at }
}

function takeProseUntilBoundary(text: string, fromIdx: number): string {
  const rest = text.slice(fromIdx)
  const m = /\n[ \t]*\n|\n#{1,2}[ \t]|\n---[ \t]*\n|\n\*\*[^*\n]+\*\*[ \t]*(?:\n|$)/.exec(rest)
  const cut = m ? m.index : rest.length
  return rest.slice(0, cut).replace(/\s+/g, ' ').trim()
}

interface AnswerCtx {
  headingSuffixNote?: string
  headingDate?: string
  options: DecisionOption[]
  nestedIdx: number | null
  /** Where the archival-reason-blockquote search may start (skips a true outer heading line). */
  scanFrom: number
}

function finalizeAnswer(by: string, at: string, note: string, options: DecisionOption[]): DecisionAnswer | undefined {
  if (!note.trim()) return undefined
  const choice = options.length ? matchKeyNearStart(note, options, 60) : undefined
  return { by: by || 'owner', at, note: note.trim(), choice }
}

/**
 * Best-effort resolution text for an archived entry: tries an inline
 * `**已答（by，at）。**` marker, a bare `**已答。**` marker, a `> 已答「…」`
 * blockquote, a lead archival-reason blockquote, then the heading's own
 * suffix. Undefined only if none of those turn up anything.
 */
function extractAnswer(lines: string[], ctx: AnswerCtx): DecisionAnswer | undefined {
  const fullText = lines.join('\n')

  const boldM = /\*\*已答[（(]([^)）]*)[)）][。.][ \t]*\*\*[ \t]*/.exec(fullText)
  if (boldM) {
    const note = takeProseUntilBoundary(fullText, boldM.index + boldM[0].length)
    const { by, at } = splitByAt(boldM[1])
    const a = finalizeAnswer(by, at || ctx.headingDate || '', note, ctx.options)
    if (a) return a
  }

  const bareBoldM = /\*\*已答[。.]?\*\*[ \t]*/.exec(fullText)
  if (bareBoldM) {
    const note = takeProseUntilBoundary(fullText, bareBoldM.index + bareBoldM[0].length)
    const a = finalizeAnswer('owner', ctx.headingDate ?? '', note, ctx.options)
    if (a) return a
  }

  for (let i = 0; i < lines.length; i++) {
    if (/^>[ \t]*已答[「:：]?/.test(lines[i])) {
      const para = findFirstBlockquoteParagraph(lines, i, lines.length) ?? ''
      const note = para
        .replace(/^已答[「:：]?/, '')
        .replace(/」?[ \t]*原文如下[。.]?[ \t]*$/, '')
        .replace(/」\s*$/, '')
        .trim()
      const a = finalizeAnswer('owner', ctx.headingDate ?? '', note, ctx.options)
      if (a) return a
    }
  }

  const boundEnd = ctx.nestedIdx ?? lines.length
  const para = findFirstBlockquoteParagraph(lines, ctx.scanFrom, boundEnd)
  if (para && /归档|结果[:：]|答复/.test(para)) {
    const note = para.replace(/原文如下[。.]?[ \t]*$/, '').trim()
    // 「owner 的答复」 is a quote; a 「归档理由」/「结果：」 note explains why
    // it's closed, not a quote.
    const by = /答复/.test(para) ? 'owner' : 'lead'
    const a = finalizeAnswer(by, ctx.headingDate ?? '', note, ctx.options)
    if (a) return a
  }

  if (ctx.headingSuffixNote) {
    return finalizeAnswer('owner', ctx.headingDate ?? '', ctx.headingSuffixNote, ctx.options)
  }

  return undefined
}

interface OuterHeading {
  id: number
  date: string
  rest: string
  answered?: string
  /** From a `答案：` list preamble mapping id → text. */
  answerList?: Map<number, string>
}

/**
 * An older batch format answers everything in one list up top — `答案：`
 * then `    D<id>  <text>` — instead of a marker per entry.
 */
function extractAnswerList(lines: string[]): Map<number, string> {
  const map = new Map<number, string>()
  const start = lines.findIndex((l) => /^答案[：:][ \t]*$/.test(l))
  if (start === -1) return map
  let curId: number | null = null
  let buf: string[] = []
  const flush = () => {
    if (curId !== null) map.set(curId, buf.join(' ').replace(/\s+/g, ' ').trim())
    buf = []
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) {
      if (curId !== null) continue
      break
    }
    const m = /^[ \t]+D(\d+)[ \t]+([\s\S]*)$/.exec(line)
    if (m) {
      flush()
      curId = Number(m[1])
      buf.push(m[2])
      continue
    }
    if (curId !== null && /^[ \t]+\S/.test(line)) {
      buf.push(line.trim())
      continue
    }
    break
  }
  flush()
  return map
}

/**
 * Builds one entry from a region of lines. `hasOwnHeadingLine` is false for
 * a sub-entry carved out of a batch block, where index 0 is already content.
 */
function processEntry(contentLines: string[], outer: OuterHeading, nestedIdx: number | null, hasOwnHeadingLine: boolean): LegacyEntry {
  const warnings: string[] = []
  const outerParsed = parseIdRest(outer.rest)
  let title = outerParsed.title
  let author = outerParsed.author

  if (nestedIdx !== null) {
    const m = /^##[ \t]+D(\d+)(.*)$/.exec(contentLines[nestedIdx])!
    const nestedId = Number(m[1])
    if (nestedId !== outer.id) {
      warnings.push(t('core.migrate.nestedHeadingMismatch', { nestedId, outerId: outer.id }))
    }
    const nestedParsed = parseIdRest(m[2])
    if (nestedParsed.title.trim()) title = nestedParsed.title
    if (nestedParsed.author) author = nestedParsed.author
  }

  const authorSearchFrom = nestedIdx !== null ? nestedIdx + 1 : hasOwnHeadingLine ? 1 : 0
  const authorBlock = findAuthorBlock(contentLines, authorSearchFrom)
  if (authorBlock.author) author = authorBlock.author

  if (!title || !title.trim()) {
    title = `D${outer.id}`
    warnings.push(t('core.migrate.emptyTitle'))
  }
  if (!author) {
    author = 'legacy'
    warnings.push(t('core.migrate.noAuthor'))
  }

  const bodyRaw = (hasOwnHeadingLine ? contentLines.slice(1) : contentLines).join('\n')
  const extracted = extractOptions(bodyRaw)
  warnings.push(...extracted.warnings)

  const answer = extractAnswer(contentLines, {
    headingSuffixNote: outer.answered,
    headingDate: outer.date,
    options: extracted.options,
    nestedIdx,
    scanFrom: hasOwnHeadingLine ? 1 : 0,
  })
  const listNote = outer.answerList?.get(outer.id)
  let finalAnswer = answer ?? (listNote ? finalizeAnswer('owner', outer.date, listNote, extracted.options) : undefined)
  // archived means resolved; `status: open` there would be self-contradictory.
  if (!finalAnswer) {
    warnings.push(t('core.migrate.noExtractableAnswer'))
    finalAnswer = { by: 'legacy', at: outer.date, note: undefined, choice: undefined }
  }

  return {
    id: outer.id,
    title: title.trim(),
    author: author.trim(),
    body: extracted.body,
    date: outer.date,
    answer: finalAnswer,
    isAcceptance: detectKind(title),
    options: extracted.options,
    // every archived entry is now answered (possibly with an empty note),
    // so a "what happens if the owner never answers" default is moot.
    default: undefined,
    warnings,
  }
}

/**
 * One archive block = one decision, always — the outer heading's own id. A
 * nested `## D<id>` heading only updates title/author; never split into a
 * separate entry (that would invent a renumbered id other entries already
 * reference by number).
 */
function processArchiveBlock(lines: string[]): LegacyEntry {
  const boundary = matchArchiveBoundary(lines[0])
  if (!boundary) throw new Error('internal: archive block missing its boundary heading')
  const { rest: restNoSuffix, answered } = stripAnsweredSuffix(boundary.rest)
  const answerList = extractAnswerList(lines)
  const outer: OuterHeading = { id: boundary.id, date: boundary.date, rest: restNoSuffix, answered, answerList }

  const nestedAll = findAllNestedHeadings(lines, 1)
  const e = processEntry(lines, outer, nestedAll[0]?.idx ?? null, true)
  if (nestedAll.length > 1) {
    e.warnings.push(
      t('core.migrate.otherNestedHeadings', {
        count: nestedAll.length - 1,
        ids: nestedAll.slice(1).map((n) => `D${n.id}`).join(', '),
        outerId: outer.id,
      }),
    )
  }
  return e
}

export function parseLegacyArchive(text: string): LegacyEntry[] {
  const lines = normalizeNewlines(text).split('\n')
  const boundaries: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (matchArchiveBoundary(lines[i])) boundaries.push(i)
  }
  return boundaries.map((start, bi) => {
    const end = bi + 1 < boundaries.length ? boundaries[bi + 1] : lines.length
    return processArchiveBlock(lines.slice(start, end))
  })
}

// ---------------------------------------------------------------------------

export function toDecision(entry: LegacyEntry, project: string): Decision {
  const slug = slugify(entry.title)
  const created = entry.date ? `${entry.date}T00:00:00+00:00` : nowStamp()
  // An 验收 entry is an ordinary decision whose only option is 验收通过; giving
  // it that option is what lets one key press settle it.
  const options =
    entry.options.length || !entry.isAcceptance ? entry.options : [{ ...ACCEPTANCE_OPTION, body: '' }]
  return {
    id: entry.id,
    title: entry.title,
    author: entry.author,
    status: entry.answer ? 'answered' : 'open',
    // A legacy answer always meant "filed away as done".
    state: entry.answer ? 'completed' : 'needs_decision',
    kind: 'decision',
    created,
    default: entry.default,
    pin: undefined,
    pinnedAt: undefined,
    answer: entry.answer,
    tags: [],
    body: entry.body,
    options,
    attachments: [],
    bodyAttachments: [],
    notes: [],
    approvals: [],
    file: `D${entry.id}-${slug}.md`,
    slug,
    archived: !!entry.answer,
    project,
  }
}
