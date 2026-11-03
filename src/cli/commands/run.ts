import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bool, one, type Args } from '../args.ts'
import { guardOtherAuthor, rememberStarted, requireDecision, resolveAuthor, resolveStore } from '../context.ts'
import { createEventTracker, finishSummary, type FinishEvent } from '../../core/events.ts'
import { createThrottle } from '../../core/progress.ts'
import { refOf } from '../../core/ref.ts'
import { isTerminal } from '../../core/status.ts'
import type { Decision } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.run')

const TICK_MS = 300
const MAX_TAIL_LINES = 20

/** Splits arbitrary stdout/stderr chunks into complete lines, holding back a trailing partial line until more data (or flush) completes it. */
class LineBuffer {
  private held = ''
  private readonly onLine: (line: string) => void

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine
  }

  push(chunk: string): void {
    this.held += chunk
    const lines = this.held.split('\n')
    this.held = lines.pop() ?? ''
    for (const line of lines) this.onLine(line)
  }

  flush(): void {
    if (this.held) this.onLine(this.held)
    this.held = ''
  }
}

/** A small ring buffer of the last N lines, for the failure note. */
class Tail {
  private readonly max: number
  private lines: string[] = []

  constructor(max: number) {
    this.max = max
  }

  push(line: string): void {
    this.lines.push(line)
    if (this.lines.length > this.max) this.lines.shift()
  }

  get(): string[] {
    return this.lines
  }
}

function durationLabel(ms: number): string {
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

/** The short reason recorded on `nod hold`'s `--on` — one line, not the full note. */
function failingOn(finish: FinishEvent | undefined, exitCode: number): string {
  const summary = finish ? finish.summary ?? finishSummary(finish) : undefined
  return summary ?? `exit ${exitCode}`
}

function resultNote(opts: {
  finish: FinishEvent | undefined
  exitCode: number
  elapsedMs: number
  logPath: string | undefined
  tail: string[]
}): string {
  const { finish, exitCode, elapsedMs, logPath, tail } = opts
  const parts: string[] = []
  if (finish?.summary) parts.push(finish.summary)
  else if (finish) parts.push(finishSummary(finish))
  parts.push(`exit ${exitCode}, ${durationLabel(elapsedMs)}`)
  const failedNodeids = finish?.failed_nodeids
  if (Array.isArray(failedNodeids) && failedNodeids.length) {
    parts.push(`failed:\n${failedNodeids.map((id) => `  ${id}`).join('\n')}`)
  }
  if (logPath) parts.push(`log: ${logPath}`)
  if (tail.length) parts.push(`last ${tail.length} line(s) of output:\n${tail.join('\n')}`)
  return parts.join('\n\n')
}

function mkEventsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nod-run-'))
  return join(dir, 'events.jsonl')
}

export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [ref, ...cmd] = args._
  if (!ref) throw new Error(`${t('cli.run.whichNode')}\n\n${help()}`)
  if (!cmd.length) throw new Error(`${t('cli.run.noCommand')}\n\n${help()}`)

  const store = resolveStore(args, { allowRegistry: true })
  const d0 = requireDecision(store, ref, args)
  guardOtherAuthor(store, d0, args)
  if (isTerminal(d0.state)) throw new Error(t('cli.run.alreadyFinished', { ref: refOf(d0) }))
  const author = resolveAuthor(args)
  const force = bool(args, 'force')
  let node: Decision = store.start(d0, { force })
  rememberStarted(store, node, author)

  const explicitEvents = one(args, 'events')
  const eventsPath = explicitEvents ?? mkEventsPath()
  const ownEventsFile = !explicitEvents
  const logPath = one(args, 'log')
  const waitLabel = one(args, 'wait-label')

  try {
    writeFileSync(eventsPath, '') // start clean, in case a previous run left a file at this same path
  } catch (e) {
    throw new Error(t('cli.run.cannotWriteEvents', { path: eventsPath, reason: (e as Error).message }))
  }

  if (waitLabel) node = store.progress(node, { progress: 0, progressMsg: waitLabel })

  const childEnv = { ...process.env, NODDIT_EVENTS: eventsPath }
  const tail = new Tail(MAX_TAIL_LINES)
  const outLines = new LineBuffer((line) => {
    process.stdout.write(`${line}\n`)
    tail.push(line)
  })
  const errLines = new LineBuffer((line) => {
    process.stderr.write(`${line}\n`)
    tail.push(line)
  })

  const started = Date.now()
  const child = spawn(cmd[0], cmd.slice(1), {
    env: childEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
    // Node can't exec a .cmd/.bat shim directly on Windows; everywhere else
    // this is unnecessary but harmless for a plain executable + args.
    shell: process.platform === 'win32',
  })
  child.stdout?.on('data', (c: Buffer) => outLines.push(c.toString('utf8')))
  child.stderr?.on('data', (c: Buffer) => errLines.push(c.toString('utf8')))

  const tracker = createEventTracker()
  let sawEvent = false
  const throttle = createThrottle<{ pct: number; msg?: string }>(5000, ({ pct, msg }) => {
    node = store.progress(node, { progress: pct, progressMsg: msg })
  })

  let lastSize = -1
  const readEvents = () => {
    if (!existsSync(eventsPath)) return
    const { size } = statSync(eventsPath)
    if (size === lastSize) return
    lastSize = size
    const text = readFileSync(eventsPath, 'utf8')
    let last: { pct: number; msg?: string } | null = null
    for (const line of text.split('\n')) {
      const v = tracker.push(line)
      if (v !== null) last = v
    }
    if (last !== null) {
      sawEvent = true
      throttle.push(last)
    }
  }

  const exitCode = await new Promise<number>((resolveP) => {
    const timer = setInterval(readEvents, TICK_MS)
    child.on('error', (err) => {
      clearInterval(timer)
      outLines.flush()
      errLines.flush()
      tail.push(`nod run: failed to start the command: ${err.message}`)
      resolveP(127)
    })
    child.on('exit', (code, signal) => {
      clearInterval(timer)
      readEvents() // one last read: catch a finish line written right at exit
      outLines.flush()
      errLines.flush()
      resolveP(code !== null ? code : 1)
      void signal
    })
  })
  throttle.flush()

  if (logPath) {
    try {
      appendFileSync(logPath, tail.get().join('\n') + (tail.get().length ? '\n' : ''))
    } catch {
      /* best effort — the note below still has the tail inline */
    }
  }
  if (ownEventsFile) {
    try {
      rmSync(join(eventsPath, '..'), { recursive: true, force: true }) // removes mkEventsPath()'s whole temp dir
    } catch {
      /* a leftover temp file is not worth failing the run over */
    }
  }

  const finish = tracker.last.finish
  const ok = exitCode === 0 && finish?.ok !== false
  const elapsedMs = Date.now() - started
  const note = resultNote({ finish, exitCode, elapsedMs, logPath, tail: tail.get() })

  if (ok) {
    node = store.complete(node, { note, author })
    console.log(t('cli.run.done', { ref: refOf(node), exitCode }))
  } else {
    node = store.note(node, { text: note, role: 'agent', author })
    // `--on` is free text, like a hand-written `nod hold --on "…"` — not a
    // translated UI string, just a short reason for the "waiting" badge.
    node = store.hold(node, `failing: ${failingOn(finish, exitCode)}`, author)
    console.log(t('cli.run.failed', { ref: refOf(node), exitCode }))
  }
  if (!sawEvent && explicitEvents === undefined) {
    // Nothing ever showed up at the auto-generated path — not an error (plenty
    // of commands don't emit this format), just worth a hint on how to get it.
    process.stderr.write(`${t('cli.run.noEventsHint')}\n`)
  }
  return exitCode
}
