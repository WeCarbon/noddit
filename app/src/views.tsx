import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, Bell, Bookmark, Bot, Calendar, CheckSquare, Clock, Eye, Filter, Flag, Folder, Hand, History, Hourglass, Inbox,
  Layers, ListTodo, ListTree, Plus, RotateCcw, Star, Tag, Target, Trash2, User, Zap, type LucideIcon,
} from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import * as api from './backend.ts'
import { useDialogFocus } from './focus.ts'
import { s } from './strings.ts'

/** The icons a view can take: lucide's names, as views.json stores them. */
export const VIEW_ICONS: Record<string, LucideIcon> = {
  'list-todo': ListTodo, activity: Activity, hand: Hand, 'list-tree': ListTree, hourglass: Hourglass, history: History, star: Star, flag: Flag,
  user: User, bot: Bot, inbox: Inbox, folder: Folder, calendar: Calendar, clock: Clock, tag: Tag, zap: Zap, target: Target, bookmark: Bookmark,
  'check-square': CheckSquare, eye: Eye, 'alert-triangle': AlertTriangle, layers: Layers, filter: Filter, bell: Bell,
}

export function ViewIcon({ name, size = 15, tone }: { name?: string | null; size?: number; tone?: string }) {
  const Icon = (name && VIEW_ICONS[name]) || ListTodo
  return <Icon size={size} strokeWidth={1.75} class={`ico line-ico ${tone ? `ico-${tone}` : ''}`} />
}

type Def = api.ViewDef

/**
 * The views in the sidebar, as data (`nod views`): add, rename, reorder, delete, and edit what
 * each one shows — a filter typed in nod's own words, tree or list, grouping, sort keys, what
 * happens to finished and deferred nodes. The count under the filter is a live preview.
 */
export function ViewEditor(p: { start?: string; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<api.ViewsList | null>(null)
  const [sel, setSel] = useState<string | null>(p.start ?? null)
  const [draft, setDraft] = useState<Def | null>(null)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDialogFocus(box)

  const load = async (pick?: string) => {
    const l = await api.viewsList()
    setList(l)
    const id = pick ?? sel ?? l.views[0]?.id ?? null
    setSel(id)
    const v = l.views.find((x) => x.id === id) ?? l.views[0]
    if (v) {
      setDraft(v)
      setName(typeof v.name === 'string' ? v.name : v.label)
    }
  }
  useEffect(() => void load().catch((e: Error) => setError(e.message)), [])

  // Live count for the filter and layout as they stand, a moment after the last change.
  useEffect(() => {
    if (!draft) return
    setPreview(null)
    const t = setTimeout(() => void api.previewView(draft).then(setPreview, () => setPreview(null)), 400)
    return () => clearTimeout(t)
  }, [draft?.filter_text, draft?.layout, draft?.finished, draft?.deferred, draft?.window?.days, draft?.window?.max])

  const act = async (fn: () => Promise<unknown>, pick?: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load(pick)
      p.onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const schema = list?.schema
  const v = list?.views.find((x) => x.id === sel)
  const idx = list?.views.findIndex((x) => x.id === sel) ?? -1
  const set = (patch: Partial<Def>) => draft && setDraft({ ...draft, ...patch })
  const changed = useMemo(() => {
    if (!draft || !v) return false
    const keys: (keyof Def)[] = ['icon', 'layout', 'group', 'sort', 'finished', 'deferred', 'window', 'count', 'filter_text']
    return keys.some((k) => JSON.stringify(draft[k] ?? null) !== JSON.stringify(v[k] ?? null)) || name !== (typeof v.name === 'string' ? v.name : v.label)
  }, [draft, v, name])

  const save = () =>
    draft &&
    act(() =>
      api.editView(draft.id, {
        icon: draft.icon,
        layout: draft.layout,
        group: draft.layout === 'list' ? draft.group : undefined,
        sort: draft.layout === 'list' ? draft.sort : undefined,
        finished: draft.finished,
        deferred: draft.deferred,
        window: draft.window,
        count: draft.count,
        filter: draft.filter_text ?? '',
        ...(v && name !== v.label ? { name } : {}),
      }),
    )
  const addView = () => {
    const taken = new Set(list?.views.map((x) => x.id))
    let n = 1
    while (taken.has(`view-${n}`)) n++
    const id = `view-${n}`
    void act(() => api.addView(id, { name: s('viewNewName'), icon: 'star', layout: 'list', group: 'project', sort: ['bench'], filter: 'flag:flagged' }), id)
  }

  if (!list || !draft || !schema) return null
  return (
    <div class="overlay" onClick={p.onClose}>
      <div class="view-editor" role="dialog" aria-label={s('viewEditorTitle')} ref={box} tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
        <aside class="ve-list">
          <div class="ve-head">{s('viewEditorTitle')}</div>
          {list.views.map((x) => (
            <button key={x.id} class={`ve-item ${x.id === sel ? 'on' : ''}`} onClick={() => void load(x.id)}>
              <ViewIcon name={x.icon} size={14} />
              <span class="ve-label">{x.label}</span>
              {!x.pristine && x.builtin && <span class="ve-dot" title={s('viewChanged')} />}
            </button>
          ))}
          <button class="ve-item add" onClick={addView} disabled={busy}>
            <Plus size={14} strokeWidth={1.75} />
            <span class="ve-label">{s('viewAdd')}</span>
          </button>
          <span class="grow" />
          <button class="ghost ve-reset" onClick={() => void act(() => api.resetViews())} disabled={busy}>
            <RotateCcw size={13} strokeWidth={1.75} />
            {s('viewResetAll')}
          </button>
        </aside>

        <section class="ve-form">
          <div class="ve-row">
            <input class="ve-name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label={s('viewName')} />
            <button class="ed-tool" title={s('viewMoveUp')} disabled={busy || idx <= 0} onClick={() => void act(() => api.moveView(draft.id, idx))}>
              <ArrowUp size={14} strokeWidth={1.75} />
            </button>
            <button class="ed-tool" title={s('viewMoveDown')} disabled={busy || idx >= list.views.length - 1} onClick={() => void act(() => api.moveView(draft.id, idx + 2))}>
              <ArrowDown size={14} strokeWidth={1.75} />
            </button>
            <button class="ed-tool danger" title={s('viewDelete')} disabled={busy || list.views.length < 2} onClick={() => void act(() => api.removeView(draft.id), list.views[idx === 0 ? 1 : idx - 1]?.id)}>
              <Trash2 size={14} strokeWidth={1.75} />
            </button>
          </div>

          <div class="ve-icons" role="radiogroup" aria-label={s('viewIcon')}>
            {Object.keys(VIEW_ICONS).map((k) => (
              <button key={k} role="radio" aria-checked={draft.icon === k} class={`ve-icon ${draft.icon === k ? 'on' : ''}`} onClick={() => set({ icon: k })} title={k}>
                <ViewIcon name={k} size={14} />
              </button>
            ))}
          </div>

          <label class="ve-field">
            <span>{s('viewFilter')}</span>
            <input class="ve-filter" value={draft.filter_text ?? ''} placeholder="state:in_progress assignee:human -is:deferred or flag:flagged" onInput={(e) => set({ filter_text: (e.target as HTMLInputElement).value })} spellcheck={false} />
            <span class="ve-preview">{preview === null ? '…' : s('viewMatches', { count: preview })}</span>
          </label>
          <p class="ve-hint">{s('viewFilterHint', { fields: schema.filter_fields.join(' '), is: schema.is_values.join(' ') })}</p>

          <div class="ve-grid">
            <Choice label={s('viewLayout')} value={draft.layout} options={schema.layouts} onPick={(x) => set({ layout: x as Def['layout'] })} />
            {draft.layout === 'list' && <Choice label={s('viewGroup')} value={draft.group ?? 'none'} options={schema.groups} onPick={(x) => set({ group: x })} />}
            <Choice label={s('viewFinished')} value={draft.finished ?? 'hide'} options={schema.finished.filter((x) => draft.layout === 'tree' || x !== 'fold')} onPick={(x) => set({ finished: x })} />
            <Choice label={s('viewDeferred')} value={draft.deferred ?? 'hide'} options={schema.deferred} onPick={(x) => set({ deferred: x })} />
          </div>

          {draft.layout === 'list' && (
            <div class="ve-field">
              <span>{s('viewSort')}</span>
              <div class="ve-sort">
                {(draft.sort ?? []).map((k, i) => (
                  <button
                    key={`${k}-${i}`}
                    class="qchip on"
                    title={s('viewSortHint')}
                    onClick={() => set({ sort: (draft.sort ?? []).map((x, j) => (j === i ? (x.startsWith('-') ? x.slice(1) : `-${x}`) : x)) })}
                    onContextMenu={(e) => (e.preventDefault(), set({ sort: (draft.sort ?? []).filter((_, j) => j !== i) }))}
                  >
                    {k.startsWith('-') ? `↓ ${k.slice(1)}` : `↑ ${k}`}
                  </button>
                ))}
                <select value="" onChange={(e) => (e.currentTarget as HTMLSelectElement).value && set({ sort: [...(draft.sort ?? []), (e.currentTarget as HTMLSelectElement).value] })}>
                  <option value="">{s('viewSortAdd')}</option>
                  {schema.sort.filter((k) => !(draft.sort ?? []).some((x) => x.replace(/^-/, '') === k)).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div class="ve-grid">
            {draft.layout === 'list' && (
              <label class="ve-field small">
                <span>{s('viewWindowDays')}</span>
                <input type="number" min={0} value={draft.window?.days ?? ''} onInput={(e) => set({ window: { ...draft.window, days: Number((e.target as HTMLInputElement).value) || undefined } })} />
              </label>
            )}
            <label class="ve-check">
              <input type="checkbox" checked={draft.count !== false} onChange={() => set({ count: draft.count === false })} />
              <span>{s('viewCount')}</span>
            </label>
          </div>

          {error && <p class="s-error">{error}</p>}
          <div class="sheet-footer">
            {v?.builtin && !v.pristine && (
              <button class="ghost" onClick={() => void act(() => api.resetViews(draft.id), draft.id)} disabled={busy}>
                {s('viewResetOne')}
              </button>
            )}
            <span class="grow" />
            <button class="ghost" onClick={p.onClose}>
              {s('cancel')}
            </button>
            <button class="primary" disabled={!changed || busy} onClick={() => void save()}>
              {s('viewSave')}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function Choice(p: { label: string; value: string; options: readonly string[]; onPick: (v: string) => void }) {
  return (
    <div class="ve-field small">
      <span>{p.label}</span>
      <div class="ve-seg">
        {p.options.map((o) => (
          <button key={o} class={o === p.value ? 'on' : ''} onClick={() => p.onPick(o)}>
            {s(`viewOpt_${o}` as never) || o}
          </button>
        ))}
      </div>
    </div>
  )
}
