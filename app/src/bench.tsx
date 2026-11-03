import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { Body } from './body.tsx'
import { NodeHeader } from './header.tsx'
import { QuickEntry, StartSession } from './quick.tsx'
import { DelayDialog, NewNode } from './newnode.tsx'
import { Viewer, itemsAround, type ViewItem } from './viewer.tsx'
import { BodyEditor } from './editor.tsx'
import { ViewEditor, ViewIcon } from './views.tsx'
import {
  Archive, ArrowRight, CaseUpper, CheckCheck, ChevronsDownUp, ChevronsUpDown, CircleCheck, Copy, CornerLeftUp, ExternalLink, FileText,
  FolderSearch, Inbox, Keyboard, ListChecks, Lock, Maximize2, MessageSquareReply, Paperclip, PenLine, Play, Plus, RotateCcw,
  Bot, Flag, Hourglass, Pencil, Repeat, Settings as SettingsIcon, SlidersHorizontal, Star, StickyNote, User, SquareTerminal, Timer, TimerOff, Unlink, X, type LucideIcon,
} from 'lucide-preact'

/** One size and stroke for every icon in a menu. */
const I = (Icon: LucideIcon) => <Icon size={14} strokeWidth={1.75} />
import { Bar, Glyph, Segs } from './segs.tsx'
import { gotoSessionBundleId, gotoSessionLabelKey } from './goto-label.ts'
import { MainAgentEntry } from './main-agent.tsx'
import { NodMeter } from './nod-meter.tsx'
import { hiddenCount, isSelectable, nodeCollapsed, reveal, scopeView, visibleRows, type Folds } from './rows.ts'
import { ContextMenu, type MenuItem, type MenuState } from './menu.tsx'
import { popupNative } from './native-menu.ts'
import { LetterPicker, RenameField, UnlinkConfirm } from './projects.tsx'
import { Settings } from './settings.tsx'
import { useDialogFocus } from './focus.ts'
import { useLiveMotion } from './motion.ts'
import { NoticeStack, noticeWhat, useNoticeQueue, type Notice } from './notices.tsx'
import { playNoticeSound, playSound } from './notice-sound.ts'
import { CycleBanner } from './cycles.tsx'
import { SourcesPanel } from './sources.tsx'
import { noticeTitle, plainReply } from './plain-reply.ts'
import { DraftFiles, filesOf } from './draftfiles.tsx'
import { applyOps, both, dropRows, heldAt, keepAllHeld, moveRow, nextStamp, patchNode, patchRows, pendingOver, runBatch, type BatchItem, type Held, type PendingOp } from './optimistic.ts'
import { bumpNodsToday, displayNods, type NodsBump } from './nod-bump.ts'
import { Divider, clampPanes, paneColumns, type PaneWidths } from './panes.tsx'
import { NONE, batchActions, boxHits, boxed, extend, listed, range, toggle, type Selection } from './selection.ts'
import { s } from './strings.ts'
import { OTHER_KEY, type Attachment, type Bench as BenchData, type Node, type Note, type PreviousRound, type Project, type Row, type View, type ViewName } from './types.ts'

export interface Prefs {
  view: ViewName
  selected: string | null
  folds: Folds
  onboarded: boolean
  /** Dragged pane widths; absent = the default layout. */
  panes?: PaneWidths | null
  /** Only this project's nodes in every view (its key); absent = all projects. */
  project?: string | null
}

type Composer =
  | { kind: 'answer'; key: string }
  | { kind: 'free' }
  | { kind: 'reply' }
  | { kind: 'close' }
  | null

const VIEW_ICON: Record<ViewName, string> = {
  available: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z',
  active: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.5v10a5 5 0 0 1 0-10Z',
  decide: 'M8 1.8 14.2 8 8 14.2 1.8 8Z',
  all: 'M2.5 3.5h11v2h-11zm0 3.5h11v2h-11zm0 3.5h11v2h-11z',
  waiting: 'M5 3h2v10H5zm4 0h2v10H9z',
  live: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.6a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8ZM7.2 4.5v4.1l3.1 1.9.8-1.3-2.3-1.4V4.5Z',
}

function useToast(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((m: string) => {
    setMsg(m)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(null), 2600)
  }, [])
  return [msg, show]
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))
}

export function Bench(props: {
  bench: BenchData
  /** When the read that produced `bench` began (`nextStamp()`). */
  readAt: number
  prefs: Prefs
  setPrefs: (p: Partial<Prefs>) => void
  refresh: () => Promise<void>
  refreshing: boolean
  onAddProject: () => void
  onNoProjects: () => void
  /** Single-node reloads the caller already fetched off a monitor event
   *  (N258), laid over `props.bench` the same way `ops` are — each one is
   *  its own moment's truth for that node, dropped once a later full
   *  `props.bench` catches up to it. */
  patches?: PendingOp[]
}) {
  const { prefs, setPrefs, refresh } = props
  // Actions show at once; the CLI catches up behind them (see optimistic.ts).
  const [ops, setOps] = useState<PendingOp[]>([])
  const { readAt } = props
  useEffect(
    () =>
      setOps((o) => {
        const left = pendingOver(o, readAt)
        return left.length === o.length ? o : left
      }),
    [readAt],
  )
  // `start`, closing a node as obsolete, and "done" on a node with no note change nothing
  // `computeNods` can see; the usual CLI round-trip lags the rest too. This floor (never
  // below what a moment ago already showed, reset once a new day's own count catches up
  // or begins) covers both, the same way `ops` above covers everything else about a node.
  const [nodsBump, setNodsBump] = useState<NodsBump | null>(null)
  const bumpNod = () => setNodsBump((b) => bumpNodsToday(b, props.bench.nods))
  const bench = useMemo(() => {
    const applied = applyOps(props.bench, [...ops, ...(props.patches ?? [])], readAt)
    return applied.nods ? { ...applied, nods: displayNods(applied.nods, nodsBump) } : applied
  }, [props.bench, ops, props.patches, readAt, nodsBump])
  // The sidebar picks one thing to show: a view across every project, or one project's
  // whole tree (live work, finished folded) — never the two combined. A project that is
  // gone (unlinked) falls back to the view.
  const scope = prefs.project && bench.projects.some((p) => p.project === prefs.project) ? prefs.project : null
  const views = bench.views
  const scopeName = scope ? (bench.projects.find((p) => p.project === scope)?.name ?? scope) : null
  const view = useMemo((): View => {
    if (!scope) return views.find((v) => v.view === (prefs.view === ('recent' as string) ? 'live' : prefs.view)) ?? views[0]
    const own = bench.project_views?.find((p) => p.project === scope)
    if (own) return { view: 'all', label: scopeName ?? scope, count: own.count, empty: own.empty, rows: own.rows }
    const tree = scopeView(views.find((v) => v.view === 'all') ?? views[0], scope)
    const live = tree.rows.filter((r) => r.kind === 'node' && r.state !== 'completed' && r.state !== 'closed').length
    return { ...tree, label: scopeName ?? scope, count: live, empty: s('projectEmpty') }
  }, [views, scope, scopeName, prefs.view, bench.project_views])
  const setScope = (project: string | null) => props.setPrefs({ project })
  // The node the owner just answered, closed, finished or put off stays where it was, detail and
  // all, until they pick another node or list; only then does it leave by the list's own rules.
  const [held, setHeld] = useState<{ rows: Held[]; batch: string | null } | null>(null)
  /** Clicked empty list space or Esc: no row highlighted, right pane empty. Counts as picking
   *  another node — same as `select` — so the held row (above) lets go of it too. */
  const [deselected, setDeselected] = useState(false)
  const deselect = () => {
    setDeselected(true)
    setHeld(null)
  }
  const where = `${scope ?? ''}|${view.view}`
  const rows = useMemo(() => keepAllHeld(visibleRows(view, prefs.folds), held?.rows ?? [], where, bench), [view, prefs.folds, held, where, bench])
  const liveList = !scope && view.view === 'live'
  // The composer belongs to the node it was opened on, so moving to another node closes it in the
  // same render — not in an effect that might land after the next keypress.
  const [composerOn, setComposerOn] = useState<{ c: Composer; key: string | undefined }>({ c: null, key: undefined })
  const shownKey = useRef<string | undefined>(undefined)
  const setComposer = (c: Composer) => {
    if (c && (composerOn.c?.kind !== c.kind || composerOn.key !== shownKey.current)) setDraft('')
    setComposerOn({ c, key: shownKey.current })
  }
  const [draft, setDraftText] = useState('')
  // Files pasted or dropped into the composer go with its text.
  const [draftFiles, setDraftFiles] = useState<File[]>([])
  const setDraft = (text: string) => {
    setDraftText(text)
    if (!text) setDraftFiles([])
  }
  const [busy, setBusy] = useState(false)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(() => new URLSearchParams(location.search).has('settings'))
  // Summoned by the hotkey: no transitions, so what you see is the decision, at once.
  const instant = () => {
    document.documentElement.classList.add('instant')
    setTimeout(() => document.documentElement.classList.remove('instant'), 400)
  }
  const summonRef = useRef<(key: string) => void>(() => {})
  summonRef.current = (key: string) => {
    instant()
    setPalette(false)
    setHelp(false)
    setLightbox(null)
    setDeselected(false)
    if (key && bench.nodes[key]) {
      const decide = bench.views.find((v) => v.view === 'decide')
      const folds = decide ? reveal(bench, decide, key, prefs.folds) : null
      if (folds) setPrefs({ view: 'decide', folds, selected: key })
      else jump(key)
    } else setPrefs({ view: 'decide' })

    setTimeout(() => void api.summoned('window'), 0)
  }
  useEffect(() => {
    void api.on<string>('summon', (key) => summonRef.current(key))
    void api.on<null>('open-settings', () => setSettingsOpen(true))
  }, [])
  const [viewer, setViewer] = useState<{ items: ViewItem[]; at: number } | null>(null)
  const lightbox = viewer ? viewer.at : null
  /** Opens the viewer on a node's image (by index) or attachment (by path). */
  const openView = (n: Node | undefined, what: number | string) => {
    if (!n) return
    const path = typeof what === 'number' ? n.images[what]?.path : what
    if (path) setViewer(itemsAround(n, path))
  }
  const setLightbox = (i: number | null) => (i === null ? setViewer(null) : openView(node, i))
  const [error, setError] = useState<string | null>(null)
  const [toast, showToast] = useToast()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [quick, setQuick] = useState(() => new URLSearchParams(location.search).has('quick'))
  // A node filed from here shows up only in the next bench: select it once that arrives.
  const pendingJump = useRef<string | null>(null)
  useEffect(() => {
    const key = pendingJump.current
    if (key && bench.nodes[key]) {
      pendingJump.current = null
      jumpRef.current(key)
    }
  }, [bench])
  const [startFor, setStartFor] = useState<{ project: Project; reason: 'brief' | 'menu' } | null>(null)
  const [live, setLive] = useState<Record<string, api.ProjectSessions>>({})
  // Who is listening where: sessions heartbeat every 30 s, so poll at that pace (and after every change).
  useEffect(() => {
    let gone = false
    const poll = () =>
      void api.sessions().then((list) => {
        if (!gone && list) setLive(Object.fromEntries(list.map((x) => [x.project, x])))
      })
    poll()
    const t = window.setInterval(poll, 30_000)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [bench])
  const withLive = (pr: Project): Project => {
    const l = live[pr.project]
    return l ? { ...pr, listening: l.listening } : pr
  }
  const listenerOf = (pr: Project) => live[pr.project]?.sessions.find((x) => x.role === 'lead') ?? null
  // The exact lead session `nod session goto` switches to (most recently seen, if several) is its
  // call to make; here we only need one with a recorded terminal, to show the item and word it.
  const leadTerminal = (pr: Project) => live[pr.project]?.sessions.find((x) => x.role === 'lead' && x.terminal)?.terminal
  const gotoSession = (pr: Project) => void api.gotoSession(pr.root).then((found) => { if (!found) showToast(s('sessionGone')) })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [letterFor, setLetterFor] = useState<Project | null>(null)
  const [unlinkFor, setUnlinkFor] = useState<Project | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const motion = useLiveMotion(listRef, rows.filter((r) => r.kind === 'node').map((r) => r.key), liveList, view.view)

  const selectable = rows.filter(isSelectable)
  // The cursor follows the node; when the node leaves this view it stays at the same position.
  const lastIndex = useRef(0)
  const found = selectable.findIndex((r) => r.key === prefs.selected)
  const index = found >= 0 ? found : Math.min(lastIndex.current, selectable.length - 1)
  if (index >= 0) lastIndex.current = index
  const current: Row | undefined = deselected ? undefined : selectable[index]
  const [archived, setArchived] = useState<Record<string, Node>>({})
  // More than one row picked (⌘-click, ⇧-click, ⇧↑↓, a box): the right pane and the menu act on all of them.
  const [selection, setSelection] = useState<Selection>(NONE)
  const order = useMemo(() => rows.filter((r) => r.kind === 'node').map((r) => r.key), [rows])
  const picked = listed(selection, order)
  const multi = picked.length > 1
  useEffect(() => setSelection(NONE), [where])
  const pickedSig = multi ? picked.join(' ') : null
  const pickedNodes = multi
    ? picked.flatMap((k) => {
        const key = rows.find((r) => r.key === k)?.node
        const n = key ? (bench.nodes[key] ?? archived[key]) : undefined
        return n ? [n] : []
      })
    : []
  const nodeKey = current?.kind === 'node' ? current.node! : undefined
  const node: Node | undefined = nodeKey ? (bench.nodes[nodeKey] ?? archived[nodeKey]) : undefined
  shownKey.current = node?.key
  const composer: Composer = composerOn.key === node?.key ? composerOn.c : null
  const rootOf = (n: Pick<Node, 'project'>) => bench.projects.find((p) => p.project === n.project)?.root ?? ''

  useEffect(() => setArchived({}), [bench])
  useEffect(() => {
    if (!nodeKey || bench.nodes[nodeKey] || archived[nodeKey]) return
    const [project, id] = [nodeKey.slice(0, nodeKey.lastIndexOf('#')), Number(nodeKey.slice(nodeKey.lastIndexOf('#') + 1))]
    api.loadNode(rootOf({ project }), id).then((n) => setArchived((a) => ({ ...a, [nodeKey]: n })), () => {})
  }, [nodeKey, bench, archived])

  useEffect(() => {
    if (current && current.key !== prefs.selected) setPrefs({ selected: current.key })
  }, [current?.key])
  useEffect(() => {
    if (!held) return
    const kept = held.batch !== null ? held.batch === pickedSig : !multi && held.rows[0]?.row.key === prefs.selected
    if (!kept || held.rows.some((h) => h.where !== where)) setHeld(null)
  }, [where, prefs.selected, pickedSig])
  const holdShown = (key: string) => {
    if (current?.kind !== 'node' || current.node !== key) return
    const i = rows.findIndex((r) => r.key === current.key)
    if (i >= 0) setHeld({ rows: [heldAt(rows, i, where)], batch: null })
    if (prefs.selected !== current.key) setPrefs({ selected: current.key })
  }
  /** A batch's rows all stay where they were until the selection changes. */
  const holdPicked = () => {
    const at = picked.map((k) => rows.findIndex((r) => r.key === k)).filter((i) => i >= 0)
    setHeld({ rows: at.map((i) => heldAt(rows, i, where)), batch: pickedSig })
  }

  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 })
  }, [node?.key])

  useLayoutEffect(() => {
    listRef.current?.querySelector('.row.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [prefs.selected, prefs.view])

  const select = (key: string) => (setDeselected(false), setSelection(NONE), setPrefs({ selected: key }))
  /** A new multi-selection, the cursor on `cursor` (or on the one row left picked). */
  const pick = (next: Selection, cursor: string | null) => {
    setSelection(next)
    const to = next.keys.length === 1 ? next.keys[0] : cursor
    if (to) (setDeselected(false), setPrefs({ selected: to }))
  }
  const cursorKey = current?.kind === 'node' ? current.key : null
  const rowClick = (r: Row, e?: MouseEvent) => {
    if (!isSelectable(r)) return
    if (r.kind === 'node' && e && (e.metaKey || e.ctrlKey)) {
      const next = toggle(selection, order, r.key, cursorKey)
      return pick(next, next.keys.includes(r.key) ? r.key : (next.keys[next.keys.length - 1] ?? null))
    }
    if (r.kind === 'node' && e?.shiftKey) return pick(range(selection, order, r.key, cursorKey), r.key)
    select(r.key)
  }
  const clearSelection = () => {
    setSelection(NONE)
    deselect()
  }
  /** Dragging a box from empty list space picks every row it touches (⌘ adds to what is picked). */
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const boxedJustNow = useRef(false)
  const startBox = (e: MouseEvent) => {
    if (e.target !== e.currentTarget || e.button !== 0) return
    const x0 = e.clientX
    const y0 = e.clientY
    const add = e.metaKey || e.ctrlKey
    const base = selection
    const keys = order
    let last: Selection | null = null
    const moveTo = (m: MouseEvent) => {
      if (!last && Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < 5) return
      setBox({ x0, y0, x1: m.clientX, y1: m.clientY })
      const bands = [...(listRef.current?.querySelectorAll<HTMLElement>('.row.node[data-key]') ?? [])].map((el) => {
        const b = el.getBoundingClientRect()
        return { key: el.dataset.key!, top: b.top, bottom: b.bottom }
      })
      last = boxed(base, keys, boxHits(bands, y0, m.clientY), add)
      setSelection(last)
    }
    const up = () => {
      window.removeEventListener('mousemove', moveTo)
      window.removeEventListener('mouseup', up)
      setBox(null)
      if (!last) return
      boxedJustNow.current = true
      if (last.keys.length) pick(last, last.keys[last.keys.length - 1])
    }
    window.addEventListener('mousemove', moveTo)
    window.addEventListener('mouseup', up)
  }
  const move = (delta: number) => {
    if (!selectable.length) return
    // Deselected: ↓ starts at the first row, ↑ at the last — not wherever the cursor was.
    if (deselected) return select(selectable[delta > 0 ? 0 : selectable.length - 1].key)
    const next = selectable[Math.max(0, Math.min(selectable.length - 1, Math.max(0, index) + delta))]
    select(next.key)
  }
  const switchView = (v: ViewName) => setPrefs({ view: v, project: null })
  const cycleView = (delta: number) => {
    const i = bench.views.findIndex((v) => v.view === view.view)
    switchView(bench.views[(i + delta + bench.views.length) % bench.views.length].view)
  }
  const setFold = (r: Row, open: boolean) => {
    if (r.kind === 'fold') setPrefs({ folds: { ...prefs.folds, groups: { ...prefs.folds.groups, [r.key]: open } } })
    else if (r.has_kids) setPrefs({ folds: { ...prefs.folds, nodes: { ...prefs.folds.nodes, [r.key]: !open } } })
  }
  const isOpen = (r: Row) => (r.kind === 'fold' ? Boolean(prefs.folds.groups[r.key]) : !nodeCollapsed(r, prefs.folds))

  const opSeq = useRef(0)
  /**
   * Shows `patch` now and runs `fn` behind it. Success: the patch stays until a bench read
   * after the write arrives. Failure: the patch goes (the rollback), the error shows, and
   * `undo` puts back whatever the action cleared (a composer's text).
   */
  const optimistic = (patch: (b: BenchData) => BenchData, fn: () => Promise<unknown>, done: string, undo?: (e: Error) => void) => {
    const id = ++opSeq.current
    setOps((o) => [...o, { id, patch }])
    setError(null)
    setComposer(null)
    setDraft('')
    showToast(done)
    fn().then(
      () => {
        setOps((o) => o.map((x) => (x.id === id ? { ...x, doneAt: nextStamp() } : x)))
        void refresh()
      },
      (e: Error) => {
        setOps((o) => o.filter((x) => x.id !== id))
        setError(e.message)
        showToast(s('actionFailed', { error: e.message.split('\n')[0] }))
        undo?.(e)
        void refresh()
      },
    )
  }
  const now = () => new Date().toISOString()
  /** Out of every list but the ones that keep finished nodes. */
  const finished = (key: string, state: string) =>
    both(
      patchNode(key, (n) => ({ ...n, status: state, terminal: true })),
      dropRows(key, ['all', 'live']),
      patchRows(key, (r) => ({ ...r, state, glyph: r.glyph && { ...r.glyph, dim: true, color: undefined }, badge: [], badge_short: [] })),
    )
  const answered = (key: string, choice?: string, text?: string) =>
    both(
      patchNode(key, (n) => {
        const label = choice ? `${choice}${n.options.find((o) => o.key === choice)?.label ? ` —— ${n.options.find((o) => o.key === choice)!.label}` : ''}` : ''
        const lines = [label, text?.trim() ?? ''].filter(Boolean).join('\n\n').split('\n')
        // The node's own answer is this round's: one already there means this one changes it.
        const revises = Boolean(n.answer)
        return {
          ...n,
          status: 'decided',
          answer: { choice, by: 'owner', at: now() },
          body_rows: [...n.body_rows, { text: '' }, { text: `${s('you')} | ${s('justNow')}`, style: { text: '', bold: true, color: 'magenta' } }, { text: '' }, ...lines.map((t) => ({ text: t }))],
          notes: [...n.notes, { kind: ANSWER_KIND, role: 'human', author: 'owner', at: now(), text: lines.join('\n'), revises }],
        }
      }),
      dropRows(key, ['available', 'all', 'waiting', 'live']),
      patchRows(key, (r) => ({ ...r, state: 'decided', glyph: r.glyph && { ...r.glyph, color: 'green', bold: false, dim: false }, badge: [{ text: s('answered'), color: 'green' }], badge_short: [{ text: s('answered'), color: 'green' }] })),
    )

  /** Each action on one node as its patch and its write: a single action runs one, a batch many. */
  const flagItem = (n: Node, on: boolean): BatchItem => ({
    ref: n.ref,
    patch: both(patchNode(n.key, (x) => ({ ...x, urgency: on ? 'high' : 'normal', important: on })), patchRows(n.key, (r) => ({ ...r, flag: on ? 'important' : null }))),
    write: () => api.flag(rootOf(n), n.id, on ? 'important' : 'normal'),
  })
  const assignItem = (n: Node, to: 'me' | 'ai'): BatchItem => ({
    ref: n.ref,
    patch: both(
      patchNode(n.key, (x) => ({ ...x, assignee: to === 'me' ? 'human' : 'ai', human_task: to === 'me' })),
      patchRows(n.key, (r) => ({ ...r, assignee: to === 'me' ? 'human' : 'ai', human_task: to === 'me' })),
    ),
    write: () => api.assign(rootOf(n), n.id, to),
  })
  /** N283: the third kind, alongside human/AI — a goal, never started or finished by
   *  itself. Turning it on clears whatever it was assigned to; off is the same as
   *  assigning it to an AI (nod assign <id> ai). */
  const milestoneItem = (n: Node, on: boolean): BatchItem => ({
    ref: n.ref,
    patch: both(
      patchNode(n.key, (x) => ({ ...x, milestone: on, assignee: 'ai', human_task: false })),
      patchRows(n.key, (r) => ({ ...r, assignee: 'ai', human_task: false })),
    ),
    write: () => api.assign(rootOf(n), n.id, on ? 'milestone' : 'ai'),
  })
  const startItem = (n: Node): BatchItem => {
    bumpNod()
    return {
      ref: n.ref,
      patch: both(
        patchNode(n.key, (x) => ({ ...x, status: 'in_progress' })),
        // The owner's own to-do started is ⬖ in yellow (as the CLI draws it), an AI's is ◐ in cyan; the badge waits for the reload.
        patchRows(n.key, (r) =>
          r.human_task
            ? { ...r, state: 'in_progress', glyph: r.glyph && { ...r.glyph, text: '⬖', color: 'yellow', dim: false }, badge: [], badge_short: [] }
            : { ...r, state: 'in_progress', glyph: r.glyph && { ...r.glyph, text: '◐', color: 'cyan', dim: false } },
        ),
      ),
      write: () => api.start(rootOf(n), n.id),
    }
  }
  /** 归档 without asking why: decided work is marked seen, anything still open is closed as obsolete. */
  const archiveItem = (n: Node): BatchItem => {
    bumpNod()
    return n.status === 'decided'
      ? { ref: n.ref, patch: finished(n.key, 'completed'), write: () => api.seen(rootOf(n), n.id) }
      : { ref: n.ref, patch: finished(n.key, 'closed'), write: () => api.close(rootOf(n), n.id, 'obsolete') }
  }
  /** 延迟到…: waiting on `on` (purple), or — no one named — a plain deferral (grey); `date` null = indefinitely. */
  const delayItem = (n: Node, on: string | null, date: string | null, passive: boolean): BatchItem & { active: boolean } => {
    const active = Boolean(on) || (n.status === 'waiting' && !passive)
    const until = date ? `${date}T00:00:00` : null
    return {
      ref: n.ref,
      active,
      patch: active
        ? both(
            patchNode(n.key, (x) => ({ ...x, status: 'waiting', deferred_at: null, waiting_on: on ?? x.waiting_on, waiting_until: until ?? x.waiting_until })),
            patchRows(n.key, (r) => ({ ...r, state: 'waiting', delay: 'active', deferred: false, wait_due: false, waiting_until: until ?? r.waiting_until, glyph: r.glyph && { ...r.glyph, text: '⏸', color: 'magenta', dim: false } })),
          )
        : both(
            patchNode(n.key, (x) => ({ ...x, ...(x.status === 'waiting' ? { status: 'not_started' as const, waiting_on: null } : {}), deferred_at: now(), deferred_until: date })),
            dropRows(n.key, ['all', 'live']),
            patchRows(n.key, (r) => ({ ...r, deferred: true, delay: 'passive' })),
          ),
      write: () => api.delay(rootOf(n), n.id, on, date, passive),
    }
  }
  /** 「延迟 R 天」: to today + the node's R (`every`), a wait keeping its who. */
  const everyItem = (n: Node): (BatchItem & { date: string; waiting: boolean }) | null => {
    const m = /^(\d+)([dw])$/.exec(n.every ?? '')
    if (!m) return null
    const at = new Date()
    at.setDate(at.getDate() + Number(m[1]) * (m[2] === 'w' ? 7 : 1))
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    const waiting = n.status === 'waiting'
    return {
      ref: n.ref,
      date,
      waiting,
      patch: waiting
        ? patchNode(n.key, (x) => ({ ...x, waiting_until: `${date}T00:00:00` }))
        : both(patchNode(n.key, (x) => ({ ...x, deferred_at: now(), deferred_until: date })), dropRows(n.key, ['all', 'live']), patchRows(n.key, (r) => ({ ...r, deferred: true, delay: 'passive' }))),
      write: () => api.delayEvery(rootOf(n), n.id),
    }
  }
  const moveItem = (n: Node, parent: Node): BatchItem => ({
    ref: n.ref,
    patch: patchNode(n.key, (x) => ({ ...x, parent: parent.id })),
    write: () => api.move(rootOf(n), n.id, parent.id),
  })
  /**
   * The same action on every picked node: all show at once, written a few at a time; the
   * ones that fail roll back and are named. `hold`: the rows stay put until the selection changes.
   */
  const batch = (items: BatchItem[], done: string, hold = false) => {
    if (!items.length) return
    if (hold) holdPicked()
    const first = opSeq.current + 1
    opSeq.current += items.length
    setError(null)
    showToast(s('batchDone', { what: done, count: items.length }))
    void runBatch(items, setOps, first).then((failed) => {
      void refresh()
      if (!failed.length) return
      setError(failed.map((f) => `${f.ref}: ${f.error.message.split('\n')[0]}`).join('\n'))
      showToast(s('batchFailed', { refs: failed.map((f) => f.ref).join(' ') }))
    })
  }

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setComposer(null)
      setDraft('')
      showToast(done)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canAnswer = (n: Node) => !n.terminal && (n.options.length > 0 || n.status === 'needs_decision')
  /** An answered decision keeps its answer until the owner asks to change it. */
  const [unlocked, setUnlocked] = useState<string | null>(null)
  useEffect(() => setUnlocked(null), [node?.key])
  const answerLocked = (n: Node) => Boolean(n.answer) && n.status !== 'needs_decision' && unlocked !== n.key
  const startAnswer = (key: string) => {
    if (!node || !canAnswer(node)) return
    if (answerLocked(node) && node.options.length) return showToast(s('answerLockedHint', { key: node.answer?.choice ?? '' }))
    if (node.questions.length) {
      if (key === '1') {
        holdShown(node.key)
        bumpNod()
        return act(() => api.answerDefaults(rootOf(node), node.id), s('sent'))
      }
      return detailRef.current?.querySelector<HTMLButtonElement>('.question .pick')?.focus()
    }
    if (!node.options.some((o) => o.key === key)) return
    setComposer({ kind: 'answer', key })
    setDraft('')
  }
  /** `typed` is the box as it is now — Enter can land before the last keystroke has re-rendered. */
  const send = (typed: string = draft) => {
    if (!node || !composer) return
    const files = composer.kind === 'close' ? [] : draftFiles
    const text = typed.trim() || (files.length && composer.kind !== 'answer' ? s('filesBelow') : '')
    const root = rootOf(node)
    const key = node.key
    const reopen = (c: Composer) => () => (setComposerOn({ c, key }), setDraftText(typed), setDraftFiles(files))
    if (composer.kind === 'answer') {
      setUnlocked(null)
      holdShown(key)
      bumpNod()
      return optimistic(answered(key, composer.key, text), () => api.answer(root, node.id, composer.key, text || undefined, files), s('sent'), reopen(composer))
    }
    if (composer.kind === 'free' && text) {
      holdShown(key)
      bumpNod()
      return optimistic(answered(key, undefined, text), () => api.answerFreeText(root, node.id, text, files), s('sent'), reopen(composer))
    }
    if (composer.kind === 'reply' && text) {
      bumpNod()
      return optimistic(
        patchNode(key, (n) => ({
          ...n,
          body_rows: [
            ...n.body_rows,
            { text: '' },
            { text: `${s('you')} | ${s('justNow')}`, style: { text: '', bold: true, color: 'magenta' } },
            { text: '' },
            ...text.split('\n').map((t) => ({ text: t })),
            ...files.map((f) => ({ text: `- ${f.name || 'pasted.png'}` })),
          ],
        })),
        () => api.reply(root, node.id, text, files),
        s('replied'),
        reopen(composer),
      )
    }
    if (composer.kind === 'close') {
      holdShown(key)
      bumpNod()
      return optimistic(finished(key, 'closed'), () => api.close(root, node.id, text || 'obsolete'), s('closed'), reopen(composer))
    }
  }
  /**
   * Puts `key`'s row before or after `target`'s among the rows sharing its scope (siblings in a
   * tree, one group in a list) and writes that order with one `nod order`.
   */
  const reorder = (key: string, target: string, after: boolean) => {
    const from = view.rows.find((r) => r.key === key)
    if (!from?.scope || key === target) return
    const peers = view.rows.filter((r) => r.kind === 'node' && r.scope === from.scope && r.key !== key)
    const at = peers.findIndex((r) => r.key === target)
    if (at === -1) return
    peers.splice(after ? at + 1 : at, 0, from)
    const nodes = peers.map((r) => bench.nodes[r.node ?? ''])
    const projects = new Set(nodes.map((n) => n?.project))
    const root = projects.size === 1 && nodes[0] ? rootOf(nodes[0]) : undefined
    optimistic(moveRow(key, target, after), () => api.order(peers.map((r) => r.ref ?? ''), root), s('moved', { ref: from.ref ?? '' }))
  }
  const [dragAt, setDragAt] = useState<{ key: string | null; scope: string | null; over: string | null; after: boolean }>({ key: null, scope: null, over: null, after: false })
  const drag: DragState = { ...dragAt, set: setDragAt, drop: reorder }
  /** ⌥↑ / ⌥↓: the selected node one place up or down among its peers. */
  const nudge = (delta: -1 | 1) => {
    const row = current && view.rows.find((r) => r.key === current.key)
    if (!row) return
    if (!row.scope) return showToast(s('cantMove'))
    const peers = view.rows.filter((r) => r.kind === 'node' && r.scope === row.scope)
    const next = peers[peers.indexOf(row) + delta]
    if (next) reorder(row.key, next.key, delta === 1)
  }
  const seen = () => {
    if (!node || node.terminal) return
    holdShown(node.key)
    bumpNod()
    optimistic(finished(node.key, 'completed'), () => api.seen(rootOf(node), node.id), s('dismissed'))
  }
  const startClose = () => {
    if (node && !node.terminal) setComposer({ kind: 'close' })
  }
  /** One action for both: work an AI already finished (decided — you answered, it's just waiting
   *  to be picked up) archives right away, same as "seen"; anything still open asks why first,
   *  same as "close". */
  const archive = () => {
    if (!node || node.terminal) return
    if (node.status === 'decided') return seen()
    return startClose()
  }
  const [deferFor, setDeferFor] = useState<Node | null>(null)
  /** 延迟到…: waiting on `on` (purple), or — no one named — a plain deferral (grey); `date` null = indefinitely. */
  const delayToast = (active: boolean, date: string | null) => (active ? s('heldUntil', { date: date ?? '' }) : date ? s('deferredUntil', { date }) : s('deferred'))
  const delayNode = (n: Node, on: string | null, date: string | null, passive: boolean) => {
    setDeferFor(null)
    holdShown(n.key)
    const it = delayItem(n, on, date, passive)
    optimistic(it.patch, it.write, delayToast(it.active, date))
  }
  const delayEvery = (n: Node) => {
    const it = everyItem(n)
    if (it) optimistic(it.patch, it.write, it.waiting ? s('heldUntil', { date: it.date }) : s('deferredUntil', { date: it.date }))
  }
  /** Lifts any 延迟 (a wait goes back to To do); with none, asks until when. */
  const toggleDefer = () => {
    if (!node || node.terminal) return
    if (!node.deferred_at && node.status !== 'waiting') return setDeferFor(node)
    const key = node.key
    optimistic(
      patchNode(key, (n) => ({ ...n, deferred_at: null, ...(n.status === 'waiting' ? { status: 'not_started' as const, waiting_on: null } : {}) })),
      () => api.defer(rootOf(node), node.id, true),
      s('undeferred'),
    )
  }
  /*
   * Notices: whatever an AI (or the clock) did that the owner should see, through one path
   * the "notification style" setting picks. Banner: a stack in this window when it is in front,
   * else in the banner window; System: the OS notification; Off: nothing.
   * The app side already sends System for replies, decisions, milestones and uncollected answers.
   */
  const notices = useNoticeQueue()
  const benchNow = useRef(bench)
  benchNow.current = bench
  const notify = async (n: Notice, osTooFromHere = false) => {
    const view = await api.settingsGet()
    const style = api.inDesktop ? view.settings.notify : 'banner'
    if (style === 'off') return
    playNoticeSound(n.kind, view.settings.sounds)
    if (style === 'system') {
      if (osTooFromHere) void api.noticeSystem(`${n.ref} · ${noticeWhat(n)}`, n.title)
      return
    }
    const inFront = (document.hasFocus() && document.visibilityState === 'visible') || document.documentElement.dataset.e2eFront === '1'
    if (inFront) notices.push(n)
    else void api.noticeBanner(n)
  }
  const nodeByRef = (ref: string) => Object.values(benchNow.current.nodes).find((x) => x.ref === ref)
  /** "An AI replied", carrying the reply itself: read fresh, since the bench on hand predates it. */
  const notifyReplied = async (ref: string) => {
    const n = nodeByRef(ref)
    const root = n && benchNow.current.projects.find((p) => p.project === n.project)?.root
    let text: string | undefined
    let title = n ? noticeTitle(n) : ''
    if (n && root) {
      try {
        const fresh = await api.loadNode(root, n.id)
        title = noticeTitle(fresh)
        const last = [...fresh.notes].reverse().find((x) => x.role === 'agent')
        // N203/N206: the reply's own one-line --summary, when it has one; its flattened
        // text (clamped to three lines by CSS) otherwise, same as before --summary existed.
        text = last ? last.summary || plainReply(last.text) || undefined : undefined
      } catch {
        /* the notice still goes, with what the bench on hand knows */
      }
    }
    void notify({ kind: 'replied', key: n?.key ?? '', ref, title, text })
  }
  useEffect(() => {
    void api.on<Notice>('notice', (n) => void notify(n))
    // A decision raised system-style (the OS notification only — Rust never emits a `notice`
    // for it) still gets its sound, as long as this window is alive to play it.
    void api.on<{ kind: 'update' | 'decide' }>('play-sound', (p) => {
      void api.settingsGet().then((view) => playSound(p.kind, view.settings.sounds))
    })
    void api.on<string>('decs-event', (line) => {
      try {
        const ev = JSON.parse(line) as { event?: string; owner_facing?: string[]; ref?: string; title?: string }
        for (const ref of ev.owner_facing ?? []) void notifyReplied(ref)
        if (ev.event === 'unclaimed' && ev.ref) void notify({ kind: 'uncollected', key: nodeByRef(ev.ref)?.key ?? '', ref: ev.ref, title: ev.title ?? '' })
      } catch {
        /* not JSON: an older CLI */
      }
    })
  }, [])
  // What only a fresh bench shows: a brief an AI took, a wait whose check-back day came.
  const seenBench = useRef<BenchData | null>(null)
  useEffect(() => {
    const before = seenBench.current
    seenBench.current = props.bench
    if (!before) return
    for (const n of Object.values(props.bench.nodes)) {
      const was = before.nodes[n.key]
      if (!was) continue
      if (was.brief === 'unclaimed' && n.brief === 'claimed') void notify({ kind: 'claimed', key: n.key, ref: n.ref, title: noticeTitle(n) }, true)
    }
    const due = (b: BenchData) => new Set(b.views.flatMap((v) => v.rows).filter((r) => r.wait_due && r.node).map((r) => r.node!))
    const dueBefore = due(before)
    for (const key of due(props.bench)) {
      const n = props.bench.nodes[key]
      if (n && !dueBefore.has(key)) void notify({ kind: 'checkBack', key, ref: n.ref, title: noticeTitle(n) }, true)
    }
  }, [props.bench])
  const toggleImportant = () => {
    if (!node || node.terminal) return
    const on = node.urgency !== 'high'
    const it = flagItem(node, on)
    optimistic(it.patch, it.write, on ? s('flaggedImportant') : s('unflaggedImportant'))
  }
  const reassign = () => {
    if (!node) return
    const to = node.assignee === 'human' ? 'ai' : 'me'
    const it = assignItem(node, to)
    optimistic(it.patch, it.write, to === 'me' ? s('assignedMe') : s('assignedAi'))
  }
  const toggleMilestone = () => {
    if (!node) return
    const on = !node.milestone
    const it = milestoneItem(node, on)
    optimistic(it.patch, it.write, on ? s('milestoned') : s('unmilestoned'))
  }
  const [newOpen, setNewOpen] = useState(false)
  const [viewEditor, setViewEditor] = useState<{ start?: string } | null>(null)
  /** The description (`body`) or a note (its index) being edited, on which node. */
  const [editing, setEditing] = useState<{ key: string; target: 'body' | number } | null>(null)
  const [editConflict, setEditConflict] = useState<{ n: Node; target: 'body' | number; markdown: string } | null>(null)
  const saveEdit = (n: Node, target: 'body' | number, markdown: string, overwrite = false) => {
    setEditing(null)
    const patch =
      target === 'body'
        ? patchNode(n.key, (x) => ({ ...x, description: markdown, body_rows: [...markdown.split('\n').map((text) => ({ text })), { text: '' }, ...afterDescription(x.body_rows)] }))
        : patchNode(n.key, (x) => ({ ...x, notes: x.notes.map((note, i) => (i === target ? { ...note, text: markdown } : note)) }))
    optimistic(patch, () => api.editNode(rootOf(n), n.id, target, markdown, overwrite ? undefined : (n.updated_at ?? undefined)), s('editSaved'), (e) => {
      if (/changed since|改过|改過|a changé|تغيّرت/.test(e.message)) setEditConflict({ n, target, markdown })
    })
  }
  /** The node whose title is being edited, if any — a click on it, Enter saves (`nod retitle`), Esc cancels. */
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [titleConflict, setTitleConflict] = useState<{ n: Node; title: string } | null>(null)
  const saveTitle = (n: Node, title: string, overwrite = false) => {
    setEditingTitle(null)
    const trimmed = title.trim()
    if (!trimmed || trimmed === n.title) return
    const patch = both(patchNode(n.key, (x) => ({ ...x, title: trimmed })), patchRows(n.key, (r) => ({ ...r, title: trimmed })))
    optimistic(patch, () => api.retitleNode(rootOf(n), n.id, trimmed, overwrite ? undefined : (n.updated_at ?? undefined)), s('editSaved'), (e) => {
      if (/changed since|改过|改過|a changé|تغيّرت/.test(e.message)) setTitleConflict({ n, title: trimmed })
    })
  }
  // A deferral that ended with this read: say it once.
  const backSeen = useRef(new Set<string>())
  useEffect(() => {
    for (const b of bench.back_from_deferral ?? []) {
      if (backSeen.current.has(b.key)) continue
      backSeen.current.add(b.key)
      showToast(b.text)
    }
  }, [props.bench])
  const markStart = () => {
    if (!node) return
    const it = startItem(node)
    optimistic(it.patch, it.write, s('started'))
  }
  const markDone = () => {
    if (!node) return
    holdShown(node.key)
    bumpNod()
    optimistic(finished(node.key, 'completed'), () => api.done(rootOf(node), node.id), s('markedDone'))
  }
  const goParent = () => {
    if (node?.parent != null) jump(`${node.project}#${node.parent}`)
  }
  const copy = (text: string, shown = text) => void api.copyText(text).then(() => showToast(shown.length > 40 ? s('copiedShort') : s('copiedRef', { text: shown })))
  const isMac = /Mac/.test(navigator.platform)
  const revealLabel = isMac ? s('ctxRevealMac') : s('ctxRevealWin')
  const latest = useRef<Record<string, (...a: never[]) => unknown>>({})
  latest.current = { startAnswer, archive, toggleDefer, markStart, markDone, goParent, setComposer, toggleImportant, reassign, toggleMilestone, setDeferFor, delayEvery } as never
  const batchRef = useRef(batch)
  batchRef.current = batch
  const [deferMany, setDeferMany] = useState<Node[] | null>(null)
  const [moveMany, setMoveMany] = useState<Node[] | null>(null)

  /** What fits every picked node — for the right-click menu and the right pane alike. */
  const batchMenu = (nodes: Node[]): MenuItem[] => {
    const a = batchActions(nodes)
    const run = (items: BatchItem[], done: string, hold = false) => () => batchRef.current(items, done, hold)
    const items: MenuItem[] = []
    if (a.important !== null) {
      const on = a.important
      items.push({ label: on ? s('ctxImportant') : s('unimportant'), icon: I(Star), run: run(nodes.map((n) => flagItem(n, on)), on ? s('flaggedImportant') : s('unflaggedImportant')) })
    }
    if (a.start) items.push({ label: s('ctxStart'), icon: I(Play), run: run(nodes.map(startItem), s('started')) })
    if (a.delay) {
      const every = a.every ? nodes.flatMap((n) => everyItem(n) ?? []) : []
      items.push({
        label: s('defer'),
        icon: I(Timer),
        sub: [
          ...(a.every ? [{ label: a.every.same ? s('deferEvery', { every: a.every.same }) : s('deferEveryEach'), icon: I(Repeat), run: run(every, s('deferred'), true) }] : []),
          { label: s('deferMenu'), icon: I(Hourglass), run: () => setDeferMany(nodes) },
        ],
      })
    }
    for (const to of a.assign)
      items.push({
        label: to === 'ai' ? s('assignAi') : s('assignMe'),
        icon: to === 'ai' ? I(Bot) : I(User),
        run: run(nodes.filter((n) => (n.assignee === 'human') === (to === 'ai')).map((n) => assignItem(n, to)), to === 'me' ? s('assignedMe') : s('assignedAi')),
      })
    if (a.archive) items.push({ label: s('ctxArchive'), icon: I(Archive), run: run(nodes.map(archiveItem), s('ctxArchive'), true) })
    items.push({ kind: 'separator' })
    if (a.move) items.push({ label: s('ctxMoveTo'), icon: I(CornerLeftUp), run: () => setMoveMany(nodes) })
    items.push({ label: s('ctxCopyRefs', { count: nodes.length }), icon: I(Copy), run: () => copy(nodes.map((n) => n.ref).join(' ')) })
    return items
  }
  /** Where the picked nodes can go: a live node of their project that is none of them, nor under one. */
  const moveTargets = (nodes: Node[]): Row[] => {
    const keys = new Set(nodes.map((n) => n.key))
    const under = (key: string): boolean => {
      for (let n: Node | undefined = bench.nodes[key]; n; n = n.parent != null ? bench.nodes[`${n.project}#${n.parent}`] : undefined) if (keys.has(n.key)) return true
      return false
    }
    const all = bench.views.find((v) => v.view === 'all')?.rows ?? []
    return all.filter((r) => r.kind === 'node' && r.node && !r.context && bench.nodes[r.node]?.project === nodes[0]?.project && !bench.nodes[r.node].terminal && !under(r.node))
  }

  const nodeMenu = (n: Node | undefined, r: Row): MenuItem[] => {
    const L = () => latest.current as unknown as {
      startAnswer: (k: string) => void
      toggleImportant: () => void
      reassign: () => void
      toggleMilestone: () => void
      setDeferFor: (n: Node) => void
      delayEvery: (n: Node) => void
      archive: () => void
      toggleDefer: () => void
      markStart: () => void
      markDone: () => void
      goParent: () => void
      setComposer: (c: Composer) => void
    }
    const items: MenuItem[] = []
    if (n && !n.terminal) {
      if (n.questions.length) items.push({ label: s('ctxSubQuestions'), icon: I(ListChecks), run: () => detailRef.current?.querySelector<HTMLButtonElement>('.question .pick')?.focus() })
      else if (n.options.length)
        items.push({
          label: s('ctxAnswer'),
          icon: I(CheckCheck),
          sub: n.options.map((o) => ({
            label: `${o.key} · ${o.label}${n.default === o.key ? `  (${s('defaultOption')})` : ''}`,
            shortcut: n.default === o.key ? '⏎' : /^[1-9]$/.test(o.key) ? o.key : undefined,
            checked: n.answer?.choice === o.key,
            disabled: answerLocked(n),
            run: () => L().startAnswer(o.key),
          })),
        })
      if (n.options.length && !n.questions.length && answerLocked(n))
        items.push({ label: s('changeAnswer'), icon: I(Pencil), run: () => setUnlocked(n.key) })
      else if (n.status === 'needs_decision') items.push({ label: s('ctxAnswer'), icon: I(PenLine), shortcut: '⏎', run: () => L().setComposer({ kind: 'free' }) })
    }
    if (n) items.push({ label: s('ctxReplyMenu'), icon: I(MessageSquareReply), shortcut: 'N', run: () => L().setComposer({ kind: 'reply' }) })
    if (n && !n.terminal) {
      items.push({ kind: 'separator' })
      items.push({ label: s('ctxImportant'), icon: I(Star), shortcut: '!', checked: n.urgency === 'high', run: () => L().toggleImportant() })
    }
    if (n && !n.terminal) {
      items.push({ kind: 'separator' })
      if (n.status === 'not_started') items.push({ label: s('ctxStart'), icon: I(Play), run: () => L().markStart() })
      if (n.status !== 'needs_decision') items.push({ label: s('ctxDone'), icon: I(CircleCheck), run: () => L().markDone() })
      const delayed = Boolean(n.deferred_at) || n.status === 'waiting'
      items.push({
        label: s('defer'),
        icon: I(Timer),
        sub: [
          ...(n.every ? [{ label: s('deferEvery', { every: n.every }), icon: I(Repeat), run: () => L().delayEvery(n) }] : []),
          { label: s('deferMenu'), icon: I(Hourglass), shortcut: delayed ? undefined : 'D', run: () => L().setDeferFor(n) },
          ...(delayed ? [{ label: s('undefer'), icon: I(TimerOff), shortcut: 'D', run: () => L().toggleDefer() }] : []),
        ],
      })
      items.push({ label: n.assignee === 'human' ? s('assignAi') : s('assignMe'), icon: n.assignee === 'human' ? I(Bot) : I(User), run: () => L().reassign() })
      items.push({ label: n.milestone ? s('ctxUnmilestone') : s('ctxMilestone'), icon: I(Flag), checked: n.milestone, run: () => L().toggleMilestone() })
      items.push({ label: s('ctxArchive'), icon: I(Archive), shortcut: 'A', run: () => L().archive() })
    }
    items.push({ kind: 'separator' })
    if (n?.parent != null) items.push({ label: s('ctxGoParent'), icon: I(CornerLeftUp), shortcut: '←', run: () => L().goParent() })
    items.push({
      label: s('ctxCopy'),
      icon: I(Copy),
      sub: [
        { label: s('ctxCopyRef', { ref: r.ref ?? '' }), run: () => copy(r.ref ?? '') },
        { label: s('ctxCopyTitle'), run: () => copy(r.title ?? '') },
        { label: s('ctxCopyRefTitle', { ref: r.ref ?? '' }), run: () => copy(`${r.ref ?? ''} ${r.title ?? ''}`.trim()) },
        ...(n?.file ? [{ label: s('ctxCopyPath'), run: () => copy(n.file, n.file) } as MenuItem] : []),
        ...(n?.file ? [{ label: s('ctxCopyMarkdown'), run: () => copy(`[${r.ref ?? ''} ${r.title ?? ''}](${n.file})`) } as MenuItem] : []),
        { label: s('ctxCopyCommand', { ref: r.ref ?? '' }), run: () => copy(`nod get ${r.ref ?? ''}`) },
      ],
    })
    if (n?.file) {
      items.push({ kind: 'separator' })
      items.push({ label: revealLabel, icon: I(FolderSearch), run: () => void api.reveal(n.file) })
      items.push({ label: s('ctxOpenEditor'), icon: I(FileText), run: () => void api.openPath(n.file) })
    }
    return items
  }

  const viewMenu = (v: View): MenuItem[] => {
    const items: MenuItem[] = [{ label: s('ctxOpen'), icon: I(ArrowRight), run: () => switchView(v.view) }]
    const tree = v.rows.some((r) => r.has_kids || r.kind === 'fold')
    if (tree) {
      const all = (open: boolean) => {
        const nodes = { ...prefs.folds.nodes }
        const groups = { ...prefs.folds.groups }
        for (const r of v.rows) {
          if (r.kind === 'node' && r.has_kids) nodes[r.key] = !open
          if (r.kind === 'fold') groups[r.key] = open
        }
        setPrefs({ view: v.view, folds: { nodes, groups } })
      }
      items.push({ kind: 'separator' }, { label: s('ctxExpandAll'), icon: I(ChevronsUpDown), run: () => all(true) }, { label: s('ctxCollapseAll'), icon: I(ChevronsDownUp), run: () => all(false) })
    }
    items.push({ kind: 'separator' }, { label: s('viewEditThis'), icon: I(SlidersHorizontal), run: () => setViewEditor({ start: v.view }) })
    return items
  }

  const projectMenu = (p: Project): MenuItem[] => {
    const terminal = leadTerminal(p)
    return [
      ...(live[p.project] && !live[p.project].listening ? [{ label: s('ctxStartSession'), icon: I(SquareTerminal), run: () => setStartFor({ project: withLive(p), reason: 'menu' }) } as MenuItem, { kind: 'separator' } as MenuItem] : []),
      ...(terminal
        ? [{ label: s(gotoSessionLabelKey(terminal.type)), icon: I(SquareTerminal), appIcon: gotoSessionBundleId(terminal.type), run: () => gotoSession(p) } as MenuItem, { kind: 'separator' } as MenuItem]
        : []),
      { label: s('ctxRename'), icon: I(PenLine), run: () => setRenaming(p.root) },
      { label: s('ctxChangeLetter'), icon: I(CaseUpper), run: () => (setDialogError(null), setLetterFor(p)) },
      { label: s('ctxUnlink'), icon: I(Unlink), danger: true, run: () => (setDialogError(null), setUnlinkFor(p)) },
      { kind: 'separator' },
      { label: revealLabel, icon: I(FolderSearch), run: () => void api.reveal(p.root) },
      { label: s('ctxCopyPath'), icon: I(Copy), run: () => copy(p.root, p.root) },
    ]
  }

  const fileMenu = (path: string, view: () => void = () => openView(node, path)): MenuItem[] => [
    { label: s('ctxOpen'), icon: I(Maximize2), run: view },
    { label: s('ctxOpenEditor'), icon: I(ExternalLink), shortcut: 'O', run: () => void api.openPath(path) },
    { label: revealLabel, icon: I(FolderSearch), run: () => void api.reveal(path) },
    { label: s('ctxCopyPath'), icon: I(Copy), run: () => copy(path, path) },
  ]

  const noteMenu = (text: string): MenuItem[] => [
    { label: s('ctxCopyText'), icon: I(Copy), run: () => copy(text, text) },
    ...(node ? [{ label: s('ctxReplyMenu'), icon: I(MessageSquareReply), shortcut: 'N', run: () => setComposer({ kind: 'reply' }) } as MenuItem] : []),
  ]

  /** What the element under the pointer (or the selected row, from the keyboard) offers. */
  const menuFor = (el: HTMLElement): MenuItem[] | null => {
    const host = el.closest<HTMLElement>('[data-ctx]')
    if (!host) return null
    const d = host.dataset
    switch (d.ctx) {
      case 'row': {
        const r = view.rows.find((x) => x.key === d.key)
        if (!r || r.kind !== 'node') return null
        if (multi && picked.includes(r.key)) return batchMenu(pickedNodes)
        select(r.key)
        return nodeMenu(bench.nodes[r.node!] ?? archived[r.node!], r)
      }
      case 'view': {
        const v = bench.views.find((x) => x.view === d.view)
        return v ? viewMenu(v) : null
      }
      case 'project': {
        const p = bench.projects.find((x) => x.root === d.root)
        return p ? projectMenu(p) : null
      }
      case 'image': {
        const i = Number(d.index)
        const im = node?.images[i]
        return im ? fileMenu(im.path, () => setLightbox(i)) : null
      }
      case 'file':
        return d.path ? fileMenu(d.path) : null
      case 'note':
        return noteMenu(host.querySelector<HTMLElement>('.note-body')?.innerText.trim() ?? '')
    }
    return null
  }

  // The OS draws the menu in the desktop app; the drawn one stands in for the browser demo and for
  // scripted runs, which cannot reach a native menu and must not put one on the screen.
  const nativeMenus = useRef(false)
  useEffect(() => void api.useNativeMenus().then((v) => (nativeMenus.current = v)), [])
  const showMenu = (state: MenuState) => {
    if (!nativeMenus.current) return setMenu(state)
    void popupNative(state.items, state.x, state.y).then((shown) => shown || setMenu(state))
  }
  const debugBuild = useRef(false)
  useEffect(() => void api.isDebugBuild().then((v) => (debugBuild.current = v)), [])
  const openMenuRef = useRef<(e: MouseEvent) => void>(() => {})
  openMenuRef.current = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const editable = target.closest('input, textarea, [contenteditable="true"]')
    // Text fields keep the system's Cut/Copy/Paste; debug builds keep Inspect Element on ⌥-right-click.
    if (editable || (debugBuild.current && e.altKey)) return
    e.preventDefault()
    const items = menuFor(target)
    if (items?.length) showMenu({ x: e.clientX, y: e.clientY, items })
  }
  useEffect(() => {
    const listener = (e: MouseEvent) => openMenuRef.current(e)
    window.addEventListener('contextmenu', listener)
    return () => window.removeEventListener('contextmenu', listener)
  }, [])
  const openMenuAt = (el: HTMLElement | null | undefined) => {
    if (!el) return
    const items = menuFor(el)
    if (!items?.length) return
    const r = el.getBoundingClientRect()
    showMenu({ x: Math.min(r.right - 8, r.left + 200), y: r.bottom - 4, items })
  }

  const projectAct = async (fn: () => Promise<unknown>, done: string, close: () => void) => {
    setDialogBusy(true)
    setDialogError(null)
    try {
      await fn()
      close()
      showToast(done)
      await refresh()
    } catch (e) {
      setDialogError((e as Error).message)
    } finally {
      setDialogBusy(false)
    }
  }

  const nextStuck = () => {
    const decide = bench.views.find((v) => v.view === 'decide')!
    const stuck = decide.rows.filter((r) => r.kind === 'node' && r.glyph?.bold)
    if (!stuck.length) return
    const after = stuck.findIndex((r) => r.key === prefs.selected)
    const target = stuck[(after + 1) % stuck.length]
    jump(target.node!)
  }
  const jumpRef = useRef<(key: string) => void>(() => {})
  jumpRef.current = (key: string) => jump(key)
  const jump = (nodeKey: string) => {
    for (const v of [view, ...bench.views.filter((x) => x !== view && x.view === 'all')]) {
      const folds = reveal(bench, v, nodeKey, prefs.folds)
      if (folds) {
        // A node in another project lifts the project filter, or it could not show.
        const elsewhere = scope !== null && nodeKey.slice(0, nodeKey.lastIndexOf('#')) !== scope
        setDeselected(false)
        setPrefs({ view: v.view, folds, selected: nodeKey, ...(elsewhere ? { project: null } : {}) })
        return
      }
    }
  }

  // The listener is attached once and calls whatever this render's handler is: a keypress
  // must never act on the selection of a render whose effects have not run yet.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyRef.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
  {
    onKeyRef.current = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightbox !== null) return setLightbox(null)
        if (palette) return setPalette(false)
        if (viewEditor) return setViewEditor(null)
        if (help) return setHelp(false)
        if (settingsOpen) return setSettingsOpen(false)
        if (composer) {
          setComposer(null)
          ;(document.activeElement as HTMLElement | null)?.blur()
          return
        }
        if (menu || letterFor || unlinkFor || renaming || quick || startFor || editing || editConflict || editingTitle || titleConflict || isTyping(e)) return
        if (error) return setError(null)
        if (multi) return clearSelection()
        if (scope) return setScope(null)
        if (current && !deselected) return deselect()
        return
      }
      if (palette || settingsOpen || menu || letterFor || unlinkFor || renaming || quick || startFor || newOpen || deferFor || editing || editConflict || editingTitle || titleConflict || viewEditor || isTyping(e)) return
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault()
        return openMenuAt(listRef.current?.querySelector<HTMLElement>('.row.cursor'))
      }
      // The viewer takes its own keys (←→, O, Esc).
      if (viewer) return
      if (help) return setHelp(false)
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.altKey && /^Digit[0-9]$/.test(e.code)) {
        e.preventDefault()
        const n = Number(e.code.slice(5))
        return setScope(n === 0 ? null : (bench.projects[n - 1]?.project ?? scope))
      }
      if (meta && /^[1-9]$/.test(e.key) && bench.views[Number(e.key) - 1]) {
        e.preventDefault()
        return switchView(bench.views[Number(e.key) - 1].view)
      }
      if (meta && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        return void refresh()
      }
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        return setQuick(true)
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        return setNewOpen(true)
      }
      if (meta && e.key === ',') {
        e.preventDefault()
        return setSettingsOpen(true)
      }
      if (meta && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        return props.onAddProject()
      }
      if (e.altKey && !meta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        return nudge(e.key === 'ArrowUp' ? -1 : 1)
      }
      if (meta || e.altKey) return
      // With several rows picked, one node's keys would act on the cursor row alone: the pane and menu act on them all.
      if (multi && /^([aAdeEnNr!1-9]|Enter)$/.test(e.key)) return
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault()
          const delta = e.key === 'ArrowDown' ? 1 : -1
          if (!e.shiftKey) return move(delta)
          const next = extend(selection, order, deselected ? null : cursorKey, delta)
          return pick(next.sel, next.cursor)
        }
        case 'ArrowRight':
          e.preventDefault()
          if (current && !isOpen(current)) setFold(current, true)
          else move(1)
          return
        case 'ArrowLeft':
          e.preventDefault()
          if (current && (current.has_kids || current.kind === 'fold') && isOpen(current)) return setFold(current, false)
          if (node?.parent != null) {
            const pk = `${node.project}#${node.parent}`
            if (rows.some((r) => r.key === pk)) select(pk)
          }
          return
        case 'Tab':
          e.preventDefault()
          return cycleView(e.shiftKey ? -1 : 1)
        case 'Enter':
          e.preventDefault()
          if (current?.kind === 'fold') return setFold(current, !isOpen(current))
          if (node?.can_default && node.default) return startAnswer(node.default)
          if (node && node.status === 'needs_decision' && !node.options.length && !node.questions.length) setComposer({ kind: 'free' })
          return
        case '+':
        case '=':
          return current && setFold(current, true)
        case '-':
          return current && setFold(current, false)
        case 'j':
          return detailRef.current?.scrollBy({ top: 80, behavior: 'smooth' })
        case 'k':
          return detailRef.current?.scrollBy({ top: -80, behavior: 'smooth' })
        case 'A':
        case 'a':
          e.preventDefault()
          return archive()
        case 'd':
          return toggleDefer()
        case 'g':
        case ':':
          e.preventDefault()
          return setPalette(true)
        case 'w':
          return nextStuck()
        case 'e':
        case 'E':
          e.preventDefault()
          return node && setEditing({ key: node.key, target: 'body' })
        case '!':
          return toggleImportant()
        case 'h':
          return switchView(view.view === 'live' ? 'available' : 'live')
        case 'N':
        case 'n':
        case 'r':
          e.preventDefault()
          if (node) setComposer({ kind: 'reply' })
          return
        case '?':
          return setHelp(true)
      }
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        startAnswer(e.key)
      }
    }
  }

  const sidebarRef = useRef<HTMLElement>(null)
  const listPaneRef = useRef<HTMLElement>(null)
  const [livePanes, setLivePanes] = useState<PaneWidths | null>(null)
  const [winWidth, setWinWidth] = useState(window.innerWidth)
  useEffect(() => {
    const on = () => setWinWidth(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const measurePanes = (): PaneWidths => ({ sidebar: sidebarRef.current?.offsetWidth ?? 216, list: listPaneRef.current?.offsetWidth ?? 420 })
  const donePanes = (w: PaneWidths) => {
    setLivePanes(null)
    setPrefs({ panes: w })
  }
  const resetPanes = () => {
    setLivePanes(null)
    setPrefs({ panes: null })
  }
  const panes = livePanes ?? prefs.panes
  return (
    <div class="shell" style={panes ? { gridTemplateColumns: paneColumns(clampPanes(panes, winWidth)) } : undefined}>
      <aside class="sidebar" ref={sidebarRef}>
        <div class="drag" data-tauri-drag-region />
        <nav>
          <MainAgentEntry onToast={showToast} />
          <div class="nav-sep" />
          {bench.nods && <NodMeter nods={bench.nods} />}
          <div class="section-label with-tool">
            {s('views')}
            <button class="section-tool" onClick={() => setViewEditor({})} title={s('viewEditorTitle')} aria-label={s('viewEditorTitle')}>
              <SlidersHorizontal size={13} strokeWidth={1.75} />
            </button>
          </div>
          {views.map((v, i) => (
            <button key={v.view} data-ctx="view" data-view={v.view} class={`nav-item ${!scope && v.view === view.view ? 'on' : ''}`} onClick={() => switchView(v.view)} title={i < 9 ? `⌘${i + 1}` : undefined}>
              {v.icon ? (
                <ViewIcon name={v.icon} tone={v.view} />
              ) : (
                <svg viewBox="0 0 16 16" class={`ico ico-${v.view}`}>
                  <path d={VIEW_ICON[v.view as keyof typeof VIEW_ICON] ?? VIEW_ICON.all} />
                </svg>
              )}
              <span class="label">{v.label}</span>
              {v.view === 'waiting' && (v.due_count ?? 0) > 0 && (
                <span class="count due" title={s('waitDueCount', { count: v.due_count! })}>
                  {v.due_count}
                </span>
              )}
              {v.count !== null && v.count - (v.view === 'waiting' ? (v.due_count ?? 0) : 0) > 0 && (
                <span class={`count ${v.view === 'decide' ? 'hot' : ''}`}>{v.count - (v.view === 'waiting' ? (v.due_count ?? 0) : 0)}</span>
              )}
            </button>
          ))}
          <div class="section-label">{s('projects')}</div>
          {bench.projects.map((p, i) => (
            <div
              key={p.root}
              class={`project ${renaming === p.root ? 'editing' : ''} ${scope === p.project ? 'on' : ''}`}
              title={`${p.root}${i < 9 ? `  ⌘⌥${i + 1}` : ''}`}
              data-ctx="project"
              data-root={p.root}
              aria-pressed={scope === p.project}
              onClick={() => renaming !== p.root && setScope(p.project)}
            >
              <span
                class={`live-dot ${live[p.project] ? (live[p.project].listening ? 'on' : 'off') : 'unknown'}`}
                title={live[p.project] ? (live[p.project].listening ? s('listening', { who: listenerOf(p)?.author ?? listenerOf(p)?.harness ?? 'AI' }) : s('notListening')) : ''}
              />
              {(p.stale_count ?? 0) > 0 && renaming !== p.root && (
                <span class="stale-count" title={s('staleCountHint', { count: p.stale_count! })}>
                  {p.stale_count}
                </span>
              )}
              <span class="letter" onDblClick={() => (setDialogError(null), setLetterFor(p))}>
                {p.letter}
              </span>
              {renaming === p.root ? (
                <RenameField
                  project={p}
                  onCancel={() => setRenaming(null)}
                  onDone={(name) => {
                    setRenaming(null)
                    if (name === p.name) return
                    void projectAct(() => api.renameProject(p.root, name), s('renamed'), () => {})
                  }}
                />
              ) : (
                <span class="label" onDblClick={() => setRenaming(p.root)}>
                  {p.name ?? p.project}
                </span>
              )}
              <button
                class="more"
                aria-label={s('moreActions')}
                title={s('moreActions')}
                onClick={(e) => (e.stopPropagation(), openMenuAt(e.currentTarget.parentElement))}
              >
                ⋯
              </button>
            </div>
          ))}
          <button class="nav-item add" onClick={props.onAddProject}>
            <Plus size={15} strokeWidth={1.75} class="ico" />
            <span class="label">{s('addProject')}</span>
          </button>
        </nav>
        <SourcesPanel sources={bench.sources ?? []} />
        <footer>
          <span class={`live ${props.refreshing ? 'busy' : ''}`}>
            <span class="pulse" />
            {props.refreshing ? s('refreshing') : s('live')}
          </span>
          <span class="foot-buttons">
            <button class="kbd-hint" onClick={() => setSettingsOpen(true)} title={`${s('settingsTitle')} (⌘,)`}>
              <SettingsIcon size={15} strokeWidth={1.75} class="ico" />
            </button>
            <button class="kbd-hint" onClick={() => setHelp(true)} title={`${s('shortcuts')} (?)`}>
              <Keyboard size={15} strokeWidth={1.75} class="ico" />
            </button>
          </span>
        </footer>
      </aside>

      <NoticeStack q={notices} onOpen={(key) => key && jump(key)} floating />
      <main class="list-pane" ref={listPaneRef}>
        <Divider which="sidebar" measure={measurePanes} onMove={setLivePanes} onDone={donePanes} onReset={resetPanes} />
        <header class="pane-head" data-tauri-drag-region>
          <h1>{view.label}</h1>
          {view.count !== null && <span class="head-count">{view.count}</span>}
        </header>
        <CycleBanner cycles={bench.cycles ?? []} onJump={jump} />
        {motion.above > 0 && (
          <button class="new-above" onClick={motion.toTop}>
            ↑ {s('newAbove', { count: motion.above })}
          </button>
        )}
        <div
          class="list"
          ref={listRef}
          role="listbox"
          aria-multiselectable="true"
          onMouseDown={startBox}
          onClick={(e) => {
            if (boxedJustNow.current) return void (boxedJustNow.current = false)
            if (e.target === e.currentTarget) clearSelection()
          }}
        >
          {!rows.length && (
            <div class="empty">
              <Inbox size={28} strokeWidth={1.25} />
              <span>{view.empty}</span>
            </div>
          )}
          {rows.map((r) => (
            <ListRow
              key={r.key}
              row={r}
              drag={drag}
              arrived={motion.arrived.get(r.key)}
              selected={multi ? picked.includes(r.key) : current?.key === r.key}
              cursor={current?.key === r.key}
              open={isOpen(r)}
              hidden={r.kind === 'node' && !isOpen(r) ? hiddenCount(view, view.rows.indexOf(r)) : 0}
              onClick={(e) => rowClick(r, e)}
              onToggle={() => setFold(r, !isOpen(r))}
              onMore={(el) => openMenuAt(el)}
            />
          ))}
        </div>
        {box && (
          <div
            class="select-box"
            style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
          />
        )}
      </main>

      <section class="detail-pane">
        <Divider which="list" measure={measurePanes} onMove={setLivePanes} onDone={donePanes} onReset={resetPanes} />
        <div class="drag" data-tauri-drag-region />
        {multi ? (
          <BatchPane count={picked.length} items={batchMenu(pickedNodes)} error={error} />
        ) : node ? (
          <Detail
            key={node.key}
            node={node}
            bench={bench}
            scrollRef={detailRef}
            composer={composer}
            draft={draft}
            setDraft={setDraft}
            files={draftFiles}
            setFiles={setDraftFiles}
            busy={busy}
            error={error}
            canAnswer={canAnswer(node)}
            locked={answerLocked(node)}
            onUnlock={() => setUnlocked(unlocked === node.key ? null : node.key)}
            onAnswer={startAnswer}
            onSend={send}
            onCancel={() => setComposer(null)}
            onReply={() => setComposer({ kind: 'reply' })}
            onFree={() => setComposer({ kind: 'free' })}
            onDefer={toggleDefer}
            onArchive={archive}
            onJump={jump}
            listening={(() => {
              const pr = bench.projects.find((x) => x.project === node.project)
              const l = pr && live[pr.project]
              return l ? { on: l.listening, who: l.sessions.find((x) => x.role === 'lead')?.author ?? null } : null
            })()}
            onImage={setLightbox}
            onFile={(path) => openView(node, path)}
            editing={editing?.key === node.key ? editing.target : null}
            onEdit={(target) => setEditing({ key: node.key, target })}
            onSaveEdit={(target, md) => saveEdit(node, target, md)}
            onCancelEdit={() => setEditing(null)}
            onFiles={(target, files) => void api.attachFiles(rootOf(node), node.id, files, target).then(() => (showToast(s('attachedFiles', { count: files.length })), refresh()), (e: Error) => setError(e.message))}
            onQuestions={(picks, notes, note) => (bumpNod(), optimistic(answered(node.key), () => api.answerQuestions(rootOf(node), node.id, picks, notes, note), s('sent')))}
            editingTitle={editingTitle === node.key}
            onStartTitle={() => setEditingTitle(node.key)}
            onSaveTitle={(title) => saveTitle(node, title)}
            onCancelTitle={() => setEditingTitle(null)}
          />
        ) : current?.kind === 'fold' ? (
          <div class="placeholder">
            <div class="ph-glyph">✓</div>
            <p>{current.text}</p>
          </div>
        ) : (
          <div class="placeholder">
            <div class="ph-glyph">◇</div>
            <p class="ph-title">{s('nothingSelected')}</p>
            <p>{s('pickSomething', { count: view.count ?? selectable.length })}</p>
          </div>
        )}
      </section>

      {palette && <Palette rows={bench.views.find((v) => v.view === 'all')?.rows ?? []} onPick={(k) => (setPalette(false), jump(k))} onClose={() => setPalette(false)} />}
      {help && <Help onClose={() => setHelp(false)} />}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} onShared={() => void refresh()} />}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {quick && (
        <QuickEntry
          projects={bench.projects.map(withLive)}
          project={withLive(bench.projects.find((x) => x.project === node?.project) ?? bench.projects[0])}
          under={node && !node.terminal ? { ref: node.ref, title: node.title } : null}
          onClose={() => setQuick(false)}
          onFiled={(brief, pr) => {
            setQuick(false)
            showToast(s('filedBrief', { ref: brief.ref }))
            pendingJump.current = `${brief.project}#${brief.id}`
            void refresh()
            const listening = brief.listening ?? live[pr.project]?.listening
            if (listening === false) setStartFor({ project: pr, reason: 'brief' })
          }}
        />
      )}
      {newOpen && (
        <NewNode
          projects={bench.projects.map(withLive)}
          project={(() => {
            const p = bench.projects.find((x) => x.project === (scope ?? node?.project))
            return p ? withLive(p) : null
          })()}
          under={node && !node.terminal ? { ref: node.ref, title: node.title, project: node.project } : null}
          onClose={() => setNewOpen(false)}
          onDone={(made) => {
            setNewOpen(false)
            showToast(s('added', { ref: made.ref }))
            pendingJump.current = `${made.project}#${(made as { id?: number }).id ?? ''}`
            void refresh()
          }}
        />
      )}
      {viewEditor && <ViewEditor start={viewEditor.start} onClose={() => setViewEditor(null)} onChanged={() => void refresh()} />}
      {editConflict && (
        <EditConflict
          onReload={() => (setEditConflict(null), void refresh())}
          onOverwrite={() => {
            const c = editConflict
            setEditConflict(null)
            saveEdit(c.n, c.target, c.markdown, true)
          }}
          onKeep={() => {
            const c = editConflict
            setEditConflict(null)
            setEditing({ key: c.n.key, target: c.target })
          }}
        />
      )}
      {titleConflict && (
        <EditConflict
          onReload={() => (setTitleConflict(null), void refresh())}
          onOverwrite={() => {
            const c = titleConflict
            setTitleConflict(null)
            saveTitle(c.n, c.title, true)
          }}
          onKeep={() => {
            const c = titleConflict
            setTitleConflict(null)
            setEditingTitle(c.n.key)
          }}
        />
      )}
      {deferMany && (
        <DelayDialog
          node={deferMany.every((n) => n.status === 'waiting') ? deferMany[0] : { ...deferMany[0], status: 'not_started', waiting_on: null }}
          subject={s('selectedCount', { count: deferMany.length })}
          busy={busy}
          onClose={() => setDeferMany(null)}
          onDelay={(on, date, passive) => {
            const nodes = deferMany
            setDeferMany(null)
            const items = nodes.map((n) => delayItem(n, on, date, passive))
            batch(items, delayToast(items.every((i) => i.active), date), true)
          }}
        />
      )}
      {moveMany && (
        <Palette
          rows={moveTargets(moveMany)}
          placeholder={s('moveToPlaceholder')}
          onClose={() => setMoveMany(null)}
          onPick={(k) => {
            const nodes = moveMany
            const parent = bench.nodes[k]
            setMoveMany(null)
            if (parent) batch(nodes.map((n) => moveItem(n, parent)), s('movedUnder', { ref: parent.ref }))
          }}
        />
      )}
      {deferFor && <DelayDialog node={deferFor} busy={busy} onClose={() => setDeferFor(null)} onDelay={(on, date, passive) => delayNode(deferFor, on, date, passive)} />}
      {startFor && (
        <StartSession
          project={startFor.project}
          reason={startFor.reason}
          onClose={() => setStartFor(null)}
          onDone={(msg) => {
            setStartFor(null)
            showToast(msg)
            setTimeout(() => void api.sessions().then((list) => list && setLive(Object.fromEntries(list.map((x) => [x.project, x])))), 4000)
          }}
        />
      )}
      {letterFor && (
        <LetterPicker
          project={letterFor}
          projects={bench.projects}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setLetterFor(null)}
          onPick={(l) => void projectAct(() => api.setLetter(letterFor.root, l), s('letterChanged'), () => setLetterFor(null))}
        />
      )}
      {unlinkFor && (
        <UnlinkConfirm
          project={unlinkFor}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setUnlinkFor(null)}
          onConfirm={() =>
            void projectAct(
              async () => {
                await api.unlinkProject(unlinkFor.root)
                if (!(await api.listProjects()).length) props.onNoProjects()
              },
              s('unlinked'),
              () => setUnlinkFor(null),
            )
          }
        />
      )}
      {viewer && <Viewer items={viewer.items} at={viewer.at} onAt={(at) => setViewer({ ...viewer, at })} onClose={() => setViewer(null)} />}
      <div class={`toast ${toast ? 'show' : ''}`}>{toast}</div>
    </div>
  )
}

/** The right pane with several rows picked: how many, and the actions that fit them all. */
function BatchPane(p: { count: number; items: MenuItem[]; error: string | null }) {
  const buttons = p.items.flatMap((i) => (i.kind === 'separator' || i.kind === 'header' ? [] : (i.sub ?? [i])))
  return (
    <>
      <div class="placeholder batch">
        <div class="ph-glyph">◇</div>
        <p class="ph-title">{s('selectedCount', { count: p.count })}</p>
        <div class="batch-actions">
          {buttons.map((b) =>
            b.kind === 'separator' || b.kind === 'header' ? null : (
              <button key={b.label} class="ghost" onClick={b.run} disabled={b.disabled}>
                {b.icon}
                {b.label}
              </button>
            ),
          )}
        </div>
        <p>{s('batchHint')}</p>
      </div>
      {p.error && (
        <div class="dock">
          <div class="error">
            <b>{s('errorTitle')}</b> {p.error}
          </div>
        </div>
      )}
    </>
  )
}

/** A row being dragged, and where it would land: before or after `over`. */
interface DragState {
  key: string | null
  scope: string | null
  over: string | null
  after: boolean
  set: (d: { key: string | null; scope: string | null; over: string | null; after: boolean }) => void
  drop: (key: string, target: string, after: boolean) => void
}

/** An important row's background says who it's on: waiting outside, needing the owner
 *  (assigned to them, or a decision), or an AI's own live work. 等待 wins over 需要你 over AI. */
function importantTone(r: Row): 'waiting' | 'you' | 'ai' | null {
  if (r.flag !== 'important') return null
  if (r.state === 'waiting') return 'waiting'
  if (r.assignee === 'human' || r.state === 'needs_decision') return 'you'
  return 'ai'
}

function ListRow(p: { row: Row; drag: DragState; arrived?: number; selected: boolean; cursor: boolean; open: boolean; hidden: number; onClick: (e?: MouseEvent) => void; onToggle: () => void; onMore: (el: HTMLElement) => void }) {
  const r = p.row
  if (r.kind === 'header') return <div class="row header">{r.text}</div>
  const indent = { paddingInlineStart: `${12 + r.depth * 18}px` }
  if (r.kind === 'fold')
    return (
      <div class={`row fold ${p.selected ? 'sel' : ''} ${p.cursor ? 'cursor' : ''}`} style={indent} onClick={() => (p.onClick(), p.onToggle())}>
        <span class={`caret ${p.open ? 'open' : ''}`}>›</span>
        <span class="fold-text">{r.text?.replace(/^[⏷⏵▾▸▼▶]\s*/u, '')}</span>
      </div>
    )
  const badge = r.badge ?? []
  const d = p.drag
  const landing = d.key && d.over === r.key && d.key !== r.key ? (d.after ? 'drop-after' : 'drop-before') : ''
  return (
    <div
      class={`row node ${p.selected ? 'sel' : ''} ${p.cursor ? 'cursor' : ''} ${r.context ? 'context' : ''} ${r.deferred ? 'deferred' : ''} ${r.wait_due ? 'wait-due' : ''} ${importantTone(r) ? `important-${importantTone(r)}` : ''} state-${r.state} ${d.key === r.key ? 'dragging' : ''} ${landing} ${p.arrived !== undefined ? 'arrived' : ''}`}
      style={p.arrived !== undefined ? { ...indent, animationDelay: `${p.arrived}ms` } : indent}
      draggable={Boolean(r.scope)}
      onDragStart={(e) => {
        if (!r.scope) return
        e.dataTransfer?.setData('text/plain', r.ref ?? r.key)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        d.set({ key: r.key, scope: r.scope, over: null, after: false })
      }}
      onDragOver={(e) => {
        if (!d.key || !r.scope || r.scope !== d.scope) return
        e.preventDefault()
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const after = e.clientY > box.top + box.height / 2
        if (d.over !== r.key || d.after !== after) d.set({ ...d, over: r.key, after })
      }}
      onDrop={(e) => {
        if (!d.key || r.scope !== d.scope) return
        e.preventDefault()
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
        d.drop(d.key, r.key, e.clientY > box.top + box.height / 2)
        d.set({ key: null, scope: null, over: null, after: false })
      }}
      onDragEnd={() => d.set({ key: null, scope: null, over: null, after: false })}
      onMouseDown={(e) => (e.shiftKey || e.metaKey || e.ctrlKey) && e.preventDefault()}
      onClick={(e) => p.onClick(e)}
      role="option"
      aria-selected={p.selected}
      data-ctx="row"
      data-key={r.key}
      data-scope={r.scope ?? undefined}
    >
      <span class={`mark ${r.mark ?? ''}`}>{r.mark ? '◆' : ''}</span>
      <span
        class={`caret ${r.has_kids ? '' : 'none'} ${p.open ? 'open' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          if (r.has_kids) p.onToggle()
        }}
      >
        {r.has_kids ? '›' : ''}
      </span>
      <Glyph g={r.glyph} />
      <span class="ref">{r.ref}</span>
      {r.flag === 'important' && <span class="flag-mark important" title={s('important')}>★</span>}
      <span class="title" title={r.touch?.text && r.touch.text.trim() !== r.title ? r.touch.text : undefined}>
        {r.title}
        {r.touch?.text && r.touch.text.trim() !== r.title && <span class="excerpt-inline"> {r.touch.text.replace(/\s+/g, ' ')}</span>}
      </span>
      {p.hidden > 0 && <span class="hidden-count">+{p.hidden}</span>}
      <span class="badge full">
        <Segs segs={badge} trim />
      </span>
      <span class="badge short">
        <Segs segs={r.badge_short ?? badge} trim />
      </span>
      <button
        class="more"
        tabIndex={-1}
        aria-label={s('moreActions')}
        title={`${s('moreActions')} (⇧F10)`}
        onClick={(e) => {
          e.stopPropagation()
          p.onClick()
          p.onMore(e.currentTarget.parentElement!)
        }}
      >
        ⋯
      </button>
    </div>
  )
}

function Detail(p: {
  node: Node
  bench: BenchData
  scrollRef: { current: HTMLDivElement | null }
  composer: Composer
  draft: string
  setDraft: (s: string) => void
  files: File[]
  setFiles: (f: File[] | ((prev: File[]) => File[])) => void
  busy: boolean
  error: string | null
  canAnswer: boolean
  /** Answered: the cards are read-only until "Change answer". */
  locked: boolean
  onUnlock: () => void
  onAnswer: (key: string) => void
  onSend: (typed?: string) => void
  onCancel: () => void
  onReply: () => void
  onFree: () => void
  onDefer: () => void
  onArchive: () => void
  onJump: (key: string) => void
  listening: { on: boolean; who: string | null } | null
  onImage: (i: number) => void
  /** Opens an attachment in the big viewer. */
  onFile: (path: string) => void
  /** The description (`body`) or note index being edited here, if any. */
  editing: 'body' | number | null
  onEdit: (target: 'body' | number) => void
  onSaveEdit: (target: 'body' | number, markdown: string) => void
  onCancelEdit: () => void
  onFiles: (target: 'body' | number, files: File[]) => void
  onQuestions: (picks: Record<string, string>, notes: Record<string, string>, note?: string) => void
  editingTitle: boolean
  onStartTitle: () => void
  onSaveTitle: (title: string) => void
  onCancelTitle: () => void
}) {
  const n = p.node
  // Each message's files sit under it when the CLI says which message they belong to; older CLIs: one list at the end.
  const perMessage = n.body_attachments !== undefined || n.notes.some((x) => x.attachments !== undefined)
  const files = perMessage ? [] : n.attachments.filter((a) => !a.image)
  const fileChips = (list: Attachment[] | undefined) => {
    const only = (list ?? []).filter((a) => !a.image)
    if (!only.length) return null
    return (
      <div class="note-files">
        {only.map((a, i) => (
          <button key={i} class="file" data-ctx="file" data-path={a.path} onClick={() => p.onFile(a.path)} title={a.caption ?? a.label}>
            <Paperclip size={13} strokeWidth={1.75} />
            <span class="cap-text">{a.label}</span>
          </button>
        ))}
      </div>
    )
  }
  const chosen = n.answer?.choice
  const waitsForAnswer = !n.terminal && n.status === 'needs_decision'
  return (
    <>
    <div class="detail" ref={p.scrollRef}>
      <div class="detail-inner">
        <NodeHeader
          n={n}
          onJump={p.onJump}
          listening={p.listening}
          editingTitle={p.editingTitle}
          onStartTitle={p.onStartTitle}
          onSaveTitle={p.onSaveTitle}
          onCancelTitle={p.onCancelTitle}
        />

        {n.options.length > 0 && !n.questions.length && (
          <section class="decide">
            <div class="options">
              {n.options.map((o) => {
                const isDefault = n.default === o.key
                const isChosen = chosen === o.key
                const pending = p.composer?.kind === 'answer' && p.composer.key === o.key
                const open = p.canAnswer && !p.locked
                return (
                  <button
                    key={o.key}
                    class={`option ${isChosen ? 'chosen' : ''} ${pending ? 'pending' : ''} ${open ? '' : 'locked'}`}
                    onClick={() => p.onAnswer(o.key)}
                    disabled={!open}
                  >
                    <span class="key">{o.key}</span>
                    <span class="opt-main">
                      <span class="opt-label">
                        {o.label}
                        {isDefault && (
                          <span class="chip def" title={waitsForAnswer && n.if_no_answer ? `${s('ifNoAnswer')}: ${n.if_no_answer}` : s('defaultOption')}>
                            {waitsForAnswer && n.if_no_answer ? <Timer size={11} strokeWidth={2} /> : null}
                            {s('defaultOption')} ⏎
                            {waitsForAnswer && n.reversible !== null && n.if_no_answer ? (
                              n.reversible ? <RotateCcw size={11} strokeWidth={2} aria-label={s('reversible')} /> : <Lock size={11} strokeWidth={2} aria-label={s('irreversible')} />
                            ) : null}
                          </span>
                        )}
                        {isChosen && <span class="chip ok">✓ {s('answered')}</span>}
                      </span>
                      {o.body && (
                        <span class="opt-body">
                          <Body rows={o.body.split('\n').map((text) => ({ text }))} images={[]} onImage={() => {}} />
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
            {p.canAnswer && chosen && n.status !== 'needs_decision' && (
              <div class="answer-actions">
                <button class={`ghost change-answer ${p.locked ? '' : 'on'}`} onClick={p.onUnlock} disabled={p.busy}>
                  {p.locked ? <Pencil size={14} strokeWidth={1.75} /> : <Lock size={14} strokeWidth={1.75} />}
                  <span>{p.locked ? s('changeAnswer') : s('keepAnswer')}</span>
                </button>
                {!p.locked && <span class="d small">{s('changeAnswerHint')}</span>}
              </div>
            )}
          </section>
        )}

        {n.questions.length > 0 && <Questions node={n} busy={p.busy} onSubmit={p.onQuestions} />}
        {(n.previous_rounds?.length ?? 0) > 0 && <PreviousRounds rounds={n.previous_rounds!} />}

        {n.status === 'needs_decision' && !n.options.length && !n.questions.length && p.composer?.kind !== 'free' && (
          <section class="decide">
            <button class="option" onClick={p.onFree}>
              <span class="key">✎</span>
              <span class="opt-main">
                <span class="opt-label">{s('freeText')}</span>
              </span>
            </button>
          </section>
        )}

        {p.editing === 'body' ? (
          <>
            <BodyEditor markdown={n.description ?? ''} onSave={(md) => p.onSaveEdit('body', md)} onCancel={p.onCancelEdit} onFiles={(f) => p.onFiles('body', f)} />
            <Body rows={afterDescription(n.body_rows)} images={n.images} onImage={p.onImage} />
          </>
        ) : (
          <div class="body-wrap">
            <button class="ghost edit-body" onClick={() => p.onEdit('body')} title={`${s('edEdit')} (E)`}>
              <PenLine size={13} strokeWidth={1.75} />
              {s('edEdit')}
            </button>
            {!n.description?.trim() && (
              <button class="body-placeholder" onClick={() => p.onEdit('body')}>
                {s('bodyPlaceholder')}
              </button>
            )}
            <Body
              rows={n.description?.trim() ? n.body_rows : afterDescription(n.body_rows)}
              images={n.images}
              onImage={p.onImage}
              notes={{
                tools: (i, human) =>
                  human && p.editing === null && !isAnswerNote(n.notes[i]) ? (
                    <button class="note-edit" onClick={() => p.onEdit(i)} title={s('edEdit')} aria-label={s('edEdit')}>
                      <PenLine size={12} strokeWidth={1.75} />
                    </button>
                  ) : null,
                summary: (i) => n.notes[i]?.summary,
                decision: (i) => decisionLabel(n.notes[i]),
                after: perMessage ? (i) => fileChips(i === -1 ? n.body_attachments : n.notes[i]?.attachments) : undefined,
                replace: (i) =>
                  p.editing === i ? (
                    <BodyEditor markdown={n.notes[i]?.text ?? ''} onSave={(md) => p.onSaveEdit(i, md)} onCancel={p.onCancelEdit} onFiles={(f) => p.onFiles(i, f)} />
                  ) : null,
              }}
            />
          </div>
        )}

        {files.length > 0 && (
          <section class="files">
            {files.map((a, i) => (
              <button key={i} class="file" data-ctx="file" data-path={a.path} onClick={() => p.onFile(a.path)} title={s('attachments')}>
                <Paperclip size={14} strokeWidth={1.75} />
                <span>{a.label}</span>
                {a.caption && <span class="d"> — {a.caption}</span>}
              </button>
            ))}
          </section>
        )}
        <div class="spacer" />
      </div>
    </div>

      <div class="dock">
        {p.error && (
          <div class="error">
            <b>{s('errorTitle')}</b> {p.error}
          </div>
        )}
        {p.composer ? (
          <ComposerBox {...p} />
        ) : (
          <div class="actions">
            <button class="ghost" onClick={p.onReply}>
              <MessageSquareReply size={15} strokeWidth={1.75} />
              {s('reply')} <kbd>N</kbd>
            </button>
            {!n.terminal && (
              <button class="ghost" onClick={p.onDefer}>
                {n.deferred_at ? <TimerOff size={15} strokeWidth={1.75} /> : <Timer size={15} strokeWidth={1.75} />}
                {n.deferred_at ? s('undefer') : s('defer')} <kbd>D</kbd>
              </button>
            )}
            <span class="grow" />
            {!n.terminal && (
              <button class="quiet" onClick={p.onArchive} title={s('archiveHint')}>
                <Archive size={14} strokeWidth={1.75} />
                <span class="ql">{s('ctxArchive')}</span> <kbd>A</kbd>
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function ComposerBox(p: {
  node: Node
  composer: Composer
  draft: string
  setDraft: (s: string) => void
  files: File[]
  setFiles: (f: File[] | ((prev: File[]) => File[])) => void
  busy: boolean
  onSend: (typed?: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useDialogFocus(ref, {}, [p.composer])
  const c = p.composer!
  const option = c.kind === 'answer' ? p.node.options.find((o) => o.key === c.key) : undefined
  const title =
    c.kind === 'answer' ? `${s('answerWith', { key: c.key })} · ${option?.label ?? ''}` : c.kind === 'reply' ? s('reply') : c.kind === 'close' ? s('closeNode') : s('answer')
  const placeholder =
    c.kind === 'answer' ? s('addNote') : c.kind === 'reply' ? s('replyPlaceholder') : c.kind === 'close' ? s('closeReasonPlaceholder') : s('freeTextPlaceholder')
  const blankIsFine = c.kind === 'answer' || c.kind === 'close'
  const takesFiles = c.kind !== 'close'
  const canSend = blankIsFine || p.draft.trim().length > 0 || (takesFiles && p.files.length > 0)
  const add = (files: File[]) => p.setFiles((prev) => [...prev, ...files])
  return (
    <div
      class={`composer ${c.kind}`}
      onDragOver={(e) => takesFiles && e.dataTransfer?.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        const files = filesOf(e.dataTransfer)
        if (takesFiles && files.length) (e.preventDefault(), add(files))
      }}
    >
      <div class="composer-title">{title}</div>
      <textarea
        onPaste={(e) => {
          const files = filesOf(e.clipboardData)
          if (takesFiles && files.length) (e.preventDefault(), add(files))
        }}
        ref={ref}
        rows={c.kind === 'answer' ? 2 : 3}
        value={p.draft}
        placeholder={placeholder}
        onInput={(e) => p.setDraft((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            const typed = (e.currentTarget as HTMLTextAreaElement).value
            if (blankIsFine || typed.trim() || (takesFiles && p.files.length)) p.onSend(typed)
          }
        }}
      />
      <DraftFiles files={p.files} onRemove={(i) => p.setFiles((prev) => prev.filter((_, j) => j !== i))} />
      <div class="composer-actions">
        <span class="hint">⏎ {s('send')} · ⇧⏎ ↵ · Esc {s('cancel')}</span>
        <button class="ghost" onClick={p.onCancel}>
          {s('cancel')}
        </button>
        <button class="primary" disabled={!canSend || p.busy} onClick={() => p.onSend()}>
          {s('send')}
        </button>
      </div>
    </div>
  )
}

/** Earlier rounds of `nod ask`, newest first, folded: each with its options and what it was answered. */
function PreviousRounds({ rounds }: { rounds: PreviousRound[] }) {
  const newestFirst = [...rounds].sort((a, b) => b.round - a.round)
  return (
    <details class="prev-rounds">
      <summary>{rounds.length === 1 ? s('previousRound') : s('previousRounds', { count: rounds.length })}</summary>
      {newestFirst.map((r) => {
        const chosen = r.answer?.split(/\s*——\s*/)[0]?.trim()
        return (
          <div key={r.round} class="prev-round">
            <div class="prev-round-head">
              <span class="prev-round-n">{s('roundN', { n: r.round })}</span>
              {r.answer ? (
                <span class="d small">{[r.by, r.at ? new Date(r.at).toLocaleString(document.documentElement.lang || undefined) : null].filter(Boolean).join(' · ')}</span>
              ) : (
                <span class="d small">{s('roundUnanswered')}</span>
              )}
            </div>
            <ul class="prev-options">
              {r.options.map((o) => (
                <li key={o.key} class={o.key === chosen ? 'chosen' : ''}>
                  <span class="key">{o.key}</span>
                  {o.label}
                  {o.key === chosen && <span class="chip ok">✓ {s('answered')}</span>}
                </li>
              ))}
            </ul>
            {r.sub_answers && r.questions.length > 0 && (
              <ul class="prev-subs">
                {r.questions.map((q) => {
                  const pick = r.sub_answers?.[q.key]
                  const label = pick === OTHER_KEY ? s('otherAnswered') : (q.options.find((o) => o.key === pick)?.label ?? pick)
                  return pick ? (
                    <li key={q.key}>
                      <span class="d">{q.label}</span> {label}
                    </li>
                  ) : null
                })}
              </ul>
            )}
          </div>
        )
      })}
    </details>
  )
}

function Questions({ node, busy, onSubmit }: { node: Node; busy: boolean; onSubmit: (picks: Record<string, string>, notes: Record<string, string>, note?: string) => void }) {
  // `optionPick` is the option each question would answer with if it isn't
  // (or stops being) "other"; `otherOpen`/`otherDraft` track the free-text
  // box independently, so clearing the text falls back to the last option
  // picked rather than submitting an empty "other".
  const optionFor = (q: Node['questions'][number]) => (node.answers?.[q.key] && node.answers[q.key] !== OTHER_KEY ? node.answers[q.key] : (q.default ?? q.options[0]?.key ?? ''))
  const [optionPick, setOptionPick] = useState<Record<string, string>>(() => Object.fromEntries(node.questions.map((q) => [q.key, optionFor(q)])))
  const [otherDraft, setOtherDraft] = useState<Record<string, string>>(() => Object.fromEntries(node.questions.filter((q) => node.answers?.[q.key] === OTHER_KEY).map((q) => [q.key, node.answer_notes?.[q.key] ?? ''])))
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(node.questions.filter((q) => node.answers?.[q.key] === OTHER_KEY).map((q) => [q.key, true])))
  // A note on whichever option is picked (not "other" — the option stands, this just adds a line to it).
  const [qNotes, setQNotes] = useState<Record<string, string>>(() => Object.fromEntries(node.questions.filter((q) => node.answers?.[q.key] !== OTHER_KEY).map((q) => [q.key, node.answer_notes?.[q.key] ?? ''])))
  const [qNoteOpen, setQNoteOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(node.questions.filter((q) => node.answers?.[q.key] !== OTHER_KEY && node.answer_notes?.[q.key]).map((q) => [q.key, true])))
  const [overallNote, setOverallNote] = useState('')
  const isOther = (key: string) => Boolean(otherOpen[key] && otherDraft[key]?.trim())
  const pickOption = (key: string, opt: string) => {
    setOptionPick({ ...optionPick, [key]: opt })
    setOtherOpen({ ...otherOpen, [key]: false })
  }
  const openOther = (key: string) => setOtherOpen({ ...otherOpen, [key]: true })
  const typeOther = (key: string, text: string) => setOtherDraft({ ...otherDraft, [key]: text })
  const toggleQNote = (key: string) => setQNoteOpen({ ...qNoteOpen, [key]: !qNoteOpen[key] })
  const typeQNote = (key: string, text: string) => setQNotes({ ...qNotes, [key]: text })
  const submit = () => {
    const picks: Record<string, string> = {}
    const notes: Record<string, string> = {}
    for (const q of node.questions) {
      if (isOther(q.key)) {
        picks[q.key] = OTHER_KEY
        notes[q.key] = otherDraft[q.key].trim()
      } else {
        picks[q.key] = optionPick[q.key]
        if (qNotes[q.key]?.trim()) notes[q.key] = qNotes[q.key].trim()
      }
    }
    onSubmit(picks, notes, overallNote.trim() || undefined)
  }
  return (
    <section class="decide">
      <div class="section-title">{s('questions')}</div>
      {node.questions.map((q) => {
        const other = isOther(q.key)
        return (
          <div key={q.key} class="question">
            <div class="q-label">
              <span class="key">{q.key}</span> {q.label}
              {!other && (
                <button
                  class={`q-note-btn ${qNotes[q.key]?.trim() ? 'on' : ''}`}
                  onClick={() => toggleQNote(q.key)}
                  title={s('qNoteToggle')}
                  aria-label={s('qNoteToggle')}
                >
                  <StickyNote size={12} strokeWidth={1.75} />
                </button>
              )}
            </div>
            <div class="chips">
              {q.options.map((o) => (
                <button key={o.key} class={`pick ${!other && optionPick[q.key] === o.key ? 'on' : ''}`} onClick={() => pickOption(q.key, o.key)} title={o.body}>
                  <span class="pk">{o.key}</span> {o.label}
                  {q.default === o.key && <span class="d"> · {s('defaultOption')}</span>}
                </button>
              ))}
              <button class={`pick other ${other ? 'on' : ''}`} onClick={() => openOther(q.key)}>
                {s('otherOption')}
              </button>
            </div>
            {otherOpen[q.key] && (
              <input
                class="other-input"
                autoFocus
                value={otherDraft[q.key] ?? ''}
                placeholder={s('otherPlaceholder')}
                onInput={(e) => typeOther(q.key, (e.target as HTMLInputElement).value)}
              />
            )}
            {!other && qNoteOpen[q.key] && (
              <input
                class="other-input q-note-input"
                autoFocus
                value={qNotes[q.key] ?? ''}
                placeholder={s('addNote')}
                onInput={(e) => typeQNote(q.key, (e.target as HTMLInputElement).value)}
              />
            )}
          </div>
        )
      })}
      {!node.terminal && (
        <>
          <textarea
            class="q-overall-note"
            rows={2}
            value={overallNote}
            placeholder={s('addNote')}
            onInput={(e) => setOverallNote((e.target as HTMLTextAreaElement).value)}
          />
          <div class="q-actions">
            <button class="primary" disabled={busy} onClick={submit}>
              {s('submitAnswers')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function Palette({ rows, onPick, onClose, placeholder }: { rows: Row[]; onPick: (key: string) => void; onClose: () => void; placeholder?: string }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  useDialogFocus(field)
  const all = useMemo(() => rows.filter((r) => r.kind === 'node'), [rows])
  const term = q.trim().toLowerCase()
  const hits = (term ? all.filter((r) => r.ref!.toLowerCase() === term || `${r.ref} ${r.title}`.toLowerCase().includes(term)) : all).slice(0, 50)
  return (
    <div class="overlay" onClick={onClose}>
      <div class="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={field}
          value={q}
          placeholder={placeholder ?? s('gotoPlaceholder')}
          onInput={(e) => (setQ((e.target as HTMLInputElement).value), setAt(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setAt(Math.min(hits.length - 1, at + 1)))
            if (e.key === 'ArrowUp') (e.preventDefault(), setAt(Math.max(0, at - 1)))
            if (e.key === 'Enter' && hits[at]) onPick(hits[at].node!)
            if (e.key === 'Escape') onClose()
          }}
        />
        <div class="hits">
          {!hits.length && <div class="empty small">{s('noMatch')}</div>}
          {hits.map((r, i) => (
            <div key={r.key} class={`hit ${i === at ? 'on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => onPick(r.node!)}>
              <Glyph g={r.glyph} />
              <span class="ref">{r.ref}</span>
              <span class="title">{r.title}</span>
              <span class="d small">{r.node!.slice(0, r.node!.lastIndexOf('#'))}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Help({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['↑ ↓', s('keyMove')],
    ['⇧↑ ⇧↓', s('keyExtend')],
    ['← →', s('keyFold')],
    ['⇥ / ⌘1–6', s('keyViews')],
    ['1 – 9', s('keyAnswer')],
    ['⏎', s('keyDefault')],
    ['N', s('keyReply')],
    ['D', s('keyDefer')],
    ['⌥↑ ⌥↓', s('keyReorder')],
    ['A', s('keyArchive')],
    ['G', s('keyGoto')],
    ['W', s('keyNext')],
    ['H', s('keyRecent')],
    ['⌘⌥1–9', s('keyProject')],
    ['⌘N', s('keyNew')],
    ['J K', s('keyScroll')],
    ['⌘O', s('keyAdd')],
    ['⌘K', s('keyQuick')],
    ['⌘,', s('keySettings')],
    ['Esc', s('keyClose')],
  ]
  return (
    <div class="overlay" onClick={onClose}>
      <div class="help" onClick={(e) => e.stopPropagation()}>
        <h3>{s('helpTitle')}</h3>
        <dl>
          {keys.map(([k, v]) => (
            <>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </>
          ))}
        </dl>
      </div>
    </div>
  )
}

export type { View }

/** A milestone's date; today and later. Saved as the end of that day. */
/** The body's rows after its description: from the first heading (a note, a section) on. */
/** The on-disk heading word of an answer section — a file format, never translated. */
const ANSWER_KIND = '已答'
/** Each answer is a record of what was decided then: changing it adds a new one, so none is edited in place. */
const isAnswerNote = (note: Note | undefined) => note?.kind === ANSWER_KIND
const decisionLabel = (note: Note | undefined) => (isAnswerNote(note) ? s(note!.revises ? 'decisionChangedBlock' : 'decisionBlock') : null)

function afterDescription(rows: Node['body_rows']): Node['body_rows'] {
  const at = rows.findIndex((r) => r.style)
  return at === -1 ? [] : rows.slice(at)
}

/** The node changed while the owner was editing: take theirs, keep mine, or go back to editing. */
function EditConflict(p: { onReload: () => void; onOverwrite: () => void; onKeep: () => void }) {
  return (
    <div class="overlay" onClick={p.onKeep}>
      <div class="confirm" role="alertdialog" onClick={(e) => e.stopPropagation()}>
        <h3>{s('editConflict')}</h3>
        <div class="sheet-footer">
          <button class="ghost" onClick={p.onReload}>
            {s('editReload')}
          </button>
          <button class="ghost" onClick={p.onKeep}>
            {s('editKeep')}
          </button>
          <button class="primary" onClick={p.onOverwrite}>
            {s('editOverwrite')}
          </button>
        </div>
      </div>
    </div>
  )
}
