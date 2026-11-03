import { execFileSync } from 'node:child_process'

/**
 * iTerm2 and macOS Terminal both expose an identifier a monitor can later
 * point an AppleScript at: iTerm2 by the session's own unique id, Terminal by
 * the tty it owns. Any other terminal (or platform) gets no field — there is
 * nothing to reliably reselect.
 */
export interface SessionTerminal {
  type: 'mac-iterm2' | 'mac-terminal'
  id: string
}

export interface ProcessTty {
  ppid: number
  /** `??` (`ps`'s own marker) when the process has no controlling tty. */
  tty: string
}

export type TtyLookup = (pid: number) => ProcessTty | null

/** `ps -o tty=,ppid=` for one pid, as `ps` prints it: `ttys003 1234`. */
export function parseTtyLine(line: string): ProcessTty | null {
  const m = /^(\S+)\s+(\d+)$/.exec(line.trim())
  return m ? { tty: m[1], ppid: Number(m[2]) } : null
}

/** One ancestor's tty + parent pid, or null if it can't be read — no `ps` on this box, pid is gone. */
export function psTtyLookup(pid: number): ProcessTty | null {
  try {
    const out = execFileSync('ps', ['-o', 'tty=,ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out ? parseTtyLine(out) : null
  } catch {
    return null
  }
}

/**
 * Walks the parent chain to the first ancestor with a real tty. The monitor's
 * own process usually has none — it runs under an agent harness, piped —
 * but the terminal window that ultimately opened it does.
 */
export function findTty(pid: number, lookup: TtyLookup, maxHops = 12): string | undefined {
  let p = pid
  for (let i = 0; i < maxHops && p > 1; i++) {
    const info = lookup(p)
    if (!info) return undefined
    if (info.tty && info.tty !== '??' && info.tty !== '?') return `/dev/${info.tty}`
    p = info.ppid
  }
  return undefined
}

/**
 * Pure: given the environment a monitor process inherited and a way to look
 * up a process's tty, says which terminal (if any) its heartbeat should
 * record. `TERM_PROGRAM` and `ITERM_SESSION_ID` are ordinary environment
 * variables, inherited down the whole process chain regardless of tty, so
 * iTerm2 needs no process walk at all — only Terminal.app's tty does.
 */
export function detectTerminal(env: NodeJS.ProcessEnv, lookup: TtyLookup, pid: number): SessionTerminal | undefined {
  if (env.TERM_PROGRAM === 'iTerm.app') {
    // ITERM_SESSION_ID is `w<win>t<tab>p<pane>:<uuid>` — the uuid is the session's
    // own stable id, the part iTerm2's AppleScript `id` property also returns.
    const uuid = env.ITERM_SESSION_ID?.split(':')[1]
    return uuid ? { type: 'mac-iterm2', id: uuid } : undefined
  }
  if (env.TERM_PROGRAM === 'Apple_Terminal') {
    const tty = findTty(pid, lookup)
    return tty ? { type: 'mac-terminal', id: tty } : undefined
  }
  return undefined
}

/** `detectTerminal` wired to the real environment, the real process tree and this process's own pid. */
export function currentTerminal(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): SessionTerminal | undefined {
  return detectTerminal(env, psTtyLookup, pid)
}
