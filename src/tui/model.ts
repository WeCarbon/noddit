import { t } from '../i18n/index.ts'
import { fromNow } from '../i18n/time.ts'
import { ATTACHMENTS_HEADING_RE, OPTIONS_HEADING_RE, parseNoteHeading } from '../core/parse.ts'
import { QUESTIONS_HEADING_RE } from '../core/questions.ts'
import { NOTE_KIND, NOTE_TEXT } from '../core/format.ts'
import type { Decision } from '../core/types.ts'
import { nodeImages, placeholderText, splitImageLinks, walkBody, type NodeImage } from './images.ts'
import { wrapToWidth } from './width.ts'

/**
 * `User | 2 days ago` / `Agent | lane-a | 3 days ago` — who and when only.
 * The full heading stays in the file for `decs get`; the bench just needs
 * whose words these are and how old.
 */
export function noteHeadline(note: { role: string; author: string; at: string }, now = Date.now()): string {
  const when = fromNow(note.at, now)
  if (note.role === 'human') return `${t('bench.note.user')} | ${when}`
  const name = note.author.split(/[ \t]*·[ \t]*/)[0]?.trim()
  return name ? `${t('bench.note.agent')} | ${name} | ${when}` : `${t('bench.note.agent')} | ${when}`
}

/** Default action only applies to an unsettled decision — Enter on a
 *  settled one would overwrite the owner's own answer. */
export function canUseDefault(d: Decision): boolean {
  return d.status === 'open' && Boolean(d.default)
}

/** Pinning is triage of the open queue; a settled entry has nowhere to be. */
export function canPin(d: Decision): boolean {
  return d.status === 'open'
}

export interface Segment {
  text: string
  /** Splits a row into blocks that a right-to-left layout reorders on their
   *  own and then swaps, so a row's suffix reads the same whatever its title holds. */
  gap?: boolean
  bold?: boolean
  dim?: boolean
  inverse?: boolean
  color?: string
  /** Which clickable entry (option/attachment key) this segment belongs to
   *  — carried through bidi reordering (it travels with the segment's own
   *  style) so a right-to-left footer's spans can be measured on whatever
   *  the algorithm actually produced, not assumed from the logical order. */
  key?: string
}

/**
 * The section headings decs itself reads (`## 选项`, `## Options（第 2 轮）`,
 * `## 附件`, `## 子问题` …) in the bench's language. The file keeps its own.
 */
function sectionLabel(line: string): string | undefined {
  const options = OPTIONS_HEADING_RE.exec(line)
  if (options) {
    const round = Number(options[1] ?? 1)
    return round > 1 ? t('bench.heading.optionsRound', { round }) : t('bench.heading.options')
  }
  if (ATTACHMENTS_HEADING_RE.test(line)) return t('bench.heading.attachments')
  if (QUESTIONS_HEADING_RE.test(line)) return t('bench.heading.questions')
  return undefined
}

/** Very light markdown for the terminal — enough for headings/emphasis to read as such. */
export function styleLine(line: string, now = Date.now()): Segment {
  // human (owner) vs agent must read differently at a glance.
  const note = /^##[ \t]/.test(line) ? parseNoteHeading(line) : null
  if (note) {
    const text = noteHeadline(note, now)
    return note.role === 'human' ? { text, bold: true, color: 'magenta' } : { text, color: 'blue' }
  }
  const known = sectionLabel(line)
  if (known) return { text: known, bold: true, color: 'cyan' }
  if (/^#{1,6}[ \t]/.test(line)) return { text: line.replace(/^#{1,6}[ \t]+/, ''), bold: true, color: 'cyan' }
  if (/^>[ \t]?/.test(line)) return { text: line.replace(/^>[ \t]?/, ''), dim: true }
  if (/^```/.test(line)) return { text: line, dim: true }
  if (/^[-*][ \t]/.test(line)) return { text: line, color: 'green' }
  return { text: line.replace(/\*\*/g, ''), bold: /^\*\*/.test(line) }
}

/**
 * Bold lead-ins that open the paragraphs worth keeping — what it is, why, where
 * to look. A body is written in whatever language its author used, so every
 * language's words count, whatever the bench itself speaks.
 */
const KEEP_PARAGRAPH = new RegExp(
  `^\\*\\*(${[
    '为什么', '这是什么', '是什么', '在哪看', '该看到',
    '為什麼', '這是什麼', '在哪看', '該看到',
    'What', 'Why', 'Where to look', 'What you should see',
    'Quoi', 'Pourquoi', 'Où regarder', 'Ce que vous devez voir',
    'ما هو', 'ما هي', 'لماذا', 'أين تنظر', 'ما يجب أن تراه',
  ].join('|')})`,
  'i',
)

/** The condensed view: what it is and why it matters, minus the evidence dump. */
export function condense(d: Decision): string {
  const paras = d.body.split(/\n{2,}/)
  const keep = paras.filter((p) => KEEP_PARAGRAPH.test(p.trim()))
  return (keep.length ? keep : paras.slice(0, 2)).join('\n\n')
}

const OPTION_HEADING = /^###[ \t]+([A-Za-z0-9]{1,4})[ \t]*(?:[·:：．.\-—–]{1,2}[ \t]*(.*))?$/

/** One display line of the body; `image` marks a `🖼️ alt` placeholder (index into `nodeImages`). */
export interface BodyRow {
  text: string
  image?: number
  /** Set on every row of a wrapped heading: styled whole, before wrapping, so
   *  its pieces don't each get re-read as body text. */
  style?: Omit<Segment, 'text'>
}

/**
 * The bodies decs writes under its own notes (`等 Carol`, `后面再做。…`) are
 * file content in one fixed language; the bench shows them in its own.
 */
function generatedNoteText(line: string, kind: string | undefined): string | undefined {
  if (kind === NOTE_KIND.waiting) {
    const m = /^等 (.+)$/.exec(line)
    return m ? t('core.render.waitingOn', { who: m[1] }) : undefined
  }
  if (kind === NOTE_KIND.deferred && line === NOTE_TEXT.deferred) return t('bench.noteText.deferred')
  if (kind === NOTE_KIND.undeferred && line === NOTE_TEXT.undeferred) return t('bench.noteText.undeferred')
  if (kind === NOTE_KIND.seen && line === NOTE_TEXT.seen) return t('bench.noteText.seen')
  if (kind === NOTE_KIND.addendum) {
    const m = /^(\S+) 已完成，这个节点的决定早已取走，开始执行。$/.exec(line)
    if (m) return t('bench.noteText.dependencyDone', { ref: m[1] })
  }
  if (kind === NOTE_KIND.superseded) {
    const m = /^被 (\S+) 取代：(.*)$/.exec(line)
    if (m) return t('bench.noteText.supersededBy', { ref: m[1], title: m[2] })
  }
  return undefined
}

/**
 * The body as displayable lines. Options stay inline (cost matters, footer
 * only has room for labels); so are attachment images — each `![alt](path)`
 * or `## 附件` entry becomes its own selectable `🖼️ alt` placeholder right
 * where it sits (under whichever note attached it, or the body), never the
 * picture itself. Condensed is a cut-down summary, not the full thread: it
 * keeps every attachment reachable but as one block at the end, since
 * `condense()`'s paragraph filter may have dropped the note that placed it.
 */
export function bodyRows(d: Decision, width: number, condensed: boolean, images: NodeImage[] = nodeImages(d)): BodyRow[] {
  const out: BodyRow[] = []
  // Matched by occurrence so the condensed body still points at the right entry.
  const used = new Set<number>()
  const find = (alt: string, target: string) =>
    images.findIndex((im, i) => im.source === 'body' && !used.has(i) && im.alt === alt && im.target === target)
  const findAttachment = (n: number) => images.findIndex((im) => im.source === 'attachment' && im.attachment === n)
  let noteKind: string | undefined
  // An infinite width is a window that wraps for itself.
  const wrap = (text: string) => (Number.isFinite(width) ? wrapToWidth(text, width) : [text])
  const pushText = (raw: string) => {
    // HTML comments are bookkeeping for tools (writer marks, group ends), never for reading.
    if (/^\s*<!--.*-->\s*$/.test(raw)) return
    if (/^#{1,6}[ \t]/.test(raw)) {
      noteKind = parseNoteHeading(raw)?.kind
      const { text, ...style } = styleLine(markDefault(raw, d))
      for (const piece of wrap(text)) out.push({ text: piece, style })
      return
    }
    const line = generatedNoteText(raw.trim(), noteKind) ?? raw
    for (const text of line.trim() ? wrap(line) : ['']) out.push({ text })
  }
  let attIdx = 0
  walkBody(condensed ? condense(d) : d.body, (raw, inCode, inAttachments) => {
    if (inAttachments) {
      const n = attIdx++
      if (!condensed) {
        const i = findAttachment(n)
        if (i >= 0) out.push({ text: placeholderText(images[i]), image: i })
      }
      return
    }
    if (condensed && ATTACHMENTS_HEADING_RE.test(raw)) return
    const parts = inCode ? [] : splitImageLinks(raw)
    if (!parts.some((p) => 'target' in p)) return pushText(raw)
    for (const p of parts) {
      if ('text' in p) {
        if (p.text.trim()) pushText(p.text.trim())
        continue
      }
      const i = find(p.alt, p.target)
      if (i >= 0) used.add(i)
      out.push(i >= 0 ? { text: placeholderText(images[i]), image: i } : { text: placeholderText(p) })
    }
  })
  while (out.length && !out[out.length - 1].text.trim()) out.pop()
  if (condensed) {
    const attached = images.flatMap((im, i) => (im.source === 'attachment' ? [i] : []))
    if (attached.length) {
      if (out.length) out.push({ text: '' })
      out.push({ text: t('bench.detail.attachmentsHeading') })
      for (const i of attached) out.push({ text: placeholderText(images[i]), image: i })
    }
  }
  return out
}

export function bodyLines(d: Decision, width: number, condensed: boolean): string[] {
  return bodyRows(d, width, condensed).map((r) => r.text)
}

/** Says which option happens on its own, right where the costs are being read. */
function markDefault(line: string, d: Decision): string {
  const m = OPTION_HEADING.exec(line)
  if (!m || m[1] !== d.default) return line
  return `${line.replace(/\s+$/, '')}${t('bench.detail.defaultHint')}`
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

const HTML_TARGET = /\.html?$/i

/** 0-based index of the first HTML-looking attachment (what `H` opens), or -1. */
export function firstHtmlAttachmentIndex(d: Decision): number {
  return d.attachments.findIndex((a) => HTML_TARGET.test(a.target.split(/[?#]/)[0]))
}
