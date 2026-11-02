import { basename } from 'node:path'
import { ATTACHMENT_GROUP_END } from '../core/format.ts'
import { ATTACHMENT_CAPTION_RE, ATTACHMENT_GROUP_RE, ATTACHMENTS_HEADING_RE } from '../core/parse.ts'
import type { Decision } from '../core/types.ts'

/**
 * Every picture a node shows, in draw order: inline `![alt](path)` links and
 * `## 附件` attachments, interleaved exactly as the file has them — each
 * right where its own message put it, not bucketed at the end. One list, so
 * ↑/↓, ←/→ and mouse clicks agree on "the next image". Bench shows only a
 * `🖼️ alt` placeholder; the picture itself is in the big view.
 */
export interface NodeImage {
  /** Link text; may be empty (`placeholderText` falls back to the filename). */
  alt: string
  /** As written: relative to the node file, absolute, or a URL. */
  target: string
  source: 'body' | 'attachment'
  /** 0-based index into `d.attachments`, for `source: 'attachment'`. */
  attachment?: number
  group?: string
  caption?: string
}

const IMAGE_LINK = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const FENCE = /^\s*```/
const ANY_H2 = /^##[ \t]+\S/

/** A line split into prose and image links, in order. */
export type LinePart = { text: string } | { alt: string; target: string }

export function splitImageLinks(line: string): LinePart[] {
  const out: LinePart[] = []
  let last = 0
  for (const m of line.matchAll(IMAGE_LINK)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) })
    out.push({ alt: m[1].trim(), target: m[2] })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out
}

/**
 * Walks body lines as the detail pane shows them, leaving fenced code alone
 * (a link inside is an example, not a picture). Inside a `## 附件` block, only
 * the heading and each attachment-link line reach `visit` (flagged
 * `inAttachments`) — a blank line, a `**group**` marker, a caption or the
 * group-end comment are bookkeeping the attachment list already carries
 * (`d.attachments[].group`/`.caption`), not body text, so they're dropped.
 */
export function walkBody(body: string, visit: (line: string, inCode: boolean, inAttachments?: boolean) => void): void {
  let inCode = false
  let inAttachments = false
  for (const raw of body.split('\n')) {
    if (!inCode && ANY_H2.test(raw)) {
      inAttachments = ATTACHMENTS_HEADING_RE.test(raw)
      visit(raw, false)
      continue
    }
    if (inAttachments) {
      const trimmed = raw.trim()
      if (!trimmed) {
        visit(raw, false) // a blank line still reads as a blank row, same as anywhere else in the body
        continue
      }
      if (trimmed === ATTACHMENT_GROUP_END || ATTACHMENT_GROUP_RE.test(trimmed) || ATTACHMENT_CAPTION_RE.test(trimmed)) continue
      visit(raw, false, true)
      continue
    }
    const fence = FENCE.test(raw)
    visit(raw, inCode || fence)
    if (fence) inCode = !inCode
  }
}

export function nodeImages(d: Pick<Decision, 'body' | 'attachments'>): NodeImage[] {
  const out: NodeImage[] = []
  const attachments = d.attachments ?? []
  let attIdx = 0
  walkBody(d.body ?? '', (line, inCode, inAttachments) => {
    if (inAttachments) {
      const a = attachments[attIdx++]
      if (a?.image) out.push({ alt: a.label, target: a.target, source: 'attachment', attachment: attIdx - 1, group: a.group, caption: a.caption })
      return
    }
    if (inCode) return
    for (const p of splitImageLinks(line)) if ('target' in p) out.push({ alt: p.alt, target: p.target, source: 'body' })
  })
  return out
}

/** What the image is called on screen: its alt text, else its file name. */
export function imageName(img: Pick<NodeImage, 'alt' | 'target'>): string {
  return img.alt || basename(img.target.split(/[?#]/)[0]) || img.target
}

/**
 * U+1F5BC + VS16 (emoji presentation): bare U+1F5BC measures one column via
 * string-width but most terminals draw it two wide, drifting the pane edge.
 */
export const IMAGE_MARK = '\u{1F5BC}\uFE0F'

export function placeholderText(img: Pick<NodeImage, 'alt' | 'target' | 'group'>): string {
  return `${IMAGE_MARK} ${imageName(img)}${img.group ? `（${img.group}）` : ''}`
}

/**
 * One step through the node's images, stopping at either end rather than
 * wrapping (wrap-around looks like "nothing happened"). `edge` says which
 * end was hit.
 */
export function stepImage(index: number, total: number, delta: 1 | -1): { index: number; edge?: 'first' | 'last' } {
  if (total <= 0) return { index: 0 }
  const from = Math.max(0, Math.min(index, total - 1))
  const next = from + delta
  if (next < 0) return { index: 0, edge: 'first' }
  if (next >= total) return { index: total - 1, edge: 'last' }
  return { index: next }
}

/** Images whose placeholder is actually in the (possibly condensed) body — `rows[n] >= 0`. */
export function selectableImages(rows: number[]): number[] {
  return rows.flatMap((r, n) => (r >= 0 ? [n] : []))
}

/** `stepImage` over selectable images only; from a hidden one, lands on the nearest selectable in that direction. */
export function stepSelectable(sel: number, rows: number[], delta: 1 | -1): { index: number; edge?: 'first' | 'last' } {
  const vis = selectableImages(rows)
  if (!vis.length) return { index: sel }
  const pos = vis.indexOf(sel)
  if (pos === -1) {
    const next = delta > 0 ? vis.find((n) => n > sel) : [...vis].reverse().find((n) => n < sel)
    return next !== undefined ? { index: next } : { index: delta > 0 ? vis[vis.length - 1] : vis[0], edge: delta > 0 ? 'last' : 'first' }
  }
  const step = stepImage(pos, vis.length, delta)
  return { ...step, index: vis[step.index] }
}

/** Smallest scroll putting body line `row` on screen; clamps `offset` the same way the renderer does. */
export function ensureVisible(row: number, offset: number, rows: number, total: number): number {
  const max = Math.max(0, total - rows)
  const off = Math.max(0, Math.min(offset, max))
  if (row < 0) return off
  if (row < off) return row
  if (row >= off + rows) return Math.min(max, row - rows + 1)
  return off
}
