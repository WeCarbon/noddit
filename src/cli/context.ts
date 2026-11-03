import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readProjects } from '../core/config.ts'
import { nodditEnv, nodditNodeEnv } from '../core/env.ts'
import { findLayout, layoutFor, type Layout } from '../core/paths.ts'
import { currentNode, recordAuthor, recordStarted, rememberedAuthor } from '../core/session-nodes.ts'
import { isTerminal } from '../core/status.ts'
import { Store, sameAgent } from '../core/store.ts'
import type { Decision, NoteRole } from '../core/types.ts'
import { parseRef as parseRefStrict, refOf } from '../core/ref.ts'
import { bool, many, one, type Args } from './args.ts'
import { list, t } from '../i18n/index.ts'

/**
 * Resolves which projects a command works on. Explicit `--dir` wins;
 * otherwise walk up from cwd (so a lane deep in a worktree doesn't write
 * into a sibling project's list); only then fall back to the registry, for
 * commands that span projects. `preferRegistry` flips that order for
 * `decs bench`, which defaults to every registered folder.
 */
export function resolveStore(
  args: Args,
  opts: { allowRegistry?: boolean; preferRegistry?: boolean; positionalDirs?: boolean } = {},
): Store {
  const dirs = many(args, 'dir', 'd')
  // A positional path walks up to its project, same as cwd.
  if (opts.positionalDirs) {
    for (const p of args._) {
      const found = findLayout(resolve(p))
      if (!found) throw new Error(t('cli.context.noDecisionsAbove', { path: p }))
      dirs.push(found.projectRoot)
    }
  }
  if (dirs.length) {
    const layouts: Layout[] = []
    for (const d of dirs) {
      const l = layoutFor(resolve(d))
      if (layouts.some((x) => x.projectRoot === l.projectRoot)) continue
      if (!existsSync(l.activeDir)) {
        process.emitWarning(t('cli.context.noActiveDir', { path: d }))
        continue
      }
      layouts.push(l)
    }
    if (!layouts.length) throw new Error(t('cli.context.noDirHasDecisions'))
    return warnClashes(new Store(layouts))
  }

  const registered = () =>
    readProjects()
      .map((p) => layoutFor(resolve(p.root)))
      .filter((l) => existsSync(l.activeDir))

  if (opts.preferRegistry) {
    const all = registered()
    if (all.length) return warnClashes(new Store(all))
  }

  const here = findLayout()
  if (here) return new Store([here])

  if (opts.allowRegistry) {
    const all = registered()
    if (all.length) return warnClashes(new Store(all))
  }

  throw new Error(t('cli.context.noDecisionsHere'))
}

/** Two projects sharing a letter make `W305` ambiguous; say so once, up front. */
function warnClashes(store: Store): Store {
  for (const c of store.letterClashes())
    process.emitWarning(t('cli.context.letterClash', { letter: c.letter, projects: list(c.projects), example: c.projects[0] }))
  return store
}

/** `313`, `W313`, `D313`, `W:313` and `api:313` — see core/ref.ts. */
export { parseRef } from '../core/ref.ts'

/**
 * Who is at the keyboard when no flag says: Claude Code sets `CLAUDECODE`;
 * `NODDIT_ROLE=agent|human` (or the older `DECS_ROLE`) covers other
 * harnesses; `main` (the main session) is an agent. Anything else is the owner's own terminal.
 */
export function shellRole(env: NodeJS.ProcessEnv = process.env): NoteRole {
  const role = nodditEnv('ROLE', env)
  if (role === 'agent' || role === 'human') return role
  if (role === 'main') return 'agent'
  return env.CLAUDECODE ? 'agent' : 'human'
}

export function requireDecision(store: Store, raw: string, args: Args) {
  return store.resolve(raw, one(args, 'project', 'p'))
}

/** Whether a node id was given some way other than as a positional: `NODDIT_NODE`, or this session's `nod start`. */
export function hasSessionNode(): boolean {
  return Boolean(nodditNodeEnv() || currentNode())
}

/**
 * The node a command means when no id is given: `NODDIT_NODE` (or its
 * older names) first, else the one this session last ran `nod start` on —
 * as long as it is still open in this store.
 */
export function sessionNode(store: Store, args: Args): Decision | undefined {
  const fromEnv = nodditNodeEnv()
  if (fromEnv) return requireDecision(store, fromEnv, args)
  const cur = currentNode()
  if (!cur) return undefined
  const d = store.all().find((x) => x.id === cur.id && store.layoutOf(x).projectRoot === cur.root)
  return d && !isTerminal(d.state) ? d : undefined
}

/** `raw` reads as a node id (`305`, `W305`, `web:305`) rather than free text. */
export function looksLikeRef(raw: string): boolean {
  try {
    parseRefStrict(raw)
    return true
  } catch {
    return false
  }
}

/** `nod start` / `nod claim`: remember `d` as this session's current node and its starter. */
export function rememberStarted(store: Store, d: Decision, author: string | undefined): boolean {
  return recordStarted({ id: d.id, ref: refOf(d), root: store.layoutOf(d).projectRoot }, author)
}

/**
 * Who is writing — inferred from the branch name when not given explicitly,
 * since every node needs a signer to know who can answer a follow-up.
 *
 * N267: an explicit `--author` is remembered for this session (see
 * `core/session-nodes.ts`), so a later call that gives neither `--author`
 * nor `NODDIT_AUTHOR` reuses it instead of falling all the way to the
 * branch-name guess — `--author`/`NODDIT_AUTHOR` still win outright.
 */
export function resolveAuthor(args: Args, cwd = process.cwd()): string {
  const explicit = one(args, 'author', 'a')
  if (explicit) {
    recordAuthor(explicit)
    return explicit
  }
  const author = nodditEnv('AUTHOR')
  if (author) return author
  const remembered = rememberedAuthor()
  if (remembered) return remembered
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (branch && branch !== 'HEAD') return `${branch} · lane`
  } catch {
    /* not a git repo; fall through */
  }
  throw new Error(t('cli.context.noAuthor'))
}

/**
 * Reads a piped body without hanging on stdin that is an idle pipe, not a
 * body — waiting briefly for the first chunk tells the two apart.
 */
export function readStdin(firstChunkTimeoutMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.pause()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(done, firstChunkTimeoutMs)

    process.stdin.on('data', (c: Buffer) => {
      clearTimeout(timer)
      chunks.push(c)
    })
    process.stdin.once('end', done)
    process.stdin.once('error', done)
  })
}

/**
 * A node signed by another agent is invisible to this shell's
 * `decs monitor --mine`; say so once, on stderr.
 */
export function warnOtherAuthor(nodeAuthor: string, ref: string, claimedBy?: string): void {
  const me = nodditEnv('AUTHOR')
  if (!me || sameAgent(nodeAuthor, me) || sameAgent(me, nodeAuthor)) return
  // A brief this agent claimed reaches its --mine monitor (see `ownedBy`).
  if (claimedBy && (sameAgent(claimedBy, me) || sameAgent(me, claimedBy))) return
  const name = nodeAuthor.split(/[ \t]*·[ \t]*/)[0]
  process.stderr.write(`${t('cli.context.otherAuthor', { ref, author: name, me: me.split(/[ \t]*·[ \t]*/)[0] })}\n`)
}

/**
 * A lane finishing, closing, holding, asking on or reopening a node another
 * agent filed is almost always a mistyped number. Refuse unless --force, or
 * unless this agent filed one of the node's ancestors (a lead tidying its lanes).
 * The owner's own terminal is never stopped.
 */
export function guardOtherAuthor(store: Store, d: Decision, args: Args, env: NodeJS.ProcessEnv = process.env): void {
  const me = one(args, 'author') ?? nodditEnv('AUTHOR', env)
  if (bool(args, 'force') || !me || shellRole(env) !== 'agent') return
  const mine = (author: string | undefined) => sameAgent(author, me) || (author !== undefined && sameAgent(me, author))
  // A claimed brief is the claimer's.
  if (mine(d.author) || mine(d.claimedBy)) return
  const all = store.all()
  for (let p = d.parent; p !== undefined; ) {
    const up = all.find((x) => x.project === d.project && x.id === p)
    if (!up) break
    if (mine(up.author)) return
    p = up.parent
  }
  const name = (s: string) => s.split(/[ \t]*·[ \t]*/)[0]
  throw new Error(t('cli.context.notYours', { ref: refOf(d), author: name(d.author ?? ''), me: name(me) }))
}
