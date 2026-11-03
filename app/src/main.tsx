import { render } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { Bench, type Prefs } from './bench.tsx'
import { ResizeEdges } from './resize.tsx'
import { Onboarding, envReady } from './onboarding.tsx'
import { Banner } from './banner.tsx'
import { newer, nextStamp, patchNode, readBench, type PendingOp, type Read } from './optimistic.ts'
import { s, setLanguage, whenLanguageSet } from './strings.ts'
import type { Bench as BenchData, MonitorUpdated, ShellEnv } from './types.ts'
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
  // A monitor "updated" event names exactly which nodes changed; these hold
  // the ones reloaded one at a time off that (N258), on top of `bench` until
  // a later full reload catches up (see optimistic.ts, and the matching prop
  // on Bench) — instead of a full `loadBench()` on every single event. Their
  // `doneAt` is a `nextStamp()`, the same clock `read.startedAt` uses, so a
  // read that began after a patch was made drops it exactly like `Bench`'s
  // own `ops` (never by wall-clock time, which a slow read could cross either way).
  const [patches, setPatches] = useState<PendingOp[]>([])
  const patchId = useRef(0)
  const knownKeys = useRef<Set<string>>(new Set(Object.keys(snapshot?.nodes ?? {})))
  useEffect(() => {
    if (bench) knownKeys.current = new Set(Object.keys(bench.nodes))
  }, [bench])
  useEffect(() => {
    if (!read) return
    setPatches((ps) => (ps.some((p) => p.doneAt && p.doneAt <= read.startedAt) ? ps.filter((p) => !p.doneAt || p.doneAt > read.startedAt) : ps))
  }, [read?.startedAt])
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

  const refreshTimer = useRef(0)
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => void refresh(), 250)
  }, [refresh])

  /**
   * One line from `decs monitor --updates --json`. `event: 'updated'` carries
   * exactly which nodes changed (N258) — known ones are reloaded individually
   * (`api.loadNode`) and laid over the bench instead of reloading the whole
   * thing (~2.5s, megabytes of JSON, for what is usually a one-line edit).
   * Anything this can't resolve structurally — a brand-new node (inserting
   * its row needs the server's own sort), one that left scope, a node whose
   * root can't be read back out of its file path, an older `nod` build
   * without the `changed` field, or any other kind of monitor line (brief,
   * unclaimed, checkin, stale, warn) — falls back to the same debounced full
   * reload this always did before.
   */
  const onMonitorLine = useCallback(
    (line: string) => {
      let evt: { event?: string; changed?: unknown; gone?: unknown } = {}
      try {
        evt = JSON.parse(line)
      } catch {
        /* a plain-text line never reaches here — the app always passes --json */
      }
      const changed = evt.event === 'updated' && Array.isArray(evt.changed) ? (evt.changed as MonitorUpdated['changed']) : null
      if (!changed) {
        scheduleRefresh()
        return
      }
      if (Array.isArray(evt.gone) && evt.gone.length) scheduleRefresh()
      for (const c of changed) {
        if (!knownKeys.current.has(c.key) || !c.file) {
          scheduleRefresh() // a node we've never shown: the full reload places its row
          continue
        }
        const root = api.rootFromFile(c.file)
        if (!root) {
          scheduleRefresh()
          continue
        }
        void api
          .loadNode(root, c.id)
          .then((node) => {
            const id = ++patchId.current
            setPatches((ps) => [...ps, { id, patch: patchNode(c.key, () => node), doneAt: nextStamp() }])
          })
          .catch(() => scheduleRefresh())
      }
    },
    [scheduleRefresh],
  )

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
      await api.startMonitor(onMonitorLine)
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
    await api.startMonitor(onMonitorLine)
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
    return (
      <Bench
        bench={read.bench}
        readAt={read.startedAt}
        patches={patches}
        prefs={prefs}
        setPrefs={setPrefs}
        refresh={refresh}
        refreshing={refreshing}
        onAddProject={() => setAdding(true)}
        onNoProjects={() => setPhase({ kind: 'onboarding', startAt: 'add' })}
      />
    )
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
