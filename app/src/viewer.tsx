import { Code2, ExternalLink, FileText, Globe } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { Body } from './body.tsx'
import { s } from './strings.ts'
import type { Attachment, Node } from './types.ts'
import { clampPan, FIT, zoomTo, ZOOM_MIN, type ZoomState } from './zoom.ts'

/** One thing the big viewer can show. */
export interface ViewItem {
  name: string
  path: string
  image: boolean
  caption: string | null
}

const TEXT = /\.(txt|log|md|markdown|json|csv|tsv|ya?ml|toml|ini|xml|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|sh|sql|diff|patch)$/i
const MARKDOWN = /\.(md|markdown)$/i
const HTML = /\.html?$/i
export const kindOf = (it: ViewItem): 'image' | 'markdown' | 'html' | 'text' | 'other' =>
  it.image ? 'image' : MARKDOWN.test(it.path) ? 'markdown' : HTML.test(it.path) ? 'html' : TEXT.test(it.path) ? 'text' : 'other'

/** `rel` (a link or image in the page) as a file path, next to the page at `page`. Null for anything that leaves the folder's machine (http:, mailto:, …). */
function resolveLocal(page: string, rel: string): string | null {
  if (!rel || rel.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//')) return null
  const clean = decodeURIComponent(rel.split(/[?#]/)[0])
  const parts = (clean.startsWith('/') ? clean : `${page.slice(0, page.lastIndexOf('/'))}/${clean}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return `/${out.join('/')}`
}

/**
 * The page made safe to show: no scripts, frames, plugins, refreshes or event handlers, and
 * its images and stylesheets pointed at the files next to it. Shown in a sandbox that runs no
 * scripts either; anything remote stays blocked by the window's own content policy.
 */
export function safeHtml(html: string, page: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, noscript, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv]').forEach((e) => e.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name)
  })
  const point = (el: Element, attr: string) => {
    const file = resolveLocal(page, el.getAttribute(attr) ?? '')
    if (file) el.setAttribute(attr, api.imageSrc(file))
  }
  doc.querySelectorAll('img[src], source[src], video[src], audio[src], input[src]').forEach((e) => point(e, 'src'))
  doc.querySelectorAll('link[href]').forEach((e) => (/stylesheet|icon/i.test(e.getAttribute('rel') ?? '') ? point(e, 'href') : e.remove()))
  doc.querySelectorAll('img[srcset], source[srcset]').forEach((e) => e.removeAttribute('srcset'))
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

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
  const [zoom, setZoom] = useState<ZoomState>(FIT)
  // A click right after a drag-pan release must not fall through to the background's close.
  const draggedRef = useRef(false)
  useEffect(() => {
    setError(null)
    if (kind !== 'text' && kind !== 'markdown' && kind !== 'html') return
    let live = true
    void api.readPreview(it.path).then(
      (r) => live && setText({ path: it.path, body: r.text, truncated: r.truncated }),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [it.path])
  useEffect(() => setZoom(FIT), [it.path])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') (e.preventDefault(), e.stopPropagation(), p.onAt(Math.min(p.items.length - 1, p.at + 1)))
      else if (e.key === 'ArrowLeft') (e.preventDefault(), e.stopPropagation(), p.onAt(Math.max(0, p.at - 1)))
      else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), p.onClose())
      else if (e.key === 'o' || e.key === 'O') (e.preventDefault(), e.stopPropagation(), void api.openPath(it.path))
      else if (e.key === '0' && kind === 'image') (e.preventDefault(), e.stopPropagation(), setZoom(FIT))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [p.at, p.items, it.path, kind])
  /** Wheel (and trackpad pinch, which macOS reports as ctrl+wheel) zooms around the cursor. */
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const img = e.currentTarget as HTMLImageElement
    const rect = img.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const relY = e.clientY - rect.top
    setZoom((z) => {
      const scaled = zoomTo(z, z.scale * Math.exp(-e.deltaY * 0.0025), relX, relY)
      return clampPan(scaled, rect.width / z.scale, rect.height / z.scale, window.innerWidth, window.innerHeight)
    })
  }
  /** Drag to pan once zoomed in; a click right after release is swallowed above. */
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || zoom.scale <= ZOOM_MIN) return
    e.preventDefault()
    const img = e.currentTarget as HTMLImageElement
    img.setPointerCapture(e.pointerId)
    const rect = img.getBoundingClientRect()
    const fitW = rect.width / zoom.scale
    const fitH = rect.height / zoom.scale
    const x0 = e.clientX
    const y0 = e.clientY
    const start = zoom
    let moved = false
    const move = (m: PointerEvent) => {
      const dx = m.clientX - x0
      const dy = m.clientY - y0
      if (!moved && Math.hypot(dx, dy) < 3) return
      moved = true
      setZoom(clampPan({ ...start, x: start.x + dx, y: start.y + dy }, fitW, fitH, window.innerWidth, window.innerHeight))
    }
    const up = () => {
      img.removeEventListener('pointermove', move)
      img.removeEventListener('pointerup', up)
      img.removeEventListener('pointercancel', up)
      if (moved) {
        draggedRef.current = true
        setTimeout(() => (draggedRef.current = false), 0)
      }
    }
    img.addEventListener('pointermove', move)
    img.addEventListener('pointerup', up)
    img.addEventListener('pointercancel', up)
  }

  const shown = text?.path === it.path ? text : null
  const [source, setSource] = useState(false)
  const page = useMemo(() => (kind === 'html' && shown ? safeHtml(shown.body, it.path) : ''), [kind, shown?.body, it.path])
  /** Links in the page: out to the system's browser, or the file next to it opened with its own app. */
  const wire = (frame: HTMLIFrameElement | null) => {
    const doc = frame?.contentDocument
    if (!doc || (doc as unknown as { wired?: boolean }).wired) return
    ;(doc as unknown as { wired?: boolean }).wired = true
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]')
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#')) return void doc.getElementById(href.slice(1))?.scrollIntoView()
      const file = resolveLocal(it.path, href)
      void api.openPath(file ?? href)
    })
  }
  return (
    <div class="lightbox viewer" onClick={() => (draggedRef.current ? (draggedRef.current = false) : p.onClose())}>
      <div class={`viewer-stage ${kind}`} onClick={(e) => e.stopPropagation()}>
        {kind === 'image' && (
          <img
            src={api.imageSrc(it.path)}
            alt={it.name}
            draggable={false}
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onDblClick={() => setZoom(FIT)}
          />
        )}
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
        {kind === 'html' &&
          (!shown ? (
            <div class="viewer-text">{error ? <p class="s-error">{error}</p> : <p class="d">…</p>}</div>
          ) : source ? (
            <div class="viewer-text">
              <pre>{shown.body}</pre>
            </div>
          ) : (
            <iframe class="viewer-page" sandbox="allow-same-origin" srcdoc={page} title={it.name} onLoad={(e) => wire(e.currentTarget as HTMLIFrameElement)} />
          ))}
        {kind === 'other' && (
          <div class="viewer-other">
            <FileText size={40} strokeWidth={1.25} />
            <p>{s('previewNone')}</p>
          </div>
        )}
      </div>
      <div class="lb-caption" onClick={(e) => e.stopPropagation()}>
        <span class="cap-text">{it.caption ?? it.name}</span>
        {kind === 'image' && zoom.scale > ZOOM_MIN && <span class="d"> · {Math.round(zoom.scale * 100)}%</span>}
        {p.items.length > 1 && <span class="d"> · {p.at + 1} / {p.items.length}</span>}
        {kind === 'html' && (
          <button class="ghost viewer-open" onClick={() => setSource(!source)} aria-pressed={source}>
            {source ? <Globe size={13} strokeWidth={1.75} /> : <Code2 size={13} strokeWidth={1.75} />}
            {source ? s('previewPage') : s('previewSource')}
          </button>
        )}
        <button class="ghost viewer-open" onClick={() => void api.openPath(it.path)} title="O">
          <ExternalLink size={13} strokeWidth={1.75} />
          {s('previewOpen')}
        </button>
      </div>
    </div>
  )
}
