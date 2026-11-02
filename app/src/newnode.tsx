import { Bot, Flag, FolderGit2, Play, Star, User, WandSparkles } from 'lucide-preact'
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
  const [milestoneOn, setMilestoneOn] = useState(false)
  const [milestoneText, setMilestoneText] = useState('')
  const [milestone, setMilestone] = useState<string | null>(null)
  const [start, setStart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  useDialogFocus(field)
  const under = p.under && project && p.under.project === project.project ? p.under : null
  const ready = Boolean(project && title.trim() && (!milestoneOn || milestone))

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
        milestone: milestoneOn && milestone ? milestone : undefined,
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
          <button class={`qchip ${important ? 'on' : ''}`} onClick={() => setImportant(!important)} aria-pressed={important}>
            <Star {...ICON} />
            {s('quickImportant')}
          </button>
          <button class={`qchip ${milestoneOn ? 'on' : ''}`} onClick={() => setMilestoneOn(!milestoneOn)} aria-pressed={milestoneOn}>
            <Flag {...ICON} />
            {s('milestone')}
          </button>
          {who !== 'brief' && (
            <button class={`qchip ${start ? 'on' : ''}`} onClick={() => setStart(!start)} aria-pressed={start}>
              <Play {...ICON} />
              {s('newStartNow')}
            </button>
          )}
        </div>
        {milestoneOn && (
          <DateField value={milestoneText} onText={setMilestoneText} onChange={setMilestone} onEnter={() => void save()} onEscape={p.onClose} placeholder={s('milestonePlaceholder')} />
        )}
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

/** d: put a node off until a day (it comes back by itself then), or indefinitely. */
export function DeferDialog(p: { title: string; busy: boolean; onClose: () => void; onDefer: (date: string | null) => void }) {
  const [text, setText] = useState('')
  const [date, setDate] = useState<string | null>(null)
  const go = () => (text.trim() ? date && p.onDefer(date) : p.onDefer(null))
  return (
    <div class="overlay" onClick={p.onClose}>
      <div class="confirm defer-dialog" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{s('deferTitle')}</h3>
        <p class="d">{p.title}</p>
        <DateField value={text} onText={setText} onChange={setDate} onEnter={go} onEscape={p.onClose} autoFocus placeholder={s('deferPlaceholder')} />
        <div class="sheet-footer">
          <button class="ghost" onClick={() => p.onDefer(null)} disabled={p.busy}>
            {s('deferIndefinitely')}
          </button>
          <span class="grow" />
          <button class="ghost" onClick={p.onClose}>
            {s('cancel')}
          </button>
          <button class="primary" disabled={!date || p.busy} onClick={go}>
            {s('deferUntilButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Waiting on someone outside, until a day to check back on them. On a node already waiting, the who is filled in. */
export function HoldDialog(p: { node: import('./types.ts').Node; busy: boolean; onClose: () => void; onHold: (on: string | null, date: string) => void }) {
  const waiting = p.node.status === 'waiting'
  const [on, setOn] = useState(waiting ? (p.node.waiting_on ?? '') : '')
  const [text, setText] = useState('')
  const [date, setDate] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  useDialogFocus(field)
  const ready = Boolean(on.trim() && date)
  const go = () => ready && p.onHold(waiting && on.trim() === (p.node.waiting_on ?? '') ? null : on.trim(), date!)
  return (
    <div class="overlay" onClick={p.onClose}>
      <div class="confirm hold-dialog" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{waiting ? s('holdChange') : s('holdMenu')}</h3>
        <p class="d">
          {p.node.ref} {p.node.title}
        </p>
        <input
          ref={field}
          class="hold-on"
          value={on}
          placeholder={s('holdOnPlaceholder')}
          onInput={(e) => setOn((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') p.onClose()
          }}
        />
        <DateField value={text} onText={setText} onChange={setDate} onEnter={go} onEscape={p.onClose} placeholder={s('holdUntilPlaceholder')} />
        <div class="sheet-footer">
          <span class="grow" />
          <button class="ghost" onClick={p.onClose}>
            {s('cancel')}
          </button>
          <button class="primary" disabled={!ready || p.busy} onClick={go}>
            {s('holdButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
