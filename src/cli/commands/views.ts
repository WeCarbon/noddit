import {
  BUILTIN_IDS, COND_FIELDS, GROUPS, IS_VALUES, LAYOUTS, SHOW, SORT_FIELDS, builtinView, filterText, isPristine, loadViews, resetViews, saveViews,
  validateView, viewsPath, type ViewDef,
} from '../../core/view-defs.ts'
import { viewLabel } from '../../tui/views.ts'
import { bool, one, type Args } from '../args.ts'
import { t } from '../../i18n/index.ts'

/** A view as `nod views --json` and `nod bench --json` hand it to a window. */
export function viewJson(def: ViewDef): Record<string, unknown> {
  return { ...def, label: viewLabel(def), filter_text: filterText(def.filter), builtin: Boolean(builtinView(def.id)), pristine: isPristine(def) }
}

/** What a view editor can offer: every field, value and key a definition may use. */
export const VIEW_SCHEMA = {
  layouts: LAYOUTS,
  groups: GROUPS,
  finished: SHOW,
  deferred: SHOW,
  sort: SORT_FIELDS,
  filter_fields: COND_FIELDS,
  is_values: IS_VALUES,
  builtin: BUILTIN_IDS,
}

/**
 * `nod views` lists the bench's tabs; `nod view add|edit|rm|reset|move|show`
 * changes them. Stored per person in `$NODDIT_HOME/views.json`.
 */
export function run(args: Args, verb: string): number {
  if (bool(args, 'help', 'h')) {
    console.log(t(verb === 'views' ? 'cli.help.views' : 'cli.help.view'))
    return 0
  }
  if (verb === 'views') return list(args)
  const [sub, id, ...rest] = args._
  switch (sub) {
    case undefined:
    case 'list':
      return list(args)
    case 'show':
      return show(args, need(id))
    case 'add':
      return add(args, need(id))
    case 'edit':
      return edit(args, need(id))
    case 'rm':
    case 'remove':
    case 'delete':
      return remove(args, [need(id), ...rest])
    case 'reset':
      return reset(args, id)
    case 'move':
      return move(args, need(id), rest[0])
    default:
      throw new Error(`${t('cli.view.badVerb', { verb: sub })}\n\n${t('cli.help.view')}`)
  }
}

const need = (id: string | undefined) => {
  if (!id) throw new Error(`${t('cli.view.whichView')}\n\n${t('cli.help.view')}`)
  return id
}

function list(args: Args): number {
  const views = loadViews()
  if (bool(args, 'json')) {
    console.log(JSON.stringify({ file: viewsPath(), views: views.map(viewJson), schema: VIEW_SCHEMA }))
    return 0
  }
  for (const [i, v] of views.entries()) {
    const how = v.layout === 'tree' ? t('cli.view.tree') : t('cli.view.list', { group: v.group ?? 'none', sort: (v.sort ?? ['bench']).join(',') })
    const mark = builtinView(v.id) ? (isPristine(v) ? '' : ` ${t('cli.view.edited')}`) : ` ${t('cli.view.yours')}`
    console.log(`${i + 1}. ${v.id.padEnd(10)} ${viewLabel(v)}${mark} · ${how}${v.filter ? ` · ${filterText(v.filter)}` : ''}`)
  }
  return 0
}

function find(id: string): { views: ViewDef[]; at: number } {
  const views = loadViews()
  return { views, at: views.findIndex((v) => v.id === id) }
}

function show(args: Args, id: string): number {
  const { views, at } = find(id)
  const def = views[at] ?? builtinView(id)
  if (!def) throw new Error(t('cli.view.noSuch', { id, ids: views.map((v) => v.id).join(' ') }))
  console.log(bool(args, 'json') ? JSON.stringify(viewJson(def)) : JSON.stringify(def, null, 2))
  return 0
}

/** The fields the flags set, laid over `base` — `--def '<json>'` first, then each flag. */
function fromFlags(args: Args, base: Record<string, unknown>): ViewDef {
  const out: Record<string, unknown> = { ...base }
  const def = one(args, 'def')
  if (def) Object.assign(out, JSON.parse(def) as Record<string, unknown>)
  for (const key of ['name', 'icon', 'filter', 'layout', 'group', 'sort', 'finished', 'deferred'] as const) {
    const v = one(args, key)
    if (v === undefined) continue
    if (v === '' && (key === 'name' || key === 'icon' || key === 'filter')) delete out[key]
    else out[key] = v
  }
  const days = one(args, 'window-days')
  const max = one(args, 'window-max')
  if (days !== undefined || max !== undefined) out.window = { ...(out.window as object), ...(days ? { days: Number(days) } : {}), ...(max ? { max: Number(max) } : {}) }
  const count = one(args, 'count')
  if (count !== undefined) out.count = !/^(no|false|0|off)$/i.test(count)
  return validateView(out)
}

function report(args: Args, def: ViewDef, key: string): number {
  if (bool(args, 'json')) console.log(JSON.stringify(viewJson(def)))
  else console.log(t(key, { id: def.id, label: viewLabel(def) }))
  return 0
}

function add(args: Args, id: string): number {
  const { views, at } = find(id)
  if (at !== -1) throw new Error(t('cli.view.exists', { id }))
  const def = fromFlags(args, { id, layout: 'list', sort: ['bench'] })
  const pos = one(args, 'at')
  const next = [...views]
  next.splice(pos ? Math.max(0, Math.min(next.length, Number(pos) - 1)) : next.length, 0, def)
  saveViews(next)
  return report(args, def, 'cli.view.added')
}

function edit(args: Args, id: string): number {
  const { views, at } = find(id)
  const current = views[at]
  if (!current) throw new Error(t('cli.view.noSuch', { id, ids: views.map((v) => v.id).join(' ') }))
  const def = fromFlags(args, current as unknown as Record<string, unknown>)
  if (def.id !== id && views.some((v) => v.id === def.id)) throw new Error(t('cli.view.exists', { id: def.id }))
  saveViews(views.map((v, i) => (i === at ? def : v)))
  return report(args, def, 'cli.view.edited_done')
}

function remove(args: Args, ids: string[]): number {
  let views = loadViews()
  for (const id of ids) {
    if (!views.some((v) => v.id === id)) throw new Error(t('cli.view.noSuch', { id, ids: views.map((v) => v.id).join(' ') }))
    views = views.filter((v) => v.id !== id)
  }
  if (!views.length) throw new Error(t('core.views.lastOne'))
  saveViews(views)
  if (bool(args, 'json')) console.log(JSON.stringify({ removed: ids, views: views.map(viewJson) }))
  else console.log(t('cli.view.removed', { ids: ids.join(' ') }))
  return 0
}

function reset(args: Args, id: string | undefined): number {
  const views = resetViews(id)
  if (bool(args, 'json')) console.log(JSON.stringify({ reset: id ?? 'all', views: views.map(viewJson) }))
  else console.log(id ? t('cli.view.resetOne', { id }) : t('cli.view.resetAll'))
  return 0
}

function move(args: Args, id: string, to: string | undefined): number {
  const n = Number(to)
  if (!Number.isInteger(n) || n < 1) throw new Error(t('cli.view.badPosition', { value: to ?? '' }))
  const { views, at } = find(id)
  if (at === -1) throw new Error(t('cli.view.noSuch', { id, ids: views.map((v) => v.id).join(' ') }))
  const next = [...views]
  const [def] = next.splice(at, 1)
  next.splice(Math.min(next.length, n - 1), 0, def)
  saveViews(next)
  if (bool(args, 'json')) console.log(JSON.stringify({ views: next.map(viewJson) }))
  else console.log(t('cli.view.moved', { id, position: Math.min(next.length, n) }))
  return 0
}
