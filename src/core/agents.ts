/**
 * `decs setup` — wiring decs into whichever coding agent CLIs a project has.
 *
 * Claude Code gets the real plugin (`.claude-plugin/`, hooks, a monitor) through
 * its own `plugin` subcommand. Codex and Kimi have no plugin system that reaches
 * decs; the only thing every harness reads is a project file named `AGENTS.md`,
 * so for them this drops a `decs` section into it — the same block whichever of
 * the two asked for it, since both read the same file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Lang } from '../i18n/index.ts'

export type AgentId = 'claude' | 'codex' | 'kimi'
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'kimi']

/** The executable each agent's CLI installs under. */
const AGENT_BIN: Record<AgentId, string> = { claude: 'claude', codex: 'codex', kimi: 'kimi' }

/** What a single agent's setup attempt did, in a shape stable enough for `--json`. */
export type SetupAction = 'skipped' | 'created' | 'updated' | 'unchanged' | 'manual' | 'error'

export interface AgentOutcome {
  detected: boolean
  action: SetupAction
  /** Short, plain-English, machine-oriented detail (a path, a command, a reason) — never translated. */
  detail: string
  /** The file touched, when one was. */
  file?: string
}

/** True if `name` resolves to an executable file on `pathEnv` (Windows extensions included). Takes an explicit PATH so tests can point it at a temp dir instead of the real one. */
export function commandExists(name: string, pathEnv: string = process.env.PATH ?? ''): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => existsSafe(join(dir, `${name}${ext}`))))
}

function existsSafe(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

export function detectAgents(pathEnv: string = process.env.PATH ?? ''): Record<AgentId, boolean> {
  return Object.fromEntries(AGENT_IDS.map((id) => [id, commandExists(AGENT_BIN[id], pathEnv)])) as Record<AgentId, boolean>
}

// ---------------------------------------------------------------------------
// The repo root — so `plugin/rules.md` resolves whether this file is
// running as source (`src/core/agents.ts`) or compiled (`dist/src/core/agents.js`),
// without hard-coding how many `..` that takes in either layout.
// ---------------------------------------------------------------------------

let repoRootCache: string | undefined

function repoRoot(): string {
  if (repoRootCache) return repoRootCache
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'plugin', 'rules.md'))) {
      repoRootCache = dir
      return dir
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error('nod: could not find plugin/rules.md relative to src/core/agents.ts')
}

/** The short rules the plugin injects every session — same text other harnesses get in their `AGENTS.md`. English in every interface language. */
export function rulesBody(): string {
  return readFileSync(join(repoRoot(), 'plugin', 'rules.md'), 'utf8').trim()
}

// ---------------------------------------------------------------------------
// AGENTS.md: one block, marked so it can be found and replaced, never
// touching anything a person wrote above or below it.
// ---------------------------------------------------------------------------

const START_MARKER = '<!-- decs:start — managed by `decs setup`; edits outside this block are kept -->'
const END_MARKER = '<!-- decs:end -->'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface SectionResult {
  action: 'created' | 'updated' | 'unchanged'
  path: string
}

/** Adds or refreshes the marked decs block in `path`, leaving everything else byte-for-byte alone. */
export function upsertSection(path: string, body: string, opts: { dryRun?: boolean } = {}): SectionResult {
  const block = `${START_MARKER}\n${body}\n${END_MARKER}`
  const existed = existsSync(path)
  const before = existed ? readFileSync(path, 'utf8') : ''
  const re = new RegExp(`${escapeRe(START_MARKER)}[\\s\\S]*?${escapeRe(END_MARKER)}`)

  let after: string
  if (re.test(before)) {
    after = before.replace(re, block)
    if (after === before) return { action: 'unchanged', path }
  } else {
    const base = before.replace(/\s+$/, '')
    after = `${base ? `${base}\n\n` : ''}${block}\n`
  }

  if (!opts.dryRun) writeFileSync(path, after)
  return { action: existed ? 'updated' : 'created', path }
}

// ---------------------------------------------------------------------------
// Codex / Kimi: both read a plain project `AGENTS.md`.
// ---------------------------------------------------------------------------

export function agentsMdPath(dir: string): string {
  return join(dir, 'AGENTS.md')
}

export function setupViaAgentsMd(dir: string, lng: Lang, opts: { dryRun?: boolean } = {}): AgentOutcome {
  const path = agentsMdPath(dir)
  const { action } = upsertSection(path, rulesBody(), opts)
  return { detected: true, action, detail: 'AGENTS.md', file: path }
}

// ---------------------------------------------------------------------------
// Claude: the real plugin, installed through `claude plugin …` when that
// can run non-interactively; otherwise the two lines a person types instead.
// ---------------------------------------------------------------------------

export const CLAUDE_MARKETPLACE = 'wecarbon/noddit'
export const CLAUDE_PLUGIN = 'nod@noddit'
/** The marketplace was "decisions-md" and the plugin "decs" before the Noddit rename; still installed on older machines. */
export const OLD_CLAUDE_PLUGIN = 'decs@decisions-md'
export const CLAUDE_MANUAL_LINES = [`/plugin marketplace add ${CLAUDE_MARKETPLACE}`, `/plugin install ${CLAUDE_PLUGIN}`] as const
export const OLD_CLAUDE_MANUAL_LINES = [`/plugin uninstall ${OLD_CLAUDE_PLUGIN}`, ...CLAUDE_MANUAL_LINES] as const

interface Exec {
  (args: string[]): { status: number | null; stdout: string; stderr: string }
}

/** `claude` has no `-C`/`--cwd` flag; `--scope project` reads the project from the process's own cwd, so that's what moves, not an extra argument. */
function execIn(dir: string): Exec {
  return (args) => {
    const r = spawnSync('claude', args, { cwd: dir, encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
}

/** The scope `OLD_CLAUDE_PLUGIN` is installed under, or undefined if it isn't installed (or `plugin list` can't be read). */
function detectOldPlugin(exec: Exec): string | undefined {
  try {
    const r = exec(['plugin', 'list', '--json'])
    if (r.status !== 0) return undefined
    const found = (JSON.parse(r.stdout) as Array<{ id?: string; scope?: string }>).find((p) => p.id === OLD_CLAUDE_PLUGIN)
    return found ? found.scope ?? 'user' : undefined
  } catch {
    return undefined
  }
}

/** `exec` is only ever overridden by tests — production always shells out to the real `claude` binary on PATH, run from `dir`. */
export function setupClaudePlugin(dir: string, opts: { dryRun?: boolean; exec?: Exec } = {}): AgentOutcome {
  if (opts.dryRun) {
    return { detected: true, action: 'manual', detail: CLAUDE_MANUAL_LINES.join('\n') }
  }
  const exec = opts.exec ?? execIn(dir)
  const alreadyMarketplace = /already/i

  // An older install under the pre-rename name: remove it non-interactively
  // before installing the new one, so a stale `decs@decisions-md` doesn't
  // sit alongside `nod@noddit`.
  const oldScope = detectOldPlugin(exec)
  if (oldScope !== undefined) {
    const uninstall = exec(['plugin', 'uninstall', OLD_CLAUDE_PLUGIN, '--scope', oldScope, '-y'])
    const gone = uninstall.status === 0 || /not (installed|found)/i.test(uninstall.stderr) || /not (installed|found)/i.test(uninstall.stdout)
    if (!gone) {
      return { detected: true, action: 'manual', detail: OLD_CLAUDE_MANUAL_LINES.join('\n') }
    }
  }

  const add = exec(['plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE, '--scope', 'project'])
  const marketplaceOk = add.status === 0 || alreadyMarketplace.test(add.stderr) || alreadyMarketplace.test(add.stdout)
  if (!marketplaceOk) {
    return { detected: true, action: 'manual', detail: CLAUDE_MANUAL_LINES.join('\n') }
  }
  const install = exec(['plugin', 'install', CLAUDE_PLUGIN, '--scope', 'project', '--json', '-y'])
  if (install.status !== 0) {
    return { detected: true, action: 'manual', detail: CLAUDE_MANUAL_LINES.join('\n') }
  }
  const already = /already/i.test(install.stdout) || /already/i.test(install.stderr)
  const detail = oldScope !== undefined
    ? `plugin ${CLAUDE_PLUGIN} installed from ${CLAUDE_MARKETPLACE} (removed old ${OLD_CLAUDE_PLUGIN})`
    : `plugin ${CLAUDE_PLUGIN} installed from ${CLAUDE_MARKETPLACE}`
  return { detected: true, action: already ? 'unchanged' : oldScope !== undefined ? 'updated' : 'created', detail }
}

// ---------------------------------------------------------------------------
// One entry point per agent.
// ---------------------------------------------------------------------------

export function setupAgent(id: AgentId, dir: string, lng: Lang, opts: { dryRun?: boolean; pathEnv?: string } = {}): AgentOutcome {
  if (!commandExists(AGENT_BIN[id], opts.pathEnv)) {
    return { detected: false, action: 'skipped', detail: `${AGENT_BIN[id]} not found on PATH` }
  }
  if (id === 'claude') return setupClaudePlugin(dir, opts)
  return setupViaAgentsMd(dir, lng, opts)
}
