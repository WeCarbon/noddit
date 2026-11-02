import { parseDuration } from './duration.ts'
import { settingValue } from './settings.ts'
import type { Decision as Item } from './types.ts'

/** in_progress with no update for a while → due a check-in (see `core/checkins.ts`). */

type Staleish = Pick<Item, 'state' | 'updatedAt' | 'created' | 'staleAfter' | 'activeAt'> & Partial<Pick<Item, 'deferredAt'>>

/** Minutes since the node's `updatedAt` (falling back to `created`). `Infinity` when neither parses. */
export function minutesSince(i: Pick<Item, 'updatedAt' | 'created' | 'activeAt'>, now = Date.now()): number {
  // Activity anywhere below counts: a parent is alive while its children move.
  const t = Date.parse(i.activeAt || i.updatedAt || i.created || '')
  if (Number.isNaN(t)) return Infinity
  return Math.max(0, (now - t) / 60_000)
}

export type Staleness = 'fresh' | 'stale'

/** The node's own `stale_after`, else the `checkin-after` setting (default 1h) — the
 *  one span both "no update in a while" and the check-in ask (`core/checkins.ts`) share. */
export function checkinThresholdMs(staleAfter?: string): number {
  return staleAfter ? parseDuration(staleAfter) : parseDuration(settingValue('checkin-after').value)
}

/** Only `in_progress` goes stale — a node waiting on the owner (needs_decision) not moving is expected. */
export function stalenessOf(i: Staleish, now = Date.now()): Staleness {
  if (i.state !== 'in_progress') return 'fresh'
  // 延迟: the owner put it off; nobody is expected to move it.
  if (i.deferredAt) return 'fresh'
  const thresholdMs = checkinThresholdMs(i.staleAfter)
  const t = Date.parse(i.activeAt || i.updatedAt || i.created || '')
  if (Number.isNaN(t)) return 'fresh'
  return now - t >= thresholdMs ? 'stale' : 'fresh'
}

export function isStale(i: Staleish, now = Date.now()): boolean {
  return stalenessOf(i, now) !== 'fresh'
}

export interface ObsoleteOptions {
  now?: number
  /** Days with no update before an open node is flagged "possibly obsolete"; default 3. */
  staleDays?: number
}

/** "可能过时": nobody has touched this node in days and it is not done. */
export function isPossiblyObsolete(i: Pick<Item, 'state' | 'updatedAt' | 'created'>, opts: ObsoleteOptions = {}): boolean {
  if (i.state === 'completed' || i.state === 'closed') return false
  const now = opts.now ?? Date.now()
  const staleDays = opts.staleDays ?? 3
  return minutesSince(i, now) / (60 * 24) >= staleDays
}
