import { watch, type FSWatcher } from 'node:fs'
import { bool, one, type Args } from '../args.ts'
import { readStdin, resolveAuthor, resolveStore } from '../context.ts'
import { alignRow, bold, cyan, dim, green, yellow } from '../../core/render.ts'
import { fromNow } from '../../i18n/time.ts'
import { t } from '../../i18n/index.ts'
import type { Layout } from '../../core/paths.ts'
import type { Store } from '../../core/store.ts'
import {
  ackSourceItems,
  findSourceLayouts,
  heartbeatSource,
  listSources,
  parseIncomingItemsJsonl,
  pushSourceItem,
  readSourceState,
  registerSource,
  sourceEventsSince,
  syncSourceItems,
  unhandledSourceItems,
  type SourceEventWithProject,
  type SourceItem,
  type SourceSummary,
} from '../../core/sources.ts'
import { setSourceSync, sourceSyncOf, syncRunStateOf } from '../../core/source-sync.ts'

const help = () => t('cli.help.source')

function run_(args: Args): Promise<number> | number {
  const [verb, ...rest] = args._
  if (!verb || verb === 'help' || bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const sub = { ...args, _: rest }
  switch (verb) {
    case 'register':
      return register(sub)
    case 'sync':
      return sync(sub)
    case 'push':
      return push(sub)
    case 'heartbeat':
      return heartbeat(sub)
    case 'list':
      return list(sub)
    case 'items':
      return items(sub)
    case 'ack':
      return ack(sub)
    case 'wait':
      return wait(sub)
    case 'events':
      return events(sub)
    default:
      throw new Error(`${t('cli.source.unknownSubcommand', { verb })}\n\n${help()}`)
  }
}

export const run = run_

// ---------------------------------------------------------------------------
// Helpers shared by several subcommands
// ---------------------------------------------------------------------------

/** Resolves a single project's layout — register/sync/push/heartbeat/ack all write, so, like `decs add`, they never fall back to the multi-project registry. */
function singleLayout(args: Args): Layout {
  return resolveStore(args).primary
}

/** Finds the one layout (within a possibly multi-project store) that has `name` registered. */
function pickLayout(store: Store, name: string, args: Args): Layout {
  const matches = findSourceLayouts(store, name)
  if (!matches.length) throw new Error(t('cli.source.notRegistered', { name }))
  if (matches.length === 1) return matches[0]
  const want = one(args, 'project', 'p')
  if (want) {
    const m = matches.find((l) => l.projectRoot.endsWith(`/${want}`) || l.projectRoot === want)
    if (m) return m
  }
  throw new Error(t('cli.source.ambiguousProject', { name, projects: matches.map((l) => l.projectRoot).join(', ') }))
}

function label(s: { project: string; projectLetter: string; name: string }, multi: boolean): string {
  return multi ? `${s.projectLetter}·${s.name}` : s.name
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

function register(args: Args): number {
  const [name] = args._
  if (!name) throw new Error(t('cli.source.whichSourceRegister'))
  const layout = singleLayout(args)
  const cfg = registerSource(layout, {
    name,
    title: one(args, 'title'),
    kind: one(args, 'kind'),
    adapter: one(args, 'adapter'),
    ownerAgent: one(args, 'owner-agent'),
    staleAfter: one(args, 'stale-after'),
    notes: one(args, 'notes'),
  })
  const syncCmd = one(args, 'sync-cmd')
  const every = one(args, 'every')
  let sync = sourceSyncOf(layout, name) ?? null
  if (bool(args, 'no-sync-cmd')) sync = setSourceSync(layout, name, null)
  else if (syncCmd !== undefined) sync = setSourceSync(layout, name, { cmd: syncCmd, every })
  else if (every !== undefined) {
    if (!sync) throw new Error(t('cli.source.everyNeedsSyncCmd'))
    sync = setSourceSync(layout, name, { cmd: sync.cmd, every })
  }
  if (bool(args, 'json')) {
    console.log(JSON.stringify({ ...cfg, sync: sync ?? undefined }))
  } else {
    console.log(t('cli.source.registered', { name: cfg.name, title: cfg.title, adapter: cfg.adapter ? t('cli.source.adapterSuffix', { adapter: cfg.adapter }) : '' }))
    if (bool(args, 'no-sync-cmd')) console.log(t('cli.source.syncRemoved', { name }))
    else if (sync && (syncCmd !== undefined || every !== undefined)) console.log(t('cli.source.syncSaved', { cmd: sync.cmd, every: sync.every }))
  }
  return 0
}

// ---------------------------------------------------------------------------
// sync — full snapshot from stdin
// ---------------------------------------------------------------------------

async function sync(args: Args): Promise<number> {
  const [name] = args._
  if (!name) throw new Error(t('cli.source.whichSourceSync'))
  const layout = singleLayout(args)
  const text = await readStdin()
  const items = parseIncomingItemsJsonl(text)
  const diff = syncSourceItems(layout, name, items)

  if (bool(args, 'json')) {
    console.log(JSON.stringify(diff))
  } else {
    console.log(
      t('cli.source.syncResult', { name, new: diff.new.length, changed: diff.changed.length, gone: diff.gone.length, unchanged: diff.unchanged }),
    )
  }
  return 0
}

// ---------------------------------------------------------------------------
// push — one item
// ---------------------------------------------------------------------------

function push(args: Args): number {
  const [name] = args._
  if (!name) throw new Error(t('cli.source.whichSourcePush'))
  const id = one(args, 'id')
  const title = one(args, 'title')
  if (!id || !title) throw new Error(t('cli.source.pushNeedsIdTitle'))
  const layout = singleLayout(args)
  const { kind, item } = pushSourceItem(layout, name, {
    id,
    title,
    url: one(args, 'url'),
    state: one(args, 'state'),
    from: one(args, 'from'),
  })

  if (bool(args, 'json')) console.log(JSON.stringify({ kind, item }))
  else console.log(t('cli.source.pushed', { name, id: item.id, kind }))
  return 0
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

function heartbeat(args: Args): number {
  const [name] = args._
  if (!name) throw new Error(t('cli.source.whichSourceHeartbeat'))
  const layout = singleLayout(args)
  const at = heartbeatSource(layout, name)
  if (bool(args, 'json')) console.log(JSON.stringify({ name, heartbeatAt: at }))
  else console.log(t('cli.source.heartbeat', { name, at }))
  return 0
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

type ListedSource = SourceSummary & { sync?: { cmd: string; every: string; lastError?: string } }

function summaryLine(s: ListedSource, multi: boolean): string {
  const bits = [cyan(label(s, multi)), s.title]
  const tail: string[] = []
  if (s.cleared) tail.push(green(t('cli.source.cleared')))
  else {
    if (s.unhandled) tail.push(yellow(t('cli.source.unhandled', { n: s.unhandled })))
    for (const [bucket, n] of Object.entries(s.buckets)) {
      if (bucket === 'unhandled') continue
      tail.push(t('cli.source.waitingOnBucket', { bucket, n }))
    }
  }
  if (s.sync) tail.push(s.sync.lastError ? yellow(t('cli.source.autoSyncFailed', { every: s.sync.every, error: s.sync.lastError })) : dim(t('cli.source.autoSync', { every: s.sync.every })))
  if (s.stale) tail.push(yellow(t('cli.check.adapterMaybeDown', { heartbeat: s.heartbeatAt ? ` ${fromNow(s.heartbeatAt)}` : t('cli.check.neverHeartbeat') })))
  else if (s.heartbeatAt) tail.push(dim(t('cli.source.heartbeatAgo', { ago: fromNow(s.heartbeatAt) })))
  return `${bits.join('  ')}${tail.length ? dim('  — ') + tail.join(' · ') : ''}`
}

function list(args: Args): number {
  const store = resolveStore(args, { allowRegistry: true })
  const layoutByProject = new Map(store.layouts.map((l) => [store.projectName(l), l]))
  let summaries: ListedSource[] = listSources(store).map((s) => {
    const layout = layoutByProject.get(s.project)
    const sync = layout ? sourceSyncOf(layout, s.name) : undefined
    if (!sync || !layout) return s
    const lastError = syncRunStateOf(layout, s.name).lastError
    return { ...s, sync: { ...sync, ...(lastError ? { lastError } : {}) } }
  })
  if (bool(args, 'stale')) summaries = summaries.filter((s) => s.stale)
  const multi = store.layouts.length > 1

  if (bool(args, 'json')) {
    console.log(JSON.stringify(summaries))
    return 0
  }
  if (!summaries.length) {
    console.log(t('cli.source.noneRegistered'))
    return 0
  }
  for (const s of summaries) console.log(summaryLine(s, multi))
  return 0
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

function itemLine(it: SourceItem): string {
  const bits = [cyan(`#${it.id}`), it.title]
  if (it.url) bits.push(dim(it.url))
  const tail: string[] = []
  if (it.gone) tail.push(dim(t('cli.source.gone')))
  if (it.handled) tail.push(green(t('cli.source.handled')))
  else tail.push(yellow(t('cli.source.unhandledWord')))
  if (it.waitingOn) tail.push(t('cli.source.waitingOnWho', { who: it.waitingOn }))
  if (it.from) tail.push(dim(t('cli.source.from', { from: it.from })))
  if (it.handledNote) tail.push(dim(it.handledNote))
  return `${bits.join('  ')}${dim('  — ')}${tail.join(' · ')}`
}

function items(args: Args): number {
  const [name] = args._
  if (!name) throw new Error(t('cli.source.whichSourceItems'))
  const store = resolveStore(args, { allowRegistry: true })
  const layout = pickLayout(store, name, args)
  const state = readSourceState(layout, name)
  let list = Object.values(state.items)
  if (bool(args, 'unhandled')) list = list.filter((i) => !i.handled)
  list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

  if (bool(args, 'json')) {
    console.log(JSON.stringify(list))
    return 0
  }
  if (!list.length) {
    console.log(bool(args, 'unhandled') ? t('cli.source.noneUnhandled', { name }) : t('cli.source.noItems', { name }))
    return 0
  }
  for (const it of list) console.log(alignRow(itemLine(it)))
  return 0
}

// ---------------------------------------------------------------------------
// ack
// ---------------------------------------------------------------------------

function ack(args: Args): number {
  const [name, ...ids] = args._
  if (!name || !ids.length) throw new Error(t('cli.source.ackUsage'))
  const store = resolveStore(args, { allowRegistry: true })
  const layout = pickLayout(store, name, args)
  const by = one(args, 'by') ?? resolveAuthor(args)
  const acked = ackSourceItems(layout, name, ids, {
    by,
    note: one(args, 'note'),
    waitingOn: one(args, 'waiting-on'),
  })

  if (bool(args, 'json')) console.log(JSON.stringify(acked))
  else {
    for (const it of acked) {
      console.log(t('cli.source.acked', { name, id: it.id, waitingOn: it.waitingOn ? t('cli.source.waitingOnSuffix', { who: it.waitingOn }) : '' }))
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// wait — blocks until an unhandled new/changed item exists, then exits
// ---------------------------------------------------------------------------

function watchSources(store: Store, onChange: () => void): () => void {
  const watchers: FSWatcher[] = []
  let debounce: NodeJS.Timeout | undefined
  const nudge = () => {
    clearTimeout(debounce)
    debounce = setTimeout(onChange, 150)
  }
  for (const l of store.layouts) {
    try {
      watchers.push(watch(l.root, { recursive: true }, nudge))
    } catch {
      /* the poll still covers it — recursive fs.watch is not available everywhere */
    }
  }
  const timer = setInterval(onChange, 2000)
  return () => {
    clearTimeout(debounce)
    clearInterval(timer)
    for (const w of watchers) w.close()
  }
}

function wait(args: Args): Promise<number> {
  const [name] = args._
  const store = resolveStore(args, { allowRegistry: true })
  const asJson = bool(args, 'json')
  const timeoutSec = Number(one(args, 'timeout') ?? 0)
  const multi = store.layouts.length > 1

  const peek = () => unhandledSourceItems(store, name)

  const report = (pending: ReturnType<typeof peek>) => {
    const since = new Date().toISOString()
    const bySource = new Map<string, number>()
    for (const p of pending) {
      const key = label(p, multi)
      bySource.set(key, (bySource.get(key) ?? 0) + 1)
    }
    if (asJson) {
      console.log(
        JSON.stringify({
          updates: true,
          count_at_wake: pending.length,
          sources: [...bySource.entries()].map(([source, unhandled]) => ({ source, unhandled })),
          since,
        }),
      )
    } else {
      const parts = [...bySource.entries()].map(([k, n]) => `${k} +${n}`).join(' · ')
      console.log(`${cyan(t('cli.wait.updates'))}${dim(` ${parts}`)}`)
      console.log(dim(t('cli.source.waitHint', { name: name ?? '<name>', since })))
    }
  }

  const now = peek()
  if (now.length) {
    report(now)
    return Promise.resolve(0)
  }

  return new Promise<number>((resolve) => {
    const finish = (code: number) => {
      stop()
      clearTimeout(timer)
      resolve(code)
    }
    const check = () => {
      const pending = peek()
      if (!pending.length) return
      report(pending)
      finish(0)
    }
    const stop = watchSources(store, check)
    const timer = timeoutSec
      ? setTimeout(() => {
          console.error(t('cli.source.waitTimedOut', { seconds: timeoutSec }))
          finish(2)
        }, timeoutSec * 1000)
      : undefined
  })
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

function eventLine(e: SourceEventWithProject, multi: boolean): string {
  const mark = e.kind === 'new' ? yellow('＋') : e.kind === 'gone' ? dim('－') : cyan('~')
  const src = multi ? `${e.projectLetter}·${e.source}` : e.source
  return `${dim(e.at)} ${mark} ${bold(src)} #${e.id} ${e.title}`
}

function events(args: Args): number {
  const [name] = args._
  const store = resolveStore(args, { allowRegistry: true })
  const since = one(args, 'since')
  const list = sourceEventsSince(store, since, { name: name ?? one(args, 'source') })
  const multi = store.layouts.length > 1

  if (bool(args, 'json')) {
    console.log(JSON.stringify(list))
    return 0
  }
  if (!list.length) {
    console.log(since ? t('cli.changes.noneSince', { since }) : t('cli.source.noEventsRecorded'))
    return 0
  }
  for (const e of list) console.log(eventLine(e, multi))
  return 0
}
