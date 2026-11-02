import { ExternalLink, FileText } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { Body } from './body.tsx'
import { s } from './strings.ts'
import type { Attachment, Node } from './types.ts'

/** One thing the big viewer can show. */
export interface ViewItem {
  name: string
  path: string
  image: boolean
  caption: string | null
}

const TEXT = /\.(txt|log|md|markdown|json|csv|tsv|ya?ml|toml|ini|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|sh|sql|diff|patch)$/i
const MARKDOWN = /\.(md|markdown)$/i
export const kindOf = (it: ViewItem): 'image' | 'markdown' | 'text' | 'other' =>
  it.image ? 'image' : MARKDOWN.test(it.path) ? 'markdown' : TEXT.test(it.path) ? 'text' : 'other'

const fromAttachment = (a: Attachment): ViewItem => ({ name: a.label, path: a.path, image: a.image, caption: a.caption })

/**
 * What ←→ flips through when `path` is opened: the attachments of the message it belongs to
 * (the body's own, or one note's), else every image and file of the node.
 */
export function itemsAround(n: Node, path: string): { items: ViewItem[]; at: number } {
  const groups: Attachment[][] = [n.body_attachments ?? [], ...(n.notes ?? []).map((x) => x.attachments ?? [])].filter((g) => g.length)
  const group = groups.find((g) => g.some((a) => a.path === path))
  const items = group
    ? group.map(fromAttachment)
    : [
        ...n.images.map((im) => ({ name: im.name, path: im.path, image: true, caption: im.caption })),
        ...n.attachments.filter((a) => !a.image).map(fromAttachment),
      ]
  return { items, at: Math.max(0, items.findIndex((x) => x.path === path)) }
}

/** Markdown as the bench reads it: a `#` line becomes a heading row, the rest plain rows. */
const markdownRows = (text: string) =>
  text.split('\n').map((line) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    return h ? { text: h[2], style: { text: '', bold: true } } : { text: line }
  })

/**
 * The big viewer: images (GIFs move), text and markdown read in place (the first megabyte),
 * anything else offered to the system's own app. ←→ flip, O opens the file outside, Esc closes.
 */
export function Viewer(p: { items: ViewItem[]; at: number; onAt: (i: number) => void; onClose: () => void }) {
  const it = p.items[p.at]
  const kind = kindOf(it)
  const [text, setText] = useState<{ path: string; body: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setError(null)
    if (kind !== 'text' && kind !== 'markdown') return
    let live = true
    void api.readPreview(it.path).then(
      (r) => live && setText({ path: it.path, body: r.text, truncated: r.truncated }),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [it.path])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') (e.preventDefault(), e.stopPropagation(), p.onAt(Math.min(p.items.length - 1, p.at + 1)))
      else if (e.key === 'ArrowLeft') (e.preventDefault(), e.stopPropagation(), p.onAt(Math.max(0, p.at - 1)))
      else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), p.onClose())
      else if (e.key === 'o' || e.key === 'O') (e.preventDefault(), e.stopPropagation(), void api.openPath(it.path))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [p.at, p.items, it.path])

  const shown = text?.path === it.path ? text : null
  return (
    <div class="lightbox viewer" onClick={p.onClose}>
      <div class={`viewer-stage ${kind}`} onClick={(e) => e.stopPropagation()}>
        {kind === 'image' && <img src={api.imageSrc(it.path)} alt={it.name} />}
        {(kind === 'text' || kind === 'markdown') && (
          <div class="viewer-text">
            {error ? (
              <p class="s-error">{error}</p>
            ) : !shown ? (
              <p class="d">…</p>
            ) : kind === 'markdown' ? (
              <Body rows={markdownRows(shown.body)} images={[]} onImage={() => {}} />
            ) : (
              <pre>{shown.body}</pre>
            )}
            {shown?.truncated && <p class="viewer-note">{s('previewTruncated')}</p>}
          </div>
        )}
        {kind === 'other' && (
          <div class="viewer-other">
            <FileText size={40} strokeWidth={1.25} />
            <p>{s('previewNone')}</p>
          </div>
        )}
      </div>
      <div class="lb-caption" onClick={(e) => e.stopPropagation()}>
        <span class="cap-text">{it.caption ?? it.name}</span>
        {p.items.length > 1 && <span class="d"> · {p.at + 1} / {p.items.length}</span>}
        <button class="ghost viewer-open" onClick={() => void api.openPath(it.path)} title="O">
          <ExternalLink size={13} strokeWidth={1.75} />
          {s('previewOpen')}
        </button>
      </div>
    </div>
  )
}
