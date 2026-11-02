import { staleTasksOf } from './checkins.ts'
import { compareUrgency } from './order.ts'
import { refOf } from './ref.ts'
import { buildSchedule, dependentsOf, findCycles, type Cycle, type ScheduleRow } from './sequence.ts'
import { deferHidden } from './status.ts'
import { isStale, minutesSince } from './staleness.ts'
import { listSources, type SourceSummary } from './sources.ts'
import type { Store } from './store.ts'
import { projectSessions } from './listeners.ts'
import type { Decision as Item } from './types.ts'

export type { SourceSummary }

/**
 * Three sections the bench renders in one screen: what needs a decision,
 * whether every external source (issues/mail/feedback) is cleared, and the
 * planned order of open work. No `decs status` command — this belongs in
 * `decs bench`.
 */

export interface NeedsOwnerRow {
  id: number
  project: string
  ref: string
  title: string
  urgency: string
  /** Nodes that transitively depend on this one — "不上线的话，下面这些都卡着". */
  blocks: { id: number; ref: string; title: string }[]
}

export interface InProgressRow {
  id: number
  project: string
  ref: string
  title: string
  progress?: number
  progressMsg?: string
  stale: boolean
  /** `core/checkins.ts`: asked 3 times with no reply. */
  checkinUnanswered: boolean
  minutesSinceUpdate: number
}

export interface Overview {
  /** §1: what the owner needs to rule on, most urgent first, with what each blocks. */
  needsOwner: NeedsOwnerRow[]
  /** What is running right now, with progress and staleness. */
  inProgress: InProgressRow[]
  /** §3: the planned order of open nodes. */
  schedule: ScheduleRow[]
  /** Answered but not yet collected (`state === 'decided'`) — "已决策待 AI 取走". */
  decidedNotCollected: number
  /** issues/mail/feedback cleared? One row per registered source
   *  (`decs source list`'s data); `stale` means the adapter probably stopped. */
  sources: SourceSummary[]
  /** `after` dependency cycles — `decs check` reports the same list as errors. */
  cycles: Cycle[][]
  /** Per project: is a session's `nod monitor` running there (see core/listeners.ts)? */
  sessions: ProjectSessions[]
  /** N47: not_started, not deferred — neither waiting on a decision nor being worked on. */
  staleTasks: number
}

export type ProjectSessions = ReturnType<typeof projectSessions>[number]

export function buildOverview(items: Item[], now = Date.now(), sources: SourceSummary[] = [], sessions: ProjectSessions[] = []): Overview {
  // 延迟 nodes (and their subtrees) are put off: not asked of the owner, not "running".
  const hidden = deferHidden(items)
  const needsOwner = items
    .filter((i) => i.state === 'needs_decision' && !hidden(i))
    .sort(compareUrgency)
    .map((i) => ({
      id: i.id,
      project: i.project,
      ref: refOf(i),
      title: i.title,
      urgency: i.urgency ?? 'normal',
      blocks: dependentsOf(i, items).map((b) => ({ id: b.id, ref: refOf(b), title: b.title })),
    }))

  const inProgress = items
    .filter((i) => i.state === 'in_progress' && !hidden(i))
    .map((i) => ({
      id: i.id,
      project: i.project,
      ref: refOf(i),
      title: i.title,
      progress: i.progress,
      progressMsg: i.progressMsg,
      stale: isStale(i, now),
      checkinUnanswered: Boolean(i.checkin?.unanswered),
      minutesSinceUpdate: Math.round(minutesSince(i, now)),
    }))

  return {
    needsOwner,
    inProgress,
    schedule: buildSchedule(items).filter((r) => !hidden(r)),
    decidedNotCollected: items.filter((i) => i.state === 'decided').length,
    sources,
    cycles: findCycles(items),
    sessions,
    staleTasks: staleTasksOf(items).length,
  }
}

/** The whole store's overview, sources included — what bench renders. */
export function overviewOf(store: Store, now = Date.now()): Overview {
  return buildOverview(store.all(), now, listSources(store, now), projectSessions(store, now))
}
