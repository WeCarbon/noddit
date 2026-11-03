import { isHumanTask } from '../core/assignee.ts'
import { untilDay } from '../core/fuzzy-date.ts'
import { isUnclaimedBrief } from '../core/intake.ts'
import { benchOrder, isFlagged, manualRank, untilDue, urgencyRank } from '../core/order.ts'
import { parseDuration } from '../core/duration.ts'
import { estimateTotal, fmtMinutes, type EstimateTotal } from '../core/estimate.ts'
import { BUILTIN_IDS, builtinView, loadViews, type CondField, type Filter, type SortField, type SortKey, type ViewDef } from '../core/view-defs.ts'
import { NOTE_KIND } from '../core/format.ts'
import { parseNotes } from '../core/parse.ts'
import { refOf } from '../core/ref.ts'
import { dependentsOf } from '../core/sequence.ts'
import { isStale, minutesSince } from '../core/staleness.ts'
import { ITEM_STATUSES, WAIT_ON_MAX_COLS, deferHidden, deferredByAgent, delayOf, dependenciesOf, isDeferred, isStartable, isTerminal, isWaitDue, statusLabel, waitingOnOwner } from '../core/status.ts'
import { parseSteps, stepProgress } from '../core/steps.ts'
import type { Decision as Item } from '../core/types.ts'
import { isRtl, lang, t } from '../i18n/index.ts'
import { dayFromToday, dayText, elapsed, fromNow } from '../i18n/time.ts'
import type { Segment } from './model.ts'
import { fit, padToWidth, stringWidth } from './width.ts'

/**
 * bench's left-pane tabs, named for the question each answers (digits are
 * taken by answering, so switch with Tab):
 * - 可用 (default): executing, startable, waiting on owner, or answered and
 *   awaiting an AI — as the tree.
 * - 活动: executing, waiting on a decision, or any live human work — as the
 *   tree; a superset of 人类工作.
 * - 人类工作 (key `decide`): everything waiting on a person — what the owner must
 *   rule on and the human-assigned tasks that can be done now — AI-blocking first,
 *   then ★, then the rest.
 * - 等待: held up outside, longest first, plus a 「延迟 N」 fold row.
 * - 实时: what the owner answered, replied to, filed or deferred, latest first —
 *   finished and archived nodes included.
 * - 全部: every node; finished ones fold into 「✓ 已完成/已结束 N」.
 *
 * 延迟 keeps its state (not archived); it and its subtree are out of
 * 可用/活动/人类工作/等待 proper, and dim in 全部.
 */
export type View = string
/** The built-in tabs, in their shipped order. The user's own list: `viewIds()`. */
export const VIEWS: View[] = [...BUILTIN_IDS]

/** The user's tabs, in order (`$NODDIT_HOME/views.json`, else the built-ins). */
export const viewIds = (): View[] => loadViews().map((v) => v.id)

/** The definition behind a tab: the user's, else the built-in of that id, else the first tab. */
export function defOf(view: View | ViewDef): ViewDef {
  if (typeof view !== 'string') return view
  const id = view === 'recent' ? 'live' : view
  return loadViews().find((v) => v.id === id) ?? builtinView(id) ?? loadViews()[0]
}

/** A tab's name: the user's own (in this language if given per language), else the built-in's translated one, else its id. */
export function viewLabel(view: View | ViewDef): string {
  const def = defOf(view)
  if (typeof def.name === 'string') return def.name
  if (def.name) return def.name[lang()] ?? def.name.en ?? Object.values(def.name)[0] ?? def.id
  return builtinView(def.id) ? t(`bench.tabs.${def.id}`) : def.id
}

/** What an empty tab says: the built-in's own line, or a plain one for the user's views. */
export function viewEmpty(view: View | ViewDef): string {
  const def = defOf(view)
  return builtinView(def.id) ? t(`bench.viewEmpty.${def.id}`) : t("bench.viewEmpty.custom")
}

export const VIEW_LABEL: Record<View, string> = new Proxy({}, { get: (_, k) => viewLabel(String(k)) })
export const VIEW_EMPTY: Record<View, string> = new Proxy({}, { get: (_, k) => viewEmpty(String(k)) })

/** The views that draw the tree (and so fold with ←/→ and +/-). */
export const isTreeView = (v: View) => defOf(v).layout === 'tree'

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
  // 最近 became 实时.
  recent: 'live',
}

export function viewFromArg(raw: string | undefined): View {
  const ids = viewIds()
  if (!raw) return ids.includes('available') ? 'available' : ids[0]
  if (ids.includes(raw) || VIEWS.includes(raw)) return raw
  const v = LEGACY_VIEW[raw]
  if (!v) throw new Error(t('bench.legacyViewError', { views: ids.join(' | ') }))
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
export function inView(view: View | ViewDef, d: Item, items: Item[], now = Date.now()): boolean {
  const def = defOf(view)
  if (isDeferHidden(d, items) && (def.deferred ?? 'hide') !== 'show') return false
  if ((def.finished ?? 'hide') === 'hide' && isTerminal(d.state)) return false
  return !def.filter || matches(def.filter, d, items, now)
}

/** One filter against one node. */
export function matches(f: Filter, d: Item, items: Item[], now = Date.now()): boolean {
  if ('any' in f) return f.any.some((x) => matches(x, d, items, now))
  if ('all' in f) return f.all.every((x) => matches(x, d, items, now))
  if ('not' in f) return !matches(f.not, d, items, now)
  return f.value.some((v) => condHolds(f.field, v, d, items, now))
}

function condHolds(field: CondField, v: string, d: Item, items: Item[], now: number): boolean {
  const low = v.toLowerCase()
  switch (field) {
    case 'state':
      return d.state === v
    case 'assignee':
      return low === 'human' || low === 'me' ? isHumanTask(d) : low === 'ai' ? !isHumanTask(d) : d.assignee === v
    case 'flag':
      if (low === 'important') return d.urgency === 'high'
      if (low === 'milestone') return Boolean(d.milestone && d.due)
      if (low === 'flagged') return isFlagged(d)
      return low === 'none' && !isFlagged(d)
    case 'kind':
      return d.kind === v
    case 'project':
      return d.project === v || d.projectName === v || d.letter === v.toUpperCase()
    case 'author':
      return `${d.author}\n${d.ownerAgent ?? ''}`.toLowerCase().includes(low)
    case 'tag':
      return d.tags.includes(v)
    case 'title':
      return d.title.toLowerCase().includes(low)
    case 'due':
      return Boolean(d.due) && Date.parse(d.due!) - now <= spanMs(v)
    case 'updated':
      return now - Date.parse(d.activeAt || d.updatedAt || d.created || '') <= spanMs(v)
    case 'is':
      return isHolds(low, d, items, now)
  }
}

function isHolds(what: string, d: Item, items: Item[], now: number): boolean {
  switch (what) {
    case 'startable':
      return isStartable(d, items)
    case 'deferred':
      return isDeferHidden(d, items)
    case 'delayed':
      return delayOf(d, now) !== undefined
    case 'blocks_ai':
      return blocksAnAi(d, items)
    case 'brief':
      return isUnclaimedBrief(d)
    case 'touched':
      return lastTouch(d) !== undefined
    case 'finished':
      return isTerminal(d.state)
    case 'archived':
      return d.archived
    case 'stale':
      return isStale(d, now)
    case 'root':
      return d.parent === undefined
    case 'parent':
      return Boolean(d.children?.length)
    default:
      return false
  }
}

const spanMs = (v: string) => {
  try {
    return parseDuration(v)
  } catch {
    return -Infinity
  }
}

/** The owner's own to-do that can be done now: started, held up outside, or startable. */
export function isOpenHumanTask(d: Item, items: Item[]): boolean {
  if (!isHumanTask(d) || isTerminal(d.state)) return false
  return d.state === 'in_progress' || d.state === 'waiting' || d.state === 'decided' || (d.state === 'not_started' && isStartable(d, items))
}

/** The number on a tab; 全部 and 最近 have none. */
export function viewCount(view: View | ViewDef, items: Item[]): number | undefined {
  const def = defOf(view)
  if (def.count === false) return undefined
  return items.filter((d) => inView(def, d, items)).length
}

/** How many of what `view` lists are waiting nodes whose check-back day has come. */
export function viewDueCount(view: View | ViewDef, items: Item[], now = Date.now()): number {
  const def = defOf(view)
  return items.filter((d) => isWaitDue(d, now) && inView(def, d, items)).length
}

/** Waiting nodes due to be checked on first (the longest overdue first; one without a day first of all),
 *  then every 延迟 by its day; a deferral with no day last. */
function checkBackKey(d: Item, now = Date.now()): [number, number] {
  const delay = delayOf(d, now)
  if (!delay) return [3, 0]
  if (delay.kind === 'passive' && !delay.until) return [2, 0]
  const at = delay.until ? Date.parse(delay.until) : -Infinity
  return [delay.due ? 0 : 1, Number.isNaN(at) ? -Infinity : at]
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
  touch?: Change
  /**
   * The nodes this one can be moved among by hand (`nod order`): rows with the same scope.
   * Siblings in a tree; one group, and one band of the keys sorted before `manual`, in a list.
   * Absent where the list keeps its own order (a date sort, a fold of finished or older rows).
   */
  scope?: string
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
  const rest = [...sibs].sort((a, b) => manualRank(a) - manualRank(b) || Number(isFlagged(b)) - Number(isFlagged(a)) || a.id - b.id)
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
export function filteredTreeRows(view: View | ViewDef, items: Item[], opts: TreeOptions = {}): Row[] {
  return cutTreeRows((i) => inView(view, i, items), viewLabel(view), items, opts)
}

/**
 * A project picked on its own (not a view): every live node of it as the tree,
 * deferred ones included (drawn dim). Finished nodes are left out. `items` is one project's.
 */
export function projectTreeRows(items: Item[], opts: TreeOptions = {}): Row[] {
  return cutTreeRows((i) => !isTerminal(i.state), '', items, opts)
}

function cutTreeRows(inCut: (i: Item) => boolean, label: string, items: Item[], opts: TreeOptions): Row[] {
  const kids = childMap(items)
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const match = new Set(items.filter(inCut).map(keyOf))
  const shown = new Set(match)
  for (const k of match) for (const a of ancestorsOf(byKey.get(k)!, items)) shown.add(keyOf(a))
  const out: Row[] = []
  const projects = projectsOf(items)

  const walk = (d: Item, depth: number, scope: string) => {
    const children = siblingOrder((kids.get(keyOf(d)) ?? []).filter((c) => shown.has(keyOf(c))), items)
    // Only the owner's own folds — a default-folded ancestor would hide this view's node.
    const collapsed = children.length > 0 && Boolean(opts.collapsed?.has(keyOf(d)))
    out.push({ key: keyOf(d), kind: 'node', node: d, depth, hasKids: children.length > 0, collapsed, context: !match.has(keyOf(d)), scope })
    if (!collapsed) for (const c of children) walk(c, depth + 1, keyOf(d))
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
        text: t('bench.header.viewCount', { letter: p.letter ?? 'X', project: p.name, count: n, label }) + flaggedNote(items.filter((i) => i.project === p.project && match.has(keyOf(i)))),
      })
    }
    for (const r of roots) walk(r, 0, rootScope(p.project))
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

  const walk = (d: Item, depth: number, scope?: string) => {
    const children = siblingOrder(kids.get(keyOf(d)) ?? [], items)
    const collapsed = children.length > 0 && isCollapsed(d, opts)
    out.push({ key: keyOf(d), kind: 'node', node: d, depth, hasKids: children.length > 0, collapsed, ...(scope ? { scope } : {}) })
    if (collapsed) return
    for (const c of children) if (!isTerminal(c.state)) walk(c, depth + 1, keyOf(d))
    const finished = children.filter((c) => isTerminal(c.state))
    // Finished ones list newest first, not by hand.
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
    for (const r of open) walk(r, 0, rootScope(p.project))
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

/** 「 · ★ 2」 after a project header: how many of its listed nodes the owner flagged. */
function flaggedNote(list: Item[]): string {
  const n = list.filter((d) => isFlagged(d) && !isTerminal(d.state)).length
  return n ? t('bench.header.flagged', { count: n }) : ''
}

/** An important row's colour says who it's on: waiting outside, needing the owner — assigned
 *  to them or a decision — or an AI's own live work. 等待 wins over 需要你 over AI; the app
 *  draws the same three as a row background, this is its only equivalent in a terminal. */
export function importantTone(d: Item): 'waiting' | 'you' | 'ai' {
  if (d.state === 'waiting') return 'waiting'
  if (isHumanTask(d) || d.state === 'needs_decision') return 'you'
  return 'ai'
}

const IMPORTANT_COLOR: Record<ReturnType<typeof importantTone>, string> = { waiting: 'magenta', you: 'yellow', ai: 'blue' }

/** ★ important — the owner's mark, drawn after the ref. N250 stopped drawing ⚑ for a milestone
 *  here: the data (d.milestone / d.due) is still read and still sorts a node first, just no
 *  longer shown as a flag or a countdown (see milestoneCountdown below). */
export function flagMark(d: Item, now = Date.now()): Segment | null {
  if (d.urgency === 'high' && !isTerminal(d.state)) return { text: '★ ', color: IMPORTANT_COLOR[importantTone(d)], bold: true }
  return null
}

/** 「Due tomorrow」 / 「Overdue 2 hours」 on any live node with a due date, milestone-flagged or
 *  not — N250 retired the milestone's own countdown (see milestoneCountdown below), so this is
 *  now the only due-date display, for every node alike. */
export function dueMark(d: Item, now = Date.now()): Segment | null {
  if (!d.due || isTerminal(d.state)) return null
  const left = untilDue(d, now)
  if (!Number.isFinite(left)) return null
  if (left < 0) return { text: t('bench.badge.overdue', { span: agoSpan(-left / 60_000) }), color: 'red', bold: true }
  const day = untilDay(d.due)
  const soon = left < 86_400_000
  return { text: t('bench.badge.due', { when: day ? dayFromToday(day, new Date(now)) : '' }), color: soon ? 'red' : 'yellow', bold: soon }
}

/** N250: no longer shown — kept as a no-op so callers don't need to change (dueMark above now
 *  covers a milestone's due date the same as any other node's). */
export function milestoneCountdown(_d: Item, _now = Date.now()): Segment | null {
  return null
}

/** 待决: per project, AI-stuck nodes first, then early-answerable ones.
 *  Answered nodes have left this view; they're in 可用. */
export function ownerRows(items: Item[]): Row[] {
  const out: Row[] = []
  for (const p of projectsOf(items)) {
    const list = ownerQueue(items).filter((i) => i.project === p.project)
    if (!list.length) continue
    out.push({ key: `project:${p.project}`, kind: 'header', depth: 0, text: t('bench.header.group', { letter: p.letter ?? 'X', project: p.name, label: viewLabel('decide'), count: list.length }) + flaggedNote(list) })
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
    .sort((a, b) => Number(isFlagged(b)) - Number(isFlagged(a)) || (waitingSince(a) === waitingSince(b) ? a.id - b.id : waitingSince(a) < waitingSince(b) ? -1 : 1))
    .map((d) => ({ key: keyOf(d), kind: 'node', node: d, depth: 0 }))
  return [...out, ...deferredFold(items, opts)]
}

/** The 「延迟 N」 row (every deferred node), and those nodes once it is opened. */
function deferredFold(items: Item[], opts: TreeOptions): Row[] {
  const deferred = deferredNodes(items)
  if (!deferred.length) return []
  const open = Boolean(opts.openGroups?.has(DEFERRED_GROUP))
  const suffix = open ? t('bench.fold.collapseSuffix') : t('bench.fold.expandSuffix')
  const out: Row[] = [{ key: DEFERRED_GROUP, kind: 'fold', depth: 0, text: `${t('bench.fold.deferredRow', { count: deferred.length })}${suffix}`, finished: deferred, open }]
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

/** The latest write to a node, by anyone, and what it was — 实时's right-hand side. */
export interface Change extends Omit<Touch, 'kind'> {
  kind: Touch['kind'] | 'asked' | 'claimed' | 'heartbeat' | 'received' | 'waiting' | 'progress' | 'state'
  /** progress: the percentage. */
  pct?: number
  /** state: what it became. */
  state?: string
}

const CHANGE_KIND: Record<string, Change['kind']> = {
  [NOTE_KIND.addendum]: 'noted',
  [NOTE_KIND.log]: 'noted',
  [NOTE_KIND.newQuestion]: 'asked',
  [NOTE_KIND.claimed]: 'claimed',
  [NOTE_KIND.heartbeat]: 'heartbeat',
  [NOTE_KIND.received]: 'received',
  [NOTE_KIND.waiting]: 'waiting',
  [NOTE_KIND.completed]: 'state',
  [NOTE_KIND.superseded]: 'state',
}

/** When a node was last written: any note, progress, state change or edit. */
export const changedAt = (d: Item) => d.updatedAt || d.created || ''

/** A note this close to the last write is what that write was. */
const SAME_WRITE_MS = 5000

export function lastChange(d: Item): Change {
  const at = changedAt(d)
  const note = d.notes.reduce<(typeof d.notes)[number] | undefined>((a, n) => (!a || touchTime(n.at) >= touchTime(a.at) ? n : a), undefined)
  if (note && Math.abs(touchTime(note.at) - touchTime(at)) <= SAME_WRITE_MS) {
    const kind = ((TOUCH_KIND[note.kind] as Change['kind'] | undefined) ?? CHANGE_KIND[note.kind] ?? 'noted') as Change['kind']
    if (kind === 'state') return { kind, at, text: '', state: d.state }
    const answers = d.notes.filter((n) => n.kind === NOTE_KIND.answered)
    const choice = kind === 'answered' && note === answers.at(-1) ? d.answer?.choice : undefined
    const quiet = kind === 'deferred' || kind === 'undeferred' || kind === 'seen' || kind === 'heartbeat'
    return { kind, at, text: quiet ? '' : note.text, ...(choice ? { choice } : {}) }
  }
  if (typeof d.progress === 'number' && d.state === 'in_progress') return { kind: 'progress', at, text: d.progressMsg ?? '', pct: d.progress }
  return { kind: 'state', at, text: '', state: d.state }
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
      // A defer or a 看过 carries canned text, not the owner's words.
      const text = kind === 'deferred' || kind === 'undeferred' || kind === 'seen' ? '' : n.text
      return { kind, at: n.at, text, ...(choice ? { choice } : {}) }
    })
    .sort((a, b) => touchTime(a.at) - touchTime(b.at))
}

export const lastTouch = (d: Item): Touch | undefined => ownerTouches(d).at(-1)

export const RECENT_OLDER_GROUP = 'fold:recent-older'

/** "Answered 2" / "Replied" — what the owner did, without the when. */
export function touchLabel(touch: Change): string {
  if (touch.kind === 'answered' && touch.choice) return t('bench.recent.answeredChoice', { choice: touch.choice })
  if (touch.kind === 'progress') return t('bench.recent.progress', { pct: Math.round(touch.pct ?? 0) })
  if (touch.kind === 'state') return statusLabel((touch.state ?? 'in_progress') as Item['state'])
  return t(`bench.recent.${touch.kind}`)
}

/**
 * A view's rows, from its definition. A tree is each project's tree cut to the
 * matches (or, with finished folded, every node with finished ones folded); a
 * list is the matches sorted, grouped, windowed, with a 「Deferred N」 row last.
 */
export function rowsFor(view: View | ViewDef, items: Item[], opts: TreeOptions = {}, now = Date.now()): Row[] {
  const def = defOf(view)
  if (def.layout === 'tree') {
    if (def.finished !== 'fold') return filteredTreeRows(def, items, opts)
    if (!def.filter) return treeRows(def.deferred === 'show' ? items : items.filter((i) => inView(def, i, items)), opts)
    const hit = items.filter((i) => inView(def, i, items))
    const keep = new Set([...hit, ...hit.flatMap((i) => ancestorsOf(i, items))])
    return treeRows(items.filter((i) => keep.has(i)), opts)
  }
  const sorted = items.filter((i) => inView(def, i, items, now)).sort(compareBy(def.sort ?? ['bench'], items))
  const first = (def.sort ?? []).map((k) => k.replace(/^-/, '')).find((k) => k === 'touched' || k === 'changed')
  const scopeOf = listScope(def, items)
  const row = (d: Item, depth: number): Row => {
    const scope = depth === 0 ? scopeOf(d) : undefined
    const r: Row = { key: keyOf(d), kind: 'node', node: d, depth, ...(scope ? { scope } : {}) }
    const tt = first === 'changed' ? lastChange(d) : first === 'touched' ? lastTouch(d) : undefined
    return tt ? { ...r, touch: tt } : r
  }
  const { shown, older } = windowed(def, sorted, now)
  const out = groupedRows(def, shown, items, row)
  if (older.length) {
    const key = olderGroupKey(def)
    const open = Boolean(opts.openGroups?.has(key))
    const suffix = open ? t('bench.fold.collapseSuffix') : t('bench.fold.expandSuffix')
    out.push({ key, kind: 'fold', depth: 0, text: `${t('bench.fold.olderRow', { count: older.length })}${suffix}`, finished: older, open })
    if (open) for (const d of older) out.push(row(d, 1))
  }
  if (def.deferred === 'fold') out.push(...deferredFold(items, opts))
  return out
}

const rootScope = (project: string) => `${project}#`

/** The sort keys that have only a few values, so nodes sharing them can still be put in order by hand. */
const BANDS: Partial<Record<SortField, (d: Item, items: Item[]) => string>> = {
  blocks_ai: (d, items) => String(blocksAnAi(d, items)),
  flag: (d) => String(isFlagged(d)),
  urgency: (d) => String(urgencyRank(d)),
  state: (d) => d.state,
}

/**
 * A list row's `scope`: its group plus its values for the keys sorted before the hand-made
 * order (`manual`, or `bench`, which begins with it). A key with too many values to share
 * (a date, a title) leaves nothing to arrange, so the list has no scope at all.
 */
function listScope(def: ViewDef, items: Item[]): (d: Item) => string | undefined {
  const keys = def.sort ?? ['bench']
  const at = keys.findIndex((k) => k === 'manual' || k === 'bench')
  const before = keys.slice(0, Math.max(at, 0)).map((k) => BANDS[k.replace(/^-/, '') as SortField])
  if (at === -1 || before.some((b) => !b)) return () => undefined
  const group = def.group ?? 'none'
  const groupOf = (d: Item) => (group === 'project' ? d.project : group === 'state' ? d.state : group === 'assignee' ? String(isHumanTask(d)) : '')
  return (d) => ['list', groupOf(d), ...before.map((b) => b!(d, items))].join(':')
}

/** Where a list's 「Older N」 row is remembered — 最近 keeps its old key. */
export const olderGroupKey = (def: ViewDef) => (def.id === 'live' ? RECENT_OLDER_GROUP : `fold:older:${def.id}`)

/** The time a windowed list measures from: its first sort key's. */
function sortTime(def: ViewDef, d: Item): number {
  const key = (def.sort ?? [])[0]?.replace(/^-/, '')
  if (key === 'touched') return touchTime(lastTouch(d)?.at ?? '')
  if (key === 'changed') return touchTime(changedAt(d))
  if (key === 'updated') return Date.parse(d.updatedAt || d.created || '') || 0
  if (key === 'created') return Date.parse(d.created || '') || 0
  return NaN
}

function windowed(def: ViewDef, sorted: Item[], now: number): { shown: Item[]; older: Item[] } {
  if (!def.window) return { shown: sorted, older: [] }
  const since = def.window.days ? now - def.window.days * 86_400_000 : -Infinity
  const max = def.window.max ?? Infinity
  const cut = sorted.findIndex((d, i) => i >= max || sortTime(def, d) < since)
  return cut === -1 ? { shown: sorted, older: [] } : { shown: sorted.slice(0, cut), older: sorted.slice(cut) }
}

function groupedRows(def: ViewDef, list: Item[], items: Item[], row: (d: Item, depth: number) => Row): Row[] {
  const group = def.group ?? 'none'
  if (group === 'none') return list.map((d) => row(d, 0))
  const out: Row[] = []
  const push = (key: string, text: string, members: Item[]) => {
    if (!members.length) return
    out.push({ key, kind: 'header', depth: 0, text })
    for (const d of members) out.push(row(d, 0))
  }
  if (group === 'project') {
    for (const p of projectsOf(items)) {
      const members = list.filter((d) => d.project === p.project)
      push(`project:${p.project}`, t('bench.header.group', { letter: p.letter ?? 'X', project: p.name, label: viewLabel(def), count: members.length }) + flaggedNote(members), members)
    }
  } else if (group === 'state') {
    for (const st of ITEM_STATUSES) {
      const members = list.filter((d) => d.state === st)
      push(`state:${st}`, t('bench.header.groupPlain', { label: statusLabel(st), count: members.length }), members)
    }
  } else {
    const mine = list.filter((d) => isHumanTask(d))
    push('assignee:human', t('bench.header.groupPlain', { label: t('bench.badge.forYou'), count: mine.length }), mine)
    const ai = list.filter((d) => !isHumanTask(d))
    push('assignee:ai', t('bench.header.groupPlain', { label: t('bench.group.ai'), count: ai.length }), ai)
  }
  return out
}

/** The list comparator for a view's sort keys; every key has a natural direction, `-` flips it; ties end on the id. */
export function compareBy(keys: readonly SortKey[], items: Item[]): (a: Item, b: Item) => number {
  const cmps = keys.map((k) => {
    const flip = k.startsWith('-') ? -1 : 1
    const c = SORTERS[k.replace(/^-/, '') as SortField]
    return (a: Item, b: Item) => flip * c(a, b, items)
  })
  return (a, b) => {
    for (const c of cmps) {
      const r = c(a, b)
      if (r) return r
    }
    return a.id - b.id
  }
}

const asc = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1)
const timeOf = (s: string | undefined) => Date.parse(s ?? '') || 0
const dueOf = (d: Item) => (d.due ? Date.parse(d.due) || Infinity : Infinity)

const SORTERS: Record<SortField, (a: Item, b: Item, items: Item[]) => number> = {
  bench: (a, b) => benchOrder(a, b),
  blocks_ai: (a, b, items) => Number(blocksAnAi(b, items)) - Number(blocksAnAi(a, items)),
  flag: (a, b) => Number(isFlagged(b)) - Number(isFlagged(a)),
  manual: (a, b) => manualRank(a) - manualRank(b),
  urgency: (a, b) => urgencyRank(a) - urgencyRank(b),
  due: (a, b) => asc(dueOf(a), dueOf(b)),
  created: (a, b) => asc(timeOf(a.created), timeOf(b.created)),
  updated: (a, b) => asc(timeOf(b.updatedAt || b.created), timeOf(a.updatedAt || a.created)),
  check_back: (a, b) => {
    const [ra, ta] = checkBackKey(a)
    const [rb, tb] = checkBackKey(b)
    return ra - rb || (ta === tb ? 0 : ta < tb ? -1 : 1)
  },
  waiting_since: (a, b) => (waitingSince(a) === waitingSince(b) ? 0 : waitingSince(a) < waitingSince(b) ? -1 : 1),
  touched: (a, b) => touchTime(lastTouch(b)?.at ?? '') - touchTime(lastTouch(a)?.at ?? ''),
  changed: (a, b) => touchTime(changedAt(b)) - touchTime(changedAt(a)),
  id: (a, b) => a.id - b.id,
  title: (a, b) => a.title.localeCompare(b.title),
  state: (a, b) => ITEM_STATUSES.indexOf(a.state) - ITEM_STATUSES.indexOf(b.state),
}

/** Where a jump to `d` lands if the current view doesn't list it: 可用,
 *  else 等待 (deferred) or 全部. */
export function homeView(d: Item, items: Item[], from: View): View {
  if (inView(from, d, items)) return from
  if (defOf(from).deferred === 'fold' && isDeferred(d)) return from
  const views = loadViews()
  if (views.some((v) => v.id === 'available') && inView('available', d, items)) return 'available'
  const fold = isDeferred(d) ? views.find((v) => v.deferred === 'fold') : undefined
  if (fold) return fold.id
  return (views.find((v) => v.layout === 'tree' && inView(v, d, items)) ?? views.find((v) => inView(v, d, items)))?.id ?? from
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

/** 人类工作, not started: a hollow yellow diamond, instead of its state's own shape. */
export const HUMAN_GLYPH = '◇'

/** 人类工作, started (in_progress): a yellow diamond with its left half filled —
 *  between HUMAN_GLYPH (not started) and a decision's solid ◆ (blocking an AI). */
export const HUMAN_DOING_GLYPH = '⬖'

/** The glyph text for `d`, whatever its state. */
export const glyphText = (d: Item, items: Item[]) =>
  isUnclaimedBrief(d)
    ? BRIEF_GLYPH
    : isOpenHumanTask(d, items)
      ? d.state === 'in_progress'
        ? HUMAN_DOING_GLYPH
        : HUMAN_GLYPH
      : d.state === 'decided'
        ? decidedShape(d)
        : GLYPH[d.state]

/**
 * ◆ is yellow, bold while an AI is stuck on it, dim if answerable early.
 * ◇ (hollow, also yellow) is the owner's own open to-do, not yet started — a
 * human task, not a decision; see `isOpenHumanTask`. ⬖ (left half filled,
 * also yellow) is that same to-do once started (in_progress). Green is
 * 已答待取 (owner answered, AI hasn't picked up), keeping its task shape. ◐
 * goes red once a check-in has gone unanswered 3 times (core/checkins.ts).
 */
export function glyphOf(d: Item, items: Item[], now = Date.now()): Glyph {
  const text = glyphText(d, items)
  if (isUnclaimedBrief(d)) return { text, color: 'blue', bold: true }
  if (isOpenHumanTask(d, items)) return { text, color: 'yellow' }
  switch (d.state) {
    case 'not_started':
      return { text, dim: true }
    case 'in_progress':
      return { text, color: d.checkin?.unanswered ? 'red' : 'cyan' }
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
  const sep: Segment = { text: ' · ', dim: true }
  const lead = (forms: Segment[][], seg: Segment | null) => (seg ? [...forms.map((f) => [seg, sep, ...f]), [seg]] : forms)
  const countdown = row?.touch ? null : (milestoneCountdown(d, now) ?? dueMark(d, now))
  const est = row?.touch ? null : estimateMark(d, items)
  return lead(lead(stateSuffix(d, items, now, row), est), countdown)
}

/** 「人 2h」 / 「AI 30m」: what is still ahead here, the subtree's total on a parent, split by whose time. */
export function estimateMark(d: Item, items: Item[]): Segment | null {
  if (isTerminal(d.state)) return null
  const text = estimateText(estimateTotal(d, items))
  return text ? { text, dim: true } : null
}

export function estimateText(e: EstimateTotal): string {
  return [e.human ? t('bench.badge.estHuman', { span: fmtMinutes(e.human) }) : '', e.ai ? t('bench.badge.estAi', { span: fmtMinutes(e.ai) }) : ''].filter(Boolean).join(' · ')
}

function stateSuffix(d: Item, items: Item[], now: number, row?: Row): Segment[][] {
  const forms: Segment[][] = []
  const fold: Segment[] = row?.collapsed ? [{ text: `+${countBelow(d, items)} `, dim: true }] : []
  if (row?.touch) {
    const when = ago(minutesSince({ updatedAt: row.touch.at, created: d.created }, now))
    const what = touchLabel(row.touch)
    forms.push([{ text: `${what} · ${when}`, color: 'blue' }, { text: ` · ${statusLabel(d.state)}`, dim: true }])
    forms.push([{ text: `${what} · ${when}`, color: 'blue' }])
    return forms
  }
  if (isDeferred(d, now)) {
    const ai: Segment[] = deferredByAgent(d) ? [{ text: `${t('bench.badge.byAi')} · `, color: 'red' }] : []
    const since = d.deferredAt ? ago(minutesSince({ updatedAt: d.deferredAt, created: d.created }, now)) : ''
    const back = d.deferredUntil ? untilDay(d.deferredUntil) : undefined
    if (back) {
      const date = dayText(back, new Date(now))
      forms.push([...fold, ...ai, { text: t('bench.badge.deferredUntil', { date, relative: dayFromToday(back, new Date(now)) }), dim: true }])
      forms.push([...fold, ...ai, { text: t('bench.badge.deferredUntilShort', { date }), dim: true }])
    }
    if (since) forms.push([...fold, ...ai, { text: t('bench.badge.deferredSince', { since }), dim: true }])
    forms.push([...fold, ...ai, { text: t('bench.badge.deferred'), dim: true }])
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
      // A human task's own badge, yellow like 待决: no age, no progress bar — it never gets a check-in.
      if (isHumanTask(d)) {
        forms.push([...fold, { text: t('bench.badge.doing'), color: 'yellow' }])
        break
      }
      const when = ago(minutesSince(d, now))
      const pct = progressOf(d)
      const alert = d.checkin?.unanswered
      const color = alert ? 'red' : undefined
      const age: Segment = { text: when, color, dim: !alert, bold: alert }
      const badge: Segment[] = alert ? [{ text: ` ${t('bench.badge.checkinUnanswered', { count: d.checkin!.asked })}`, color: 'red', bold: true }] : []
      if (pct !== undefined) forms.push([...fold, { text: bar(pct, 8), color: color ?? 'cyan' }, { text: ` ${pct}% ` }, age, ...badge])
      if (pct !== undefined) forms.push([...fold, { text: `${pct}% ` }, age, ...badge])
      forms.push([age, ...badge])
      if (alert) forms.push([{ text: t('bench.badge.checkinUnanswered', { count: d.checkin!.asked }), color: 'red', bold: true }])
      break
    }
    case 'waiting': {
      const since = ago(minutesSince({ updatedAt: waitingSince(d), created: d.created }, now))
      if (isWaitDue(d, now)) {
        // Time to follow up: an inverse badge, the one thing in the row that stands out.
        const due: Segment = { text: ` ${t('bench.badge.checkBackDue')} `, color: 'magenta', inverse: true, bold: true }
        if (d.waitingOn) forms.push([...fold, due, { text: ` ${t('bench.badge.checkOn', { who: waitOn(d) })}`, color: 'magenta' }])
        forms.push([due])
        break
      }
      const back = d.waitingUntil ? dayText(untilDay(d.waitingUntil) ?? d.waitingUntil) : ''
      if (d.waitingOn && back) forms.push([...fold, { text: t('bench.badge.waitingOnUntil', { who: waitOn(d), date: back }), color: 'magenta' }])
      if (d.waitingOn) forms.push([...fold, { text: t('bench.badge.waitingOnSince', { who: waitOn(d), since }), color: 'magenta' }])
      forms.push([...fold, { text: back ? t('bench.badge.backOn', { date: back }) : `${statusLabel('waiting')} · ${since}`, color: 'magenta' }])
      break
    }
    case 'needs_decision': {
      const blocks = dependentsOf(d, items).length
      // Important shows as ★ before the title; the badge need not say it again.
      const urgent: Segment[] = []
      const decide = t('bench.badge.decide')
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
      } else if (isHumanTask(d)) {
        // Startable and yours: the yellow 待做, same place and colour as 待决.
        forms.push([...fold, { text: t('bench.badge.todo'), color: 'yellow' }])
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

/** 「等」 on one line: an old long one is cut at the limit new ones are held to. */
const waitOn = (d: Item) => fit((d.waitingOn ?? '').replace(/\s+/g, ' '), WAIT_ON_MAX_COLS)

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
  const finished = isTerminal(d.state)
  const mark = opts.tree ? subtreeWaiting(d, items) : null
  const lead: Segment[] = [
    { text: mark ? '◆' : ' ', color: 'yellow', bold: mark === 'strong', dim: mark === 'weak' },
    { text: '  '.repeat(row.depth) },
    { text: opts.tree ? (row.hasKids ? (row.collapsed ? '▸' : '▾') : ' ') : '', dim: true },
    { ...glyph },
    { text: ` ${refOf(d)} `, color: finished ? undefined : 'cyan', dim: finished },
    ...(flagMark(d, now) ? [flagMark(d, now)!] : []),
  ]
  const titleColor = d.state === 'in_progress' && d.checkin?.unanswered ? 'red' : undefined
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

/**
 * Order of 人类工作: what holds an AI up first (a question it is stuck on, or the
 * owner's to-do that other work is `after`), then what the owner flagged ★
 * (important or, since N250, a milestone — still sorts first, just unmarked),
 * then the rest (to-dos, questions answerable early); bench order within each.
 */
export function ownerQueue(items: Item[]): Item[] {
  const open = items.filter((i) => inView('decide', i, items))
  const rank = (i: Item) => (blocksAnAi(i, items) ? 0 : isFlagged(i) ? 1 : 2)
  return open.sort((a, b) => rank(a) - rank(b) || benchOrder(a, b))
}

/** An AI is held up on the owner here: stuck on this question, or waiting for this to-do to be done. */
export function blocksAnAi(d: Item, items: Item[]): boolean {
  if (d.state === 'needs_decision') return waitingOnOwner(d, items)
  return isHumanTask(d) && dependentsOf(d, items).some((x) => !isTerminal(x.state) && !isHumanTask(x))
}
