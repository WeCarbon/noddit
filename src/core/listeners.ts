import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DECS_HOME } from './config.ts'
import { nodditEnv } from './env.ts'
import type { Store } from './store.ts'
import type { SessionTerminal } from './terminal.ts'

/**
 * Who is connected: every running `nod monitor` keeps a heartbeat file under
 * `~/.decs/sessions/`, so `nod add --brief`, `nod sessions` and the bench can
 * say "nobody is here to pick this up" instead of letting a brief sit unseen.
 */
export interface Listener {
  /** The monitor process — a file whose pid is gone doesn't count. */
  pid: number
  roots: string[]
  /** `--mine` / teammate monitors watch one author's nodes; a lead's (null) watches everything. */
  author: string | null
  /** The agent CLI it runs under, when it can tell: `claude-code`, `codex`, or `NODDIT_HARNESS`/`DECS_HARNESS`. */
  harness: string | null
  role: 'lead' | 'teammate'
  started_at: string
  last_seen: string
  /** iTerm2 or macOS Terminal, when the monitor could tell which session/tab it runs in; absent otherwise. */
  terminal?: SessionTerminal
}

const sessionsDir = () => join(DECS_HOME, 'sessions')

/** How often a monitor rewrites its file, and how old one may get before it no longer counts. */
export const HEARTBEAT_MS = 30_000
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function harnessOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const harness = nodditEnv('HARNESS', env)
  if (harness) return harness
  if (env.CLAUDECODE) return 'claude-code'
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex'
  return null
}

export function writeHeartbeat(key: string, l: Listener): void {
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    const file = join(sessionsDir(), `${key}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(l))
    renameSync(tmp, file)
  } catch {
    /* a missing heartbeat only makes the bench say "no session" */
  }
}

export function removeHeartbeat(key: string): void {
  rmSync(join(sessionsDir(), `${key}.json`), { force: true })
}

/** Live sessions whose monitor covers `projectRoot`, longest-running first. Dead or stale files are swept. */
export function listenersFor(projectRoot: string, now = Date.now()): Listener[] {
  let names: string[]
  try {
    names = readdirSync(sessionsDir()).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  // .native to agree with core/paths.ts's own canonicalization — plain realpathSync can
  // normalise a Windows path differently, breaking the identity check below.
  const real = (p: string) => {
    try {
      return realpathSync.native(p)
    } catch {
      return resolve(p)
    }
  }
  const root = real(projectRoot)
  const out: Listener[] = []
  for (const n of names) {
    const file = join(sessionsDir(), n)
    try {
      const l = JSON.parse(readFileSync(file, 'utf8')) as Listener
      const dead = !(now - Date.parse(l.last_seen) < HEARTBEAT_STALE_MS) || !alive(l.pid)
      if (dead) {
        // Long dead (a killed monitor never removed its file): tidy it away.
        if (now - Date.parse(l.last_seen) > 10 * HEARTBEAT_STALE_MS) rmSync(file, { force: true })
        continue
      }
      if (Array.isArray(l.roots) && l.roots.some((r) => real(r) === root)) out.push(l)
    } catch {
      /* half-written or foreign file */
    }
  }
  return out.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
}

/** A brief gets picked up by a lead's monitor (one not narrowed to an author). */
export function leadFor(projectRoot: string, now = Date.now()): Listener | undefined {
  return listenersFor(projectRoot, now).find((l) => l.role === 'lead')
}

export const isListening = (projectRoot: string, now = Date.now()) => leadFor(projectRoot, now) !== undefined

/** Each project's live sessions — the shape `nod sessions`, `nod briefs` and `nod bench --json` share. */
export function projectSessions(store: Store, now = Date.now()) {
  return store.layouts.map((l) => {
    const sessions = listenersFor(l.projectRoot, now)
    return {
      project: store.projectName(l),
      name: store.displayName(l),
      letter: store.letterOf(l),
      root: l.projectRoot,
      listening: sessions.some((x) => x.role === 'lead'),
      sessions: sessions.map(({ roots: _roots, ...s }) => s),
    }
  })
}
