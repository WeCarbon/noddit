import { CornerDownRight, FolderGit2, PenLine, SquareTerminal, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { useDialogFocus } from './focus.ts'
import { s } from './strings.ts'
import type { Project } from './types.ts'

const ICON = { size: 14, strokeWidth: 1.75 } as const

/**
 * ⌘K: a line of the owner's own words, filed in a project for an AI to pick up and expand.
 * Enter files it; ⌘Enter (or the chip) files it under the selected node; ⇧Enter starts a new line.
 */
export function QuickEntry(p: {
  projects: Project[]
  project: Project
  under: { ref: string; title: string } | null
  onFiled: (brief: api.FiledBrief, project: Project) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [project, setProject] = useState(p.project)
  const [nested, setNested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useDialogFocus(box)
  const under = p.under && project.project === p.project.project ? p.under : null

  const file = async (asChild: boolean) => {
    const words = (box.current?.value ?? text).trim()
    if (!words || busy) return
    setBusy(true)
    setError(null)
    try {
      const brief = await api.fileBrief(project.root, words, asChild && under ? under.ref : undefined)
      p.onFiled(brief, project)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div class="overlay" onClick={p.onClose}>
      <div class="quick" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={s('quickTitle')}>
        <div class="quick-row">
          <PenLine {...ICON} class="quick-ico" />
          <textarea
            ref={box}
            rows={1}
            value={text}
            placeholder={s('quickPlaceholder')}
            onInput={(e) => {
              const t = e.currentTarget
              setText(t.value)
              t.style.height = 'auto'
              t.style.height = `${Math.min(t.scrollHeight, 180)}px`
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') return p.onClose()
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                void file(e.metaKey || e.ctrlKey || nested)
              }
            }}
          />
        </div>
        <div class="quick-meta">
          <label class="qchip" title={s('quickProject')}>
            <FolderGit2 {...ICON} />
            <select
              value={project.root}
              onChange={(e) => setProject(p.projects.find((x) => x.root === (e.currentTarget as HTMLSelectElement).value) ?? project)}
            >
              {p.projects.map((x) => (
                <option key={x.root} value={x.root}>
                  {x.letter} · {x.name}
                </option>
              ))}
            </select>
          </label>
          {under && (
            <button class={`qchip ${nested ? 'on' : ''}`} onClick={() => setNested(!nested)} title={`${under.ref} ${under.title} (⌘⏎)`}>
              <CornerDownRight {...ICON} />
              {s('quickUnder', { ref: under.ref })}
              {nested && <X size={12} strokeWidth={2} />}
            </button>
          )}
          <span class="grow" />
          {project.listening === false && (
            <span class="qchip warn" title={s('noSessionHint')}>
              <SquareTerminal {...ICON} />
              {s('noSessionShort')}
            </span>
          )}
          <span class="quick-keys">⏎ {s('quickFile')}</span>
        </div>
        {error && <p class="s-error quick-error">{error}</p>}
      </div>
    </div>
  )
}

/** Nobody is listening in the project: offer to open a terminal there running an agent. */
export function StartSession(p: { project: Project; reason: 'brief' | 'menu'; onClose: () => void; onDone: (msg: string) => void }) {
  const [agent, setAgent] = useState<api.AgentKind>('claude')
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const go = useRef<HTMLButtonElement>(null)
  useDialogFocus(go)
  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.startSession(p.project.root, agent)
      if (!r.ok && r.reason === 'already_listening') return p.onDone(s('sessionAlready'))
      if (!r.ok) throw new Error(r.reason ?? 'failed')
      if (r.dry_run) return p.onDone(s('sessionDryRun'))
      if (r.started === false && !r.plan?.exec && r.plan?.command) {
        setManual(r.plan.command)
        setBusy(false)
        return
      }
      p.onDone(s('sessionStarted'))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const agents: { id: api.AgentKind; name: string }[] = [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
    { id: 'kimi', name: 'Kimi' },
  ]
  return (
    <div class="overlay" onClick={p.onClose}>
      <div class="confirm" role="alertdialog" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && p.onClose())}>
        <h3>
          <SquareTerminal size={16} strokeWidth={1.75} class="h-ico" />
          {p.reason === 'brief' ? s('noSessionTitle', { project: p.project.name }) : s('startSessionTitle', { project: p.project.name })}
        </h3>
        <p>{s('noSessionBody')}</p>
        <div class="seg agents-seg">
          {agents.map((a) => (
            <button key={a.id} class={agent === a.id ? 'on' : ''} onClick={() => setAgent(a.id)}>
              {a.name}
            </button>
          ))}
        </div>
        {manual && (
          <>
            <p class="s-hint">{s('sessionManual')}</p>
            <code class="path">{manual}</code>
          </>
        )}
        {error && <p class="s-error">{error}</p>}
        <div class="row-actions end">
          <button class="ghost" onClick={p.onClose}>
            {s('notNow')}
          </button>
          {!manual && (
            <button class="primary" ref={go} disabled={busy} onClick={() => void start()}>
              {s('startSession')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
