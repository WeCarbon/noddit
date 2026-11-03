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
 * - `authors` (N267): the author this session last signed as — explicitly
 *   with `--author`, or by running `nod start` under one — so a later write
 *   that gives neither `--author` nor `NODDIT_AUTHOR` still signs the same way.
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

export interface AuthorEntry {
  author: string
  at: string
}

interface State {
  current: Record<string, CurrentNode>
  starters: Record<string, Starter>
  authors: Record<string, AuthorEntry>
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
      authors: raw?.authors && typeof raw.authors === 'object' ? raw.authors : {},
    }
  } catch {
    return { current: {}, starters: {}, authors: {} }
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
      writeFileAtomic(file, JSON.stringify({ current: prune(s.current, now), starters: prune(s.starters, now), authors: prune(s.authors, now) }))
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

/**
 * N267: `--author`/`-a` given explicitly, or `nod start` resolving one any
 * way at all — either means this session signs as `author` from here on,
 * until an explicit `--author`/`NODDIT_AUTHOR` or a later `recordAuthor`
 * says otherwise. A no-op outside any session (the owner's own terminal has
 * no session key, same as `recordStarted`).
 */
export function recordAuthor(author: string): boolean {
  const key = sessionKey()
  if (!key) return false
  update((s) => {
    s.authors[key] = { author, at: new Date().toISOString() }
  })
  return true
}

/** This session's remembered author, if any — between an explicit `--author`/`NODDIT_AUTHOR` and the branch-name guess. */
export function rememberedAuthor(): string | undefined {
  const key = sessionKey()
  return key ? read().authors[key]?.author : undefined
}
