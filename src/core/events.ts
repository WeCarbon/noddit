/**
 * The JSON Lines progress-event format written by `noddit.progress_events`
 * (the Python package in `python/`) and its pytest plugin — one JSON object
 * per line: `{"type":"start",…}`, `{"type":"progress",…}`, `{"type":"finish",…}`.
 * See `python/docs/progress-events.md` for the full schema. This module is
 * the TS-side reader: `nod progress --from-file x.jsonl` (auto-detected) and
 * `nod run` both follow one of these files through a `createEventTracker()`.
 */

export interface StartEvent {
  type: 'start'
  total?: number
  label?: string
  ts?: number
  [key: string]: unknown
}

export interface ProgressEvent {
  type: 'progress'
  done?: number
  total?: number
  passed?: number
  failed?: number
  skipped?: number
  nodeid?: string
  outcome?: string
  msg?: string
  ts?: number
  [key: string]: unknown
}

export interface FinishEvent {
  type: 'finish'
  ok?: boolean
  exitstatus?: number
  passed?: number
  failed?: number
  skipped?: number
  failed_nodeids?: string[]
  duration_s?: number
  summary?: string
  ts?: number
  [key: string]: unknown
}

export type NodditEvent = StartEvent | ProgressEvent | FinishEvent

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * Parses one line as a noddit event. `null` for a blank line, a line that
 * isn't valid JSON (including a partial last line from a file still being
 * written — not an error, just "not there yet"), a JSON value that isn't an
 * object, or a `type` other than the three recognized ones. Unknown fields
 * on an otherwise-valid line are kept, not stripped, so a reader can look at
 * them even though the typed accessors here don't know about them.
 */
export function parseEventLine(line: string): NodditEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  const type = (obj as Record<string, unknown>).type
  if (type === 'start' || type === 'progress' || type === 'finish') return obj as NodditEvent
  return null
}

/** Quick check used for auto-detection: does this line look like a noddit event? */
export function isEventLine(line: string): boolean {
  return parseEventLine(line) !== null
}

/** One line of prose for a `finish` event that didn't supply its own `summary`. */
export function finishSummary(ev: FinishEvent): string {
  const parts: string[] = []
  if (typeof ev.passed === 'number') parts.push(`${ev.passed} passed`)
  if (typeof ev.failed === 'number' && ev.failed > 0) parts.push(`${ev.failed} failed`)
  if (typeof ev.skipped === 'number' && ev.skipped > 0) parts.push(`${ev.skipped} skipped`)
  const base = parts.join(', ')
  if (ev.ok === false) return base ? `failed: ${base}` : 'failed'
  return base || 'done'
}

/** The short progress line for a `progress` event: `"3823/10011 · 2 failed"`. */
function progressMsg(ev: ProgressEvent, total: number | undefined): string | undefined {
  if (typeof ev.msg === 'string' && ev.msg) return ev.msg
  const parts: string[] = []
  if (typeof ev.done === 'number') parts.push(total !== undefined ? `${ev.done}/${total}` : `${ev.done}`)
  if (typeof ev.failed === 'number' && ev.failed > 0) parts.push(`${ev.failed} failed`)
  return parts.length ? parts.join(' · ') : undefined
}

export interface EventProgress {
  pct: number
  msg?: string
}

/**
 * Tracks one event stream's running `total` (a `progress` line is allowed
 * to omit it once a `start` line has already given it) and turns each line
 * into the `{pct, msg}` a progress bar wants. Safe to feed the same file's
 * content more than once from the start (e.g. a full re-read on every
 * poll tick, as `nod progress --from-file` does) — state only ever moves
 * forward in a way that a full replay reconstructs identically.
 */
export interface EventTracker {
  /** Feed one line. `null` if it wasn't a recognized event. */
  push(line: string): EventProgress | null
  /** The most recent event of each kind seen so far. */
  readonly last: { start?: StartEvent; progress?: ProgressEvent; finish?: FinishEvent }
}

export function createEventTracker(): EventTracker {
  let total: number | undefined
  const last: { start?: StartEvent; progress?: ProgressEvent; finish?: FinishEvent } = {}

  const push = (line: string): EventProgress | null => {
    const ev = parseEventLine(line)
    if (!ev) return null
    if (ev.type === 'start') {
      last.start = ev
      if (typeof ev.total === 'number') total = ev.total
      return { pct: 0, msg: ev.label }
    }
    if (ev.type === 'progress') {
      last.progress = ev
      if (typeof ev.total === 'number') total = ev.total
      const pct = typeof ev.done === 'number' && total ? clampPercent((ev.done / total) * 100) : 0
      return { pct, msg: progressMsg(ev, total) }
    }
    last.finish = ev
    return { pct: 100, msg: ev.summary ?? finishSummary(ev) }
  }

  return { push, last }
}
