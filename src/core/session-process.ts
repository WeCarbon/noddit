import { execFileSync } from 'node:child_process'
import { nodditEnv } from './env.ts'

export interface ProcInfo {
  ppid: number
  /** POSIX: the image name only (`ps -o comm=`). Windows: the full command
   *  line — CIM gives us that directly, so there's no second lookup. */
  comm: string
}

/** `ps -o ppid=,comm=` for one pid, as `ps` prints it: `1234 node`. */
export function parsePsLine(line: string): ProcInfo | null {
  const m = /^(\d+)\s+(.+)$/.exec(line.trim())
  return m ? { ppid: Number(m[1]), comm: m[2].trim() } : null
}

/** The one line `WIN_PROCESS_SCRIPT` prints: `1234|C:\...\node.exe --agent-name lane-a`. */
export function parseWinProcessLine(line: string): ProcInfo | null {
  const i = line.indexOf('|')
  if (i === -1) return null
  const ppid = Number(line.slice(0, i))
  return Number.isInteger(ppid) ? { ppid, comm: line.slice(i + 1).trim() } : null
}

/** Windows PowerShell (always present, unlike `wmic` on 24H2+) via CIM —
 *  the closest cross-version equivalent to `ps -o ppid=,comm=,command=`. */
function winProcessScript(pid: number): string {
  return `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)|$($p.CommandLine)" }`
}

/** The image name only, no path or args — approximates `ps`'s `comm=` from
 *  a Windows command line's own first (possibly quoted) token. */
export function imageName(comm: string): string {
  const trimmed = comm.trim()
  if (trimmed.startsWith('"')) return trimmed.slice(1, trimmed.indexOf('"', 1))
  return trimmed.split(/\s+/)[0] ?? trimmed
}

/** One ancestor's parent pid + command, or null if it can't be read — no
 *  `ps` on this POSIX box, no PowerShell on this Windows one, pid is gone. */
export function processInfo(pid: number, platform: NodeJS.Platform = process.platform): ProcInfo | null {
  try {
    if (platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', winProcessScript(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      return out ? parseWinProcessLine(out) : null
    }
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out ? parsePsLine(out) : null
  } catch {
    return null
  }
}

/** The Claude Code process this monitor runs under — walks up to the first `claude` in the process tree. */
export function locateSession(): { pid: number; info?: ProcInfo } {
  let pid = process.ppid
  // No `ps`/PowerShell reachable: the loop gives up and the session counts as the lead.
  for (let i = 0; i < 8 && pid > 1; i++) {
    const info = processInfo(pid)
    if (!info) break
    if (/(^|[\\/])claude(\.exe|\.cmd)?$/i.test(imageName(info.comm))) return { pid, info }
    pid = info.ppid
  }
  return { pid: process.ppid }
}

export function sessionPid(): number {
  return locateSession().pid
}

/**
 * The agent harness process this command runs under, when there is one to
 * find — a stable key for "this session" across shell calls, unlike
 * `process.ppid`. `NODDIT_SESSION_PID` pins it (tests, other harnesses).
 */
export function harnessPid(): number | undefined {
  const pinned = Number(nodditEnv('SESSION_PID'))
  if (Number.isInteger(pinned) && pinned > 0) return pinned
  const { pid, info } = locateSession()
  return info ? pid : undefined
}

