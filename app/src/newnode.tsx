import { Bot, FolderGit2, Play, Star, User, WandSparkles } from 'lucide-preact'
import { cols } from './cols.ts'
import { limitInput } from './limit-input.ts'
import { useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { DateField } from './datefield.tsx'
import { useDialogFocus } from './focus.ts'
import { s } from './strings.ts'
import type { Project } from './types.ts'

const ICON = { size: 14, strokeWidth: 1.75 }

/**
 * ⌘N: a node of any kind, in one sheet. Who does it decides what it becomes — the owner's
 * own to-do, a task an AI simply does, or a few words an AI expands first (the same thing
 * ⌘K files, which stays the one-line shortcut for that).
 */
export function NewNode(p: {
  projects: Project[]
  project: Project | null
  under: { ref: string; title: string; project: string } | null
  onClose: () => void
  onDone: (made: { ref: string; project: string }, project: Project) => void
}) {
  const [project, setProject] = useState<Project | null>(p.project)
  const [title, setTitle] = useState('')
  const [who, setWho] = useState<api.Who>('me')
  const [nested, setNested] = useState(false)
  const [important, setImportant] = useState(false)
  const [start, setStart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  useDialogFocus(field)
  const under = p.under && project && p.under.project === project.project ? p.under : null
  const ready = Boolean(project && title.trim())

  const save = async () => {
    if (!project) return setError(s('newNeedsProject'))
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await api.addNode(project.root, {
        title: title.trim(),
        who,
        parentRef: nested && under ? under.ref : undefined,
        important,
        start,
      })
      p.onDone(made, project)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const whoChoices: { id: api.Who; icon: preact.ComponentChildren; label: string; hint: string }[] = [
    { id: 'me', icon: <User {...ICON} />, label: s('whoMe'), hint: s('whoMeHint') },
    { id: 'ai', icon: <Bot {...ICON} />, label: s('whoAi'), hint: s('whoAiHint') },
    { id: 'brief', icon: <WandSparkles {...ICON} />, label: s('whoBrief'), hint: s('whoBriefHint') },
  ]

  return (
    <div class="overlay" onClick={p.onClose}>
      <div class="sheet new-node" role="dialog" aria-label={s('newTitle')} onClick={(e) => e.stopPropagation()}>
        <h3 class="sheet-title">{s('newTitle')}</h3>
        <div class="sheet-section">
          <input
            ref={field}
            class="field field-lg new-title"
            value={title}
            placeholder={s('newPlaceholder')}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') p.onClose()
              if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), void save())
            }}
          />
        </div>

        <div class="sheet-section">
          <div class="sheet-label">{s('newProject')}</div>
          <div class="new-row">
          <label class={`qchip ${project ? '' : 'warn'}`} title={s('quickProject')}>
            <FolderGit2 {...ICON} />
            <select value={project?.root ?? ''} onChange={(e) => setProject(p.projects.find((x) => x.root === (e.currentTarget as HTMLSelectElement).value) ?? null)}>
              {!project && <option value="">{s('newPickProject')}</option>}
              {p.projects.map((x) => (
                <option key={x.root} value={x.root}>
                  {x.letter} · {x.name}
                </option>
              ))}
            </select>
          </label>
          {under && (
            <button class={`qchip ${nested ? 'on' : ''}`} onClick={() => setNested(!nested)} aria-pressed={nested}>
              {s('quickUnder', { ref: under.ref })}
            </button>
          )}
          </div>
        </div>

        <div class="sheet-section">
        <div class="sheet-label">{s('whoLabel')}</div>
        <div class="new-row seg-row" role="radiogroup" aria-label={s('whoLabel')}>
          {whoChoices.map((c) => (
            <button key={c.id} role="radio" aria-checked={who === c.id} class={`who ${who === c.id ? 'on' : ''}`} onClick={() => setWho(c.id)} title={c.hint}>
              {c.icon}
              <span>{c.label}</span>
            </button>
          ))}
        </div>
        <p class="new-hint">{whoChoices.find((c) => c.id === who)!.hint}</p>
        </div>

        <div class="sheet-section">
        <div class="sheet-label">{s('newMarks')}</div>
        <div class="new-row">
          <button class={`qchip important ${important ? 'on' : ''}`} onClick={() => setImportant(!important)} aria-pressed={important}>
            <Star {...ICON} />
            {s('quickImportant')}
          </button>
          {who !== 'brief' && (
            <button class={`qchip ${start ? 'on' : ''}`} onClick={() => setStart(!start)} aria-pressed={start}>
              <Play {...ICON} />
              {s('newStartNow')}
            </button>
          )}
        </div>
        </div>

        {error && <p class="s-error quick-error">{error}</p>}
        <div class="sheet-footer">
          <button class="ghost" onClick={p.onClose}>
            {s('cancel')}
          </button>
          <button class="primary" disabled={!ready || busy} onClick={() => void save()}>
            {s('newAdd')} ⏎
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 延迟到…: a day to come back and, if it waits on someone or something, who or what. Naming one
 * makes it an active wait (purple); a day alone, or nothing, a passive delay (grey). Emptying the
 * who on a node already waiting turns it into a passive delay (`passive`).
 */
/** 「等」 is a few words — the limit `nod defer --on` holds to, in display columns (CJK counts two). */
const WAIT_ON_MAX_COLS = 30

export function DelayDialog(p: { node: import('./types.ts').Node; subject?: string; busy: boolean; onClose: () => void; onDelay: (on: string | null, date: string | null, passive: boolean) => void }) {
  const waiting = p.node.status === 'waiting'
  const [on, setOn] = useState(waiting ? (p.node.waiting_on ?? '') : '')
  const [text, setText] = useState('')
  const [date, setDate] = useState<string | null>(null)
  const who = on.trim()
  const tooLong = cols(who) > WAIT_ON_MAX_COLS
  const newWho = who && who !== (waiting ? (p.node.waiting_on ?? '') : '') ? who : null
  // A wait always has a day (on a node already waiting, the one it has); a passive delay may have none.
  const ready = !tooLong && (who ? Boolean(date || (newWho && waiting && p.node.waiting_until)) : Boolean(date) || !text.trim())
  const go = () => ready && p.onDelay(newWho, date, waiting && !who)
  return (
    <div class="overlay" onClick={p.onClose}>
      <div class="confirm hold-dialog" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{s('deferTitle')}</h3>
        <p class="d">{p.subject ?? `${p.node.ref} ${p.node.title}`}</p>
        <DateField value={text} onText={setText} onChange={setDate} onEnter={go} onEscape={p.onClose} autoFocus placeholder={s('deferPlaceholder')} />
        <input
          class="hold-on"
          value={on}
          placeholder={s('delayOnPlaceholder')}
          onInput={limitInput(WAIT_ON_MAX_COLS, setOn)}
          onCompositionEnd={limitInput(WAIT_ON_MAX_COLS, setOn)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') p.onClose()
            if (e.key === 'Enter') go()
          }}
        />
        <p class={`d ${tooLong ? 'c-red' : ''}`}>{tooLong ? s('delayOnTooLong', { max: String(WAIT_ON_MAX_COLS / 2) }) : who ? s('delayActiveHint') : s('delayPassiveHint')}</p>
        <div class="sheet-footer">
          <span class="grow" />
          <button class="ghost" onClick={p.onClose}>
            {s('cancel')}
          </button>
          <button class="primary" disabled={!ready || p.busy} onClick={go}>
            {s('deferUntilButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
