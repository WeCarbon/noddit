import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { nodditEnv } from './env.ts'
import { writeFileAtomic } from './lock.ts'
import { t } from '../i18n/index.ts'

/**
 * A bench view as data: which nodes it lists (filter), how they are laid out
 * (a project tree, or a flat list grouped by something) and in what order.
 * The six built-in views are defined here with the same schema; the user's
 * own list (added, edited, removed, reordered) lives in `$NODDIT_HOME/views.json`.
 */
export interface ViewDef {
  /** Stable key: `available`, `decide`, or the user's own slug. `nod bench --view <id>`. */
  id: string
  /** Shown on the tab. Absent on a built-in: its name follows the language. A string, or one per language. */
  name?: string | Record<string, string>
  /** One generic word for an icon (lucide names): `list-todo`, `hourglass`. */
  icon?: string
  /** Which nodes. Absent = every node. */
  filter?: Filter
  /** `tree`: each project's tree cut to the matches, ancestors drawn dim; `list`: one row per match. */
  layout: 'tree' | 'list'
  /** list only: a header row per project, per state, per assignee, or none. */
  group?: 'project' | 'state' | 'assignee' | 'none'
  /** list only: sort keys, first decides; `-key` reverses one. Ties end on the id. */
  sort?: SortKey[]
  /** Finished nodes: left out, listed, or (tree) folded into 「✓ Completed N」 rows. Default `hide`. */
  finished?: 'hide' | 'show' | 'fold'
  /** Deferred nodes (and their subtrees): left out, listed dim, or (list) one 「Deferred N」 row of every deferred node at the end. Default `hide`. */
  deferred?: 'hide' | 'show' | 'fold'
  /** list only: rows past this many days back (by the first sort key's time) or this many rows go behind an 「Older N」 row. */
  window?: { days?: number; max?: number }
  /** Whether the tab shows how many nodes it lists. Default true. */
  count?: boolean
}

export type SortKey = `${'' | '-'}${SortField}`
export const SORT_FIELDS = ['bench', 'blocks_ai', 'flag', 'manual', 'urgency', 'due', 'created', 'updated', 'check_back', 'waiting_since', 'touched', 'id', 'title', 'state'] as const
export type SortField = (typeof SORT_FIELDS)[number]

/** `{ any: […] }` / `{ all: […] }` / `{ not: … }` nest; a leaf is one condition. */
export type Filter = { any: Filter[] } | { all: Filter[] } | { not: Filter } | Cond

/**
 * One condition. Enum fields match when the node's value is any of `value`.
 * `is` tests flags (`startable`, `deferred`, …); `due` / `updated` take a span
 * (`7d`) and match within it; `title` / `author` match a substring.
 */
export interface Cond {
  field: CondField
  value: string[]
}
export const COND_FIELDS = ['state', 'assignee', 'flag', 'kind', 'project', 'author', 'tag', 'is', 'due', 'updated', 'title'] as const
export type CondField = (typeof COND_FIELDS)[number]
/** What `is:` can test. */
export const IS_VALUES = ['startable', 'deferred', 'blocks_ai', 'brief', 'touched', 'finished', 'archived', 'stale', 'root', 'parent'] as const

export const LAYOUTS = ['tree', 'list'] as const
export const GROUPS = ['project', 'state', 'assignee', 'none'] as const
export const SHOW = ['hide', 'show', 'fold'] as const

/** The built-in views, in tab order — what `nod view reset` restores. */
export const BUILTIN_VIEWS: readonly ViewDef[] = [
  {
    id: 'available',
    icon: 'list-todo',
    layout: 'tree',
    filter: parseFilter('state:in_progress,waiting,needs_decision,decided or state:not_started is:startable'),
  },
  { id: 'active', icon: 'activity', layout: 'tree', filter: parseFilter('state:in_progress,needs_decision') },
  {
    id: 'decide',
    icon: 'hand',
    layout: 'list',
    group: 'project',
    sort: ['blocks_ai', 'flag', 'bench'],
    filter: parseFilter('state:needs_decision or assignee:human state:in_progress,waiting,decided or assignee:human state:not_started is:startable'),
  },
  { id: 'all', icon: 'list-tree', layout: 'tree', finished: 'fold', deferred: 'show', count: false },
  { id: 'waiting', icon: 'hourglass', layout: 'list', group: 'none', sort: ['check_back', 'flag', 'waiting_since'], deferred: 'fold', filter: parseFilter('state:waiting') },
  {
    id: 'recent',
    icon: 'history',
    layout: 'list',
    group: 'none',
    sort: ['touched'],
    finished: 'show',
    deferred: 'show',
    window: { days: 30, max: 200 },
    count: false,
    filter: parseFilter('is:touched'),
  },
]

export const BUILTIN_IDS = BUILTIN_VIEWS.map((v) => v.id)
export const builtinView = (id: string) => BUILTIN_VIEWS.find((v) => v.id === id)

// ---------------------------------------------------------------------------
// The filter's text form: what `nod view add --filter` takes and `nod views` prints.
// Terms separated by spaces all hold; `or` separates alternatives; `-` negates a term.
//   state:in_progress,waiting  assignee:human  flag:important  is:startable  -is:deferred
//   due:7d  updated:1d  project:web  author:lead  tag:ops  title:"release notes"
// ---------------------------------------------------------------------------

export function parseFilter(text: string): Filter | undefined {
  const tokens = tokenize(text)
  if (!tokens.length) return undefined
  const groups: Filter[][] = [[]]
  for (const tok of tokens) {
    if (tok.toLowerCase() === 'or') {
      if (!groups.at(-1)!.length) throw new Error(t('core.views.badFilter', { term: tok }))
      groups.push([])
      continue
    }
    groups.at(-1)!.push(parseTerm(tok))
  }
  if (!groups.at(-1)!.length) throw new Error(t('core.views.badFilter', { term: 'or' }))
  const ands = groups.map((g) => (g.length === 1 ? g[0] : { all: g }))
  return ands.length === 1 ? ands[0] : { any: ands }
}

function tokenize(text: string): string[] {
  const out: string[] = []
  const re = /(-?[a-z_]+:"[^"]*"|\S+)/gi
  for (const m of text.trim().matchAll(re)) out.push(m[1])
  return out
}

function parseTerm(tok: string): Filter {
  const negate = tok.startsWith('-')
  const body = negate ? tok.slice(1) : tok
  const i = body.indexOf(':')
  if (i <= 0) throw new Error(t('core.views.badFilter', { term: tok }))
  const field = body.slice(0, i).toLowerCase() as CondField
  if (!COND_FIELDS.includes(field)) throw new Error(t('core.views.badField', { field, fields: COND_FIELDS.join(' ') }))
  let raw = body.slice(i + 1)
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1)
  const value = field === 'title' ? [raw] : raw.split(',').map((v) => v.trim()).filter(Boolean)
  if (!value.length) throw new Error(t('core.views.badFilter', { term: tok }))
  if (field === 'is') for (const v of value) if (!(IS_VALUES as readonly string[]).includes(v)) throw new Error(t('core.views.badIs', { value: v, values: IS_VALUES.join(' ') }))
  const cond: Cond = { field, value }
  return negate ? { not: cond } : cond
}

/** The text form of a filter — the inverse of `parseFilter` for anything it produced. */
export function filterText(f: Filter | undefined): string {
  if (!f) return ''
  if ('any' in f) return f.any.map(filterText).join(' or ')
  if ('all' in f) return f.all.map((x) => ('any' in x ? `(${filterText(x)})` : filterText(x))).join(' ')
  if ('not' in f) return `-${filterText(f.not)}`
  const v = f.field === 'title' ? `"${f.value[0]}"` : f.value.join(',')
  return `${f.field}:${v}`
}

// ---------------------------------------------------------------------------
// Checking a definition (from the CLI, the app, or a hand-edited views.json)
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function validateView(v: unknown): ViewDef {
  if (!v || typeof v !== 'object') throw new Error(t('core.views.notAnObject'))
  const d = v as Record<string, unknown>
  const id = String(d.id ?? '')
  if (!ID_RE.test(id)) throw new Error(t('core.views.badId', { id }))
  const layout = d.layout ?? 'list'
  if (!LAYOUTS.includes(layout as never)) throw new Error(t('core.views.badValue', { key: 'layout', value: String(layout), values: LAYOUTS.join(' | ') }))
  const out: ViewDef = { id, layout: layout as ViewDef['layout'] }
  if (d.name !== undefined) {
    if (typeof d.name === 'string' && d.name.trim()) out.name = d.name.trim()
    else if (d.name && typeof d.name === 'object') out.name = Object.fromEntries(Object.entries(d.name as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
    else throw new Error(t('core.views.badValue', { key: 'name', value: String(d.name), values: '"…" | { "en": "…" }' }))
  }
  if (d.icon !== undefined) out.icon = String(d.icon)
  if (d.filter !== undefined && d.filter !== null && d.filter !== '') out.filter = typeof d.filter === 'string' ? parseFilter(d.filter) : checkFilter(d.filter)
  const pick = <K extends 'group' | 'finished' | 'deferred'>(key: K, values: readonly string[]) => {
    if (d[key] === undefined) return
    if (!values.includes(String(d[key]))) throw new Error(t('core.views.badValue', { key, value: String(d[key]), values: values.join(' | ') }))
    out[key] = d[key] as ViewDef[K]
  }
  pick('group', GROUPS)
  pick('finished', SHOW)
  pick('deferred', SHOW)
  if (d.sort !== undefined) {
    // `pin` was manual order's name while it only meant top / bottom.
    const keys = (Array.isArray(d.sort) ? d.sort : String(d.sort).split(/[,\s]+/)).map(String).filter(Boolean).map((k) => k.replace(/^(-?)pin$/, '$1manual'))
    for (const k of keys) if (!(SORT_FIELDS as readonly string[]).includes(k.replace(/^-/, ''))) throw new Error(t('core.views.badValue', { key: 'sort', value: k, values: SORT_FIELDS.join(' ') }))
    out.sort = keys as SortKey[]
  }
  if (d.window !== undefined && d.window !== null) {
    const w = d.window as Record<string, unknown>
    const num = (x: unknown) => (x === undefined ? undefined : Number(x))
    out.window = { ...(num(w.days) ? { days: num(w.days) } : {}), ...(num(w.max) ? { max: num(w.max) } : {}) }
  }
  if (d.count !== undefined) out.count = Boolean(d.count)
  return out
}

function checkFilter(f: unknown): Filter {
  if (!f || typeof f !== 'object') throw new Error(t('core.views.badFilter', { term: JSON.stringify(f) }))
  const o = f as Record<string, unknown>
  if (Array.isArray(o.any)) return { any: o.any.map(checkFilter) }
  if (Array.isArray(o.all)) return { all: o.all.map(checkFilter) }
  if (o.not !== undefined) return { not: checkFilter(o.not) }
  const field = String(o.field) as CondField
  if (!COND_FIELDS.includes(field)) throw new Error(t('core.views.badField', { field, fields: COND_FIELDS.join(' ') }))
  const value = (Array.isArray(o.value) ? o.value : [o.value]).map(String)
  return { field, value }
}

// ---------------------------------------------------------------------------
// Storage: $NODDIT_HOME/views.json — { "views": [ViewDef…] }, the whole list in tab order.
// No file means the built-ins.
// ---------------------------------------------------------------------------

export function viewsPath(env: NodeJS.ProcessEnv = process.env): string {
  return nodditEnv('VIEWS', env) || join(nodditEnv('HOME', env) || join(homedir(), '.decs'), 'views.json')
}

let cache: { path: string; stamp: string; views: ViewDef[] } | undefined

/** The user's views in tab order; the built-ins when there is no file, or it can't be read. */
export function loadViews(path = viewsPath()): ViewDef[] {
  let stamp = ''
  try {
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return [...BUILTIN_VIEWS]
  }
  if (cache && cache.path === path && cache.stamp === stamp) return cache.views
  let views: ViewDef[]
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { views?: unknown[] }
    views = (raw.views ?? []).flatMap((v) => {
      try {
        return [validateView(v)]
      } catch {
        return []
      }
    })
    if (!views.length) views = [...BUILTIN_VIEWS]
  } catch {
    views = [...BUILTIN_VIEWS]
  }
  cache = { path, stamp, views }
  return views
}

export function saveViews(views: ViewDef[], path = viewsPath()): void {
  if (!views.length) throw new Error(t('core.views.lastOne'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, `${JSON.stringify({ views }, null, 2)}\n`)
  cache = undefined
}

/** Back to the built-ins: every view (the file goes), or the one built-in `id` (put back where it was, as shipped). */
export function resetViews(id?: string, path = viewsPath()): ViewDef[] {
  if (id === undefined) {
    if (existsSync(path)) rmSync(path)
    cache = undefined
    return [...BUILTIN_VIEWS]
  }
  const shipped = builtinView(id)
  if (!shipped) throw new Error(t('core.views.notBuiltin', { id, ids: BUILTIN_IDS.join(' ') }))
  const views = loadViews(path)
  const at = views.findIndex((v) => v.id === id)
  const next = at === -1 ? insertInBuiltinOrder(views, shipped) : views.map((v, i) => (i === at ? shipped : v))
  saveViews(next, path)
  return next
}

/** A restored built-in goes back after the built-in that precedes it in the shipped order, if that one is still there. */
function insertInBuiltinOrder(views: ViewDef[], shipped: ViewDef): ViewDef[] {
  const before = BUILTIN_IDS.slice(0, BUILTIN_IDS.indexOf(shipped.id)).reverse()
  const anchor = before.map((b) => views.findIndex((v) => v.id === b)).find((i) => i !== -1)
  const out = [...views]
  out.splice(anchor === undefined ? 0 : anchor + 1, 0, shipped)
  return out
}

/** Whether a view is a built-in exactly as shipped. */
export function isPristine(v: ViewDef): boolean {
  const shipped = builtinView(v.id)
  return Boolean(shipped) && canonical(v) === canonical(shipped)
}

/** JSON with keys sorted, so two definitions compare by content, not by key order. */
const canonical = (x: unknown): string =>
  JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v))
