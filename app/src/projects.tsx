import { useEffect, useRef, useState } from 'preact/hooks'
import { useDialogFocus } from './focus.ts'
import { s } from './strings.ts'
import type { Project } from './types.ts'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** The sidebar row's name, as a text field while it is being renamed. Empty goes back to the folder name. */
export function RenameField({ project, onDone, onCancel }: { project: Project; onDone: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useDialogFocus(ref, { select: true })
  const folder = project.root.split(/[\\/]/).filter(Boolean).pop() ?? project.project
  return (
    <input
      ref={ref}
      class="rename"
      defaultValue={project.name}
      placeholder={folder}
      aria-label={s('ctxRename')}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onDone((e.currentTarget as HTMLInputElement).value.trim())
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={(e) => onDone((e.currentTarget as HTMLInputElement).value.trim())}
    />
  )
}

/** A–Z with the letters other projects use marked; picking one runs `decs config letter`. */
export function LetterPicker(p: { project: Project; projects: Project[]; busy: boolean; error: string | null; onPick: (letter: string) => void; onClose: () => void }) {
  const owner = new Map<string, string>()
  for (const o of p.projects) if (o.root !== p.project.root && o.letter !== 'X') owner.set(o.letter, o.name)
  const [at, setAt] = useState(Math.max(0, LETTERS.indexOf(p.project.letter)))
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref)
  const pick = (l: string) => {
    if (owner.has(l) || l === p.project.letter || p.busy) return
    p.onPick(l)
  }
  return (
    <div class="overlay" onClick={p.onClose}>
      <div
        class="letter-picker"
        ref={ref}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          const move = (d: number) => (e.preventDefault(), setAt((at + d + 26) % 26))
          if (e.key === 'Escape') return p.onClose()
          if (e.key === 'ArrowRight') return move(1)
          if (e.key === 'ArrowLeft') return move(-1)
          if (e.key === 'ArrowDown') return move(7)
          if (e.key === 'ArrowUp') return move(-7)
          if (e.key === 'Enter') return pick(LETTERS[at])
          if (/^[a-z]$/i.test(e.key)) {
            setAt(LETTERS.indexOf(e.key.toUpperCase()))
            pick(e.key.toUpperCase())
          }
        }}
      >
        <h3>{s('letterTitle', { project: p.project.name })}</h3>
        <p class="s-hint">{s('letterHint')}</p>
        <div class="letters">
          {LETTERS.map((l, i) => {
            const taken = owner.get(l)
            const current = l === p.project.letter
            return (
              <button
                key={l}
                class={`lp ${current ? 'current' : ''} ${taken ? 'taken' : ''} ${i === at ? 'focus' : ''}`}
                disabled={Boolean(taken) || p.busy}
                title={taken ? s('letterTakenBy', { project: taken }) : current ? s('letterCurrent') : ''}
                onMouseEnter={() => setAt(i)}
                onClick={() => pick(l)}
              >
                {l}
              </button>
            )
          })}
        </div>
        <p class="lp-note">{owner.get(LETTERS[at]) ? s('letterTakenBy', { project: owner.get(LETTERS[at])! }) : s('letterOldRefs', { letter: p.project.letter })}</p>
        {p.error && <p class="s-error">{p.error}</p>}
      </div>
    </div>
  )
}

/** Unlinking only forgets the project; this says so before it happens. */
export function UnlinkConfirm(p: { project: Project; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useDialogFocus(ref)
  return (
    <div class="overlay" onClick={p.onClose}>
      <div
        class="confirm"
        role="alertdialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') p.onClose()
        }}
      >
        <h3>{s('unlinkTitle', { project: p.project.name })}</h3>
        <p>{s('unlinkBody')}</p>
        <code class="path">{p.project.root}</code>
        {p.error && <p class="s-error">{p.error}</p>}
        <div class="row-actions end">
          <button class="ghost" ref={ref} onClick={p.onClose}>
            {s('cancel')}
          </button>
          <button class="primary danger" disabled={p.busy} onClick={p.onConfirm}>
            {s('ctxUnlink')}
          </button>
        </div>
      </div>
    </div>
  )
}
