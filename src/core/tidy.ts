/**
 * Tree tidiness (N187): the owner's recurring "please tidy your tree" ask,
 * generalized into something `nod monitor` can nag about on its own —
 * three ways a node's own state and its subtree disagree:
 *   (a) `childrenDone` — a non-terminal node whose children all finished.
 *   (b) `openChildren` — a terminal node with a child that hasn't.
 *   (c) `orphanedAuthor` — an in-progress node nobody listens for any more:
 *       no live monitor in this project under its author's name, nor in the
 *       session that started it (see `isNodeListened`).
 * `tidyFindings` is pure over whatever `Store.all()` already loaded, so
 * tests never touch the filesystem; only `isAuthorLive` is a seam.
 *
 * The rest of this file is the per-session nag clock: how overdue a `nod
 * tidy` ack is, spaced the same way `core/checkins.ts` spaces its asks, but
 * keyed by session (author) rather than by node — see `tidyDue`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isHumanTask, isMilestone } from './assignee.ts'
import { parseDuration } from './duration.ts'
import { ensureGitignoreLines } from './gitignore.ts'
import { agentNameOf } from './identity.ts'
import { listenersFor } from './listeners.ts'
import { namesStartedBy, starterOf } from './session-nodes.ts'
import { withFileLock, writeFileAtomic } from './lock.ts'
import type { Layout } from './paths.ts'
import { refOf } from './ref.ts'
import { settingValue } from './settings.ts'
import { isDeferred, isTerminal } from './status.ts'
import type { Decision } from './types.ts'

export type TidyKind = 'childrenDone' | 'openChildren' | 'orphanedAuthor'

export interface TidyFinding {
  ref: string
  id: number
  project: string
  kind: TidyKind
  /** `childrenDone` / `openChildren`: how many children are in that state. */
  count?: number
  /** `orphanedAuthor`: the dead author's own name (before the first `·`). */
  author?: string
}

/** Whether some live monitor in `d`'s project is signed under `authorName` (the bare name before `·`). */
export type IsAuthorLive = (d: Decision, authorName: string) => boolean

/** The owner's own to-dos, anything deferred, and a milestone itself are never a tidy
 *  finding's subject — matches `core/checkins.ts`. A milestone isn't started or finished
 *  on its own, so its children all finishing is its normal end state, not a mismatch to
 *  nag about; its children's own findings are unaffected. */
const skip = (d: Pick<Decision, 'assignee' | 'deferredAt' | 'state' | 'milestone'>) => isHumanTask(d) || isDeferred(d) || isMilestone(d)

/**
 * Everywhere a node's state and its tree disagree right now. `items` is the
 * whole loaded set (so parent/child lookups work across authors); each
 * finding's subject is the node that needs a human or agent decision, not
 * necessarily the one whose state looks wrong at a glance (a closed parent
 * with an open child flags the parent — close/move the child, or reopen the
 * parent — not the child).
 */
export function tidyFindings(items: Decision[], isAuthorLive: IsAuthorLive): TidyFinding[] {
  const byKey = new Map(items.map((d) => [`${d.project}#${d.id}`, d]))
  const kidsOf = (d: Decision): Decision[] =>
    (d.children ?? []).map((id) => byKey.get(`${d.project}#${id}`)).filter((k): k is Decision => Boolean(k))

  const out: TidyFinding[] = []
  for (const d of items) {
    if (skip(d)) continue
    const kids = kidsOf(d)
    if (kids.length) {
      if (!isTerminal(d.state) && kids.every((k) => isTerminal(k.state))) {
        out.push({ ref: refOf(d), id: d.id, project: d.project, kind: 'childrenDone', count: kids.length })
      } else if (isTerminal(d.state)) {
        const open = kids.filter((k) => !isTerminal(k.state))
        if (open.length) out.push({ ref: refOf(d), id: d.id, project: d.project, kind: 'openChildren', count: open.length })
      }
    }
    if (d.state === 'in_progress') {
      const name = agentNameOf(d.author)
      if (name && name !== 'owner' && !isAuthorLive(d, name)) {
        out.push({ ref: refOf(d), id: d.id, project: d.project, kind: 'orphanedAuthor', author: name })
      }
    }
  }
  return out
}

/** Live-listener lookup `tidyFindings`' `isAuthorLive` seam is built from outside the pure function. */
export function isAuthorListening(projectRoot: string, name: string, now = Date.now()): boolean {
  return listenersFor(projectRoot, now).some((l) => l.author && agentNameOf(l.author) === name)
}

/**
 * Whether someone still listens for in-progress `d`: a live monitor signed
 * with its author's (or its starter's) name, or a live monitor running in
 * the very session that started it. The lead's monitor carries no name, so
 * it covers what its session started — and, by the names that session has
 * started nodes under, the other nodes it signed the same way.
 */
export function isNodeListened(projectRoot: string, d: Pick<Decision, 'id' | 'author'>, name: string, now = Date.now()): boolean {
  const live = listenersFor(projectRoot, now)
  const starter = starterOf(projectRoot, d.id)
  const names = new Set([name, ...(starter?.name ? [starter.name] : [])])
  if (live.some((l) => l.author && names.has(agentNameOf(l.author) ?? ''))) return true
  return live.some(
    (l) => l.session_pid !== undefined && (l.session_pid === starter?.pid || namesStartedBy(l.session_pid).has(name)),
  )
}

// ---------------------------------------------------------------------------
// Per-session ack clock (N189): `decisions/tidy.json`, gitignored, one entry
// per session (the `--mine` author, or a fixed key for the lead).
// ---------------------------------------------------------------------------

export interface TidyAckEntry {
  /** Last time this session ran `nod tidy` (or, absent an ack ever, when its clock first started). */
  lastAckAt: string
  /** Last time a NODDIT-TIDY line actually went out since that ack — spaces repeats. */
  lastSentAt?: string
}

export type TidyAckMap = Record<string, TidyAckEntry>

/** Never a real author name (those can't contain a NUL) — the lead's own row. */
const LEAD_KEY = '\u0000lead'

const tidyKey = (author: string | undefined): string => author ?? LEAD_KEY

function tidyFile(l: Layout): string {
  return join(l.root, 'tidy.json')
}

function lockFile(l: Layout): string {
  return join(l.root, '.locks', 'tidy.lock')
}

function readAll(l: Layout): TidyAckMap {
  try {
    const raw = JSON.parse(readFileSync(tidyFile(l), 'utf8'))
    return raw && typeof raw === 'object' ? (raw as TidyAckMap) : {}
  } catch {
    return {}
  }
}

function writeAll(l: Layout, data: TidyAckMap): void {
  mkdirSync(l.root, { recursive: true })
  ensureGitignoreLines(join(l.root, '.gitignore'), ['tidy.json'])
  writeFileAtomic(tidyFile(l), JSON.stringify(data))
}

function update(l: Layout, fn: (map: TidyAckMap) => TidyAckMap | undefined): void {
  try {
    withFileLock(lockFile(l), () => {
      const next = fn(readAll(l))
      if (next) writeAll(l, next)
    })
  } catch {
    /* bookkeeping only — a lock hiccup must never block the monitor */
  }
}

/** This session's own ack entry, or undefined before its clock has ever started. */
export function tidyAckOf(l: Layout, author: string | undefined): TidyAckEntry | undefined {
  return readAll(l)[tidyKey(author)]
}

/** `nod tidy`: acks right now — resets both the ack and send clocks. */
export function recordTidyAck(l: Layout, author: string | undefined, now = Date.now()): void {
  const key = tidyKey(author)
  update(l, (map) => ({ ...map, [key]: { lastAckAt: new Date(now).toISOString() } }))
}

/** Call once a NODDIT-TIDY line actually goes out, so the next one waits out the spacing. */
export function recordTidySent(l: Layout, author: string | undefined, now = Date.now()): void {
  const key = tidyKey(author)
  update(l, (map) => ({
    ...map,
    [key]: { lastAckAt: map[key]?.lastAckAt ?? new Date(now).toISOString(), lastSentAt: new Date(now).toISOString() },
  }))
}

export type TidyMode = 'attach' | 'push'

/**
 * Whether this session (`author`, or the lead when undefined) is due a
 * tree-tidiness nudge right now: `undefined` under the `tidy-after` span;
 * `'attach'` between `tidy-after` and `tidy-push-after` — only worth
 * sending alongside another event this same monitor pass already has;
 * `'push'` past `tidy-push-after` — worth its own line regardless. A
 * session with no ack on record yet starts its clock now rather than
 * nagging at once. Spaced like `core/checkins.ts`'s asks: once a line
 * actually goes out (`recordTidySent`), the same session waits out
 * `tidy-after` again before it's due a second time.
 */
export function tidyDue(l: Layout, author: string | undefined, now = Date.now()): TidyMode | undefined {
  const key = tidyKey(author)
  const entry = readAll(l)[key]
  if (!entry) {
    update(l, (map) => (key in map ? undefined : { ...map, [key]: { lastAckAt: new Date(now).toISOString() } }))
    return undefined
  }
  const attachMs = parseDuration(settingValue('tidy-after').value)
  const sinceAck = now - Date.parse(entry.lastAckAt)
  if (sinceAck < attachMs) return undefined
  const sinceSent = entry.lastSentAt ? now - Date.parse(entry.lastSentAt) : Infinity
  if (sinceSent < attachMs) return undefined
  const pushMs = parseDuration(settingValue('tidy-push-after').value)
  return sinceAck >= pushMs ? 'push' : 'attach'
}

/** `tidy.json` exists at all — for `nod init`'s gitignore line, lazily, same as `checkins.ts`. */
export function tidyFileExists(l: Layout): boolean {
  return existsSync(tidyFile(l))
}
