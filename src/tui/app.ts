import { HUMAN } from '../core/assignee.ts'
import { briefTitle } from '../core/intake.ts'
import { isListening } from '../core/listeners.ts'
import type { Layout } from '../core/paths.ts'
import { agentArg, describeStart, startSession } from '../cli/commands/session.ts'
import { spawn } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { targetPath } from '../cli/commands/open.ts'
import { openerFor } from '../core/opener.ts'
import { buildOverview, type Overview } from '../core/overview.ts'
import { refOf } from '../core/ref.ts'
import { listSources, type SourceSummary } from '../core/sources.ts'
import { projectSessions } from '../core/listeners.ts'
import type { ProjectSessions } from '../core/overview.ts'
import { delayOf, findRef, isDeferred, isTerminal, statusLabel, waitingOnOwner } from '../core/status.ts'
import { splitWhen } from '../core/fuzzy-date.ts'
import { dayText } from '../i18n/time.ts'
import { nowStamp, type Store } from '../core/store.ts'
import { assertTitleFits } from '../core/title.ts'
import { type Decision } from '../core/types.ts'
import { isRtl, t } from '../i18n/index.ts'
import { bidiMode, isolateLtr, reorderRuns, type BidiMode } from '../i18n/bidi.ts'
import { SETTINGS, cycleSetting, settingValue, showValue } from '../core/settings.ts'
import { fit, stringWidth, wrapToWidth } from './width.ts'
import { isMouse, parseMouse, MOUSE_OFF, MOUSE_ON, type MouseEvent } from './mouse.ts'
import { clearImages, cropToPng, imageProtocol, loadForCrop, renderImage, renderImageData } from './image.ts'
import { RESET, ZOOM_MIN, cropRect, imageLayout, pan, zoomHintText, zoomIn, zoomOut, type ZoomState } from './zoom.ts'
import { approvalLabel } from '../core/render.ts'
import { bodyRows, canUseDefault, clamp, firstHtmlAttachmentIndex, styleLine, type Segment } from './model.ts'
import { ensureVisible, imageName, nodeImages, selectableImages, stepSelectable } from './images.ts'
import {
  DEFERRED_GROUP,
  defOf,
  viewIds,
  VIEW_EMPTY,
  VIEW_LABEL,
  ancestorsOf,
  doneGroupKey,
  homeView,
  isCollapsed,
  isSelectable,
  isTreeView,
  keyOf,
  nodeRowSegments,
  ownerQueue,
  resolveIndex,
  rowsFor,
  stepIndex,
  viewCount,
  viewDueCount,
  type Row,
  type View,
} from './views.ts'
import { summaryLines } from './summary.ts'
import { loadViews } from '../core/view-defs.ts'
import { readPreview, TEXT_PREVIEW } from './preview.ts'
import { DEFERRED_FOLD_KEY, foldFor, foldKey, foldSets, groupFoldKey, loadFolds, saveFold, type FoldMap } from './folds.ts'
import { cycleOption, initialPicks, metaLines, optionForKey, picksSummary, questionLines, statusSegments } from './detail.ts'
import { OTHER_KEY, type DecisionQuestion } from '../core/questions.ts'

/** The box bench reserves for the big-image view: full screen minus the
 *  caption row and a 1-col margin. Must match what `imageLayout` lays out,
 *  or the panel would claim columns the picture also draws over. */
function imageBoxFor(width: number, frameHeight: number): { cols: number; rows: number } {
  return { cols: Math.max(10, width - 2), rows: Math.max(3, frameHeight - 4) }
}

/** Delay before drawing the big-view picture: Ink coalesces frame writes
 *  (~33ms at 30fps), and drawing sooner risks the frame's erase-and-rewrite
 *  wiping the picture on iTerm. */
export const IMAGE_DRAW_DELAY_MS = 60

const SGR_COLOR: Record<string, number> = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90, grey: 90 }

/** Frame rows `from`..`to` as raw terminal output, same text/styles Ink
 *  drew — used to wipe an iTerm picture from rows Ink won't rewrite itself
 *  (unchanged text). */
export function repaintRows(frame: Line[], from: number, to: number): string {
  let out = ''
  for (let r = from; r < Math.min(to, frame.length); r++) {
    out += `\x1b[${r + 1};1H\x1b[2K`
    for (const s of frame[r]) {
      const codes = [s.bold ? 1 : 0, s.dim ? 2 : 0, s.inverse ? 7 : 0, s.color ? (SGR_COLOR[s.color] ?? 0) : 0].filter(Boolean)
      out += codes.length ? `\x1b[${codes.join(';')}m${s.text}\x1b[0m` : s.text
    }
  }
  return out
}

/** How many columns a side panel needs before it is worth drawing at all. */
const MIN_PANEL_COLS = 12

type Line = Segment[]
export type Mode = 'browse' | 'move' | 'confirm' | 'note' | 'attach' | 'help' | 'image' | 'text' | 'questions' | 'qnote' | 'qother' | 'close' | 'goto' | 'settings' | 'brief' | 'session' | 'retitle' | 'delay'
/** Modes where keystrokes go into the prompt-line draft. */
const TEXT_MODES: Mode[] = ['confirm', 'note', 'qnote', 'qother', 'close', 'goto', 'brief', 'retitle', 'delay']

interface Props {
  store: Store
  view: View
  /** `--view deferred`: open 等待's 「延迟 N」 row for this session. */
  openDeferred?: boolean
  project?: string
}

/** Terminal size, kept live. Frames are built to size-minus-one in both
 *  axes — a line reaching the final column wraps and scrolls the buffer. */
function useSize(): { cols: number; rows: number } {
  const { stdout } = useStdout()
  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 })
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 })
    stdout.on('resize', onResize)
    return () => void stdout.off('resize', onResize)
  }, [stdout])
  return size
}

/** fs.watch misses events often enough that a slow poll is cheap insurance. */
function useWatch(store: Store, onChange: () => void): void {
  useEffect(() => {
    const watchers: FSWatcher[] = []
    let debounce: NodeJS.Timeout | undefined
    const nudge = () => {
      clearTimeout(debounce)
      debounce = setTimeout(onChange, 150)
    }
    for (const l of store.layouts) {
      for (const dir of [l.activeDir, l.archivedDir]) {
        try {
          watchers.push(watch(dir, { recursive: true }, nudge))
        } catch {
          /* the poll still covers it */
        }
      }
    }
    const timer = setInterval(onChange, 4000)
    return () => {
      clearTimeout(debounce)
      clearInterval(timer)
      for (const w of watchers) w.close()
    }
  }, [store, onChange])
}

/** Everything bench draws comes from one read of the store. */
interface Snapshot {
  items: Decision[]
  sources: SourceSummary[]
  sessions: ProjectSessions[]
  now: number
  /** The tab definitions as read this tick, so an edit to views.json redraws. */
  views: string
}

function snapshot(store: Store, project?: string): Snapshot {
  const now = Date.now()
  const all = store.all()
  return {
    items: project ? all.filter((d) => d.project === store.projectKey(project)) : all,
    sources: listSources(store, now).filter((s) => !project || s.project === store.projectKey(project)),
    sessions: projectSessions(store, now).filter((p) => !project || p.project === store.projectKey(project)),
    now,
    views: JSON.stringify(loadViews()),
  }
}

/** Who is connected, minus the heartbeat clock — a beat alone is not a change worth redrawing for. */
const sessionsKey = (s: Snapshot) => JSON.stringify(s.sessions.map((p) => p.sessions.map((x) => [x.pid, x.role, x.author])))

/** What changed between two reads, said in one line: new nodes, and nodes that just started waiting on the owner. */
export function changeBanner(prev: Decision[], next: Decision[]): string | null {
  if (!prev.length) return null
  const before = new Map(prev.map((d) => [keyOf(d), d]))
  const added = next.filter((d) => !before.has(keyOf(d)))
  const asking = next.filter((d) => {
    const p = before.get(keyOf(d))
    return p && p.state !== 'needs_decision' && d.state === 'needs_decision'
  })
  const bits: string[] = []
  if (added.length) bits.push(t('bench.toast.newNodes', { count: added.length, refs: added.slice(0, 4).map(refOf).join(' ') }))
  if (asking.length) bits.push(t('bench.toast.nowNeedsDecision', { refs: asking.slice(0, 3).map(refOf).join(' ') }))
  return bits.length ? bits.join(' · ') : null
}

export function App({ store, view: initialView, openDeferred, project }: Props) {
  const { exit } = useApp()
  // Ink's own stream (process.stdout in bench), so the picture goes where the frame goes.
  const { stdout } = useStdout()
  const { cols, rows } = useSize()
  const width = Math.max(20, cols - 1)

  const [snap, setSnap] = useState<Snapshot>(() => snapshot(store, project))
  const { items, sources, sessions, now } = snap
  const [view, setView] = useState<View>(initialView)
  // Folds persist per viewer across sessions (`$NODDIT_HOME/bench-state.json`).
  const [folds, setFolds] = useState<FoldMap>(() => ({ ...loadFolds(), ...(openDeferred ? { [DEFERRED_FOLD_KEY]: 'expanded' as const } : {}) }))
  const [cursorKey, setCursorKey] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [listTop, setListTop] = useState(0)
  const [condensed, setCondensed] = useState(false)
  const [mode, setMode] = useState<Mode>('browse')
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  /** 派活 (`p` / `P`): where the new brief goes, and — once filed with nobody listening — which project to offer a session for. */
  const [briefAt, setBriefAt] = useState<{ parent?: Decision; layout: Layout; forMe?: boolean } | null>(null)
  const [sessionFor, setSessionFor] = useState<{ layout: Layout; project: string } | null>(null)
  const [qIndex, setQIndex] = useState(0)
  const [qPicks, setQPicks] = useState<Record<string, string>>({})
  const [qNotes, setQNotes] = useState<Record<string, string>>({})
  /** 0-based into `nodeImages(current)`: the selected `🖼️` placeholder, and what the big view shows. */
  const [imageSel, setImageSel] = useState(0)
  /** An attachment read as text (mode 'text'): which one, its lines, how far down. */
  const [textView, setTextView] = useState<{ n: number; label: string; lines: string[]; truncated: boolean; top: number } | null>(null)
  // Detail focus (`i`/→, left with ←/Esc): ↑/↓ move the image selection instead of the list cursor.
  const [detailFocus, setDetailFocus] = useState(false)
  /** The attachment picker was opened by `O`: a digit hands that file to the OS viewer instead of drawing it. */
  const [pickToOpen, setPickToOpen] = useState(false)
  const [zoom, setZoom] = useState<ZoomState>(RESET)
  const [imgMeta, setImgMeta] = useState<ReturnType<typeof loadForCrop>>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const bannerTimer = useRef<NodeJS.Timeout | undefined>(undefined)
  /** The `,` dialog: which row is highlighted. */
  const [settingIndex, setSettingIndex] = useState(0)
  /** Settings live outside React state (config.json / env); bump this to
   *  force geometry/frame to recompute after one changes. */
  const [settingsVersion, setSettingsVersion] = useState(0)
  /** The frame Ink last got — what the image draw repaints under a picture. */
  const frameRef = useRef<Line[]>([])

  const say = useCallback((msg: string) => {
    setBanner(msg)
    clearTimeout(bannerTimer.current)
    bannerTimer.current = setTimeout(() => setBanner(null), 2600)
  }, [])

  const overview = useMemo(() => buildOverview(items, now, sources, sessions), [items, now, sources, sessions])
  const rootOf = useCallback((d: Decision) => store.layoutOf(d).projectRoot, [store])
  const { collapsed, expanded, openGroups } = useMemo(() => foldSets(items, folds, rootOf), [items, folds, rootOf])
  // The view's definition is re-read with the items, so an edited views.json shows on the next tick.
  const def = useMemo(() => JSON.stringify(defOf(view)), [view, snap.views])
  const list = useMemo(() => rowsFor(view, items, { collapsed, expanded, openGroups }), [view, def, items, collapsed, expanded, openGroups])

  /** Folds (`true`) or unfolds `d`, and remembers it for the next session. */
  const setFold = (d: Decision, folded: boolean) => {
    const key = foldKey(rootOf(d), d.id)
    const f = foldFor(d, folded)
    setFolds((m) => {
      const next = { ...m }
      if (f) next[key] = f
      else delete next[key]
      return next
    })
    saveFold(key, f)
  }
  /** Opens or shuts a 「✓ 已完成 N」 / 「✓ 已结束 N」 row, remembered the same way. */
  const setGroupOpen = (row: Row, open: boolean) => {
    const first = row.finished?.[0]
    if (!first) return
    const key = row.key === DEFERRED_GROUP ? DEFERRED_FOLD_KEY : row.key.startsWith('fold:project:') ? groupFoldKey(rootOf(first)) : groupFoldKey(rootOf(first), first.parent!)
    const f = open ? 'expanded' : undefined
    setFolds((m) => {
      const next = { ...m }
      if (f) next[key] = f
      else delete next[key]
      return next
    })
    saveFold(key, f)
  }

  const lastIndex = useRef(0)
  const index = resolveIndex(list, cursorKey, lastIndex.current)
  useEffect(() => {
    if (index >= 0) lastIndex.current = index
  }, [index])
  const current: Decision | undefined = index >= 0 ? list[index]?.node : undefined
  const backlinks = useMemo(() => (current ? store.backlinks(current, items) : []), [store, current, items])

  const reload = useCallback(() => {
    // A deferral whose date has come ends here too, not only in `nod monitor`.
    let back: Decision[] = []
    try {
      back = store.returnDueDeferrals()
    } catch {
      /* a lock hiccup: the next tick tries again */
    }
    if (back.length) say(t('bench.toast.backFromDeferral', { refs: back.map(refOf).join(' ') }))
    setSnap((prev) => {
      const next = snapshot(store, project)
      // Same array back means nothing changed; only advance the clock for 「N 分钟前」 labels.
      if (next.items === prev.items && next.views === prev.views && JSON.stringify(next.sources) === JSON.stringify(prev.sources) && sessionsKey(next) === sessionsKey(prev)) {
        return next.now - prev.now >= 60_000 ? { ...prev, now: next.now } : prev
      }
      const msg = changeBanner(prev.items, next.items)
      if (msg) say(msg)
      return next
    })
  }, [store, project, say])

  useWatch(store, reload)

  // Keep the cursor on the node the reader is looking at, even as nodes arrive
  // or disappear underneath them.
  useEffect(() => {
    if (index >= 0 && list[index].key !== cursorKey) setCursorKey(list[index].key)
  }, [list, index, cursorKey])
  // A new node/Z/view starts the body at top; the cursor's first settling
  // (start-up) is not a new node, or this would undo an early wheel scroll.
  const scrolledFor = useRef<{ key: string | null; condensed: boolean; view: View }>({ key: null, condensed, view })
  useEffect(() => {
    const was = scrolledFor.current
    scrolledFor.current = { key: cursorKey, condensed, view }
    if (was.key === null && cursorKey !== null && was.condensed === condensed && was.view === view) return
    setOffset(0)
  }, [cursorKey, condensed, view])
  // A different node resets focus to the list; the cursor's first settling
  // (start-up) must not undo an `i` pressed right away.
  const lastCursor = useRef(cursorKey)
  useEffect(() => {
    if (lastCursor.current !== null && lastCursor.current !== cursorKey) {
      setImageSel(0)
      setDetailFocus(false)
    }
    lastCursor.current = cursorKey
  }, [cursorKey])
  const images = useMemo(() => (current ? nodeImages(current) : []), [current])

  const move = (delta: number) => {
    if (index < 0) return
    const next = stepIndex(list, index, delta)
    // Also when the cursor did not move (already at an end): a wheel may have
    // scrolled it out of view, and a key press is a request to see it.
    setListTop((t) => listTopFor(next, t, geom.paneRows, list.length))
    setCursorKey(list[next].key)
  }

  /** Move mode: swaps the node with its neighbour among the rows it shares a scope with, and writes that order. */
  const moveAmongNeighbours = (delta: -1 | 1) => {
    const scope = list[index]?.scope
    if (!current || !scope) return setMode('browse')
    const peers = list.filter((r) => r.kind === 'node' && r.scope === scope).map((r) => r.node!)
    const at = peers.indexOf(current)
    const to = at + delta
    if (at === -1 || to < 0 || to >= peers.length) return say(t('bench.toast.moveEdge', { ref: refOf(current) }))
    ;[peers[at], peers[to]] = [peers[to], peers[at]]
    try {
      store.arrange(peers)
    } catch (e) {
      say((e as Error).message)
    }
    reload()
  }

  const switchView = (next: View) => {
    setView(next)
    setListTop(0)
    setCursorKey(null)
    lastIndex.current = 0
  }
  // The tab on screen was removed (nod view rm): fall back to the first one.
  useEffect(() => {
    const ids = viewIds()
    if (!ids.includes(view)) switchView(ids[0])
  }, [snap.views])
  const cycleView = (delta: number) => {
    const ids = viewIds()
    switchView(ids[(ids.indexOf(view) + delta + ids.length) % ids.length])
  }

  /** Puts the cursor on `d`, unfolding whatever hides it and switching view if this one cannot show it. */
  const reveal = (d: Decision) => {
    const k = keyOf(d)
    if (list.some((r) => r.key === k && r.kind === 'node')) return setCursorKey(k)
    const target = homeView(d, items, view)
    if (isTreeView(target)) {
      const chain = [d, ...ancestorsOf(d, items)]
      for (const a of chain.slice(1)) {
        if (target === 'all' ? isCollapsed(a, { collapsed, expanded }) : collapsed.has(keyOf(a))) setFold(a, false)
      }
      // 全部 keeps finished nodes behind 「✓ 已完成 N」 / 「✓ 已结束 N」 rows.
      if (target === 'all') {
        for (const [i, n] of chain.entries()) {
          if (!isTerminal(n.state)) continue
          const parent = chain[i + 1]
          const group = parent ? doneGroupKey(parent) : doneGroupKey({ project: n.project })
          if (!openGroups.has(group)) setGroupOpen({ key: group, kind: 'fold', depth: 0, finished: [n] }, true)
        }
      }
    }
    // 等待 keeps deferred nodes behind its 「延迟 N」 row.
    if (target === 'waiting' && isDeferred(d) && !openGroups.has(DEFERRED_GROUP))
      setGroupOpen({ key: DEFERRED_GROUP, kind: 'fold', depth: 0, finished: [d] }, true)
    if (target !== view) setView(target)
    setCursorKey(k)
  }

  const commitAnswer = () => {
    if (current && pendingKey) {
      const revising = current.status === 'answered'
      const qs = current.questions ?? []
      try {
        if (qs.length && pendingKey === '2') {
          const notes = Object.fromEntries(Object.entries(qNotes).filter(([, v]) => v.trim()))
          store.answer(current, {
            answers: qPicks,
            answerNotes: Object.keys(notes).length ? notes : undefined,
            note: draft.trim() || undefined,
            by: 'owner',
            role: 'human',
          })
          say(t('bench.toast.answeredChoice', { ref: refOf(current), choice: picksSummary(qs, qPicks, notes) }))
        } else {
          store.answer(current, { choice: pendingKey, note: draft.trim() || undefined, by: 'owner', role: 'human' })
          const verb = revising ? t('bench.toast.answeredVerbChanged') : t('bench.toast.answeredVerbNew')
          say(t('bench.toast.answeredOption', { ref: refOf(current), verb, key: pendingKey }))
        }
      } catch (e) {
        say((e as Error).message)
      }
    }
    // 待决 and 活动 drop an answered node; let go of it so the next one
    // slides under the cursor instead.
    if (view === 'decide' || view === 'active') setCursorKey(null)
    setMode('browse')
    setDraft('')
    setPendingKey(null)
    reload()
  }

  const commitNote = () => {
    if (current && draft.trim()) {
      try {
        store.note(current, { text: draft.trim(), role: 'human', author: 'owner' })
        say(t('bench.toast.notedReply', { ref: refOf(current) }))
      } catch (e) {
        say((e as Error).message)
      }
    }
    setMode('browse')
    setDraft('')
    reload()
  }

  const commitClose = () => {
    if (current) {
      const reason = draft.trim() || 'obsolete'
      try {
        store.close(current, reason)
        say(t('bench.toast.closed', { ref: refOf(current), reason }))
      } catch (e) {
        say((e as Error).message)
      }
    }
    setMode('browse')
    setDraft('')
    reload()
  }

  const commitRetitle = () => {
    if (current) {
      const title = draft.trim()
      try {
        if (title) {
          assertTitleFits(title)
          const next = store.retitle(current, title, { by: 'owner', role: 'human', expect: current.updatedAt })
          if (next !== current) say(t('bench.toast.retitled', { ref: refOf(next) }))
        }
      } catch (e) {
        say((e as Error).message)
      }
    }
    setMode('browse')
    setDraft('')
    reload()
  }

  /** 延迟 (`d`): already delayed, it is lifted; otherwise a prompt asks until when, and on what. */
  const toggleDefer = () => {
    if (!current) return
    if (isTerminal(current.state)) return say(t('bench.toast.cannotDeferTerminal'))
    if (delayOf(current) || current.deferredAt) {
      try {
        const next = store.undelay(current, { by: 'owner', role: 'human' })
        say(t('bench.toast.undeferred', { ref: refOf(current), status: statusLabel(next.state) }))
      } catch (e) {
        say((e as Error).message)
      }
      return reload()
    }
    startText('delay')
  }

  /** `fri Carol to confirm`: until that day, waiting on Carol (purple); a day alone is passive (grey); blank is indefinitely. */
  const commitDelay = () => {
    const raw = draft.trim()
    setMode('browse')
    setDraft('')
    if (!current) return
    const { when, rest } = splitWhen(raw)
    try {
      if (rest && !when) throw new Error(t('bench.toast.delayNeedsDate'))
      if (when && when.at.getTime() <= Date.now()) throw new Error(t('cli.defer.untilPast', { value: raw, date: dayText(when.day) }))
      const next = store.delay(current, { by: 'owner', role: 'human', until: when && nowStamp(when.at), on: rest || undefined })
      const date = when ? dayText(when.day) : ''
      say(next.state === 'waiting' ? t('bench.toast.delayedOn', { ref: refOf(next), on: next.waitingOn ?? '', date }) : when ? t('bench.toast.delayedUntil', { ref: refOf(next), date }) : t('bench.toast.deferred', { ref: refOf(next) }))
    } catch (e) {
      say((e as Error).message)
    }
    reload()
  }

  const commitGoto = () => {
    const raw = draft.trim()
    setMode('browse')
    setDraft('')
    if (!raw) return
    const from = current ?? items[0]
    const target = from ? findRef(raw, from, items) : undefined
    if (!target) return say(t('bench.toast.notFound', { ref: raw }))
    reveal(target)
  }

  const commitQNote = () => {
    const q = current?.questions?.[qIndex]
    if (q) setQNotes((n) => ({ ...n, [q.key]: draft.trim() }))
    setDraft('')
    setMode('questions')
  }

  /** Picks a real option for a sub-question — dropping any 「其他」 text left
   *  over from before, the same collapse the app side does on an option click. */
  const pickQuestionOption = (q: DecisionQuestion, opt: string) => {
    const wasOther = qPicks[q.key] === OTHER_KEY
    setQPicks((p) => ({ ...p, [q.key]: opt }))
    if (wasOther)
      setQNotes((n) => {
        const next = { ...n }
        delete next[q.key]
        return next
      })
  }

  /** Typed text makes this question's pick 「其他」; an empty box falls back to
   *  its default instead of leaving a text-less 「其他」 behind. */
  const commitQOther = () => {
    const q = current?.questions?.[qIndex]
    const text = draft.trim()
    if (q) {
      if (text) {
        setQPicks((p) => ({ ...p, [q.key]: OTHER_KEY }))
        setQNotes((n) => ({ ...n, [q.key]: text }))
      } else {
        setQPicks((p) => (p[q.key] === OTHER_KEY ? { ...p, [q.key]: q.default ?? q.options[0]?.key ?? '' } : p))
        setQNotes((n) => {
          const next = { ...n }
          delete next[q.key]
          return next
        })
      }
    }
    setDraft('')
    setMode('questions')
  }

  /** Files the draft as a brief; with nobody listening in that project, offers to open a session. */
  const commitBrief = () => {
    const at = briefAt
    const words = draft.trim()
    setDraft('')
    setBriefAt(null)
    setMode('browse')
    if (!at || !words) return
    try {
      const parent = at.parent ? refOf(at.parent) : undefined
      if (at.forMe) {
        const d = store.create({ title: briefTitle(words), author: 'owner', body: words === briefTitle(words) ? '' : words, task: true, assignee: HUMAN, parent }, at.layout)
        reload()
        return say(t('bench.toast.todoFiled', { ref: refOf(d) }))
      }
      const d = store.create({ title: briefTitle(words), author: 'owner', body: words, task: true, intake: true, parent }, at.layout)
      reload()
      if (isListening(at.layout.projectRoot)) return say(t('bench.toast.briefFiled', { ref: refOf(d) }))
      say(t('bench.toast.briefNobody', { ref: refOf(d) }))
      setSessionFor({ layout: at.layout, project: d.project })
      setMode('session')
    } catch (e) {
      say((e as Error).message)
    }
  }

  const answerSession = (yes: boolean) => {
    const target = sessionFor
    setSessionFor(null)
    setMode('browse')
    if (!yes || !target) return
    try {
      say(describeStart(startSession(target.layout, agentArg(undefined)), target.project))
    } catch (e) {
      say((e as Error).message)
    }
  }

  const startText = (m: Mode, initial = '') => {
    setDraft(initial)
    setCaret([...initial].length)
    setMode(m)
  }

  /** Hands a file (or URL) to the OS viewer. */
  const openTarget = (target: string, label: string) => {
    if (!current) return
    const p = targetPath(current.file, target)
    if (!p.includes('://') && !existsSync(p)) return say(t('bench.toast.fileGone', { path: p }))
    const opener = openerFor(p)
    spawn(opener.command, opener.args, { detached: true, stdio: 'ignore', ...opener.options }).unref()
    say(t('bench.toast.opened', { label }))
  }

  const openAttachment = (n: number) => {
    if (!current) return
    const a = current.attachments[n - 1]
    if (!a) return say(t('bench.toast.onlyAttachments', { count: current.attachments.length }))
    openTarget(a.target, a.label)
  }

  const openImage = (n: number) => {
    const img = images[n]
    if (img) openTarget(img.target, imageName(img))
  }

  /** Selects placeholder `n`, scrolling just enough to show it (computed
   *  here, not in an effect, so the first frame after ↑/↓ is already right). */
  const selectImage = (n: number) => {
    setImageSel(n)
    const row = geom.bodyImageRows[n]
    if (row !== undefined && row >= 0) setOffset((o) => ensureVisible(row, o, geom.bodyRows, geom.body.length))
  }

  /** Big view of image `n`; anything the terminal can't draw (URL, no
   *  protocol here) goes to the OS viewer instead. */
  const showImage = (n: number) => {
    if (!current) return
    const img = images[n]
    if (!img) return
    setImageSel(n)
    const p = targetPath(current.file, img.target)
    if (img.target.includes('://') || !imageProtocol()) return openImage(n)
    if (!existsSync(p)) return say(t('bench.toast.fileGone', { path: p }))
    setBanner(null)
    setZoom(RESET)
    setImgMeta(loadForCrop(p))
    setMode('image')
  }

  /** Esc/q from the big view: back to the detail pane, the selection on whatever was shown last. */
  const leaveImage = () => {
    setMode('browse')
    setDetailFocus(true)
    selectImage(imageSel)
  }

  /** Shows an attachment: a picture is drawn in-terminal, text and markdown read here, anything else goes to the OS. */
  const showAttachment = (n: number) => {
    if (!current) return
    const a = current.attachments[n - 1]
    if (!a) return say(t('bench.toast.onlyAttachments', { count: current.attachments.length }))
    const at = images.findIndex((img) => img.attachment === n - 1)
    if (at >= 0) return showImage(at)
    const p = targetPath(current.file, a.target)
    if (!a.target.includes('://') && TEXT_PREVIEW.test(p) && existsSync(p)) {
      try {
        const { text, truncated } = readPreview(p)
        setTextView({ n, label: a.label, lines: text.replace(/\r\n/g, '\n').split('\n'), truncated, top: 0 })
        setBanner(null)
        return setMode('text')
      } catch (e) {
        return say((e as Error).message)
      }
    }
    return openAttachment(n)
  }

  const pick = (key: string) => {
    if (!current) return
    if (!current.options.length) return say(current.state === 'needs_decision' ? t('bench.toast.noOptionsDecide') : t('bench.toast.noOptionsAi'))
    if (!current.options.some((o) => o.key === key)) return say(t('bench.toast.noSuchOption', { key }))
    // 逐条回复: answer each sub-question on its own instead of in prose.
    if (current.questions?.length && key === '2') {
      setQPicks(initialPicks(current))
      setQNotes({ ...(current.answer?.answerNotes ?? {}) })
      setQIndex(0)
      setPendingKey('2')
      return setMode('questions')
    }
    setPendingKey(key)
    startText('confirm')
  }

  /** ←/→/Enter/a value click on the `,` dialog: cycles the setting and
   *  applies it live where that means something within this running
   *  session — view switches now, mouse reporting toggles now; language and
   *  bidi mode take effect on their own (see `settingsVersion` below; `lang`
   *  already calls `setLang` via its own `apply`, and bidi/view-count labels
   *  are read fresh on every render, nothing cached). An env-sourced value
   *  can't be changed here, so this is a no-op on one. */
  const cycleSettingAt = (index: number, step: 1 | -1) => {
    const setting = SETTINGS[index]
    if (!setting || settingValue(setting.key).source === 'env') return
    const next = cycleSetting(setting.key, step)
    if (setting.key === 'view') switchView(next as View)
    if (setting.key === 'mouse') stdout.write(next === 'on' ? MOUSE_ON : MOUSE_OFF)
    setSettingsVersion((v) => v + 1)
  }

  /** `w`: the next node an AI is stuck on, in the order the owner should take them. */
  const nextWaiting = () => {
    const queue = ownerQueue(items).filter((d) => waitingOnOwner(d, items))
    const pool = queue.length ? queue : ownerQueue(items).filter((d) => d.state === 'needs_decision')
    if (!pool.length) return say(t('bench.toast.noDecisions'))
    const at = current ? pool.findIndex((d) => keyOf(d) === keyOf(current)) : -1
    reveal(pool[(at + 1) % pool.length])
  }

  /** On a 「✓ 已完成 N」 row: open / shut it; true when that did something. */
  const groupKey = (open: boolean): boolean => {
    const row = index >= 0 ? list[index] : undefined
    if (row?.kind !== 'fold') return false
    if (Boolean(row.open) === open) {
      say(open ? t('bench.toast.alreadyExpanded') : t('bench.toast.alreadyCollapsed'))
      return true
    }
    setGroupOpen(row, open)
    return true
  }

  /** ← / →: fold and unfold the tree, or step to the parent / first child. */
  const treeKey = (dir: 'left' | 'right'): boolean => {
    if (index < 0) return false
    const row = list[index]
    // 等待 is a list, but its 「延迟 N」 row folds like the tree's.
    if (!isTreeView(view) && row.kind !== 'fold') return false
    if (row.kind === 'fold') {
      if (dir === 'right') return row.open ? false : groupKey(true)
      if (row.open) return groupKey(false)
      if (row.key === DEFERRED_GROUP) return false
      const parent = row.finished?.[0] && ancestorsOf(row.finished[0], items)[0]
      if (parent) setCursorKey(keyOf(parent))
      return Boolean(parent)
    }
    if (!current) return false
    const fold = (on: boolean) => setFold(current, on)
    if (dir === 'right') {
      if (row.hasKids && row.collapsed) return fold(false), true
      if (row.hasKids && list[index + 1]?.kind === 'node') return setCursorKey(list[index + 1].key), true
      return false
    }
    if (row.hasKids && !row.collapsed) return fold(true), true
    const parent = ancestorsOf(current, items)[0]
    if (parent) setCursorKey(keyOf(parent))
    return Boolean(parent)
  }

  /** `+` / `-`: unfold / fold the node under the cursor, remembered across sessions. */
  const foldKeyPress = (folded: boolean) => {
    if (groupKey(!folded)) return
    // In 等待, - on a node listed under an open 「延迟 N」 shuts it (below).
    if (!isTreeView(view) && !(defOf(view).deferred === 'fold' && current && isDeferred(current))) return say(t('bench.toast.foldOnlyHere'))
    if (index < 0 || !current) return
    const row = list[index]
    // `-` on a finished node listed under an open 「✓ 已完成 N」 shuts that row again.
    const group = list.find((r) => r.kind === 'fold' && r.open && r.finished?.includes(current))
    if (folded && group && !(row.hasKids && !row.collapsed)) {
      setGroupOpen(group, false)
      return setCursorKey(group.key)
    }
    if (!row.hasKids) return say(t('bench.toast.noChildren', { ref: refOf(current) }))
    if (Boolean(row.collapsed) === folded) return say(folded ? t('bench.toast.alreadyCollapsed') : t('bench.toast.alreadyExpanded'))
    setFold(current, folded)
  }

  /** `i`, or → where there is nothing left to unfold: focus moves to the detail pane's `🖼️` placeholders. */
  const enterDetail = () => {
    if (!current) return
    if (!images.length) return say(t('bench.toast.noImages'))
    const vis = selectableImages(geom.bodyImageRows)
    if (!vis.length) return say(t('bench.toast.noImagesCondensed'))
    setDetailFocus(true)
    selectImage(vis.includes(imageSel) ? imageSel : vis[0])
  }

  const pageRows = Math.max(1, rows - 10)

  // The picture is painted outside the frame Ink manages, over rows an
  // almost-blank frame erased first. Leaving repaints the layout (plus an
  // explicit delete for kitty, which keeps images in their own layer).
  useEffect(() => {
    if (mode !== 'image' || !current) return
    const a = images[imageSel]
    if (!a) return
    const fullBox = imageBoxFor(width, rows)
    const layout = imgMeta ? imageLayout(imgMeta.width, imgMeta.height, fullBox.cols, fullBox.rows) : null
    const box = { cols: layout?.imageCols ?? fullBox.cols, rows: layout?.imageRows ?? fullBox.rows, name: imageName(a) }
    const path = targetPath(current.file, a.target)
    const { sequence, reason } =
      zoom.zoom <= ZOOM_MIN || !imgMeta
        ? renderImage(path, box)
        : renderImageData(cropToPng(imgMeta, cropRect(zoom, imgMeta.width, imgMeta.height)), box)
    const timer = setTimeout(() => {
      // iTerm images live in text cells; repaint rows Ink thinks are unchanged
      // before drawing the next one, or the old picture bleeds through.
      const repaint = imageProtocol() === 'kitty' ? '' : repaintRows(frameRef.current, 1, 1 + fullBox.rows)
      stdout.write(repaint + (sequence ? `\x1b[2;1H${sequence}` : `\x1b[2;1H${reason ?? t('bench.image.cannotDraw')}`))
    }, IMAGE_DRAW_DELAY_MS)
    return () => {
      clearTimeout(timer)
      stdout.write(clearImages())
    }
    // `current` changes identity on every poll; the picture only needs redrawing when what it shows changes.
  }, [mode, imageSel, current?.file, width, rows, zoom, imgMeta])

  const frameInput: FrameInput = {
    view, list, index, current, items, overview, now, backlinks,
    rows, width, listTop, offset, condensed, mode, draft, caret, imageSel, pendingKey, banner,
    zoom, zoomable: imgMeta !== null, detailFocus, pickToOpen,
    imageSize: imgMeta ? { width: imgMeta.width, height: imgMeta.height } : null,
    qIndex, qPicks, qNotes, settingIndex, textView,
    briefTarget: briefAt ? (briefAt.parent ? refOf(briefAt.parent) : store.projectName(briefAt.layout)) : undefined,
    briefForMe: Boolean(briefAt?.forMe),
    sessionProject: sessionFor?.project,
  }
  const geom = useMemo(
    () => geometry(frameInput),
    // settingsVersion isn't read directly — it's how a changed setting (lang,
    // bidi, ...) earns a recompute, since geometry reads them live, not from props.
    [list, index, current, view, rows, width, listTop, offset, condensed, mode, overview, items, now, backlinks, pendingKey, settingIndex, settingsVersion],
  )

  // The list scrolls just enough to show wherever the cursor landed, keyed
  // on the cursor (not the row number) so an added node doesn't yank a
  // wheel-scrolled list back. First settling (start-up) is not a move.
  const revealedCursor = useRef<string | null>(null)
  useEffect(() => {
    const from = revealedCursor.current
    revealedCursor.current = cursorKey
    if (from === null) return
    setListTop((t) => listTopFor(index, t, geom.paneRows, list.length))
  }, [cursorKey, view, geom.paneRows])

  // Z can hide the selected image (or every image) while the pane has focus:
  // move to the first one still shown, or hand focus back to the list.
  useEffect(() => {
    if (!detailFocus || mode !== 'browse') return
    const vis = selectableImages(geom.bodyImageRows)
    if (!vis.length) setDetailFocus(false)
    else if (!vis.includes(imageSel)) selectImage(vis[0])
  }, [geom, detailFocus, imageSel, mode])

  const onMouse = (e: MouseEvent) => {
    const hit = hitTest(frameInput, geom, e.x, e.y)

    // One row per event: a trackpad sends many small events per flick, a wheel one per notch.
    if (e.kind === 'wheel-up' || e.kind === 'wheel-down') {
      if (mode === 'settings') return // the dialog doesn't scroll; the bench behind it shouldn't either
      const delta = e.kind === 'wheel-down' ? 1 : -1
      if (e.x <= geom.lw) return setListTop((t) => scrollList(t, delta, geom.paneRows, list.length))
      const max = Math.max(0, geom.body.length - geom.bodyRows)
      return setOffset((o) => clamp(clamp(o, 0, max) + delta, 0, max))
    }
    if (e.kind !== 'press' || e.button !== 0 || !hit) return

    if (hit.on === 'settingsBackdrop') return setMode('browse')
    if (hit.on === 'setting') return setSettingIndex(hit.index)
    if (hit.on === 'settingValue') {
      setSettingIndex(hit.index)
      return cycleSettingAt(hit.index, 1)
    }

    if (TEXT_MODES.includes(mode)) {
      if (hit.on === 'prompt') setCaret(caretFromColumn(draft, promptDraftX(frameInput), hit.x))
      return
    }
    if (hit.on === 'list') {
      setDetailFocus(false)
      return setCursorKey(list[hit.index].key)
    }
    if (hit.on === 'image') {
      setDetailFocus(true)
      return showImage(hit.n)
    }
    if (hit.on === 'option') return pick(hit.key)
    if (hit.on === 'attachment') return showAttachment(hit.n)
    if (hit.on === 'tab') return switchView(hit.view)
  }

  useInput((input, key) => {
    const mouse = parseMouse(input)
    if (mouse) return onMouse(mouse)
    if (isMouse(input)) return

    if (mode === 'help') return setMode('browse')

    if (mode === 'settings') {
      if (input === ',' || key.escape) return setMode('browse')
      if (key.upArrow) return setSettingIndex((i) => Math.max(0, i - 1))
      if (key.downArrow) return setSettingIndex((i) => Math.min(SETTINGS.length - 1, i + 1))
      if (key.leftArrow) return cycleSettingAt(settingIndex, -1)
      if (key.rightArrow || key.return) return cycleSettingAt(settingIndex, 1)
      return
    }

    if (mode === 'move') {
      if (key.escape || key.return || input === 'M') {
        setMode('browse')
        return current ? say(t('bench.toast.moved', { ref: refOf(current) })) : undefined
      }
      if (key.upArrow || key.downArrow) return moveAmongNeighbours(key.upArrow ? -1 : 1)
      return
    }

    if (mode === 'session') {
      if (input === 'y' || input === 'Y') return answerSession(true)
      if (input === 'n' || input === 'N' || key.escape || key.return) return answerSession(false)
      return
    }

    if (TEXT_MODES.includes(mode)) {
      if (key.escape) {
        setDraft('')
        setBriefAt(null)
        if (mode === 'qnote' || mode === 'qother') return setMode('questions')
        if (mode === 'confirm' && current?.questions?.length && pendingKey === '2') return setMode('questions')
        setMode('browse')
        setPendingKey(null)
        return
      }
      if (key.return) {
        if (mode === 'confirm') return commitAnswer()
        if (mode === 'note') return commitNote()
        if (mode === 'qnote') return commitQNote()
        if (mode === 'qother') return commitQOther()
        if (mode === 'close') return commitClose()
        if (mode === 'delay') return commitDelay()
        if (mode === 'brief') return commitBrief()
        if (mode === 'retitle') return commitRetitle()
        return commitGoto()
      }
      // The add prompt: ⇥ switches between a brief for an AI and a to-do for the owner.
      if (key.tab && mode === 'brief') return setBriefAt((at) => (at ? { ...at, forMe: !at.forMe } : at))
      if (key.leftArrow) return setCaret((c) => Math.max(0, c - 1))
      if (key.rightArrow) return setCaret((c) => Math.min([...draft].length, c + 1))
      if (key.backspace || key.delete) {
        if (!caret) return
        const chars = [...draft]
        chars.splice(caret - 1, 1)
        setDraft(chars.join(''))
        return setCaret((c) => c - 1)
      }
      if (input && !key.ctrl && !key.meta) {
        const chars = [...draft]
        chars.splice(caret, 0, ...[...input])
        setDraft(chars.join(''))
        setCaret((c) => c + [...input].length)
      }
      return
    }

    if (mode === 'questions') {
      const qs = current?.questions ?? []
      const q = qs[qIndex]
      if (!current || !q) return setMode('browse')
      if (key.escape) {
        setPendingKey(null)
        return setMode('browse')
      }
      if (key.upArrow) return setQIndex((i) => Math.max(0, i - 1))
      if (key.downArrow || key.tab) return setQIndex((i) => Math.min(qs.length - 1, i + 1))
      if (key.leftArrow || key.rightArrow) return pickQuestionOption(q, cycleOption(q, qPicks[q.key], key.leftArrow ? -1 : 1))
      if (key.return) return startText('confirm')
      const chosen = optionForKey(q, input)
      if (chosen) {
        pickQuestionOption(q, chosen)
        return setQIndex((i) => Math.min(qs.length - 1, i + 1))
      }
      if (input === 'n' || input === 'N') return startText('qnote', qNotes[q.key] ?? '')
      if (input === 'o' || input === 'O') return startText('qother', qPicks[q.key] === OTHER_KEY ? (qNotes[q.key] ?? '') : '')
      return
    }

    if (mode === 'text' && textView) {
      const page = Math.max(1, rows - 4)
      const last = Math.max(0, textView.lines.length - page)
      const to = (top: number) => setTextView({ ...textView, top: Math.max(0, Math.min(last, top)) })
      if (input === 'q' || key.escape) return (setMode('browse'), setTextView(null))
      if (input === 'O') return openAttachment(textView.n)
      if (key.downArrow || input === 'j') return to(textView.top + 1)
      if (key.upArrow || input === 'k') return to(textView.top - 1)
      if (key.pageDown || input === ' ') return to(textView.top + page)
      if (key.pageUp) return to(textView.top - page)
      if (input === 'g') return to(0)
      if (input === 'G') return to(last)
      // ←→: the node's other attachments.
      if ((key.leftArrow || key.rightArrow) && current) {
        const next = textView.n + (key.rightArrow ? 1 : -1)
        if (next >= 1 && next <= current.attachments.length) return showAttachment(next)
      }
      return
    }

    if (mode === 'image') {
      if (input === 'q' || key.escape) return leaveImage()
      if (input === 'O') return openImage(imageSel)
      // At fit, ←/→ walk every image of the node in document order; zoomed
      // in, they pan, as before.
      if ((key.leftArrow || key.rightArrow) && (zoom.zoom <= ZOOM_MIN || !imgMeta)) {
        const step = stepSelectable(imageSel, geom.bodyImageRows, key.leftArrow ? -1 : 1)
        if (step.edge) return say(step.edge === 'first' ? t('bench.toast.firstImage') : t('bench.toast.lastImage'))
        return showImage(step.index)
      }
      if (!imgMeta) return
      if (input === '+' || input === '=') return setZoom((z) => zoomIn(z))
      if (input === '-') return setZoom((z) => zoomOut(z))
      if (input === '0') return setZoom(RESET)
      if (key.upArrow) return setZoom((z) => pan(z, 0, -1, imgMeta.width, imgMeta.height))
      if (key.downArrow) return setZoom((z) => pan(z, 0, 1, imgMeta.width, imgMeta.height))
      if (key.leftArrow) return setZoom((z) => pan(z, -1, 0, imgMeta.width, imgMeta.height))
      if (key.rightArrow) return setZoom((z) => pan(z, 1, 0, imgMeta.width, imgMeta.height))
      return
    }
    if (mode === 'attach') {
      if (/^[1-9]$/.test(input)) {
        setMode('browse')
        return pickToOpen ? openAttachment(Number(input)) : showAttachment(Number(input))
      }
      return setMode('browse')
    }

    if (mode === 'browse' && detailFocus && current) {
      if (key.escape || input === 'q' || key.leftArrow) return setDetailFocus(false)
      if (key.upArrow || key.downArrow) {
        const step = stepSelectable(imageSel, geom.bodyImageRows, key.upArrow ? -1 : 1)
        if (step.edge) say(step.edge === 'first' ? t('bench.toast.firstImage') : t('bench.toast.lastImage'))
        return selectImage(step.index)
      }
      if (input === 'i' || input === ' ' || key.return) return showImage(imageSel)
      if (input === 'O') return openImage(imageSel)
      if (key.rightArrow) return
    }

    if (input === 'q' || key.escape) return exit()
    if (key.tab) return cycleView(key.shift ? -1 : 1)

    if (key.upArrow) return move(-1)
    if (key.downArrow) return move(1)
    if (key.leftArrow) return treeKey('left')
    if (key.rightArrow) return treeKey('right') || enterDetail()
    if (key.ctrl && (input === 'f' || input === 'b'))
      return setOffset((o) => Math.max(0, o + (input === 'f' ? pageRows : -pageRows)))
    if (key.ctrl && (input === 'd' || input === 'u')) {
      const half = Math.max(1, Math.floor(pageRows / 2))
      return setOffset((o) => Math.max(0, o + (input === 'd' ? half : -half)))
    }
    if (input === ':') return startText('goto')
    if (input === 'w' || input === 'W') return nextWaiting()
    if (input === 'h') return switchView(view === 'live' ? 'available' : 'live')
    if (input === 'k') return setOffset((o) => Math.max(0, o - 1))
    if (input === 'j') return setOffset((o) => o + 1)
    if (key.pageUp) return setOffset((o) => Math.max(0, o - pageRows))
    if (key.pageDown || input === ' ') return setOffset((o) => o + pageRows)
    if (input === '+' || input === '=') return foldKeyPress(false)
    if (input === '-') return foldKeyPress(true)
    // g is goto, like `:`; the body's top moved to Home.
    if (input === 'g') return startText('goto')
    if (key.home) return setOffset(0)
    if (input === 'G' || key.end) return setOffset(Number.MAX_SAFE_INTEGER)
    if (input === 'z' || input === 'Z') return setCondensed((c) => !c)
    if (input === 'r' || input === 'R') return reload()
    if (input === '?') return setMode('help')
    if (input === ',') {
      setSettingIndex(0)
      return setMode('settings')
    }

    if (input === 'p' || input === 'P') {
      // p: under the selected node (when it can still take children); P: at its project's top level.
      const layout = current ? store.layoutOf(current) : store.primary
      const parent = input === 'p' && current && !current.archived && !isTerminal(current.state) ? current : undefined
      setBriefAt({ parent, layout })
      return startText('brief')
    }

    if (!current) return
    if (input === 'o') {
      if (!current.attachments.length) return say(t('bench.toast.noAttachments'))
      setPickToOpen(false)
      return current.attachments.length === 1 ? showAttachment(1) : setMode('attach')
    }
    if (input === 'O') {
      if (!current.attachments.length) return say(t('bench.toast.noAttachments'))
      if (current.attachments.length === 1) return openAttachment(1)
      setPickToOpen(true)
      return setMode('attach')
    }
    if (input === 'i') return enterDetail()
    if (input === 'd') return toggleDefer()
    if (input === 'H') {
      const idx = firstHtmlAttachmentIndex(current)
      if (idx === -1) return say(t('bench.toast.noHtmlAttachment'))
      return openAttachment(idx + 1)
    }
    if (input === 'n' || input === 'N') return startText('note')
    if (input === 'x' || input === 'X') {
      if (isTerminal(current.state)) return say(t('bench.toast.alreadyPendingChange', { ref: refOf(current), status: statusLabel(current.state) }))
      return startText('close')
    }
    if (input === 'T') return startText('retitle', current.title)
    if (input === 'a' || input === 'A') {
      try {
        store.dismiss(current)
        say(t('bench.toast.dismissed', { ref: refOf(current), id: current.id }))
      } catch (e) {
        say((e as Error).message)
      }
      return reload()
    }
    if (input === '!') {
      const on = current.urgency !== 'high'
      try {
        store.flag(current, { important: on })
        say(t(on ? 'bench.toast.flaggedImportant' : 'bench.toast.unflaggedImportant', { ref: refOf(current) }))
      } catch (e) {
        say((e as Error).message)
      }
      return reload()
    }
    if (input === 'M') {
      if (!list[index]?.scope) return say(t('bench.toast.cantMove'))
      setMode('move')
      return say(t('bench.toast.moveMode', { ref: refOf(current) }))
    }
    if (key.return) {
      if (current.status === 'answered') return say(t('bench.toast.alreadyAnswered'))
      return canUseDefault(current) ? pick(current.default!) : say(current.options.length ? t('bench.toast.noDefault') : t('bench.toast.noOptionsAi'))
    }
    if (/^[1-9]$/.test(input)) {
      const opt = current.options[Number(input) - 1]
      return pick(opt ? opt.key : input)
    }
  })

  const frame = useMemo(
    () => buildFrame(frameInput, geom),
    [
      list, index, current, view, items, overview, now, backlinks, rows, width, listTop, offset, condensed, mode, draft, caret,
      imageSel, pendingKey, banner, geom, zoom, imgMeta, detailFocus, pickToOpen, qIndex, qPicks, qNotes, settingIndex, settingsVersion,
      briefAt, sessionFor, textView,
    ],
  )
  frameRef.current = frame

  return h(
    Box,
    { flexDirection: 'column', width, height: Math.max(1, rows - 1) },
    ...frame.map((segments, i) =>
      h(
        Text,
        { key: i, wrap: 'truncate' },
        ...segments.map((s, j) =>
          h(Text, { key: j, bold: s.bold, dimColor: s.dim, color: s.color, inverse: s.inverse }, s.text),
        ),
      ),
    ),
  )
}

export interface FrameInput {
  view: View
  list: Row[]
  /** Index into `list` of the cursor row; -1 when there is nothing to select. */
  index: number
  current?: Decision
  /** Every node bench knows about, for dependency and subtree lookups. */
  items: Decision[]
  overview: Overview
  now: number
  /** Nodes whose body mentions `current`. */
  backlinks?: Decision[]
  rows: number
  width: number
  /** First visible row of the list pane, as scrolled; `listTopFor` keeps the cursor in it. Missing = scrolled just enough to show the cursor. */
  listTop?: number
  offset: number
  condensed: boolean
  mode: Mode
  draft: string
  /** Insertion point inside `draft`, in code points. */
  caret: number
  /** 0-based into `nodeImages(current)`: the selected `🖼️` placeholder, and the picture image mode shows. */
  imageSel: number
  pendingKey: string | null
  banner: string | null
  /** Zoom/pan of the image preview; meaningless outside image mode. */
  zoom: ZoomState
  /** Whether the previewed image's format can actually be cropped for zoom. */
  zoomable: boolean
  /** Focus is in the detail pane (`i` or →): ↑/↓ move `imageSel` among the `🖼️` placeholders instead of the list cursor. */
  detailFocus: boolean
  /** The attachment picker hands the chosen file to the OS viewer (`O`) rather than drawing it (`o`). */
  pickToOpen?: boolean
  /** The previewed image's pixel size, when known (PNG only). */
  imageSize: { width: number; height: number } | null
  /** 逐条回复: focused sub-question, and the picks / 改法 so far. */
  qIndex?: number
  qPicks?: Record<string, string>
  qNotes?: Record<string, string>
  /** The `,` dialog: index into `SETTINGS` of the highlighted row. */
  settingIndex?: number
  /** `brief` mode: the ref or project the new brief goes under. */
  briefTarget?: string
  /** The add prompt files a to-do for the owner rather than a brief for an AI. */
  briefForMe?: boolean
  /** `session` mode: the project nobody is listening in. */
  sessionProject?: string
  /** An attachment read as text (mode 'text'). */
  textView?: { n: number; label: string; lines: string[]; truncated: boolean; top: number } | null
}

/** Below this, the full hint line (natural truncation aside) crowds out too
 *  much in English/French; a narrower pane gets the short list instead. */
const HINTS_SHORT_BELOW = 100

/** The footer hints, degraded to a shorter form on a narrow pane. At or above
 *  the threshold, the full line is shown and clampFrame truncates it as needed. */
function hintsText(width: number): string {
  return width < HINTS_SHORT_BELOW ? t('bench.hints.short') : t('bench.hints.full')
}

/** The `?` help screen, one entry per line. */
export function helpText(): string[] {
  return t('bench.helpScreen', { user: t('bench.note.user'), agent: t('bench.note.agent') }).split('\n')
}

/** List pane width: enough for a full 32-column title plus ref and status
 *  at ordinary widths; the detail pane gets the rest. */
export function listWidth(width: number): number {
  if (width >= 160) return 70
  if (width >= 130) return 62
  return clamp(Math.floor(width * 0.5), 28, 58)
}

/**
 * The list's first visible row, scrolled as little as possible to show
 * `index` — never re-centres. The scrolled top/bottom row shows a
 * 「还有」 marker instead of a node, so it doesn't count as showing the cursor.
 */
export function listTopFor(index: number, top: number, rows: number, total: number): number {
  const max = Math.max(0, total - rows)
  let t = clamp(top, 0, max)
  if (index < 0 || rows < 3) return index < 0 ? t : clamp(index, 0, max)
  const first = t > 0 ? t + 1 : t
  const last = t + rows < total ? t + rows - 2 : t + rows - 1
  if (index < first) t = index <= 1 ? 0 : index - 1
  else if (index > last) t = index >= total - 1 ? max : index - rows + 2
  return clamp(t, 0, max)
}

/** Wheel/trackpad over the list: the viewport moves `delta` rows, cursor stays put. */
export function scrollList(top: number, delta: number, rows: number, total: number): number {
  return clamp(clamp(top, 0, Math.max(0, total - rows)) + delta, 0, Math.max(0, total - rows))
}

export interface Span {
  key: string
  from: number
  to: number
  /** Frame row, for spans on a footer that wrapped onto several lines. */
  row?: number
}

/** Where every clickable thing ended up; drawing and hit-testing read the
 *  same numbers, so a click can't land on the wrong thing. */
export interface Geometry {
  height: number
  /** The summary strip, already laid out — drawn under the tabs. */
  summary: Line[]
  paneRows: number
  lw: number
  rw: number
  listStart: number
  /** Frame row (0-based) of the first list entry. */
  listRow0: number
  bodyRow0: number
  bodyRows: number
  /** The scrollable detail body (meta lines + prose + `🖼️` placeholders), unhighlighted. Empty while answering sub-questions. */
  body: Line[]
  /** `s.offset` clamped to the body, i.e. what is actually drawn. */
  bodyOffset: number
  /** For each of `nodeImages(current)`, the body line its placeholder is on; -1 when not drawn (the condensed body dropped it). */
  bodyImageRows: number[]
  optionsRow?: number
  attachmentsRow?: number
  optionSpans: Span[]
  attachmentSpans: Span[]
  tabSpans: { view: View; from: number; to: number }[]
  promptRow: number
  settingsModal: SettingsModal
}

/** One option or attachment entry, built and (for a right-to-left language)
 *  mirrored as its own block — never as part of one long bidi paragraph
 *  with its neighbours, which can interleave a weak character (a bare
 *  digit, between two differently-directioned runs) with the wrong entry
 *  and make two spans overlap. Reversed order, each block mirrored on its
 *  own, is the same trick `orderedTabs` uses. */
function entryBlocks<T>(items: T[], toGroup: (item: T, i: number) => Segment[], rtl: boolean, mode: BidiMode): Segment[][] {
  const groups = items.map(toGroup)
  const ordered = rtl ? [...groups].reverse() : groups
  return rtl ? ordered.map((g) => mirrorLine(g, mode)) : ordered
}

/** The options footer, wrapped on option boundaries so a pushed-off option
 *  stays clickable. */
export function optionLines(d: Decision, width: number, rtl = false, mode: BidiMode = 'visual'): Line[] {
  const groups = entryBlocks(
    d.options,
    (o): Segment[] => [
      { text: o.key, bold: true, color: 'cyan', key: o.key },
      { text: ` ${o.label}`, color: o.key === d.default ? 'green' : undefined, key: o.key },
      ...(o.key === d.default && d.status === 'open' ? [{ text: ' (⏎)', dim: true, key: o.key } as Segment] : []),
    ],
    rtl,
    mode,
  )
  const lines: Line[] = []
  let cur: Line = [{ text: ' ' }]
  let used = 1
  for (const group of groups) {
    const gw = group.reduce((n, seg) => n + stringWidth(seg.text), 0)
    if (used > 1 && used + 2 + gw > width) {
      lines.push(cur)
      cur = [{ text: ' ' }]
      used = 1
    }
    if (used > 1) {
      cur.push({ text: '  ' })
      used += 2
    }
    cur.push(...group)
    used += gw
  }
  lines.push(cur)
  return lines
}

function attachmentSegments(d: Decision, rtl = false, mode: BidiMode = 'visual'): Segment[] {
  const label: Segment = { text: t('bench.detail.attachmentsLabel'), dim: true }
  const groups = entryBlocks(
    d.attachments,
    (a, i): Segment[] => {
      // Outbound content waiting on the owner is the one thing in this row
      // that asks for action, so it is not dimmed like the file names.
      const ap = d.approvals.find((x) => x.target === a.target)
      const key = String(i + 1)
      return [
        { text: key, bold: true, key },
        { text: ` ${a.label}`, dim: true, key },
        ...(ap ? [{ text: ` ${approvalLabel(ap)}`, color: ap.approvedHash === ap.hash ? 'green' : 'yellow', key } as Segment] : []),
      ]
    },
    rtl,
    mode,
  )
  const sep: Segment = { text: '  ', dim: true }
  const entries = groups.flatMap((g) => [...g, sep])
  // The label reads first either way — at the pane's own start, which for a
  // right-to-left language (everything right-aligned) is the end of the
  // array, past the entries, not the beginning.
  return rtl ? [...entries, label] : [label, ...entries]
}

/** Column ranges of each key-prefixed group, in the order they are drawn. */
function spansOf(segs: Segment[], keys: string[], offsetX: number): Span[] {
  const spans: Span[] = []
  let x = offsetX
  let current: Span | null = null
  for (const seg of segs) {
    const w = stringWidth(seg.text)
    if (seg.bold && keys.includes(seg.text)) {
      if (current) spans.push(current)
      current = { key: seg.text, from: x, to: x + w }
    } else if (current) {
      current.to = x + w
    }
    x += w
  }
  if (current) spans.push(current)
  return spans
}

/** Column range of every segment tagged with one of `keys` (by `.key`, set
 *  when the line was built — see `optionLines`/`attachmentSegments` — not
 *  by matching bold text, which `spansOf` does): the bidi algorithm can
 *  interleave one entry's characters with another's, so this is the only
 *  way to measure a span that actually matches what gets drawn. */
function spansByKey(segs: Segment[], keys: string[], offsetX: number): Span[] {
  const ranges = new Map<string, Span>()
  let x = offsetX
  for (const seg of segs) {
    const w = stringWidth(seg.text)
    if (seg.key && keys.includes(seg.key)) {
      const existing = ranges.get(seg.key)
      if (existing) {
        existing.from = Math.min(existing.from, x)
        existing.to = Math.max(existing.to, x + w)
      } else {
        ranges.set(seg.key, { key: seg.key, from: x, to: x + w })
      }
    }
    x += w
  }
  return [...ranges.values()]
}


function tabSegments(s: FrameInput): Segment[] {
  const needs = viewCount('decide', s.items) ?? 0
  return viewIds().map((v): Segment => {
    const n = viewCount(v, s.items)
    // Waiting: the nodes due to be checked on are counted on their own, marked ⏰, before the rest.
    const due = v === 'waiting' ? viewDueCount(v, s.items, s.now) : 0
    const rest = n === undefined ? undefined : n - due
    const text = ` ${VIEW_LABEL[v]}${due ? ` ⏰${due}` : ''}${rest ? ` ${rest}` : ''} `
    return v === s.view ? { text, bold: true, inverse: true } : { text, dim: v !== 'decide' || !needs, color: v === 'decide' && needs ? 'yellow' : undefined }
  })
}

/** Mirrors one segment's own text to its script's reading direction —
 *  reordering doesn't change its width, so spans computed off the
 *  unmirrored text still measure right. A no-op on text with nothing RTL. */
function mirrorSegment(seg: Segment, mode: BidiMode): Segment {
  if (mode === 'terminal') return { ...seg, text: isolateLtr(seg.text) }
  const [run] = reorderRuns([{ text: seg.text, style: seg }])
  return run ? { ...run.style, text: run.text } : seg
}

/** Mirrors a whole padded line (the pane width already decided) for a
 *  right-to-left language: 'visual' reorders it via the bidi algorithm —
 *  styles travel with their characters, brackets mirror, a line with
 *  nothing right-to-left in it comes back unchanged; 'terminal' isolates
 *  each segment's own left-to-right runs and keeps logical order. */
function mirrorLine(line: Line, mode: BidiMode, always = false): Line {
  if (mode === 'terminal') return line.map((seg) => ({ ...seg, text: isolateLtr(seg.text) }))
  return reorderRuns(line.map((seg) => ({ text: seg.text, style: seg })), { always }).map((r) => ({ ...r.style, text: r.text }))
}

/** A list row for a right-to-left language: the blocks a `gap` segment
 *  separates (title side, suffix side) are each reordered on their own, then
 *  drawn in reverse order — a Latin word in a title can't pull the progress
 *  or age into its run. Without a gap it is `mirrorLine`. */
function mirrorRow(line: Line, mode: BidiMode): Line {
  const blocks: Line[] = [[]]
  for (const seg of line) {
    if (seg.gap) blocks.push([seg], [])
    else blocks[blocks.length - 1].push(seg)
  }
  if (blocks.length === 1) return mirrorLine(line, mode)
  return blocks.reverse().flatMap((b) => (b.length === 1 && b[0].gap ? b : mirrorLine(b, mode, true)))
}

/** Right-aligns a detail-pane line that has already been finalized for
 *  drawing — mirrored as a whole paragraph (`renderDetail`'s prose lines),
 *  or entry by entry (options, attachments — see `optionLines` /
 *  `attachmentSegments`), or not at all for a left-to-right language.
 *  `geometry` calls this on the same lines `renderDetail` draws, so a click
 *  always lands on what's actually shown. */
function rightAlign(line: Line, rw: number, rtl: boolean): Line {
  return rtl ? padLeft(line, rw) : line
}

/** The tabs in the order they are drawn: reversed, each one mirrored to its
 *  own direction, for a right-to-left language. The same order and the same
 *  (unmirrored-width) spans feed both the header and `geometry`'s tabSpans,
 *  so a click and the drawing never disagree about which tab is where. */
function orderedTabs(s: FrameInput, rtl: boolean, mode: BidiMode): { view: View; segment: Segment }[] {
  const segs = tabSegments(s)
  const ids = viewIds()
  const order = rtl ? [...ids].reverse() : ids
  return order.map((v) => {
    const seg = segs[ids.indexOf(v)]
    return { view: v, segment: rtl ? mirrorSegment(seg, mode) : seg }
  })
}

/** The `,` settings dialog: a centred box, drawn in `buildFrame` and
 *  measured here so a click and the drawing never disagree. */
export interface SettingsModal {
  top: number
  left: number
  width: number
  height: number
  lines: Line[]
  /** One per `SETTINGS` entry actually drawn. `valueFrom`/`valueTo` are
   *  absent for an env-sourced row — nothing to cycle, only to select. */
  rows: { index: number; row: number; valueFrom?: number; valueTo?: number }[]
}

const SETTINGS_MODAL_WIDTH = 54

/** Centres a box `frameWidth`×`frameHeight` can hold; every row is mirrored
 *  (label and value swap sides) and right-to-left-shaped for Arabic, same
 *  as the detail pane — see `mirrorLine`. */
export function buildSettingsModal(frameWidth: number, frameHeight: number, selected: number): SettingsModal {
  const rtl = isRtl()
  const mode = bidiMode()
  const width = Math.max(24, Math.min(SETTINGS_MODAL_WIDTH, frameWidth - 2))
  const inner = width - 4
  const left = Math.max(0, Math.floor((frameWidth - width) / 2))

  const rule = (l: string, r: string): Line => [{ text: `${l}${'─'.repeat(width - 2)}${r}`, dim: true }]
  const wrap = (content: Line): Line => [{ text: '│ ', dim: true }, ...padLine(content, inner), { text: ' │', dim: true }]
  const centered = (text: string): Line => {
    const pad = Math.max(0, Math.floor((inner - stringWidth(text)) / 2))
    const line: Line = [{ text: ' '.repeat(pad) }, { text }]
    return wrap(rtl ? mirrorLine(line, mode) : line)
  }

  const lines: Line[] = [rule('┌', '┐'), centered(t('settings.title')), wrap([])]
  const rows: SettingsModal['rows'] = []
  // 6 fixed rows around the settings themselves: top rule, title, blank, blank, hint, bottom rule.
  const maxRows = Math.max(0, Math.min(SETTINGS.length, frameHeight - 6))

  for (const [i, setting] of SETTINGS.entries()) {
    if (i >= maxRows) break
    const { value, source, envName } = settingValue(setting.key)
    const selectedRow = i === selected
    const label = t(`settings.label.${setting.key}`)
    const valueSeg: Segment =
      source === 'env'
        ? { text: `${showValue(setting, value)}  ${t('settings.setBy', { env: envName ?? setting.env! })}`, dim: true, key: setting.key }
        : { text: `‹ ${showValue(setting, value)} ›`, color: selectedRow ? 'cyan' : undefined, bold: selectedRow, key: setting.key }
    const gap = Math.max(1, inner - stringWidth(label) - stringWidth(valueSeg.text))
    const logical: Line = [{ text: label, bold: selectedRow && source !== 'env' }, { text: ' '.repeat(gap) }, valueSeg]
    const finalRow = rtl ? mirrorLine(logical, mode) : logical
    const padded = padLine(finalRow, inner)
    // `row` is relative to the top of the modal for now — `top` isn't known
    // until every line is built; shifted to an absolute frame row below.
    const span = source === 'env' ? undefined : spansByKey(padded, [setting.key], left + 2)[0]
    rows.push({ index: i, row: lines.length, valueFrom: span?.from, valueTo: span?.to })
    lines.push(wrap(selectedRow ? padded.map((seg) => ({ ...seg, inverse: true })) : padded))
  }

  lines.push(wrap([]), centered(t('settings.hint')), rule('└', '┘'))
  const height = Math.min(lines.length, frameHeight)
  const top = Math.max(0, Math.floor((frameHeight - height) / 2))
  // Rows were pushed before `top` was known; shift them in now that it is.
  for (const r of rows) r.row += top
  return { top, left, width, height, lines, rows }
}

export function geometry(s: FrameInput): Geometry {
  const height = Math.max(1, s.rows - 1)
  const summary = summaryLines(s.overview, s.items, s.width, height, s.now)
  const top = 1 + summary.length + 1
  const paneRows = Math.max(1, height - top - 1)
  const lw = listWidth(s.width)
  const rw = Math.max(10, s.width - lw - 1)
  const d = s.current
  const rtl = isRtl()
  const mode = bidiMode()

  const optLines = d?.options.length ? optionLines(d, rw, rtl, mode) : []
  const footHeight = d ? 1 + Math.max(1, optLines.length) + (d.attachments.length ? 1 : 0) : 0
  const headHeight = d ? 3 : 0
  const bodyRows = d ? Math.max(1, paneRows - headHeight - footHeight) : 0
  const firstFootRow = top + headHeight + bodyRows + 1

  // "decs" stays pinned at the left edge; the tabs after it read right-to-left.
  let x = 5
  const tabSpans = orderedTabs(s, rtl, mode).map(({ view, segment }) => {
    const w = stringWidth(segment.text)
    const span = { view, from: x, to: x + w }
    x += w
    return span
  })

  // `rightX` is columns *consumed before* the detail pane starts (spans are
  // measured from there, same convention as the tabs' `x = 5` for "decs ").
  // The detail pane sits at columns 1..rw (list on the right) for a
  // right-to-left language, nothing comes before it; lw+2..width (list on
  // the left, past "list│") otherwise, lw+1 columns already used.
  const rightX = rtl ? 0 : lw + 1
  const detail = d && !isPicking(s, d) ? detailBody(s, d, rw) : { lines: [], imageRows: [] }
  return {
    height,
    summary,
    paneRows,
    lw,
    rw,
    listStart: s.listTop === undefined
      ? listTopFor(s.index, 0, paneRows, s.list.length)
      : scrollList(s.listTop, 0, paneRows, s.list.length),
    listRow0: top,
    bodyRow0: top + headHeight,
    bodyRows,
    body: detail.lines,
    bodyOffset: clamp(s.offset, 0, Math.max(0, detail.lines.length - bodyRows)),
    bodyImageRows: detail.imageRows,
    optionsRow: d ? firstFootRow : undefined,
    attachmentsRow: d?.attachments.length ? firstFootRow + Math.max(1, optLines.length) : undefined,
    // Spans are measured on the same finalized (right-aligned, and for RTL
    // already entry-by-entry mirrored — see `optLines` above) line
    // `buildFrame` draws, so a click always lands on what's actually shown.
    // A right-to-left language measures by the `.key` each segment carries
    // (set when the entry was built) rather than "bold key, then its label":
    // once entries mirror independently they can't interleave any more, but
    // a lone bold character sandwiched between two differently-directioned
    // runs can still resolve to an unexpected position on its own.
    optionSpans: optLines.flatMap((line, i) => {
      const keys = d!.options.map((o) => o.key)
      const final = rightAlign(line, rw, rtl)
      const spans = rtl ? spansByKey(final, keys, rightX) : spansOf(final, keys, rightX)
      return spans.map((sp) => ({ ...sp, row: firstFootRow + i }))
    }),
    attachmentSpans: d?.attachments.length
      ? (() => {
          const keys = d.attachments.map((_, i) => String(i + 1))
          const final = rightAlign(attachmentSegments(d, rtl, mode), rw, rtl)
          return rtl ? spansByKey(final, keys, rightX) : spansOf(final, keys, rightX)
        })()
      : [],
    tabSpans,
    promptRow: height - 1,
    settingsModal: buildSettingsModal(s.width, height, s.settingIndex ?? 0),
  }
}

export type Hit =
  | { on: 'list'; index: number }
  | { on: 'body' }
  | { on: 'option'; key: string }
  | { on: 'attachment'; n: number }
  /** An `🖼️` placeholder; `n` is 0-based into `nodeImages(current)`. */
  | { on: 'image'; n: number }
  | { on: 'prompt'; x: number }
  | { on: 'tab'; view: View }
  /** The settings dialog: `index` is into `SETTINGS`. `setting` on the
   *  value selects and cycles it; `setting` elsewhere on the row just
   *  selects it; outside the dialog box entirely closes it. */
  | { on: 'setting'; index: number }
  | { on: 'settingValue'; index: number }
  | { on: 'settingsBackdrop' }
  | null

/** Terminal coordinates are 1-based; frame rows are 0-based. */
export function hitTest(s: FrameInput, g: Geometry, x: number, y: number): Hit {
  const row = y - 1
  if (row < 0 || row >= g.height) return null
  if (s.mode === 'settings') {
    const m = g.settingsModal
    const inside = row >= m.top && row < m.top + m.height && x > m.left && x <= m.left + m.width
    if (!inside) return { on: 'settingsBackdrop' }
    const hitRow = m.rows.find((r) => r.row === row)
    if (!hitRow) return null
    if (hitRow.valueFrom !== undefined && x > hitRow.valueFrom && x <= hitRow.valueTo!) {
      return { on: 'settingValue', index: hitRow.index }
    }
    return { on: 'setting', index: hitRow.index }
  }
  if (row === 0) {
    const tab = g.tabSpans.find((t) => x > t.from && x <= t.to)
    return tab ? { on: 'tab', view: tab.view } : null
  }
  if (row === g.promptRow) return { on: 'prompt', x }
  if (row < g.listRow0) return null

  // A right-to-left language draws the list on the right (past the divider
  // after the detail pane) instead of the left.
  const onList = isRtl() ? x > g.rw + 1 : x <= g.lw
  if (onList) {
    const index = g.listStart + (row - g.listRow0)
    return index >= 0 && index < s.list.length && isSelectable(s.list[index]) ? { on: 'list', index } : null
  }
  if (g.optionSpans.some((sp) => sp.row === row)) {
    const span = g.optionSpans.find((sp) => sp.row === row && x > sp.from && x <= sp.to)
    return span ? { on: 'option', key: span.key } : null
  }
  if (row === g.attachmentsRow) {
    const span = g.attachmentSpans.find((sp) => x > sp.from && x <= sp.to)
    return span ? { on: 'attachment', n: Number(span.key) } : null
  }
  if (row >= g.bodyRow0 && row < g.bodyRow0 + g.bodyRows) {
    const line = g.bodyOffset + (row - g.bodyRow0)
    const n = g.bodyImageRows.indexOf(line)
    return n >= 0 && line < g.body.length ? { on: 'image', n } : { on: 'body' }
  }
  return null
}

/** Replaces the modal's rows wholesale — margins either side of the box are
 *  blank, not a peek at the bench underneath, the way a solid dialog box
 *  would draw over a terminal UI that has no transparency to speak of. */
function overlaySettingsModal(lines: Line[], m: SettingsModal, frameWidth: number): void {
  const right = Math.max(0, frameWidth - m.left - m.width)
  for (let i = 0; i < m.lines.length; i++) {
    const row = m.top + i
    if (row < 0 || row >= lines.length) continue
    lines[row] = [
      ...(m.left > 0 ? [{ text: ' '.repeat(m.left) }] : []),
      ...m.lines[i],
      ...(right > 0 ? [{ text: ' '.repeat(right) }] : []),
    ]
  }
}

/** Builds exactly `rows - 1` lines, each strictly narrower than the
 *  terminal; both clamps happen at this one exit point so none is missed. */
export function buildFrame(s: FrameInput, g: Geometry = geometry(s)): Line[] {
  const height = g.height
  // An empty <Text> collapses to zero height in Ink, so a blank line is a space, not nothing.
  const blank = (): Line => [{ text: ' ' }]
  const clampFrame = (ls: Line[]): Line[] => {
    const out = ls.slice(0, height).map((l) => {
      const trimmed = trimLine(l, s.width)
      return trimmed.some((seg) => seg.text.trim().length) ? trimmed : blank()
    })
    while (out.length < height) out.push(blank())
    return out
  }

  const nodes = s.list.filter((r) => r.kind === 'node').length
  const pos = s.index >= 0 ? s.list.slice(0, s.index + 1).filter((r) => r.kind === 'node').length : 0
  const projects = [...new Set(s.items.map((d) => `${d.letter ?? 'X'}·${d.project}`))]
  const rtl = isRtl()
  const mode = bidiMode()
  const header: Line = [
    { text: 'decs', bold: true },
    { text: ' ' },
    ...orderedTabs(s, rtl, mode).map((tab) => tab.segment),
  ]

  if (s.mode === 'help') {
    const rule: Line = [{ text: '─'.repeat(s.width), dim: true }]
    const body = helpText().map((l): Line => [{ text: l }])
    return clampFrame(rtl ? [header, rule, ...body.map((l) => mirrorLine(l, mode))] : [header, rule, ...body])
  }

  if (s.mode === 'text' && s.textView) {
    const v = s.textView
    const page = Math.max(1, s.rows - 4)
    const head: Line = [
      { text: `${s.current ? refOf(s.current) : ''} · ${v.label}`, bold: true },
      { text: `  ${Math.min(v.top + 1, v.lines.length)}–${Math.min(v.top + page, v.lines.length)}/${v.lines.length}`, dim: true },
      { text: `   ${t('bench.prompt.textView')}`, dim: true },
    ]
    const markdown = /\.(md|markdown)$/i.test(v.label)
    const body = v.lines.slice(v.top, v.top + page).map((l): Line => {
      const h = markdown ? /^(#{1,6})\s+(.*)$/.exec(l) : null
      return [h ? { text: fit(h[2], s.width), bold: true, color: 'cyan' } : { text: fit(l, s.width) }]
    })
    const tail: Line[] = v.truncated && v.top + page >= v.lines.length ? [[{ text: t('bench.prompt.textTruncated'), dim: true }]] : []
    return clampFrame([head, [{ text: '─'.repeat(s.width), dim: true }], ...body, ...tail])
  }

  if (s.mode === 'image') {
    // Blank on purpose: rendering this frame is what wipes the layout off the
    // screen, and the picture is then drawn over these rows from an effect.
    const all = s.current ? nodeImages(s.current) : []
    const a = all[s.imageSel]
    const name = a ? imageName(a) : ''
    // ←/→ walk only what Z leaves on screen, so the count does too.
    const vis = selectableImages(g.bodyImageRows)
    const pool = vis.includes(s.imageSel) ? vis : all.map((_, i) => i)
    const count = pool.length > 1 ? `  ${pool.indexOf(s.imageSel) + 1}/${pool.length}` : ''
    const caption: Line = [
      { text: `${s.current ? refOf(s.current) : ''} · ${name}`, bold: true },
      { text: count, dim: true },
      { text: `   ${zoomHintText(s.zoom, s.zoomable, pool.length > 1)}`, dim: true },
      ...(s.banner ? [{ text: `   ${s.banner}`, color: 'yellow' } as Segment] : []),
    ]

    const box = imageBoxFor(s.width, g.height)
    const layout = s.imageSize ? imageLayout(s.imageSize.width, s.imageSize.height, box.cols, box.rows) : null
    if (!layout || layout.textCols < MIN_PANEL_COLS || !a) return clampFrame([caption])

    const pad: Segment = { text: ' '.repeat(layout.textX) }
    const panel: Line[] = [[pad, { text: `${s.current ? refOf(s.current) : ''} · ${name}`, bold: true }, { text: count, dim: true }]]
    if (a.group) panel.push([pad, { text: a.group, color: 'cyan' }])
    if (a.caption) {
      panel.push([pad])
      for (const line of wrapToWidth(a.caption, layout.textCols)) panel.push([pad, { text: line }])
    }
    panel.push([pad])
    panel.push([pad, { text: zoomHintText(s.zoom, s.zoomable, pool.length > 1), dim: true }])
    if (s.banner) panel.push([pad, { text: s.banner, color: 'yellow' }])
    return clampFrame(panel)
  }

  const { paneRows, lw, rw } = g
  const left = renderList(s, g, lw, paneRows)
  const right = s.current ? renderDetail(s, g, s.current, rw, paneRows) : renderEmpty(s, rw)
  const divider: Segment = { text: '│', dim: true }

  const summary = rtl ? g.summary.map((l) => mirrorLine(l, mode)) : g.summary
  const lines: Line[] = [header, ...summary, [{ text: '─'.repeat(s.width), dim: true }]]
  for (let i = 0; i < paneRows; i++) {
    if (rtl) {
      // List on the right: padded to its full width first (reordering
      // doesn't add the space to mirror into), then mirrored as a whole, so
      // the row's own glyph/ref lands at its own right edge. Detail pane on
      // the left: `renderDetail`/`renderEmpty` already mirror and
      // right-align every row they return — nothing left to do here but
      // fill in the width for a row past what either one returned. The pane
      // order then just swaps.
      const leftRow = mirrorRow(padLine(left[i] ?? [], lw), mode)
      const rightRow = right[i] ?? [{ text: ' '.repeat(rw) }]
      lines.push([...rightRow, divider, ...leftRow])
    } else {
      lines.push([...padLine(left[i] ?? [], lw), divider, ...(right[i] ?? [{ text: ' ' }])])
    }
  }
  lines.push(rtl ? mirrorLine(promptLine(s), mode) : promptLine(s))
  if (s.mode === 'settings') overlaySettingsModal(lines, g.settingsModal, s.width)
  return clampFrame(lines)
}

/** The left pane, scrolled so the selection is always on screen. */
export function renderList(s: FrameInput, g: Geometry, width: number, rows: number): Line[] {
  const start = g.listStart
  const out: Line[] = []
  // One column short of the pane, so a full-width row never touches the divider.
  const inner = Math.max(4, width - 1)

  s.list.slice(start, start + rows).forEach((row, i) => {
    const selected = start + i === s.index
    let segs: Segment[]
    if (row.kind === 'header') {
      segs = [{ text: ` ${row.text}`, bold: true, color: 'magenta' }]
    } else if (row.kind === 'fold') {
      // ✓ sits in the glyph column of the rows around it.
      segs = [{ text: fit(` ${'  '.repeat(row.depth)} ${row.text}`, inner, isRtl()), dim: !selected, color: selected ? undefined : 'green' }]
    } else {
      segs = nodeRowSegments(row, s.items, inner, s.now, { tree: isTreeView(s.view) })
    }
    out.push(selected ? padLine(segs, inner).map((seg) => ({ ...seg, inverse: true })) : segs)
  })

  if (start > 0) out[0] = [{ text: fit(t('bench.row.more'), inner, isRtl()), dim: true }]
  if (start + rows < s.list.length) out[out.length - 1] = [{ text: fit(t('bench.row.moreBelow'), inner, isRtl()), dim: true }]
  return out
}

function renderEmpty(s: FrameInput, width: number): Line[] {
  const row = s.index >= 0 ? s.list[s.index] : undefined
  const rtl = isRtl()
  const mode = bidiMode()
  const finalize = (lines: Line[]): Line[] => (rtl ? lines.map((l) => padLeft(mirrorLine(l, mode), width)) : lines)
  if (row?.kind === 'fold') {
    const refs = (row.finished ?? []).map((d) => `${refOf(d)} ${d.title}`)
    return finalize([
      [{ text: ' ' }],
      [{ text: ` ${fit(row.text?.replace(/\s+[+-] .*$/, '') ?? '', width - 1, rtl)}`, bold: true, color: row.key === DEFERRED_GROUP ? undefined : 'green' }],
      [{ text: ` ${fit(row.open ? t('bench.fold.openHint') : t('bench.fold.closedHint'), width - 1, rtl)}`, dim: true }],
      [{ text: ' ' }],
      ...refs.map((r): Line => [{ text: ` ${fit(r, width - 1, rtl)}`, dim: true }]),
    ])
  }
  return finalize([
    [{ text: ' ' }],
    [{ text: ` ${fit(VIEW_EMPTY[s.view], width - 1, rtl)}` }],
    [{ text: ' ' }],
    [{ text: ` ${fit(t('bench.viewEmpty.hint'), width - 1, rtl)}`, dim: true }],
  ])
}

function renderDetail(s: FrameInput, g: Geometry, d: Decision, width: number, rows: number): Line[] {
  const rtl = isRtl()
  const mode = bidiMode()
  // Prose lines mirror themselves as one whole run; options/attachments
  // mirror entry by entry (see `optionLines`/`attachmentSegments`) so a
  // weak character shared between two entries can't interleave them. Either
  // way, the finalized line is only ever right-aligned after that — see the
  // single `padLeft` pass at the end of this function.
  const mirror = (line: Line): Line => (rtl ? mirrorLine(line, mode) : line)

  // The status stays on screen however far the body is scrolled.
  const head: Line[] = [
    mirror([
      { text: ` ${refOf(d)}  `, bold: true, color: 'cyan' },
      ...statusSegments(d, s.items, s.now),
      ...(d.queued && d.state !== 'decided' ? [{ text: t('bench.row.queuedNotCollected'), color: 'yellow' } as Segment] : []),
    ]),
    mirror([{ text: ` ${d.title}`, bold: true }]),
    [{ text: '─'.repeat(width), dim: true }],
  ]

  const foot: Line[] = []
  if (!d.options.length) {
    foot.push(
      mirror([
        {
          text: ` ${d.state === 'needs_decision' ? t('bench.detail.noOptionsFoot') : t('bench.detail.noOptionsAiFoot')}`,
          dim: true,
        },
      ]),
    )
  }
  if (d.options.length) foot.push(...optionLines(d, width, rtl, mode))
  if (d.attachments.length) foot.push(attachmentSegments(d, rtl, mode))
  foot.unshift([{ text: '─'.repeat(width), dim: true }])

  const bodyRows = g.bodyRows
  const qs = d.questions ?? []
  let body: Line[]
  let off: number
  if (isPicking(s, d)) {
    const q = questionLines(qs, s.qIndex ?? 0, s.qPicks ?? {}, s.qNotes ?? {}, width - 2)
    body = q.lines.map(mirror)
    // Keep the focused question (and its options) in view.
    off = clamp(q.focusRow - Math.floor(bodyRows / 3), 0, Math.max(0, body.length - bodyRows))
  } else {
    body = g.body.map(mirror)
    off = g.bodyOffset
    // The selected placeholder reads as selected only while focus is on it.
    const sel = s.detailFocus ? g.bodyImageRows[s.imageSel] : -1
    if (sel !== undefined && sel >= 0) {
      body = body.slice()
      body[sel] = (rtl ? padLeft(body[sel], width - 2) : padLine(body[sel], width - 2)).map((seg) => ({ ...seg, inverse: true, bold: true }))
    }
  }
  const maxOffset = Math.max(0, body.length - bodyRows)
  const scrollable = body.length > bodyRows

  const pane: Line[] = []
  for (let i = 0; i < bodyRows; i++) {
    const line = body[off + i]
    if (line === undefined) {
      pane.push([{ text: ' ' }])
      continue
    }
    if (!scrollable) {
      pane.push(line)
      continue
    }
    const mark: Segment = { text: scrollMark(i, bodyRows, off, maxOffset), dim: true }
    // The scrollbar sits at the pane's own outer edge — the left, once the
    // detail pane itself is the one on the left.
    pane.push(rtl ? [mark, ...padLeft(line, width - 1)] : [...padLine(line, width - 1), mark])
  }
  const combined = [...head, ...pane, ...foot]
  return rtl ? combined.map((l) => padLeft(l, width)) : combined
}

/** 逐条回复 replaces the body with the sub-question picker. */
function isPicking(s: FrameInput, d: Decision): boolean {
  const qs = d.questions ?? []
  return qs.length > 0 && (s.mode === 'questions' || s.mode === 'qnote' || s.mode === 'qother' || (s.mode === 'confirm' && s.pendingKey === '2'))
}

/** The detail pane's scrollable body and where each `🖼️` placeholder
 *  landed, so drawing/hit-testing/scrolling all agree on line numbers. */
export function detailBody(s: FrameInput, d: Decision, width: number): { lines: Line[]; imageRows: number[] } {
  const images = nodeImages(d)
  const meta = metaLines(d, s.items, s.now, width - 2, s.backlinks ?? [])
  const imageRows = images.map(() => -1)
  const lines: Line[] = [...meta]
  for (const r of bodyRows(d, width - 3, s.condensed, images)) {
    if (r.image !== undefined) {
      imageRows[r.image] = lines.length
      lines.push([{ text: ` ${fit(r.text, width - 3, isRtl())}`, color: 'magenta' }])
      continue
    }
    const styled = r.style ? { ...r.style, text: r.text } : styleLine(r.text)
    lines.push([{ ...styled, text: ` ${styled.text}` }])
  }
  return { lines, imageRows }
}

function scrollMark(row: number, rows: number, offset: number, maxOffset: number): string {
  const thumb = maxOffset === 0 ? 0 : Math.round((offset / maxOffset) * (rows - 1))
  return row === thumb ? '█' : '│'
}

/** The segments that come before the editable draft on the prompt row. */
function promptPrefix(s: FrameInput): Line | null {
  const d = s.current
  if (s.banner) return null
  if (s.mode === 'goto') return [{ text: t('bench.prompt.goto'), color: 'cyan', bold: true }]
  if (s.mode === 'brief') return [{ text: t(s.briefForMe ? 'bench.prompt.todo' : 'bench.prompt.brief', { target: s.briefTarget ?? '' }), color: 'blue', bold: true }]
  if (!d) return null
  if (s.mode === 'confirm') {
    const qs = d.questions ?? []
    if (qs.length && s.pendingKey === '2') {
      return [
        { text: t('bench.prompt.submit', { ref: refOf(d), summary: picksSummary(qs, s.qPicks ?? {}, s.qNotes ?? {}) }), color: 'green', bold: true },
        { text: t('bench.prompt.note'), dim: true },
      ]
    }
    const opt = d.options.find((o) => o.key === s.pendingKey)
    const verb = d.status === 'answered' ? t('bench.prompt.answerVerbChange', { ref: refOf(d), from: d.answer?.choice ?? '—' }) : t('bench.prompt.answerVerbNew', { ref: refOf(d) })
    return [
      { text: `${verb} ${s.pendingKey} ${opt?.label ?? ''}`, color: 'green', bold: true },
      { text: t('bench.prompt.note'), dim: true },
    ]
  }
  if (s.mode === 'note') return [{ text: t('bench.prompt.reply', { ref: refOf(d) }), color: 'cyan', bold: true }]
  if (s.mode === 'qnote') {
    const q = d.questions?.[s.qIndex ?? 0]
    return [{ text: t('bench.prompt.qnote', { key: q?.key ?? '' }), color: 'magenta', bold: true }]
  }
  if (s.mode === 'qother') {
    const q = d.questions?.[s.qIndex ?? 0]
    return [{ text: t('bench.prompt.qother', { key: q?.key ?? '' }), color: 'magenta', bold: true }]
  }
  if (s.mode === 'close') return [{ text: t('bench.prompt.close', { ref: refOf(d) }), color: 'red', bold: true }]
  if (s.mode === 'retitle') return [{ text: t('bench.prompt.retitle', { ref: refOf(d) }), color: 'cyan', bold: true }]
  if (s.mode === 'delay') return [{ text: t('bench.prompt.delay', { ref: refOf(d) }), color: 'magenta', bold: true }]
  return null
}

/** Column (1-based) where the draft's first character is drawn. */
export function promptDraftX(s: FrameInput): number {
  const prefix = promptPrefix(s)
  return prefix ? prefix.reduce((n, seg) => n + stringWidth(seg.text), 0) + 1 : 1
}

/** Which code point a click at column `x` lands on. */
export function caretFromColumn(draft: string, draftX: number, x: number): number {
  const chars = [...draft]
  let col = draftX
  for (let i = 0; i < chars.length; i++) {
    const w = stringWidth(chars[i])
    if (x < col + w) return i
    col += w
  }
  return chars.length
}

/** Renders the draft with the insertion point marked by an inverted cell. */
function draftSegments(s: FrameInput, placeholder: string): Segment[] {
  if (!s.draft) return [{ text: placeholder, dim: true }, { text: ' ', inverse: true }]
  const chars = [...s.draft]
  const caret = clamp(s.caret, 0, chars.length)
  return [
    { text: chars.slice(0, caret).join('') },
    { text: chars[caret] ?? ' ', inverse: true },
    { text: chars.slice(caret + 1).join('') },
  ]
}

const PLACEHOLDER: Partial<Record<Mode, () => string>> = {
  confirm: () => t('bench.placeholder.optional'),
  note: () => t('bench.placeholder.typeHere'),
  qnote: () => t('bench.placeholder.typeHere'),
  qother: () => t('bench.placeholder.typeHere'),
  close: () => t('bench.placeholder.closeReason'),
  goto: () => t('bench.placeholder.goto'),
  brief: () => t('bench.placeholder.brief'),
  retitle: () => t('bench.placeholder.retitle'),
  delay: () => t('bench.placeholder.delay'),
}

function promptLine(s: FrameInput): Line {
  if (s.banner) return [{ text: s.banner, color: 'yellow' }]
  const prefix = promptPrefix(s)
  if (prefix && TEXT_MODES.includes(s.mode)) {
    const verb = s.mode === 'confirm' ? t('bench.prompt.verbConfirm') : s.mode === 'goto' ? t('bench.prompt.verbGoto') : t('bench.prompt.verbSubmit')
    return [...prefix, ...draftSegments(s, PLACEHOLDER[s.mode]?.() ?? ''), { text: t('bench.prompt.confirmHint', { verb }), dim: true }]
  }
  if (s.mode === 'questions') {
    return [{ text: t('bench.prompt.questionsMode'), color: 'cyan', bold: true }]
  }
  if (s.mode === 'session') return [{ text: t('bench.prompt.startSession', { project: s.sessionProject ?? '' }), color: 'yellow', bold: true }]
  if (s.mode === 'attach') {
    return [{ text: s.pickToOpen ? t('bench.prompt.attachPickOpen') : t('bench.prompt.attachPickView'), color: 'cyan' }]
  }
  if (s.mode === 'browse' && s.detailFocus) {
    return [{ text: t('bench.prompt.imagePicker'), color: 'cyan', bold: true }]
  }
  return [{ text: hintsText(s.width), dim: true }]
}

/** Pads a line out to `width` so the next column starts at a fixed offset. */
function padLine(line: Line, width: number): Line {
  const used = line.reduce((n, seg) => n + stringWidth(seg.text), 0)
  return used >= width ? trimLine(line, width) : [...line, { text: ' '.repeat(width - used) }]
}

/** Pads on the left instead — right-aligns a line within `width`. */
function padLeft(line: Line, width: number): Line {
  const used = line.reduce((n, seg) => n + stringWidth(seg.text), 0)
  return used >= width ? trimLine(line, width) : [{ text: ' '.repeat(width - used) }, ...line]
}

function trimLine(segments: Segment[], width: number): Line {
  const out: Line = []
  let used = 0
  for (const seg of segments) {
    const room = width - used
    if (room <= 0) break
    const text = fit(seg.text, room)
    out.push({ ...seg, text })
    used += stringWidth(text)
  }
  return out
}
