import { render } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { Bench, type Prefs } from './bench.tsx'
import { ResizeEdges } from './resize.tsx'
import { Onboarding, envReady } from './onboarding.tsx'
import { Banner } from './banner.tsx'
import { newer, readBench, type Read } from './optimistic.ts'
import { s, setLanguage, whenLanguageSet } from './strings.ts'
import type { Bench as BenchData, ShellEnv } from './types.ts'
import './style.css'
import './panels.css'
import './header.css'
import './quick.css'
import './menu.css'
import './main-agent.css'

const params = new URLSearchParams(location.search)
const forcedTheme = params.get('theme')
if (forcedTheme) document.documentElement.dataset.theme = forcedTheme
// Menus and shortcut hints follow the platform's own conventions.
document.documentElement.dataset.platform = params.get('platform') ?? (/Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'win' : 'other')

const DEFAULT_PREFS: Prefs = { view: 'available', selected: null, folds: { nodes: {}, groups: {} }, onboarded: false }

type Phase = { kind: 'boot' } | { kind: 'onboarding'; startAt?: 'welcome' | 'check' | 'add' } | { kind: 'bench' }

function App({ prefs0, snapshot }: { prefs0: Prefs; snapshot: BenchData | null }) {
  const [prefs, setPrefsState] = useState<Prefs>(prefs0)
  const [read, setRead] = useState<Read | null>(snapshot && { bench: snapshot, startedAt: 0 })
  const bench = read?.bench ?? null
  const [env, setEnv] = useState<ShellEnv | null>(null)
  const [phase, setPhase] = useState<Phase>(snapshot && prefs0.onboarded ? { kind: 'bench' } : { kind: 'boot' })
  const [adding, setAdding] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const inflight = useRef<Promise<void> | null>(null)
  const again = useRef(false)

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...p }
      api.prefsSave(next)
      return next
    })
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (inflight.current) {
      again.current = true
      return inflight.current
    }
    setRefreshing(true)
    inflight.current = (async () => {
      do {
        again.current = false
        try {
          const next = await readBench(api.loadBench)
          setLanguage(next.bench.lang, next.bench.rtl)
          setRead((shown) => newer(shown, next))
          void api.snapshotSave(JSON.stringify(next.bench))
        } catch {
          /* keep what is on screen; the next event retries */
        }
      } while (again.current)
    })()
    await inflight.current
    inflight.current = null
    setRefreshing(false)
  }, [])

  useEffect(() => {
    if (bench) setLanguage(bench.lang, bench.rtl)
    void api.prepareImages()
    void (async () => {
      const e = await api.shellEnv(false)
      setEnv(e)
      if (!envReady(e)) return setPhase({ kind: 'onboarding', startAt: prefs0.onboarded ? 'check' : 'welcome' })
      const known = snapshot?.projects.length ? snapshot.projects : await api.listProjects().catch(() => [])
      if (!known.length) return setPhase({ kind: 'onboarding', startAt: 'welcome' })
      await refresh()
      setPhase({ kind: 'bench' })
      setTimeout(() => void api.ready('live bench'), 0)
      if (!prefs0.onboarded) setPrefs({ onboarded: true })
      let timer = 0
      await api.startMonitor(() => {
        clearTimeout(timer)
        timer = window.setTimeout(() => void refresh(), 250)
      })
    })()
    const tick = window.setInterval(() => void refresh(), 60_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(tick)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const finishOnboarding = async () => {
    setAdding(false)
    setPrefs({ onboarded: true })
    await refresh()
    setPhase({ kind: 'bench' })
    let timer = 0
    await api.startMonitor(() => {
      clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), 250)
    })
  }

  if (adding || phase.kind === 'onboarding')
    return (
      <Onboarding
        env={env}
        startAt={adding ? 'add' : phase.kind === 'onboarding' ? phase.startAt : undefined}
        onEnv={setEnv}
        onDone={finishOnboarding}
        onCancel={adding ? () => setAdding(false) : undefined}
      />
    )
  if (phase.kind === 'bench' && read)
    return <Bench bench={read.bench} readAt={read.startedAt} prefs={prefs} setPrefs={setPrefs} refresh={refresh} refreshing={refreshing} onAddProject={() => setAdding(true)} onNoProjects={() => setPhase({ kind: 'onboarding', startAt: 'add' })} />
  return <div class="boot" data-tauri-drag-region />
}

// The web view's own menu offers Reload and, in a debug build, Inspect Element: never in a release build,
// and only on ⌥-right-click in a debug one. Text fields keep their Cut/Copy/Paste.
let debugBuild = false
void api.isDebugBuild().then((v) => (debugBuild = v))
window.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
  if (debugBuild && e.altKey) return
  e.preventDefault()
})

window.addEventListener('error', (e) => api.log(`error: ${e.message} at ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => api.log(`unhandled: ${String(e.reason)}`))

whenLanguageSet(() =>
  void api.setPhrases({
    needsDecision: s('phraseNeedsDecision'),
    notCollected: s('phraseNotCollected'),
    milestoneDay: s('phraseMilestoneDay'),
    milestoneHour: s('phraseMilestoneHour'),
    milestone: s('milestone'),
    agentReplied: s('phraseAgentReplied'),
    open: s('trayOpen'),
    settings: s('traySettings'),
    quit: s('trayQuit'),
  }),
)

async function bootBanner() {
  document.documentElement.classList.add('banner-window')
  const cached = await api.snapshotLoad()
  if (cached) setLanguage(cached.lang, cached.rtl)
  render(<Banner />, document.getElementById('app')!)
}

async function boot() {
  const [prefs, snapshot] = await Promise.all([api.prefsLoad(DEFAULT_PREFS), api.snapshotLoad()])
  if (params.get('view')) prefs.view = params.get('view') as Prefs['view']
  if (params.get('sel')) prefs.selected = params.get('sel')
  if (params.get('screen') === 'onboarding') prefs.onboarded = false
  render(
    <>
      <App prefs0={prefs} snapshot={snapshot} />
      <ResizeEdges />
    </>,
    document.getElementById('app')!,
  )
  setTimeout(() => void api.ready(snapshot ? 'first frame (cached bench)' : 'first frame'), 0)
}

void (params.has('banner') ? bootBanner() : boot())
