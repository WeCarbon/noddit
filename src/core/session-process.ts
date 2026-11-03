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
 *  the closest cross-version equivalent to `ps -o ppid=,comm=,command=`.
 *  The whole walk runs inside one PowerShell: starting one costs about a
 *  second, so one per ancestor kept a monitor from starting for many seconds.
 *  Prints one `pid|ppid|command line` per ancestor, nearest first. */
function winAncestorsScript(pid: number, max: number): string {
  return `$id = ${pid}; for ($i = 0; $i -lt ${max} -and $id -gt 1; $i++) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if (-not $p) { break }; "$id|$($p.ParentProcessId)|$($p.CommandLine)"; $id = $p.ParentProcessId }`
}

/** The lines `winAncestorsScript` prints, read back. */
export function parseWinAncestors(out: string): Array<ProcInfo & { pid: number }> {
  const chain: Array<ProcInfo & { pid: number }> = []
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('|')
    const pid = Number(line.slice(0, i))
    const info = i > 0 && Number.isInteger(pid) ? parseWinProcessLine(line.slice(i + 1)) : null
    if (info) chain.push({ pid, ...info })
  }
  return chain
}

/** The image name only, no path or args — approximates `ps`'s `comm=` from
 *  a Windows command line's own first (possibly quoted) token. */
export function imageName(comm: string): string {
  const trimmed = comm.trim()
  if (trimmed.startsWith('"')) return trimmed.slice(1, trimmed.indexOf('"', 1))
  return trimmed.split(/\s+/)[0] ?? trimmed
}

/** One ancestor's parent pid + command, or null if it can't be read — no
 *  `ps` on this POSIX box, pid is gone. */
function psProcessInfo(pid: number): ProcInfo | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out ? parsePsLine(out) : null
  } catch {
    return null
  }
}

const isHarness = (info: ProcInfo) => /(^|[\\/])claude(\.exe|\.cmd)?$/i.test(imageName(info.comm))

function walkToHarness(): { pid: number; info?: ProcInfo } {
  if (process.platform === 'win32') {
    let out = ''
    try {
      out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', winAncestorsScript(process.ppid, 8)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      /* no PowerShell here */
    }
    const hit = parseWinAncestors(out).find(isHarness)
    return hit ? { pid: hit.pid, info: { ppid: hit.ppid, comm: hit.comm } } : { pid: process.ppid }
  }
  let pid = process.ppid
  for (let i = 0; i < 8 && pid > 1; i++) {
    const info = psProcessInfo(pid)
    if (!info) break
    if (isHarness(info)) return { pid, info }
    pid = info.ppid
  }
  return { pid: process.ppid }
}

let located: { pid: number; info?: ProcInfo } | undefined

/** The Claude Code process this monitor runs under — walks up to the first
 *  `claude` in the process tree; with no `ps`/PowerShell reachable, the
 *  session counts as the lead. Walked once per process: the ancestry doesn't
 *  change, and a monitor asks three times while starting up. */
export function locateSession(): { pid: number; info?: ProcInfo } {
  located ??= walkToHarness()
  return located
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

