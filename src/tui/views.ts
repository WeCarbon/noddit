import { isUnclaimedBrief } from '../core/intake.ts'
import { benchOrder } from '../core/order.ts'
import { NOTE_KIND } from '../core/format.ts'
import { parseNotes } from '../core/parse.ts'
import { refOf } from '../core/ref.ts'
import { dependentsOf } from '../core/sequence.ts'
import { minutesSince, stalenessOf, type Staleness } from '../core/staleness.ts'
import { deferHidden, dependenciesOf, isDeferred, isStartable, isTerminal, statusLabel, waitingOnOwner } from '../core/status.ts'
import { parseSteps, stepProgress } from '../core/steps.ts'
import type { Decision as Item } from '../core/types.ts'
import { isRtl, t } from '../i18n/index.ts'
import { elapsed, fromNow } from '../i18n/time.ts'
import type { Segment } from './model.ts'
import { fit, padToWidth, stringWidth } from './width.ts'

/**
 * bench's left-pane tabs, named for the question each answers (digits are
 * taken by answering, so switch with Tab):
 * - 可用 (default): executing, startable, waiting on owner, or answered and
 *   awaiting an AI — as the tree.
 * - 活动: executing or waiting on the owner — as the tree.
 * - 待决: only what the owner must rule on, AI-stuck first.
 * - 全部: every node; finished ones fold into 「✓ 已完成/已结束 N」.
 * - 等待: held up outside, longest first, plus a 「延迟 N」 fold row.
 * - 最近: what the owner answered, replied to, filed or deferred, latest first —
 *   finished and archived nodes included.
 *
 * 延迟 keeps its state (not archived); it and its subtree are out of
 * 可用/活动/待决/等待 proper, and dim in 全部.
 */
export type View = 'available' | 'active' | 'decide' | 'all' | 'waiting' | 'recent'
/** The tabs in the header, in Tab order. */
export const VIEWS: View[] = ['available', 'active', 'decide', 'all', 'waiting', 'recent']
export const VIEW_LABEL: Record<View, string> = {
  get available() { return t('bench.tabs.available') },
  get active() { return t('bench.tabs.active') },
  get decide() { return t('bench.tabs.decide') },
  get all() { return t('bench.tabs.all') },
  get waiting() { return t('bench.tabs.waiting') },
  get recent() { return t('bench.tabs.recent') },
}
export const VIEW_EMPTY: Record<View, string> = {
  get available() { return t('bench.viewEmpty.available') },
  get active() { return t('bench.viewEmpty.active') },
  get decide() { return t('bench.viewEmpty.decide') },
  get all() { return t('bench.viewEmpty.all') },
  get waiting() { return t('bench.viewEmpty.waiting') },
  get recent() { return t('bench.viewEmpty.recent') },
}

/** The views that draw the tree (and so fold with ←/→ and +/-). */
export const isTreeView = (v: View) => v === 'available' || v === 'active' || v === 'all'

/** `--view`/`--scope` names from before 可用/活动 map onto the nearest
 *  view, so old scripts keep working. */
const LEGACY_VIEW: Record<string, View> = {
  tree: 'all',
  owner: 'decide',
  running: 'active',
  timeline: 'available',
  done: 'all',
  open: 'decide',
  queued: 'decide',
  archived: 'all',
  // 延迟 lives in 等待 now, as a fold row; bench opens it for these two.
  deferred: 'waiting',
  defer: 'waiting',
}

export function viewFromArg(raw: string | undefined): View {
  if (!raw) return 'available'
  if (VIEWS.includes(raw as View)) return raw as View
  const v = LEGACY_VIEW[raw]
  if (!v) throw new Error(t('bench.legacyViewError', { views: VIEWS.join(' | ') }))
  return v
}

const hiddenCache = new WeakMap<Item[], (i: Item) => boolean>()

/** Deferred, or under a deferred ancestor — out of every working list. Cached per item list. */
export function isDeferHidden(d: Item, items: Item[]): boolean {
  let pred = hiddenCache.get(items)
  if (!pred) hiddenCache.set(items, (pred = deferHidden(items)))
  return pred(d)
}

/** Whether `d` is one of the nodes `view` lists (not counting ancestors drawn for context). */
export function inView(view: View, d: Item, items: Item[]): boolean {
  if (view === 'recent') return lastTouch(d) !== undefined
  if (view !== 'all' && isDeferHidden(d, items)) return false
  switch (view) {
    case 'available':
      return (
        d.state === 'in_progress' ||
        // Held up outside is still live work the owner wants in sight.
        d.state === 'waiting' ||
        d.state === 'needs_decision' ||
        d.state === 'decided' ||
        (d.state === 'not_started' && isStartable(d, items))
      )
    case 'active':
      return d.state === 'in_progress' || d.state === 'needs_decision'
    case 'decide':
      return d.state === 'needs_decision'
    case 'waiting':
      return d.state === 'waiting'
    case 'all':
      return true
  }
}

/** The number on a tab; 全部 and 最近 have none. */
export function viewCount(view: View, items: Item[]): number | undefined {
  if (view === 'all' || view === 'recent') return undefined
  return items.filter((d) => inView(view, d, items)).length
}

export const keyOf = (d: Pick<Item, 'project' | 'id'>) => `${d.project}#${d.id}`

/** The 「✓ 已完成 N」 row under `parent`, or the 「✓ 已结束 N」 row of a project's finished roots. */
export const doneGroupKey = (parent: Pick<Item, 'project' | 'id'> | { project: string }) =>
  'id' in parent ? `fold:${keyOf(parent)}` : `fold:project:${parent.project}`

/**
 * One line of the left pane. `node` rows and `fold` rows take the cursor
 * (+/- opens and shuts a fold); `header` rows are there to be read.
 */
export interface Row {
  key: string
  kind: 'node' | 'header' | 'fold'
  node?: Item
  depth: number
  /** header / fold text. */
  text?: string
  hasKids?: boolean
  collapsed?: boolean
  /** An ancestor drawn only so a matching node below has its context; drawn dim. */
  context?: boolean
  /** fold rows: the finished nodes it stands for, and whether they are listed below it. */
  finished?: Item[]
  open?: boolean
  /** 最近: what the owner last did to this node. */
  touch?: Touch
}

export const isSelectable = (r: Row) => r.kind === 'node' || r.kind === 'fold'

export interface TreeOptions {
  /** Open nodes the owner folded with ←. */
  collapsed?: Set<string>
  /** Finished nodes the owner unfolded with →. */
  expanded?: Set<string>
  /** 全部: 「✓ 已完成 N」 / 「✓ 已结束 N」 rows (by `doneGroupKey`) the owner opened. */
  openGroups?: Set<string>
}

function childMap(items: Item[]): Map<string, Item[]> {
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const out = new Map<string, Item[]>()
  for (const i of items) {
    if (i.parent === undefined) continue
    const pk = `${i.project}#${i.parent}`
    if (!byKey.has(pk)) continue
    out.set(pk, [...(out.get(pk) ?? []), i])
  }
  return out
}

/** Siblings in happening order: after the siblings it's `after`, else
 *  creation order — not by status, or a row would jump mid-watch. */
export function siblingOrder(sibs: Item[], items: Item[]): Item[] {
  const rest = [...sibs].sort((a, b) => a.id - b.id)
  const placed: Item[] = []
  const isSib = (d: Item) => rest.some((s) => s === d)
  while (rest.length) {
    const i = rest.findIndex((s) =>
      dependenciesOf(s, items).every((dep) => typeof dep === 'string' || !isSib(dep) || placed.includes(dep)),
    )
    placed.push(...rest.splice(i === -1 ? 0 : i, 1))
  }
  return placed
}

export function isCollapsed(d: Item, opts: TreeOptions): boolean {
  const k = keyOf(d)
  if (opts.collapsed?.has(k)) return true
  return isTerminal(d.state) && !opts.expanded?.has(k)
}

/** Project order as the store lists them, so a joined bench keeps a stable layout. */
function projectsOf(items: Item[]): { project: string; letter?: string; name: string }[] {
  const seen = new Map<string, Item>()
  for (const i of items) if (!seen.has(i.project)) seen.set(i.project, i)
  return [...seen].map(([project, i]) => ({ project, letter: i.letter, name: i.projectName ?? project }))
}

const isRoot = (i: Item, byKey: Map<string, Item>) => i.parent === undefined || !byKey.has(`${i.project}#${i.parent}`)

/** 可用/活动: the tree cut to the view's nodes, keeping dim ancestor
 *  context so a match is never shown without where it belongs. */
export function filteredTreeRows(view: View, items: Item[], opts: TreeOptions = {}): Row[] {
  const kids = childMap(items)
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const match = new Set(items.filter((i) => inView(view, i, items)).map(keyOf))
  const shown = new Set(match)
  for (const k of match) for (const a of ancestorsOf(byKey.get(k)!, items)) shown.add(keyOf(a))
  const out: Row[] = []
  const projects = projectsOf(items)

  const walk = (d: Item, depth: number) => {
    const children = siblingOrder((kids.get(keyOf(d)) ?? []).filter((c) => shown.has(keyOf(c))), items)
    // Only the owner's own folds — a default-folded ancestor would hide this view's node.
    const collapsed = children.length > 0 && Boolean(opts.collapsed?.has(keyOf(d)))
    out.push({ key: keyOf(d), kind: 'node', node: d, depth, hasKids: children.length > 0, collapsed, context: !match.has(keyOf(d)) })
    if (!collapsed) for (const c of children) walk(c, depth + 1)
  }

  for (const p of projects) {
    const roots = items.filter((i) => i.project === p.project && isRoot(i, byKey) && shown.has(keyOf(i))).sort(benchOrder)
    if (!roots.length) continue
    if (projects.length > 1) {
      const n = items.filter((i) => i.project === p.project && match.has(keyOf(i))).length
      out.push({
        key: `project:${p.project}`,
        kind: 'header',
        depth: 0,
        text: t('bench.header.viewCount', { letter: p.letter ?? 'X', project: p.name, count: n, label: VIEW_LABEL[view] }),
      })
    }
    for (const r of roots) walk(r, 0)
  }
  return out
}

/** 全部: every node, live. Finished children fold into 「✓ 已完成 N」 under
 *  their parent, finished roots into 「✓ 已结束 N」 per project. */
export function treeRows(items: Item[], opts: TreeOptions = {}): Row[] {
  const kids = childMap(items)
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const out: Row[] = []
  const projects = projectsOf(items)

  const group = (key: string, depth: number, finished: Item[], kind: 'completed' | 'finished') => {
    const open = Boolean(opts.openGroups?.has(key))
    out.push({ key, kind: 'fold', depth, text: foldText(finished, kind, open), finished, open })
    return open
  }

  const walk = (d: Item, depth: number) => {
    const children = siblingOrder(kids.get(keyOf(d)) ?? [], items)
    const collapsed = children.length > 0 && isCollapsed(d, opts)
    out.push({ key: keyOf(d), kind: 'node', node: d, depth, hasKids: children.length > 0, collapsed })
    if (collapsed) return
    for (const c of children) if (!isTerminal(c.state)) walk(c, depth + 1)
    const finished = children.filter((c) => isTerminal(c.state))
    if (finished.length && group(doneGroupKey(d), depth + 1, finished, 'completed')) for (const c of finished) walk(c, depth + 1)
  }

  for (const p of projects) {
    const mine = items.filter((i) => i.project === p.project)
    const roots = mine.filter((i) => isRoot(i, byKey))
    const open = roots.filter((i) => !isTerminal(i.state)).sort(benchOrder)
    const finished = roots.filter((i) => isTerminal(i.state)).sort(newestFinishedFirst)
    if (projects.length > 1) {
      const done = mine.filter((i) => isTerminal(i.state)).length
      out.push({
        key: `project:${p.project}`,
        kind: 'header',
        depth: 0,
        text: done
          ? t('bench.header.inProgressDone', { letter: p.letter ?? 'X', project: p.name, count: mine.length - done, done })
          : t('bench.header.inProgress', { letter: p.letter ?? 'X', project: p.name, count: mine.length - done }),
      })
    }
    for (const r of open) walk(r, 0)
    if (finished.length && group(doneGroupKey({ project: p.project }), 0, finished, 'finished')) for (const r of finished) walk(r, 0)
  }
  return out
}

function foldText(finished: Item[], kind: 'completed' | 'finished', open: boolean): string {
  const closed = finished.filter((c) => c.state === 'closed').length
  const base = t(kind === 'completed' ? 'bench.fold.completed' : 'bench.fold.finished', { count: finished.length })
  const closedNote = closed ? t('bench.fold.closedNote', { count: closed }) : ''
  const suffix = open ? t('bench.fold.collapseSuffix') : t('bench.fold.expandSuffix')
  return `${base}${closedNote}${suffix}`
}

const finishedAt = (d: Item) => d.archivedAt || d.updatedAt || d.answer?.at || d.created || ''
const newestFinishedFirst = (a: Item, b: Item) =>
  finishedAt(a) === finishedAt(b) ? b.id - a.id : finishedAt(a) < finishedAt(b) ? 1 : -1

/** 待决: per project, AI-stuck nodes first, then early-answerable ones.
 *  Answered nodes have left this view; they're in 可用. */
export function ownerRows(items: Item[]): Row[] {
  const out: Row[] = []
  for (const p of projectsOf(items)) {
    const list = ownerQueue(items).filter((i) => i.project === p.project)
    if (!list.length) continue
    out.push({ key: `project:${p.project}`, kind: 'header', depth: 0, text: t('bench.header.decide', { letter: p.letter ?? 'X', project: p.name, count: list.length }) })
    for (const d of list) out.push({ key: keyOf(d), kind: 'node', node: d, depth: 0 })
  }
  return out
}

/** When a node started waiting: the latest `## 等待` note, else its last
 *  write (not `updatedAt` alone, or a later note would look like a fresh wait). */
export function waitingSince(d: Item): string {
  const holds = parseNotes(d.body ?? '').filter((n) => n.kind === NOTE_KIND.waiting)
  return holds.at(-1)?.at ?? d.updatedAt ?? d.created
}

/** The 「延迟 N」 row at the end of 等待 — one for every project bench shows. */
export const DEFERRED_GROUP = 'fold:deferred'

/** What the owner put off, the longest-deferred first. */
export function deferredNodes(items: Item[]): Item[] {
  const at = (d: Item) => d.deferredAt ?? ''
  return items.filter(isDeferred).sort((a, b) => (at(a) === at(b) ? a.id - b.id : at(a) < at(b) ? -1 : 1))
}

/** 等待: held up outside, longest wait first; then a 「延迟 N」 fold row with
 *  deferred nodes once opened (a node that's both is listed there only). */
export function waitingRows(items: Item[], opts: TreeOptions = {}): Row[] {
  const out: Row[] = items
    .filter((i) => inView('waiting', i, items))
    .sort((a, b) => (waitingSince(a) === waitingSince(b) ? a.id - b.id : waitingSince(a) < waitingSince(b) ? -1 : 1))
    .map((d) => ({ key: keyOf(d), kind: 'node', node: d, depth: 0 }))
  const deferred = deferredNodes(items)
  if (!deferred.length) return out
  const open = Boolean(opts.openGroups?.has(DEFERRED_GROUP))
  const suffix = open ? t('bench.fold.collapseSuffix') : t('bench.fold.expandSuffix')
  out.push({ key: DEFERRED_GROUP, kind: 'fold', depth: 0, text: `${t('bench.fold.deferredRow', { count: deferred.length })}${suffix}`, finished: deferred, open })
  if (open) for (const d of deferred) out.push({ key: keyOf(d), kind: 'node', node: d, depth: 1 })
  return out
}

/** Something the owner did to a node: a section written as the human. */
export interface Touch {
  kind: 'answered' | 'seen' | 'replied' | 'filed' | 'deferred' | 'undeferred' | 'noted'
  at: string
  /** The owner's words, if any. */
  text: string
  /** answered: the option picked. */
  choice?: string
}

const TOUCH_KIND: Record<string, Touch['kind']> = {
  [NOTE_KIND.answered]: 'answered',
  [NOTE_KIND.seen]: 'seen',
  [NOTE_KIND.reply]: 'replied',
  [NOTE_KIND.followUp]: 'replied',
  reply: 'replied',
  [NOTE_KIND.original]: 'filed',
  [NOTE_KIND.deferred]: 'deferred',
  [NOTE_KIND.undeferred]: 'undeferred',
}

const touchTime = (at: string) => Date.parse(at) || 0

/** Everything the owner did to `d`, oldest first. Pins aren't signed, so they don't count. */
export function ownerTouches(d: Item): Touch[] {
  const answers = d.notes.filter((n) => n.role === 'human' && n.kind === NOTE_KIND.answered)
  return d.notes
    .filter((n) => n.role === 'human')
    .map((n): Touch => {
      const kind = TOUCH_KIND[n.kind] ?? 'noted'
      // The stored answer is the latest one; earlier answers were superseded by it.
      const choice = kind === 'answered' && n === answers.at(-1) ? d.answer?.choice : undefined
      return { kind, at: n.at, text: n.text, ...(choice ? { choice } : {}) }
    })
    .sort((a, b) => touchTime(a.at) - touchTime(b.at))
}

export const lastTouch = (d: Item): Touch | undefined => ownerTouches(d).at(-1)

/** 最近 lists this far back before the 「更早 N」 row… */
export const RECENT_DAYS = 30
/** …and at most this many above it. */
export const RECENT_MAX = 200
export const RECENT_OLDER_GROUP = 'fold:recent-older'

/** 最近: nodes the owner touched, latest touch first, across every project and
 *  whatever their state; past 30 days (or 200 rows) behind a 「更早 N」 fold row. */
export function recentRows(items: Item[], opts: TreeOptions = {}, now = Date.now()): Row[] {
  const touched = items
    .map((d) => ({ d, touch: lastTouch(d) }))
    .filter((x): x is { d: Item; touch: Touch } => x.touch !== undefined)
    .sort((a, b) => touchTime(b.touch.at) - touchTime(a.touch.at) || a.d.id - b.d.id)
  const since = now - RECENT_DAYS * 86_400_000
  const cut = touched.findIndex((x, i) => i >= RECENT_MAX || touchTime(x.touch.at) < since)
  const shown = cut === -1 ? touched : touched.slice(0, cut)
  const older = cut === -1 ? [] : touched.slice(cut)
  const row = (x: { d: Item; touch: Touch }, depth: number): Row => ({ key: keyOf(x.d), kind: 'node', node: x.d, depth, touch: x.touch })
  const out = shown.map((x) => row(x, 0))
  if (!older.length) return out
  const open = Boolean(opts.openGroups?.has(RECENT_OLDER_GROUP))
  const suffix = open ? t('bench.fold.collapseSuffix') : t('bench.fold.expandSuffix')
  out.push({ key: RECENT_OLDER_GROUP, kind: 'fold', depth: 0, text: `${t('bench.fold.olderRow', { count: older.length })}${suffix}`, finished: older.map((x) => x.d), open })
  if (open) for (const x of older) out.push(row(x, 1))
  return out
}

/** "Answered 2" / "Replied" — what the owner did, without the when. */
export function touchLabel(touch: Touch): string {
  if (touch.kind === 'answered' && touch.choice) return t('bench.recent.answeredChoice', { choice: touch.choice })
  return t(`bench.recent.${touch.kind}`)
}

export function rowsFor(view: View, items: Item[], opts: TreeOptions = {}): Row[] {
  if (view === 'recent') return recentRows(items, opts)
  if (view === 'decide') return ownerRows(items)
  if (view === 'waiting') return waitingRows(items, opts)
  if (view === 'all') return treeRows(items, opts)
  return filteredTreeRows(view, items, opts)
}

/** Where a jump to `d` lands if the current view doesn't list it: 可用,
 *  else 等待 (deferred) or 全部. */
export function homeView(d: Item, items: Item[], from: View): View {
  if (inView(from, d, items)) return from
  if (from === 'waiting' && isDeferred(d)) return from
  if (inView('available', d, items)) return 'available'
  return isDeferred(d) ? 'waiting' : 'all'
}

/** Every ancestor's key, nearest first. */
export function ancestorsOf(d: Item, items: Item[]): Item[] {
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const out: Item[] = []
  let p = d.parent !== undefined ? byKey.get(`${d.project}#${d.parent}`) : undefined
  while (p && !out.includes(p)) {
    out.push(p)
    p = p.parent !== undefined ? byKey.get(`${p.project}#${p.parent}`) : undefined
  }
  return out
}

/** Cursor follows the node, not the row number — adding a row above must
 *  not slide another node under the cursor; only a gone node lets the
 *  position hold. */
export function resolveIndex(rows: Row[], cursorKey: string | null, lastIndex: number): number {
  const at = cursorKey ? rows.findIndex((r) => r.key === cursorKey && isSelectable(r)) : -1
  if (at >= 0) return at
  return nearestSelectable(rows, Math.min(lastIndex, rows.length - 1), 1)
}

/** The first node or fold row at or after `from` going `dir`, else the other way; -1 when there is none. */
export function nearestSelectable(rows: Row[], from: number, dir: 1 | -1): number {
  const start = Math.max(0, Math.min(from, rows.length - 1))
  for (let i = start; i >= 0 && i < rows.length; i += dir) if (isSelectable(rows[i])) return i
  for (let i = start; i >= 0 && i < rows.length; i -= dir) if (isSelectable(rows[i])) return i
  return -1
}

/** Moves `delta` node/fold rows from `index`, skipping headers, stopping at either end. */
export function stepIndex(rows: Row[], index: number, delta: number): number {
  let i = index
  let left = Math.abs(delta)
  const dir = delta < 0 ? -1 : 1
  while (left > 0) {
    let j = i + dir
    while (j >= 0 && j < rows.length && !isSelectable(rows[j])) j += dir
    if (j < 0 || j >= rows.length) break
    i = j
    left--
  }
  return i
}

// ---------------------------------------------------------------------------
// Drawing one row
// ---------------------------------------------------------------------------

/** "3 minutes ago" / "3 分钟前" / "il y a 3 minutes" / "قبل 3 دقائق", via the current language's dayjs locale. */
export function ago(minutes: number): string {
  if (!Number.isFinite(minutes)) return ''
  return fromNow(0, minutes * 60_000)
}

/** The same span without "ago": "3 minutes" / "3 分钟" — for "waited 3 minutes" style composition. */
export function agoSpan(minutes: number): string {
  if (!Number.isFinite(minutes)) return ''
  return elapsed(0, minutes * 60_000)
}

export function bar(pct: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** 0–100 from `progress`, else from the step list; undefined when neither says. */
export function progressOf(d: Item): number | undefined {
  if (typeof d.progress === 'number') return d.progress
  const steps = parseSteps(d.steps)
  return steps.length ? stepProgress(steps) : undefined
}

export const STALE_COLOR: Record<Staleness, string | undefined> = { fresh: undefined, stale: 'gray', very_stale: 'red' }

export interface Glyph {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

/** One glyph per state, used everywhere bench draws status. 已答待取 is a
 *  colour, not its own shape — see glyphOf. */
export const GLYPH: Record<Exclude<Item['state'], 'decided'>, string> = {
  not_started: '○',
  in_progress: '◐',
  waiting: '⏸',
  needs_decision: '◆',
  completed: '✓',
  closed: '✕',
}

/** Shape an answered node keeps: ◆ if a decision, else what the task
 *  looked like before (not recorded) — ◐ with progress, ○ otherwise. */
export function decidedShape(d: Item): string {
  if (d.options?.length || d.questions?.length) return GLYPH.needs_decision
  const steps = parseSteps(d.steps)
  const started = (progressOf(d) ?? 0) > 0 || steps.some((s) => s.done)
  return started ? GLYPH.in_progress : GLYPH.not_started
}

/** 派活 the owner filed that no AI has picked up yet — its own shape, whatever the state says. */
export const BRIEF_GLYPH = '✎'

/** The glyph text for `d`, whatever its state. */
export const glyphText = (d: Item) => (isUnclaimedBrief(d) ? BRIEF_GLYPH : d.state === 'decided' ? decidedShape(d) : GLYPH[d.state])

/**
 * ◆ is yellow, bold while an AI is stuck on it, dim if answerable early.
 * Green is 已答待取 (owner answered, AI hasn't picked up), keeping its task
 * shape. ◐ goes grey past stale_after, red past 2×.
 */
export function glyphOf(d: Item, items: Item[], now = Date.now()): Glyph {
  const text = glyphText(d)
  if (isUnclaimedBrief(d)) return { text, color: 'blue', bold: true }
  switch (d.state) {
    case 'not_started':
      return { text, dim: true }
    case 'in_progress':
      return { text, color: STALE_COLOR[stalenessOf(d, now)] ?? 'cyan' }
    case 'waiting':
      return { text, color: 'magenta' }
    case 'needs_decision':
      return waitingOnOwner(d, items) ? { text, color: 'yellow', bold: true } : { text, color: 'yellow', dim: true }
    case 'decided':
      return { text, color: 'green' }
    case 'completed':
      return { text, color: 'green', dim: true }
    case 'closed':
      return { text, dim: true }
  }
}

/** Refs this node still waits on. */
export function unmetDeps(d: Item, items: Item[]): string[] {
  return dependenciesOf(d, items)
    .filter((dep) => typeof dep === 'string' || !isTerminal(dep.state))
    .map((dep) => (typeof dep === 'string' ? dep : refOf(dep)))
}

function refsShort(refs: string[], max = 2): string {
  return refs.length <= max ? refs.join(' ') : `${refs.slice(0, max).join(' ')} +${refs.length - max}`
}

/** Row's right end, longest form first; the renderer uses the first that fits beside the full title. */
export function suffixOf(d: Item, items: Item[], now: number, row?: Row): Segment[][] {
  const forms: Segment[][] = []
  const fold: Segment[] = row?.collapsed ? [{ text: `+${countBelow(d, items)} `, dim: true }] : []
  if (row?.touch) {
    const when = ago(minutesSince({ updatedAt: row.touch.at, created: d.created }, now))
    const what = touchLabel(row.touch)
    forms.push([{ text: `${what} · ${when}`, color: 'blue' }, { text: ` · ${statusLabel(d.state)}`, dim: true }])
    forms.push([{ text: `${what} · ${when}`, color: 'blue' }])
    forms.push([{ text: when, dim: true }])
    return forms
  }
  if (isDeferred(d)) {
    const since = d.deferredAt ? ago(minutesSince({ updatedAt: d.deferredAt, created: d.created }, now)) : ''
    if (since) forms.push([...fold, { text: t('bench.badge.deferredSince', { since }), dim: true }])
    forms.push([...fold, { text: t('bench.badge.deferred'), dim: true }])
    return forms
  }
  if (isUnclaimedBrief(d)) {
    const since = ago(minutesSince({ updatedAt: d.created, created: d.created }, now))
    forms.push([...fold, { text: t('bench.badge.briefSince', { since }), color: 'blue' }])
    forms.push([...fold, { text: t('bench.badge.brief'), color: 'blue' }])
    return forms
  }
  switch (d.state) {
    case 'in_progress': {
      const st = stalenessOf(d, now)
      const when = ago(minutesSince(d, now))
      const pct = progressOf(d)
      const color = STALE_COLOR[st]
      const age: Segment = { text: when, color, dim: st === 'fresh', bold: st === 'very_stale' }
      if (pct !== undefined) forms.push([...fold, { text: bar(pct, 8), color: color ?? 'cyan' }, { text: ` ${pct}% ` }, age])
      if (pct !== undefined) forms.push([...fold, { text: `${pct}% ` }, age])
      forms.push([age])
      break
    }
    case 'waiting': {
      const since = ago(minutesSince({ updatedAt: waitingSince(d), created: d.created }, now))
      if (d.waitingOn) forms.push([...fold, { text: t('bench.badge.waitingOnSince', { who: d.waitingOn, since }), color: 'magenta' }])
      forms.push([...fold, { text: `${statusLabel('waiting')} · ${since}`, color: 'magenta' }])
      break
    }
    case 'needs_decision': {
      const blocks = dependentsOf(d, items).length
      const urgent: Segment[] = d.urgency === 'high' ? [{ text: `${t('bench.badge.urgent')} `, color: 'red', bold: true }] : []
      const decide = t('bench.tabs.decide')
      if (waitingOnOwner(d, items)) {
        const tail: Segment[] = blocks ? [{ text: ` · ${t('bench.summary.blockingNote', { count: blocks })}`, dim: true }] : []
        forms.push([...fold, ...urgent, { text: decide, color: 'yellow', bold: true }, ...tail])
        forms.push([...urgent, { text: decide, color: 'yellow', bold: true }])
      } else {
        const deps = unmetDeps(d, items)
        const early = t('bench.badge.early')
        forms.push([...fold, ...urgent, { text: early, color: 'yellow' }, { text: ` · ${t('bench.badge.waitingOn', { refs: refsShort(deps) })}`, dim: true }])
        forms.push([...urgent, { text: early, color: 'yellow' }])
      }
      break
    }
    case 'not_started': {
      const deps = unmetDeps(d, items)
      if (deps.length) {
        forms.push([...fold, { text: t('bench.badge.waitingOn', { refs: refsShort(deps) }), dim: true }])
        forms.push([{ text: t('bench.badge.waitingOn', { refs: refsShort(deps, 1) }), dim: true }])
      } else forms.push([...fold, { text: t('bench.badge.ready'), dim: true }])
      break
    }
    case 'decided':
      forms.push([...fold, { text: t('bench.badge.answered'), color: 'green' }])
      break
    case 'completed':
      forms.push([...fold, { text: statusLabel('completed'), dim: true }])
      break
    case 'closed':
      forms.push(
        [...fold, { text: `${statusLabel('closed')}${d.closeReason ? ` · ${d.closeReason}` : ''}`, dim: true }],
        [{ text: statusLabel('closed'), dim: true }],
      )
      break
  }
  return forms
}

function countBelow(d: Item, items: Item[]): number {
  const kids = childMap(items)
  let n = 0
  const stack = [...(kids.get(keyOf(d)) ?? [])]
  while (stack.length) {
    const c = stack.pop()!
    n++
    stack.push(...(kids.get(keyOf(c)) ?? []))
  }
  return n
}

/** Somewhere below `d` an AI is stuck on the owner (`strong`), or a question can be answered early. */
export function subtreeWaiting(d: Item, items: Item[]): 'strong' | 'weak' | null {
  const kids = childMap(items)
  let found: 'strong' | 'weak' | null = null
  const stack = [...(kids.get(keyOf(d)) ?? [])]
  while (stack.length) {
    const c = stack.pop()!
    // A deferred subtree asks nothing of the owner for now.
    if (isDeferred(c)) continue
    if (c.state === 'needs_decision') {
      if (waitingOnOwner(c, items)) return 'strong'
      found = 'weak'
    }
    stack.push(...(kids.get(keyOf(c)) ?? []))
  }
  return found
}

const segWidth = (segs: Segment[]) => segs.reduce((n, s) => n + stringWidth(s.text), 0)

/** One node row, exactly `width` columns; the title is never cut while
 *  there's room — the suffix shrinks or goes first. */
export function nodeRowSegments(row: Row, items: Item[], width: number, now: number, opts: { tree?: boolean } = {}): Segment[] {
  const segs = nodeRowParts(row, items, width, now, opts)
  // 全部/延迟: dim but keep the state glyph, so un-deferring isn't a surprise.
  if (!row.context && isDeferHidden(row.node!, items)) return segs.map((seg, i) => (i === 0 || i === 3 ? seg : { text: seg.text, dim: true }))
  if (!row.context) return segs
  // Context ancestor: all dim but the ◆ mark, which still flags something below.
  return segs.map((seg, i) => (i === 0 ? seg : { text: seg.text, dim: true }))
}

function nodeRowParts(row: Row, items: Item[], width: number, now: number, opts: { tree?: boolean }): Segment[] {
  const d = row.node!
  const glyph = glyphOf(d, items, now)
  const st = stalenessOf(d, now)
  const finished = isTerminal(d.state)
  const mark = opts.tree ? subtreeWaiting(d, items) : null
  const lead: Segment[] = [
    { text: mark ? '◆' : ' ', color: 'yellow', bold: mark === 'strong', dim: mark === 'weak' },
    { text: '  '.repeat(row.depth) },
    { text: opts.tree ? (row.hasKids ? (row.collapsed ? '▸' : '▾') : ' ') : '', dim: true },
    { ...glyph },
    { text: ` ${refOf(d)} `, color: finished ? undefined : 'cyan', dim: finished },
  ]
  const titleColor = d.state === 'in_progress' ? STALE_COLOR[st] : undefined
  const title: Segment = {
    text: d.title,
    dim: finished,
    bold: d.state === 'needs_decision' && waitingOnOwner(d, items),
    color: titleColor,
  }
  const room = width - segWidth(lead)
  const titleW = stringWidth(d.title)
  if (titleW > room) return [...lead, { ...title, text: fit(d.title, room, isRtl()) }]
  for (const suffix of suffixOf(d, items, now, row)) {
    const sw = segWidth(suffix)
    if (titleW + 1 + sw <= room) return [...lead, title, { text: ' '.repeat(room - titleW - sw), gap: true }, ...suffix]
  }
  return [...lead, { ...title, text: padToWidth(d.title, room) }]
}

/** Order of the needs-owner rows: AI-blocking first, then early; bench order (pins, urgency, age) within each. */
export function ownerQueue(items: Item[]): Item[] {
  const open = items.filter((i) => inView('decide', i, items))
  const blocking = open.filter((i) => isStartable(i, items)).sort(benchOrder)
  const early = open.filter((i) => !isStartable(i, items)).sort(benchOrder)
  return [...blocking, ...early]
}
