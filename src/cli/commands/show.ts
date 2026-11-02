import { bool, one, type Args } from '../args.ts'
import { resolveStore } from '../context.ts'
import { alignRow, summaryLine, toJSON } from '../../core/render.ts'
import { isFlagged } from '../../core/order.ts'
import { isStale } from '../../core/staleness.ts'
import { deferHidden, isDeferred, statusLabel } from '../../core/status.ts'
import type { ListFilter } from '../../core/store.ts'
import { ITEM_STATUSES, type ItemStatus } from '../../core/types.ts'
import { lang, loadResources, t, type Lang } from '../../i18n/index.ts'

const help = () => t('cli.help.show')

const SCOPES: Record<string, ListFilter> = {
  open: { status: 'open', archived: false },
  answered: { status: 'answered', archived: 'all' },
  active: { status: 'all', archived: false },
  archived: { status: 'all', archived: true },
  all: { status: 'all', archived: 'all' },
  fyi: { status: 'all', archived: 'all' },
  deferred: { status: 'all', archived: false },
  flagged: { status: 'all', archived: false },
}

const statusWordCache = new Map<Lang, Record<string, ItemStatus>>()

/** `{ 待决策: 'needs_decision', ... }` for one language's own status labels. */
function statusWordsOf(lng: Lang): Record<string, ItemStatus> {
  const cached = statusWordCache.get(lng)
  if (cached) return cached
  const status = (loadResources(lng) as { common?: { status?: Record<string, string> } }).common?.status ?? {}
  const out: Record<string, ItemStatus> = {}
  for (const [key, label] of Object.entries(status)) out[label] = key as ItemStatus
  statusWordCache.set(lng, out)
  return out
}

/**
 * A scope word as a status: the bare key (`needs_decision`), the canonical
 * Chinese label (`待决策` — accepted whatever the UI language is, since that
 * is what every decisions/*.md file and every existing script already
 * types), or the current UI language's own label.
 */
function resolveStatusWord(raw: string): ItemStatus | undefined {
  if ((ITEM_STATUSES as readonly string[]).includes(raw)) return raw as ItemStatus
  return statusWordsOf('zh-Hans')[raw] ?? statusWordsOf(lang())[raw]
}

export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const staleOnly = bool(args, 'stale')
  // `--stale` only means anything among in_progress nodes, which `open`
  // (needs_decision only) never has — default to `active` so a bare
  // `decs show --stale` does the obvious thing instead of always being empty.
  const given = args._[0] ?? (staleOnly ? 'active' : 'open')
  const scope = given === 'defer' ? 'deferred' : given
  const statusWord = resolveStatusWord(scope)
  const isState = statusWord !== undefined
  const filter = isState ? { states: [statusWord], archived: 'all' as const } : SCOPES[scope]
  if (!filter) throw new Error(`${t('cli.show.unknownScope', { scope })}\n\n${help()}`)

  const store = resolveStore(args, { allowRegistry: true })
  const items = store.all()
  const hidden = deferHidden(items)
  const list = store
    .list({ ...filter, author: one(args, 'author', 'a'), project: one(args, 'project', 'p') })
    // An fyi needs nothing from anyone; it only shows when asked for.
    .filter((d) => (scope === 'fyi' ? d.kind === 'fyi' : scope === 'all' || scope === 'deferred' || isState || d.kind !== 'fyi'))
    .filter((d) => (staleOnly ? isStale(d) : true))
    // 延迟 is put off: not 待决 for the owner; listed on its own under `deferred`.
    .filter((d) => (scope === 'deferred' ? isDeferred(d) : scope === 'open' ? !hidden(d) : true))
    // What the owner marked important or as a milestone, still live and not put off.
    .filter((d) => (scope === 'flagged' ? isFlagged(d) && !hidden(d) : true))

  if (bool(args, 'json')) {
    console.log(JSON.stringify(list.map(toJSON)))
    return 0
  }
  if (!list.length) {
    console.log(
      staleOnly
        ? t('cli.show.noneStale')
        : scope === 'deferred'
          ? t('cli.show.noneDeferred')
          : scope === 'open'
            ? t('cli.show.noneOpen')
            : isState
              ? t('cli.show.noneWithStatus', { status: statusLabel(statusWord!) })
              : t('cli.show.noneMatching'),
    )
    return 0
  }
  const multi = store.layouts.length > 1
  for (const d of list) console.log(alignRow(summaryLine(d, { project: multi })))
  return 0
}
