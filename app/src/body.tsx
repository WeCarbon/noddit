import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { imageSrc } from './backend.ts'
import { findRefs, type RefLinker } from './refs.ts'
import { segClass } from './segs.tsx'
import type { BodyRow, Image } from './types.ts'

/** A node ref rendered in place, as a plain clickable span (not `<a>`/`<button>`, so it nests
 *  safely inside a `<button>` option card without breaking HTML or double-firing its click). */
function RefLink({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <span
      class="ref-link"
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
    >
      {text}
    </span>
  )
}

/** `text`, with any node ref that resolves to a real node swapped for a `RefLink`; a ref whose
 *  letter isn't a known project, or that resolves to no node, is left as plain text. */
function splitRefs(text: string, refs: RefLinker | undefined, nextKey: () => number): ComponentChildren[] {
  if (!refs) return [text]
  const matches = findRefs(text, refs.knownLetters)
  if (!matches.length) return [text]
  const out: ComponentChildren[] = []
  let last = 0
  for (const m of matches) {
    const key = refs.resolve(`${m.letter}${m.id}`)
    if (!key) continue
    if (m.start > last) out.push(text.slice(last, m.start))
    out.push(<RefLink key={nextKey()} text={m.text} onClick={() => refs.jump(key)} />)
    last = m.end
  }
  if (!out.length) return [text]
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** A plain string with node refs linked — titles, option labels, a note's one-line summary: text
 *  that never carries the rest of `Inline`'s markdown. */
export function RefText({ text, refs }: { text: string; refs?: RefLinker }) {
  let i = 0
  return <>{splitRefs(text, refs, () => i++)}</>
}

/** `**bold**`, `` `code` ``, links, and node refs — the little markdown a node's prose leans on. */
export function Inline({ text, refs }: { text: string; refs?: RefLinker }) {
  const out: ComponentChildren[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g
  let last = 0
  let i = 0
  const nextKey = () => i++
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(...splitRefs(text.slice(last, m.index), refs, nextKey))
    if (m[1] !== undefined) out.push(<strong key={nextKey()}>{splitRefs(m[1], refs, nextKey)}</strong>)
    else if (m[2] !== undefined) out.push(<code key={nextKey()}>{m[2]}</code>)
    else if (m[3] !== undefined) out.push(<a key={nextKey()} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>)
    else out.push(<a key={nextKey()} href={m[5]} target="_blank" rel="noreferrer">{m[5]}</a>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...splitRefs(text.slice(last), refs, nextKey))
  return <>{out}</>
}

type Block =
  | { kind: 'heading'; row: BodyRow }
  | { kind: 'note'; row: BodyRow; human: boolean; rows: Block[]; index: number }
  | { kind: 'para'; lines: string[] }
  | { kind: 'list'; items: string[]; ordered: boolean }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'image'; index: number }
  | { kind: 'compare'; indices: number[] }
  | { kind: 'table'; rows: string[][] }

const isNoteHeading = (r: BodyRow) => Boolean(r.style && (r.style.color === 'magenta' || r.style.color === 'blue'))

/** A section heading that only introduces attachments: images follow, or nothing does before the next heading. */
function attachmentsHeading(rows: BodyRow[], at: number): boolean {
  for (let i = at + 1; i < rows.length; i++) {
    const r = rows[i]
    if (r.image !== undefined) return true
    if (r.style) return true
    if (r.text.trim()) return false
  }
  return true
}

function blocks(rows: BodyRow[], images: Image[], dropAttachmentHeadings = false): Block[] {
  const out: Block[] = []
  let target = out
  let para: string[] | null = null
  let code: string[] | null = null
  const flush = () => {
    if (para?.length) target.push({ kind: 'para', lines: para })
    para = null
  }
  for (let at = 0; at < rows.length; at++) {
    const r = rows[at]
    if (code) {
      if (/^\s*```/.test(r.text)) {
        target.push({ kind: 'code', lines: code })
        code = null
      } else code.push(r.text)
      continue
    }
    if (/^\s*```/.test(r.text) && !r.style) {
      flush()
      code = []
      continue
    }
    if (r.image !== undefined) {
      flush()
      const prev = target.at(-1)
      const grouped = (i: number) => Boolean(images[i]?.group)
      // Attachments labelled with groups (before / after, option 1 / option 2) are one comparison.
      if (grouped(r.image) && prev?.kind === 'compare') prev.indices.push(r.image)
      else if (grouped(r.image) && prev?.kind === 'image' && grouped(prev.index) && images[prev.index].group !== images[r.image].group)
        target[target.length - 1] = { kind: 'compare', indices: [prev.index, r.image] }
      else target.push({ kind: 'image', index: r.image })
      continue
    }
    if (r.style) {
      flush()
      // Files are drawn under their own message by the caller; the heading would only repeat that.
      if (dropAttachmentHeadings && !isNoteHeading(r) && attachmentsHeading(rows, at)) continue
      if (isNoteHeading(r)) {
        const note: Block = { kind: 'note', row: r, human: r.style.color === 'magenta', rows: [], index: out.filter((b) => b.kind === 'note').length }
        out.push(note)
        target = note.rows
      } else target.push({ kind: 'heading', row: r })
      continue
    }
    const t = r.text
    if (!t.trim()) {
      flush()
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(t)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(t)
    if (bullet || numbered) {
      flush()
      const ordered = Boolean(numbered)
      const prev = target.at(-1)
      const item = (bullet ?? numbered)![1]
      if (prev?.kind === 'list' && prev.ordered === ordered) prev.items.push(item)
      else target.push({ kind: 'list', items: [item], ordered })
      continue
    }
    if (/^\s*>/.test(t)) {
      flush()
      const prev = target.at(-1)
      const line = t.replace(/^\s*>\s?/, '')
      if (prev?.kind === 'quote') prev.lines.push(line)
      else target.push({ kind: 'quote', lines: [line] })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(t)) {
      flush()
      if (/^\s*\|[\s:|-]+\|\s*$/.test(t)) continue
      const cells = t.trim().slice(1, -1).split('|').map((c) => c.trim())
      const prev = target.at(-1)
      if (prev?.kind === 'table') prev.rows.push(cells)
      else target.push({ kind: 'table', rows: [cells] })
      continue
    }
    ;(para ??= []).push(t)
  }
  flush()
  if (code) target.push({ kind: 'code', lines: code })
  return out
}

/** `AI | lane-a | 3 hours ago` / `User | 3 hours ago`, as decs words it, laid out on one line: name · when, role.
 *  N203/N206: a `summary` (the note's own one-line `--summary`) takes the title spot instead — who/when
 *  moves down to a small secondary line, same idea as a chat message's own one-line preview. */
function NoteHead({ text, summary, label, tools, refs }: { text: string; summary?: string | null; label?: string | null; tools?: preact.ComponentChildren; refs?: RefLinker }) {
  const parts = text.split(' | ')
  const role = parts[0]
  const when = parts.length > 1 ? parts.at(-1)! : ''
  const who = parts.length > 2 ? parts.slice(1, -1).join(' | ') : role
  if (summary) {
    return (
      <header class="has-summary" title={text}>
        <span class="dot" />
        <div class="head-text">
          <span class="summary" dir="auto"><RefText text={summary} refs={refs} /></span>
          <span class="who-line">
            {label && <span class="decision-label">{label}</span>}
            <span class="who">{who}</span>
            {when && <span class="when">· {when}</span>}
          </span>
        </div>
        {tools && <span class="note-tools">{tools}</span>}
      </header>
    )
  }
  return (
    <header title={text}>
      <span class="dot" />
      {label && <span class="decision-label">{label}</span>}
      <span class="who">{who}</span>
      {when && <span class="when">· {when}</span>}
      {who !== role && <span class="role">{role}</span>}
      {tools && <span class="note-tools">{tools}</span>}
    </header>
  )
}

/** What a caller can add to a note: tools in its header, or something (an editor) in place of its text. */
export interface NoteHooks {
  tools?: (index: number, human: boolean) => preact.ComponentChildren
  replace?: (index: number) => preact.ComponentChildren | null
  /** Drawn at the end of each note (its files), and after the description (`-1`). When set, attachment headings are left out. */
  after?: (index: number) => preact.ComponentChildren | null
  /** The note's own one-line summary (N203/N206), shown as its title instead of who/when. */
  summary?: (index: number) => string | null | undefined
  /** An answer's own label (「Decided」/「Answer changed」); the note is then drawn as a decision block. */
  decision?: (index: number) => string | null | undefined
}

function Blocks({ list, images, onImage, notes, refs }: { list: Block[]; images: Image[]; onImage: (i: number) => void; notes?: NoteHooks; refs?: RefLinker }) {
  return (
    <>
      {list.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <h3 dir="auto" key={i} class={segClass({ ...b.row.style, color: undefined })}><Inline text={b.row.text} refs={refs} /></h3>
          case 'note': {
            const decision = notes?.decision?.(b.index)
            return (
              <section key={i} class={`note ${b.human ? 'human' : 'agent'}${decision ? ' decision' : ''}`} data-ctx="note">
                <NoteHead text={b.row.text} summary={notes?.summary?.(b.index)} label={decision} tools={notes?.tools?.(b.index, b.human)} refs={refs} />
                <div class="note-body">
                  {notes?.replace?.(b.index) ?? <Blocks list={b.rows} images={images} onImage={onImage} refs={refs} />}
                  {notes?.after?.(b.index)}
                </div>
              </section>
            )
          }
          case 'para':
            return (
              <p dir="auto" key={i}>
                {b.lines.map((l, j) => (
                  <>
                    {j > 0 && <br />}
                    <Inline text={l} refs={refs} />
                  </>
                ))}
              </p>
            )
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul'
            return (
              <L dir="auto" key={i}>
                {b.items.map((it, j) => (
                  <li dir="auto" key={j}>
                    <Inline text={it} refs={refs} />
                  </li>
                ))}
              </L>
            )
          }
          case 'quote':
            return (
              <blockquote dir="auto" key={i}>
                {b.lines.map((l, j) => (
                  <div key={j}>
                    <Inline text={l} refs={refs} />
                  </div>
                ))}
              </blockquote>
            )
          case 'code':
            return <pre key={i}>{b.lines.join('\n')}</pre>
          case 'table':
            return (
              <div class="table-wrap" key={i}>
                <table>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (j === 0 ? <th key={k}><Inline text={c} refs={refs} /></th> : <td key={k}><Inline text={c} refs={refs} /></td>))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'compare':
            // A before/after pair flips; more than two are simply shown one after another.
            if (b.indices.length !== 2) return b.indices.map((ix) => <Shot key={`${i}-${ix}`} index={ix} images={images} onImage={onImage} />)
            return <Compare key={i} indices={b.indices} images={images} onImage={onImage} />
          case 'image':
            return <Shot key={i} index={b.index} images={images} onImage={onImage} />
        }
      })}
    </>
  )
}

/** One image at full width, its name or caption under it; a click opens the viewer. */
function Shot({ index, images, onImage }: { index: number; images: Image[]; onImage: (i: number) => void }) {
  const im = images[index]
  if (!im) return null
  const text = im.caption ?? im.name
  return (
    <figure class="shot" data-ctx="image" data-index={index} onClick={() => onImage(index)}>
      <img src={imageSrc(im.path)} alt={im.name} loading="lazy" decoding="async" />
      <figcaption title={text}>
        {im.group && <span class="chip">{im.group}</span>}
        <span class="cap-text">{text}</span>
      </figcaption>
    </figure>
  )
}

/** A labelled pair (before / after) shown one at a time, flipped by the labels — side by side on request. */
function Compare({ indices, images, onImage }: { indices: number[]; images: Image[]; onImage: (i: number) => void }) {
  const [at, setAt] = useState(0)
  const [side, setSide] = useState(false)
  const shown = side ? indices : [indices[at]]
  return (
    <figure
      class={`compare ${side ? 'side' : ''}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') (e.stopPropagation(), setAt((at + 1) % indices.length))
        if (e.key === 'ArrowLeft') (e.stopPropagation(), setAt((at - 1 + indices.length) % indices.length))
      }}
    >
      <div class="seg">
        {indices.map((ix, k) => (
          <button key={ix} class={!side && k === at ? 'on' : ''} onClick={() => (setSide(false), setAt(k))} title={images[ix].group ?? undefined}>
            <span class="seg-text">{images[ix].group}</span>
          </button>
        ))}
        <button class={side ? 'on' : ''} onClick={() => setSide(!side)} title="⇆">
          ⇆
        </button>
      </div>
      <div class="frames">
        {shown.map((ix) => (
          <div key={ix} class="frame" data-ctx="image" data-index={ix} onClick={() => onImage(ix)}>
            <img src={imageSrc(images[ix].path)} alt={images[ix].name} loading="lazy" decoding="async" />
            <figcaption title={images[ix].caption ?? images[ix].name}>
              {side && <span class="chip">{images[ix].group}</span>}
              <span class="cap-text">{images[ix].caption ?? images[ix].name}</span>
            </figcaption>
          </div>
        ))}
      </div>
    </figure>
  )
}

/** HTML comments (`<!-- nod:by=… -->`, group ends) are bookkeeping in the file, never text to read. */
export function withoutComments(rows: BodyRow[]): BodyRow[] {
  const out: BodyRow[] = []
  let open = false
  for (const r of rows) {
    if (r.image !== undefined || r.style) {
      out.push(r)
      continue
    }
    let text = r.text
    if (open) {
      const end = text.indexOf('-->')
      if (end === -1) continue
      text = text.slice(end + 3)
      open = false
    }
    text = text.replace(/<!--[\s\S]*?-->/g, '')
    const start = text.indexOf('<!--')
    if (start !== -1) {
      text = text.slice(0, start)
      open = true
    }
    if (text.trim() || !r.text.includes('<!--') && !r.text.includes('-->')) out.push(text === r.text ? r : { ...r, text })
  }
  return out
}

export function Body({ rows, images, onImage, notes, refs }: { rows: BodyRow[]; images: Image[]; onImage: (i: number) => void; notes?: NoteHooks; refs?: RefLinker }) {
  return (
    <div class="prose">
      {(() => {
        const list = blocks(withoutComments(rows), images, Boolean(notes?.after))
        if (!notes?.after) return <Blocks list={list} images={images} onImage={onImage} notes={notes} refs={refs} />
        // The description's own files sit between it and the first note.
        const first = list.findIndex((b) => b.kind === 'note')
        const head = first === -1 ? list : list.slice(0, first)
        const rest = first === -1 ? [] : list.slice(first)
        return (
          <>
            <Blocks list={head} images={images} onImage={onImage} notes={notes} refs={refs} />
            {notes.after(-1)}
            <Blocks list={rest} images={images} onImage={onImage} notes={notes} refs={refs} />
          </>
        )
      })()}
    </div>
  )
}
