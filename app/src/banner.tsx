import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { NoticeStack, useNoticeQueue, type Notice } from './notices.tsx'
import { s } from './strings.ts'

interface Shown {
  node: api.WaitingNode
  count: number
  focus: boolean
}

const AUTO_HIDE_MS = 12_000

/**
 * The small always-on-top window: one waiting decision and its options. Shown by a new
 * decision (as a notification, without taking focus) or by the hotkey (focused: 1–9
 * answers, Enter takes the default, Esc dismisses).
 */
export function Banner() {
  const [shown, setShown] = useState<Shown | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const hovering = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const shownRef = useRef<Shown | null>(null)
  shownRef.current = shown
  // Notices from the main window while it is not in front: a stack, fitted, gone when empty.
  const notices = useNoticeQueue(() => !shownRef.current && void api.bannerHide())
  const stack = useRef<HTMLDivElement>(null)

  const hide = () => {
    clearTimeout(timer.current)
    void api.bannerHide()
  }
  const armAutoHide = (focus: boolean) => {
    clearTimeout(timer.current)
    if (!focus) timer.current = window.setTimeout(() => !hovering.current && hide(), AUTO_HIDE_MS)
  }

  useEffect(() => {
    if (!api.inDesktop) void demoShown().then((d) => d && setShown(d))
    void api.on<Notice>('banner-notice', (n) => {
      if (shownRef.current?.focus) return
      setShown(null)
      notices.push(n)
    })
    void api.on<Shown>('banner-show', (payload) => {
      setShown(payload)
      setBusy(null)
      setError(null)
      setDone(false)
      armAutoHide(payload.focus)
      if (payload.focus) setTimeout(() => void api.summoned('banner'), 0)
    })
  }, [])

  const answer = async (key: string) => {
    if (!shown || busy || done) return
    setBusy(key)
    setError(null)
    try {
      await api.answer(shown.node.root, shown.node.id, key)
      setDone(true)
      setTimeout(hide, 700)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shown) return
      if (e.key === 'Escape') return hide()
      if (e.key === 'Enter') {
        e.preventDefault()
        if (shown.node.default) void answer(shown.node.default)
        else void api.bannerOpenMain(shown.node.key)
        return
      }
      if (/^[1-9a-zA-Z]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
        const opt = shown.node.options.find((o) => o.key.toLowerCase() === e.key.toLowerCase())
        if (opt) void answer(opt.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useLayoutEffect(() => {
    if (shown || !notices.items.length || !stack.current) return
    void api.bannerFit(Math.ceil(stack.current.getBoundingClientRect().height) + 2)
  }, [shown, notices.items.length])

  if (!shown)
    return notices.items.length ? (
      <div class="banner-notices" ref={stack}>
        <NoticeStack q={notices} onOpen={(key) => void api.bannerOpenMain(key)} />
      </div>
    ) : (
      <div class="banner empty" />
    )
  const n = shown.node
  return (
    <div
      class={`banner ${done ? 'done' : ''}`}
      onMouseEnter={() => (hovering.current = true)}
      onMouseLeave={() => {
        hovering.current = false
        armAutoHide(shown.focus)
      }}
    >
      <header data-tauri-drag-region>
        <span class="b-gem" />
        <span class="b-ref">{n.ref}</span>
        <span class="b-project">{n.project}</span>
        {n.urgent && <span class="b-urgent">!</span>}
        {shown.count > 1 && <span class="b-more">+{shown.count - 1}</span>}
        <button class="b-close" onClick={hide} title="Esc">
          ✕
        </button>
      </header>
      <div class="b-title" dir="auto">
        {n.title}
      </div>
      {done ? (
        <div class="b-done">✓ {s('sent')}</div>
      ) : (
        <div class="b-options">
          {n.options.slice(0, 4).map((o) => (
            <button key={o.key} class={`b-opt ${n.default === o.key ? 'default' : ''} ${busy === o.key ? 'busy' : ''}`} onClick={() => void answer(o.key)}>
              <span class="b-key">{o.key}</span>
              <span class="b-label" dir="auto">
                {o.label}
              </span>
              {n.default === o.key && <span class="b-enter">⏎</span>}
            </button>
          ))}
          {(n.options.length === 0 || n.options.length > 4) && (
            <button class="b-opt open" onClick={() => void api.bannerOpenMain(n.key)}>
              <span class="b-label">{s('bannerOpen')}</span>
            </button>
          )}
        </div>
      )}
      {error && <div class="b-error">{error}</div>}
      <footer>
        <button class="b-link" onClick={() => void api.bannerOpenMain(n.key)}>
          {s('bannerOpen')}
        </button>
        <span>{s('bannerKeys')}</span>
      </footer>
    </div>
  )
}

/** A plain browser has no app side: show the first waiting decision from the recorded bench. */
async function demoShown(): Promise<Shown | null> {
  const b = await api.loadBench()
  const decide = b.views.find((v) => v.view === 'decide')?.rows.filter((r) => r.kind === 'node') ?? []
  const n = decide[0] && b.nodes[decide[0].node!]
  if (!n) return null
  return {
    node: { key: n.key, id: n.id, ref: n.ref, project: n.project, title: n.title, root: '', options: n.options.map((o) => ({ key: o.key, label: o.label })), default: n.default, urgent: n.urgency === 'high' },
    count: decide.length,
    focus: true,
  }
}
