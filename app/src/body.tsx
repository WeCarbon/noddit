import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { imageSrc } from './backend.ts'
import { segClass } from './segs.tsx'
import type { BodyRow, Image } from './types.ts'

/** `**bold**`, `` `code` ``, and links — the little markdown a node's prose leans on. */
export function Inline({ text }: { text: string }) {
  const out: ComponentChildren[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<strong key={i++}>{m[1]}</strong>)
    else if (m[2] !== undefined) out.push(<code key={i++}>{m[2]}</code>)
    else if (m[3] !== undefined) out.push(<a key={i++} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>)
    else out.push(<a key={i++} href={m[5]} target="_blank" rel="noreferrer">{m[5]}</a>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

type Block =
  | { kind: 'heading'; row: BodyRow }
  | { kind: 'note'; row: BodyRow; human: boolean; rows: Block[] }
  | { kind: 'para'; lines: string[] }
  | { kind: 'list'; items: string[]; ordered: boolean }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'image'; index: number }
  | { kind: 'compare'; indices: number[] }
  | { kind: 'table'; rows: string[][] }

const isNoteHeading = (r: BodyRow) => Boolean(r.style && (r.style.color === 'magenta' || r.style.color === 'blue'))

function blocks(rows: BodyRow[], images: Image[]): Block[] {
  const out: Block[] = []
  let target = out
  let para: string[] | null = null
  let code: string[] | null = null
  const flush = () => {
    if (para?.length) target.push({ kind: 'para', lines: para })
    para = null
  }
  for (const r of rows) {
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
      if (isNoteHeading(r)) {
        const note: Block = { kind: 'note', row: r, human: r.style.color === 'magenta', rows: [] }
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

/** `AI | lane-a | 3 hours ago` / `User | 3 hours ago`, as decs words it, laid out on one line: name · when, role. */
function NoteHead({ text }: { text: string }) {
  const parts = text.split(' | ')
  const role = parts[0]
  const when = parts.length > 1 ? parts.at(-1)! : ''
  const who = parts.length > 2 ? parts.slice(1, -1).join(' | ') : role
  return (
    <header title={text}>
      <span class="dot" />
      <span class="who">{who}</span>
      {when && <span class="when">· {when}</span>}
      {who !== role && <span class="role">{role}</span>}
    </header>
  )
}

function Blocks({ list, images, onImage }: { list: Block[]; images: Image[]; onImage: (i: number) => void }) {
  return (
    <>
      {list.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <h3 dir="auto" key={i} class={segClass({ ...b.row.style, color: undefined })}>{b.row.text}</h3>
          case 'note':
            return (
              <section key={i} class={`note ${b.human ? 'human' : 'agent'}`} data-ctx="note">
                <NoteHead text={b.row.text} />
                <div class="note-body">
                  <Blocks list={b.rows} images={images} onImage={onImage} />
                </div>
              </section>
            )
          case 'para':
            return (
              <p dir="auto" key={i}>
                {b.lines.map((l, j) => (
                  <>
                    {j > 0 && <br />}
                    <Inline text={l} />
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
                    <Inline text={it} />
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
                    <Inline text={l} />
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
                        {r.map((c, k) => (j === 0 ? <th key={k}><Inline text={c} /></th> : <td key={k}><Inline text={c} /></td>))}
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

export function Body({ rows, images, onImage }: { rows: BodyRow[]; images: Image[]; onImage: (i: number) => void }) {
  return (
    <div class="prose">
      <Blocks list={blocks(rows, images)} images={images} onImage={onImage} />
    </div>
  )
}
