import { staleTasksOf } from '../core/checkins.ts'
import { parseBodyRefs, refOf } from '../core/ref.ts'
import { OPTIONS_HEADING_RE } from '../core/parse.ts'
import { QUESTIONS_HEADING_RE } from '../core/questions.ts'
import { toJSON } from '../core/render.ts'
import { readProjectConfig } from '../core/project.ts'
import { dependentsOf } from '../core/sequence.ts'
import { isHumanTask } from '../core/assignee.ts'
import { dependenciesOf, isDeferred, isTerminal } from '../core/status.ts'
import { projectSessions } from '../core/listeners.ts'
import type { Store } from '../core/store.ts'
import type { Decision as Item } from '../core/types.ts'
import { isRtl, lang, t } from '../i18n/index.ts'
import { targetPath } from '../cli/commands/open.ts'
import { metaLines, statusSegments, whoOf } from './detail.ts'
import { bodyRows, canPin, canUseDefault, type BodyRow, type Segment } from './model.ts'
import { imageName, nodeImages } from './images.ts'
import {
  DEFERRED_GROUP, RECENT_OLDER_GROUP, blocksAnAi, projectTreeRows, touchLabel, VIEWS, VIEW_EMPTY, VIEW_LABEL, doneGroupKey, glyphOf, isCollapsed, isDeferHidden, isTreeView,
  keyOf, progressOf, rowsFor, subtreeWaiting, suffixOf, viewCount, type Row, type View,
} from './views.ts'

/** The window does its own wrapping. */
const NO_WRAP = Infinity
/** The meta block's progress bar is drawn at this many cells; a GUI redraws it as a bar. */
const META_WIDTH = 60

const plain = (segs: Segment[]) => segs.map(({ text, bold, dim, color }) => ({ text, ...(bold ? { bold } : {}), ...(dim ? { dim } : {}), ...(color ? { color } : {}) }))

/** Who mentions whom, in one pass over every body instead of one per node. */
function backlinkIndex(store: Store, items: Item[]): Map<string, Item[]> {
  const letters = new Set(store.layouts.map((l) => store.letterOf(l)))
  const byRef = new Map(items.map((i) => [`${i.letter ?? ''}${i.id}`, i]))
  const out = new Map<string, Item[]>()
  for (const o of items) {
    const hit = new Set<string>()
    for (const r of parseBodyRefs(o.body, letters)) {
      const target = r.letter === 'D' && !letters.has('D') ? items.find((i) => i.project === o.project && i.id === r.id) : byRef.get(`${r.letter}${r.id}`)
      if (!target || target === o || hit.has(keyOf(target))) continue
      hit.add(keyOf(target))
      out.set(keyOf(target), [...(out.get(keyOf(target)) ?? []), o])
    }
  }
  return out
}

function everyFoldKey(items: Item[]): Set<string> {
  const keys = new Set<string>([DEFERRED_GROUP, RECENT_OLDER_GROUP])
  for (const i of items) {
    keys.add(doneGroupKey(i))
    keys.add(doneGroupKey({ project: i.project }))
  }
  return keys
}

function rowJson(view: View, row: Row, items: Item[], now: number, fold: string | null): Record<string, unknown> {
  const base = { key: row.key, kind: row.kind, depth: row.depth, fold }
  if (row.kind === 'header') return { ...base, text: row.text }
  if (row.kind === 'fold') return { ...base, text: withoutKeyHint(row.text ?? ''), count: row.finished?.length ?? 0 }
  const d = row.node!
  const collapsed = view === 'all' ? Boolean(row.hasKids) && isCollapsed(d, {}) : false
  const forms = suffixOf(d, items, now, { ...row, collapsed: false })
  const mark = isTreeView(view) ? subtreeWaiting(d, items) : null
  return {
    ...base,
    node: keyOf(d),
    ref: refOf(d),
    title: d.title,
    state: d.state,
    glyph: plain([glyphOf(d, items, now)])[0],
    mark,
    has_kids: Boolean(row.hasKids),
    collapsed,
    context: Boolean(row.context),
    deferred: isDeferHidden(d, items),
    progress: progressOf(d) ?? null,
    badge: plain(forms[0] ?? []),
    badge_short: plain(forms.at(-1) ?? []),
    // The owner's marks: 'important' (★) or 'milestone' (⚑, counted down to `due`).
    flag: isTerminal(d.state) ? null : d.milestone && d.due ? 'milestone' : d.urgency === 'high' ? 'important' : null,
    due: d.due ?? null,
    // Who does it: 'human' (the owner's own to-do — no agent works on it) or 'ai'.
    assignee: isHumanTask(d) ? (d.assignee ?? 'human') : 'ai',
    human_task: isHumanTask(d),
    // `nod defer --until`: the moment it comes back on its own (null: deferred indefinitely, or not deferred).
    deferred_until: isDeferred(d, now) ? (d.deferredUntil ?? null) : null,
    // 需要人类: an AI is held up on the owner here (a question it is stuck on, or a to-do other work waits for).
    blocks_ai: blocksAnAi(d, items),
    // 最近: what the owner did, for a window that shows it its own way.
    ...(row.touch ? { touch: { ...row.touch, label: touchLabel(row.touch) } } : {}),
  }
}

/** A fold row's 「+ expands」 is the terminal's key; a window has its own. */
function withoutKeyHint(text: string): string {
  for (const hint of [t('bench.fold.collapseSuffix'), t('bench.fold.expandSuffix')]) if (hint && text.endsWith(hint)) return text.slice(0, -hint.length)
  return text
}

/** The innermost fold row each row is listed under: a fold holds what follows it at its depth or deeper, until the tree climbs out. */
function withFolds(rows: Row[]): (string | null)[] {
  const out: (string | null)[] = []
  const open: { key: string; depth: number }[] = []
  for (const r of rows) {
    if (r.kind === 'header') open.length = 0
    while (open.length && open.at(-1)!.depth > r.depth) open.pop()
    out.push(open.at(-1)?.key ?? null)
    if (r.kind === 'fold') open.push({ key: r.key, depth: r.depth })
  }
  return out
}

/**
 * The body minus the current round's options and sub-questions: a window
 * draws those from `options` / `questions` as things to click. Older rounds stay.
 */
function withoutLiveChoices(body: string): string {
  const lines = body.split('\n')
  for (const re of [OPTIONS_HEADING_RE, QUESTIONS_HEADING_RE]) {
    const start = lines.findLastIndex((l) => re.test(l))
    if (start === -1) continue
    let end = start + 1
    while (end < lines.length && !/^##[ \t]+\S/.test(lines[end])) end++
    lines.splice(start, end - start)
  }
  return lines.join('\n')
}

const OPTION_HEADING = /^###[ \t]+([A-Za-z0-9]{1,4})[ \t]*(?:[·:：．.\-—–]{1,2}[ \t]*(.*))?$/

/**
 * Options whose cost is written in the body under their own `### 1 · …` heading rather than
 * under the option: the window shows that text on the option's card, so it is taken out of
 * the body here and handed back per option key.
 */
function optionCosts(body: string, keys: string[]): { body: string; costs: Record<string, string> } {
  const lines = body.split('\n')
  const costs: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION_HEADING.exec(lines[i])
    if (!m || !keys.includes(m[1]) || costs[m[1]] !== undefined) continue
    let end = i + 1
    while (end < lines.length && !/^#{2,3}[ \t]+\S/.test(lines[end])) end++
    costs[m[1]] = lines.slice(i + 1, end).join('\n').trim()
    lines.splice(i, end - i)
    i--
  }
  return { body: lines.join('\n'), costs }
}

/** A node another one points at, as a window draws it: a small linked pill. */
const pill = (o: Item, items: Item[], now: number) => ({ key: keyOf(o), ref: refOf(o), title: o.title, state: o.state, glyph: plain([glyphOf(o, items, now)])[0] })

/** The 附件 line bench writes above attachment images is plain text in a terminal; a window draws it as the heading it is. */
const asHeading = (heading: string) => (r: BodyRow, i: number, rows: BodyRow[]): BodyRow =>
  !r.style && r.text === heading && rows[i + 1]?.image !== undefined ? { text: heading.replace(/^#+\s*/, ''), style: { bold: true, color: 'cyan' } } : r

/** `d.attachments`' plain shape plus the absolute path a window needs to read the file itself. */
const withPath = (d: Item, a: Item['attachments'][number]) => ({
  label: a.label, target: a.target, path: targetPath(d.file, a.target), image: a.image, group: a.group ?? null, caption: a.caption ?? null,
})

function nodeJson(d: Item, items: Item[], now: number, backlinks: Item[]): Record<string, unknown> {
  const { body: _body, ...fields } = toJSON(d)
  const live = withoutLiveChoices(d.body)
  const { body: rest, costs } = optionCosts(live, d.options.filter((o) => !o.body.trim()).map((o) => o.key))
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const parent = d.parent !== undefined ? byKey.get(`${d.project}#${d.parent}`) : undefined
  const images = nodeImages(d).map((im) => ({
    name: imageName(im),
    alt: im.alt,
    target: im.target,
    path: targetPath(d.file, im.target),
    source: im.source,
    attachment: im.attachment ?? null,
    group: im.group ?? null,
    caption: im.caption ?? null,
  }))
  return {
    ...fields,
    key: keyOf(d),
    who: whoOf(d),
    can_default: canUseDefault(d),
    can_pin: canPin(d),
    status_line: plain(statusSegments(d, items, now)),
    meta: metaLines(d, items, now, META_WIDTH, backlinks).map(plain),
    options: d.options.map((o) => ({ key: o.key, label: o.label, body: o.body.trim() || costs[o.key] || '' })),
    parent_node: parent ? pill(parent, items, now) : null,
    after_nodes: dependenciesOf(d, items).map((dep) => (typeof dep === 'string' ? { key: null, ref: dep, title: null, state: null, glyph: null } : pill(dep, items, now))),
    blocking_nodes: dependentsOf(d, items).map((b) => pill(b, items, now)),
    referenced_by: backlinks.map((b) => pill(b, items, now)),
    // `staleness` / `checkin` come from `toJSON(d)` above (`...fields`).
    body_rows: bodyRows({ ...d, body: rest }, NO_WRAP, false, nodeImages(d)).map(asHeading(t('bench.detail.attachmentsHeading'))).map((r) => ({
      text: r.text,
      ...(r.image !== undefined ? { image: r.image } : {}),
      ...(r.style ? { style: plain([{ text: '', ...r.style }])[0] } : {}),
    })),
    images,
    // Every attachment, flat — the bench's own numbered picker. Render per
    // message instead: `body_attachments` for the body, each entry in
    // `notes[].attachments` for that note — same shape, plus `path`.
    attachments: d.attachments.map((a) => withPath(d, a)),
    body_attachments: d.bodyAttachments.map((a) => withPath(d, a)),
    notes: d.notes.map((n) => ({ kind: n.kind, role: n.role, author: n.author, at: n.at, text: n.text, attachments: n.attachments.map((a) => withPath(d, a)) })),
    terminal: isTerminal(d.state),
    backlinks: backlinks.map((b) => keyOf(b)),
  }
}

/** One node's detail pane — for an archived node, which `benchJson` lists but leaves out of `nodes`. */
export function nodeDetailJson(store: Store, d: Item, now = Date.now()): Record<string, unknown> {
  const items = store.all()
  const self = items.find((i) => keyOf(i) === keyOf(d)) ?? d
  return nodeJson(self, items, now, store.backlinks(self, items))
}

/**
 * Everything the bench shows, for a window that draws it itself: each view's
 * rows, and the detail pane of every node still in active/ (archived ones,
 * often most of a long-lived project, come one at a time via `nodeDetailJson`).
 */
export function benchJson(store: Store, opts: { project?: string; now?: number; back?: Item[] } = {}): Record<string, unknown> {
  const now = opts.now ?? Date.now()
  const all = store.all()
  const key = store.projectKey(opts.project)
  const items = key ? all.filter((d) => d.project === key) : all
  const openAll = { expanded: new Set(items.map(keyOf)), openGroups: everyFoldKey(items) }
  const views = VIEWS.map((view) => {
    const rows = rowsFor(view, items, openAll)
    const folds = withFolds(rows)
    return {
      view,
      label: VIEW_LABEL[view],
      empty: VIEW_EMPTY[view],
      count: viewCount(view, items) ?? null,
      rows: rows.map((r, i) => rowJson(view, r, items, now, folds[i])),
    }
  })
  // A project picked on its own: all its live nodes as one tree, never mixed with a view's filter.
  const projectViews = store.layouts
    .map((l) => store.projectName(l))
    .filter((p) => items.some((d) => d.project === p))
    .map((project) => {
      const mine = items.filter((d) => d.project === project)
      const rows = projectTreeRows(mine, openAll)
      const folds = withFolds(rows)
      return {
        project,
        count: mine.filter((d) => !isTerminal(d.state)).length,
        empty: t('bench.viewEmpty.project'),
        rows: rows.map((r, i) => rowJson('all', r, mine, now, folds[i])),
      }
    })
  const links = backlinkIndex(store, items)
  const nodes = Object.fromEntries(items.filter((d) => !d.archived).map((d) => [keyOf(d), nodeJson(d, items, now, links.get(keyOf(d)) ?? [])]))
  const sessions = projectSessions(store, now)
  return {
    now: new Date(now).toISOString(),
    lang: lang(),
    rtl: isRtl(),
    labels: { defaultMark: t('bench.detail.defaultMark') },
    // `listening`: a main session's `nod monitor` is running there, so a new brief will be picked up.
    // `stale_count` (N47): not_started, not deferred nodes in this project — neither
    // waiting on a decision nor being worked on.
    projects: store.layouts.map((l, i) => ({
      project: store.projectName(l),
      name: store.displayName(l),
      letter: store.letterOf(l),
      former_letters: readProjectConfig(l).former_letters ?? [],
      root: l.projectRoot,
      listening: sessions[i].listening,
      sessions: sessions[i].sessions,
      stale_count: staleTasksOf(items.filter((d) => d.project === store.projectName(l))).length,
    })),
    views,
    project_views: projectViews,
    // Deferred `--until` a day that has come: brought back by this read (or one just before it).
    back_from_deferral: (opts.back ?? []).map((d) => ({ key: keyOf(d), ref: refOf(d), title: d.title, text: t('bench.toast.backFromDeferral', { refs: refOf(d) }) })),
    nodes,
  }
}
