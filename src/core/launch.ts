import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * `nod session start`: opens a new, foreground terminal window in the
 * project's root running an agent CLI, with a first prompt telling it to
 * pick up waiting briefs. From there the plugin's session-start rules and
 * auto-started monitor take over. Building the plan is pure; running it is
 * a separate step, so tests (and `--dry-run`) never open a window.
 */

export const AGENTS = ['claude', 'codex', 'kimi'] as const
export type AgentCli = (typeof AGENTS)[number]

export interface LaunchPlan {
  agent: AgentCli
  root: string
  /** What runs inside the new window, already quoted for its shell. */
  command: string
  /** How the window is opened: `iterm`, `terminal`, `wt`, `cmd`, a Linux terminal's name, or `none` (print only). */
  terminal: string
  /** The program and arguments that open it; null when there is no terminal to open. */
  exec: { file: string; args: string[] } | null
  /** The AppleScript, when the terminal is driven by one. */
  script?: string
}

export const PICKUP_PROMPT = 'nod: pick up the briefs waiting in this project (nod briefs), expand and split each one, then nod ask the owner to confirm before starting.'

export const MAIN_PROMPT = 'nod: you are the main session, across every registered project (nod sessions). Wait for the owner; file what they say in the right project.'

/** POSIX single quotes: everything literal, a `'` closed, escaped, reopened. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** An AppleScript string literal. */
export function asQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** cmd.exe double quotes; `"` itself can't appear in a Windows path, and is dropped from a prompt. */
export function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, "'")}"`
}

/** The interactive agent invocation with its first prompt — kimi takes no prompt argument, so it starts bare. */
function agentArgs(agent: AgentCli, prompt: string): string[] {
  return agent === 'kimi' ? [agent] : [agent, prompt]
}

export interface LaunchEnv {
  platform: NodeJS.Platform
  /** Is this program on PATH (or an app installed)? */
  has: (name: string) => boolean
}

export function hostEnv(): LaunchEnv {
  const path = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return {
    platform: process.platform,
    has: (name) => {
      if (name === 'iTerm.app') return ['/Applications', join(homedir(), 'Applications')].some((d) => existsSync(join(d, name)))
      return path.some((d) => exts.some((x) => existsSync(join(d, name + x))))
    },
  }
}

/** The project's real root: symlinks resolved, so the agent opens where `decisions/` actually lives.
 *  `.native` to agree with `core/paths.ts`'s own canonicalization — plain `realpathSync` can
 *  normalise a Windows path differently, breaking an identity check between the two. */
export function realRoot(root: string): string {
  try {
    return realpathSync.native(root)
  } catch {
    return root
  }
}

/** `vars` are set for the agent alone, e.g. `NODDIT_ROLE=main`; names must be plain identifiers. */
export function launchPlan(agent: AgentCli, root: string, env: LaunchEnv, prompt = PICKUP_PROMPT, vars: Record<string, string> = {}): LaunchPlan {
  const args = agentArgs(agent, prompt)
  const pairs = Object.entries(vars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  if (env.platform === 'win32') {
    const sets = pairs.map(([k, v]) => `set "${k}=${v.replace(/"/g, '')}"&& `).join('')
    const inner = sets + args.map((a, i) => (i === 0 ? a : cmdQuote(a))).join(' ')
    // Passed verbatim (see runPlan): cmd and wt parse their own quotes.
    if (env.has('wt')) return { agent, root, command: inner, terminal: 'wt', exec: { file: 'wt', args: ['-d', cmdQuote(root), 'cmd', '/k', inner] } }
    return { agent, root, command: inner, terminal: 'cmd', exec: { file: 'cmd', args: ['/c', 'start', '""', '/D', cmdQuote(root), 'cmd', '/k', inner] } }
  }
  const command = `cd ${shQuote(root)} && ${pairs.map(([k, v]) => `${k}=${shQuote(v)} `).join('')}${args.map(shQuote).join(' ')}`
  if (env.platform === 'darwin') {
    if (env.has('iTerm.app')) {
      // A new tab in the window already open; a cold start uses the window iTerm2 opens itself.
      const script = [
        'set wasRunning to (application "iTerm" is running)',
        'tell application "iTerm"',
        '  activate',
        '  if wasRunning and (count of windows) > 0 then',
        '    tell current window to set t to (create tab with default profile)',
        `    tell current session of t to write text ${asQuote(command)}`,
        '  else if (count of windows) > 0 then',
        `    tell current session of current window to write text ${asQuote(command)}`,
        '  else',
        '    set w to (create window with default profile)',
        `    tell current session of w to write text ${asQuote(command)}`,
        '  end if',
        'end tell',
      ].join('\n')
      return { agent, root, command, terminal: 'iterm', exec: { file: 'osascript', args: ['-e', script] }, script }
    }
    const script = ['tell application "Terminal"', '  activate', `  do script ${asQuote(command)}`, 'end tell'].join('\n')
    return { agent, root, command, terminal: 'terminal', exec: { file: 'osascript', args: ['-e', script] }, script }
  }
  // Linux and the rest: the first terminal we can find; the shell keeps the window open after the agent exits.
  const keep = `${command}; exec "\${SHELL:-sh}"`
  const linux: [string, string[]][] = [
    ['x-terminal-emulator', ['-e', 'sh', '-c', keep]],
    ['gnome-terminal', ['--', 'sh', '-c', keep]],
    ['konsole', ['-e', 'sh', '-c', keep]],
    ['xfce4-terminal', ['-x', 'sh', '-c', keep]],
    ['kitty', ['sh', '-c', keep]],
    ['alacritty', ['-e', 'sh', '-c', keep]],
    ['xterm', ['-e', 'sh', '-c', keep]],
  ]
  for (const [file, a] of linux) if (env.has(file)) return { agent, root, command, terminal: file, exec: { file, args: a } }
  return { agent, root, command, terminal: 'none', exec: null }
}

/**
 * Opens the window. `NODDIT_LAUNCH_RECORD=<file>` appends the plan as one
 * JSON line instead — the seam tests use, so no suite ever opens a real window.
 */
export function runPlan(plan: LaunchPlan): void {
  const record = process.env.NODDIT_LAUNCH_RECORD
  if (record) {
    appendFileSync(record, `${JSON.stringify(plan)}\n`)
    return
  }
  if (!plan.exec) return
  if (plan.exec.file === 'osascript') {
    execFileSync(plan.exec.file, plan.exec.args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 })
    return
  }
  const child = spawn(plan.exec.file, plan.exec.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: plan.terminal === 'cmd' || plan.terminal === 'wt' })
  child.on('error', () => {})
  child.unref()
}
