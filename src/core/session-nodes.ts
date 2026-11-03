import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { nodditEnv } from './env.ts'
import { agentNameOf, currentIdentity } from './identity.ts'
import { withFileLock, writeFileAtomic } from './lock.ts'
import { harnessPid } from './session-process.ts'

/**
 * Machine-local, per-session bookkeeping in `$NODDIT_HOME/session-nodes.json`
 * (never `decisions/`, which is shared through git):
 *
 * - `current`: the node this session last ran `nod start` / `nod claim` on,
 *   which `nod progress` / `nod beat` / `nod note` / `nod steps` fall back
 *   to when no id is given and `NODDIT_NODE` is unset.
 * - `starters`: which session started each in-progress node, so `nod tidy`
 *   can tell a node someone is still listening for from an orphaned one.
 */
export interface CurrentNode {
  root: string
  id: number
  ref: string
  at: string
}

export interface Starter {
  /** The agent harness process (see `harnessPid`), when one was found. */
  pid?: number
  /** The signer's bare name (before `·`). */
  name?: string
  at: string
}

interface State {
  current: Record<string, CurrentNode>
  starters: Record<string, Starter>
}

const KEEP_MS = 14 * 86_400_000

/** Read at call time; `NODDIT_SESSION_NODES` points it elsewhere (tests). */
function stateFile(env: NodeJS.ProcessEnv = process.env): string {
  return nodditEnv('SESSION_NODES', env) || join(nodditEnv('HOME', env) || join(homedir(), '.decs'), 'session-nodes.json')
}

function read(file = stateFile()): State {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return {
      current: raw?.current && typeof raw.current === 'object' ? raw.current : {},
      starters: raw?.starters && typeof raw.starters === 'object' ? raw.starters : {},
    }
  } catch {
    return { current: {}, starters: {} }
  }
}

function prune<T extends { at: string }>(map: Record<string, T>, now: number): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([, v]) => now - Date.parse(v.at) < KEEP_MS))
}

function update(fn: (s: State) => void): void {
  const file = stateFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    withFileLock(`${file}.lock`, () => {
      const s = read(file)
      fn(s)
      const now = Date.now()
      writeFileAtomic(file, JSON.stringify({ current: prune(s.current, now), starters: prune(s.starters, now) }))
    })
  } catch {
    /* a convenience: an unwritable home only means ids have to be spelled out */
  }
}

/**
 * Which session is asking: the pinned identity, else the harness's own
 * session id, else its process. Undefined outside any agent session — the
 * owner's terminal has no "current node".
 */
export function sessionKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const identity = currentIdentity(env)
  if (identity) return `id:${identity}`
  if (env.CLAUDE_CODE_SESSION_ID) return `session:${env.CLAUDE_CODE_SESSION_ID}`
  const pid = harnessPid()
  return pid ? `pid:${pid}` : undefined
}

const starterKey = (root: string, id: number) => `${root}#${id}`

/** `nod start` / `nod claim`: this session is now on `node`, and it is the one that started it. */
export function recordStarted(node: { id: number; ref: string; root: string }, author: string | undefined): boolean {
  const key = sessionKey()
  const pid = harnessPid()
  const at = new Date().toISOString()
  const name = agentNameOf(author)
  update((s) => {
    if (key) s.current[key] = { root: node.root, id: node.id, ref: node.ref, at }
    s.starters[starterKey(node.root, node.id)] = { ...(pid ? { pid } : {}), ...(name ? { name } : {}), at }
  })
  return Boolean(key)
}

/** The node this session last started, if any. */
export function currentNode(): CurrentNode | undefined {
  const key = sessionKey()
  return key ? read().current[key] : undefined
}

export function starterOf(root: string, id: number): Starter | undefined {
  return read().starters[starterKey(root, id)]
}

/** Every bare name a still-running session `pid` has started a node under — what that session signs as. */
export function namesStartedBy(pid: number): Set<string> {
  return new Set(
    Object.values(read().starters)
      .filter((s) => s.pid === pid && s.name)
      .map((s) => s.name!),
  )
}
