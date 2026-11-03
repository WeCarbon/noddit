/**
 * Check-in asks: an `in_progress` node idle past its span (`core/staleness.ts`'s
 * `checkinThresholdMs`, default 30m) gets asked for a status update, and a
 * not-started, not-deferred ("stale") node gets nagged to the lead — both
 * piggybacked onto whatever line `nod monitor` is about to print anyway
 * where possible, but either can show up on its own after a long enough
 * silence (see `cli/commands/monitor.ts`) — at most once per span either
 * way. How many times a node's been asked, and when, lives in
 * `decisions/checkins.json`, gitignored and shared by the monitor and the
 * bench; never in the node's own file. Any write to the node (progress,
 * note, step, `nod beat`, done…) resets it — that happens centrally in
 * `Store.write()`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureGitignoreLines } from './gitignore.ts'
import { withFileLock, writeFileAtomic } from './lock.ts'
import type { Layout } from './paths.ts'
import { isHumanTask, isMilestone } from './assignee.ts'
import { remindsLater } from './remind.ts'
import { checkinThresholdMs } from './staleness.ts'
import { isDeferred, isStartable } from './status.ts'
import type { Decision } from './types.ts'

/** After this many unanswered asks, the bench shows an alert. */
export const UNANSWERED_AFTER = 3

export interface CheckinEntry {
  asked: number
  lastAskedAt: string
}

export interface CheckinStatus extends CheckinEntry {
  unanswered: boolean
}

export type CheckinMap = Record<string, CheckinEntry>

function checkinsFile(l: Layout): string {
  return join(l.root, 'checkins.json')
}

function lockFile(l: Layout): string {
  return join(l.root, '.locks', 'checkins.lock')
}

/** Every node's check-in entry in this layout, by id — `{}` if there has never been one. */
export function readCheckinsMap(l: Layout): CheckinMap {
  try {
    const raw = JSON.parse(readFileSync(checkinsFile(l), 'utf8'))
    return raw && typeof raw === 'object' ? (raw as CheckinMap) : {}
  } catch {
    return {}
  }
}
const readAll = readCheckinsMap

function writeAll(l: Layout, data: CheckinMap): void {
  mkdirSync(l.root, { recursive: true })
  // A project set up before this feature existed never got the line from `nod init`.
  ensureGitignoreLines(join(l.root, '.gitignore'), ['checkins.json'])
  writeFileAtomic(checkinsFile(l), JSON.stringify(data))
}

/** Runs `fn(map)` under the layout's lock; writes back only when it returns a map. */
function update(l: Layout, fn: (map: CheckinMap) => CheckinMap | undefined): void {
  try {
    withFileLock(lockFile(l), () => {
      const next = fn(readAll(l))
      if (next) writeAll(l, next)
    })
  } catch {
    /* bookkeeping only — a lock hiccup must never block a real write or the monitor */
  }
}

/** The entry for one node, or undefined if it has never been asked (or was reset). */
export function checkinOf(l: Layout, id: number): CheckinStatus | undefined {
  const e = readAll(l)[String(id)]
  return e ? { ...e, unanswered: e.asked >= UNANSWERED_AFTER } : undefined
}

/** Whether the checkins file exists at all — for `nod init`'s gitignore line, lazily. */
export function checkinsFileExists(l: Layout): boolean {
  return existsSync(checkinsFile(l))
}

/** Any write to the node — progress, note, step, done, reopen… — counts as a reply. */
export function resetCheckin(l: Layout, id: number): void {
  const key = String(id)
  update(l, (map) => (key in map ? Object.fromEntries(Object.entries(map).filter(([k]) => k !== key)) : undefined))
}

/**
 * Records an ask for `id` right now and returns the new count — unless
 * it's idle for less than `thresholdMs`, or was already asked within the
 * last `thresholdMs` (so asks are spaced out, not one per monitor pass).
 * `undefined`, and nothing written, when neither condition is met.
 */
function dueAndRecord(l: Layout, id: number, lastWrite: number, thresholdMs: number, now: number): CheckinStatus | undefined {
  if (Number.isNaN(lastWrite)) return undefined
  if (now - lastWrite < thresholdMs) return undefined
  const existing = checkinOf(l, id)
  if (existing && now - Date.parse(existing.lastAskedAt) < thresholdMs) return undefined

  let result: CheckinStatus | undefined
  update(l, (map) => {
    const key = String(id)
    const asked = (map[key]?.asked ?? 0) + 1
    const lastAskedAt = new Date(now).toISOString()
    result = { asked, lastAskedAt, unanswered: asked >= UNANSWERED_AFTER }
    return { ...map, [key]: { asked, lastAskedAt } }
  })
  return result
}

/**
 * A parent whose unfinished children are all waiting on the owner — a decision, or the
 * owner's own to-do: the tree itself says it is waiting, so nobody should be asked for news.
 */
export function waitsOnlyOnOwner(d: Pick<Decision, 'id' | 'project'>, items: Pick<Decision, 'id' | 'project' | 'parent' | 'state' | 'assignee'>[]): boolean {
  const open = items.filter((c) => c.project === d.project && c.parent === d.id && c.state !== 'completed' && c.state !== 'closed')
  return open.length > 0 && open.every((c) => c.state === 'needs_decision' || isHumanTask(c))
}

/**
 * Whether `d` is due for another status-update ask right now: `in_progress`,
 * not deferred, idle past its span. When due, records the ask and returns
 * the new count; otherwise undefined, and nothing is written.
 */
export function askIfDue(
  l: Layout,
  d: Pick<Decision, 'id' | 'state' | 'updatedAt' | 'created' | 'staleAfter' | 'activeAt' | 'deferredAt' | 'deferredUntil' | 'assignee' | 'milestone'>,
  now = Date.now(),
): CheckinStatus | undefined {
  if (d.state !== 'in_progress' || isDeferred(d) || isHumanTask(d) || isMilestone(d)) return undefined
  const lastWrite = Date.parse(d.activeAt || d.updatedAt || d.created || '')
  return dueAndRecord(l, d.id, lastWrite, checkinThresholdMs(d.staleAfter), now)
}

/**
 * Whether a not-started, not-deferred node ("stale" per N47 — nobody's
 * deciding on it and nobody's working it) is due for another nag to the
 * lead right now — start it, defer it, close it, or re-plan it. Same
 * per-node spacing and record as `askIfDue`, in the same file.
 */
export function staleNagDue(
  l: Layout,
  d: Pick<Decision, 'id' | 'state' | 'updatedAt' | 'created' | 'staleAfter' | 'activeAt' | 'deferredAt' | 'deferredUntil' | 'assignee' | 'milestone' | 'remindAt'>,
  now = Date.now(),
): CheckinStatus | undefined {
  if (d.state !== 'not_started' || isDeferred(d) || isHumanTask(d) || isMilestone(d) || remindsLater(d, now)) return undefined
  const lastWrite = Date.parse(d.activeAt || d.updatedAt || d.created || '')
  return dueAndRecord(l, d.id, lastWrite, checkinThresholdMs(d.staleAfter), now)
}

/** Not-started, not deferred, free to start and not the owner's own to-do — the owner's
 *  "stale task": neither waiting on a decision nor being worked on. A node queued behind
 *  an unfinished `--after` is waiting its turn, not stale; neither is a reminder before its
 *  own clock (`remind_at`, `nod add --remind` / `nod edit --remind`) — not idle, just
 *  waiting on its own schedule. Oldest first, so the nag (and `stale_count` in the
 *  bench/JSON) surfaces what's sat longest. */
export function staleTasksOf<T extends Decision>(items: T[], now = Date.now()): T[] {
  return items
    .filter((d) => d.state === 'not_started' && !isDeferred(d) && !isHumanTask(d) && !isMilestone(d) && isStartable(d, items))
    .filter((d) => !remindsLater(d, now))
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))
}
