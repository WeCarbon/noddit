import { nodditEnv } from './env.ts'

/**
 * The session id this process is running under, if any — the same value
 * `decs add` stamps onto a new node (see `core/types.ts`'s `session` field).
 */
export function currentSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_SESSION_ID || nodditEnv('SESSION', env) || undefined
}

/** Just the name before the first ` · `/`・`, trimmed — same split used everywhere else. */
export function agentNameOf(author: string | undefined): string | undefined {
  const name = author?.split(/[ \t]*[·・][ \t]*/)[0]?.trim()
  return name || undefined
}

/**
 * One stable string naming the process writing right now — not a display
 * label, never shown to the owner. `NODDIT_IDENTITY`/`DECS_IDENTITY` wins
 * outright (set it once per agent to pin this exactly) — deliberately a
 * different name from `NODDIT_AGENT` (`nod session start --agent`'s
 * claude/codex/kimi harness choice), so setting one never leaks into the
 * other. Otherwise the author's own name plus the session id, so two
 * processes signing the same author name (a lane restarted, or two
 * terminals) don't collide. A process with neither set has no identity:
 * nothing is tagged, nothing is skipped.
 */
export function currentIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = nodditEnv('IDENTITY', env)
  if (explicit) return explicit
  const name = agentNameOf(nodditEnv('AUTHOR', env))
  const session = currentSession(env)
  if (name && session) return `${name}#${session}`
  return name ?? session
}
