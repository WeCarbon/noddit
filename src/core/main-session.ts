import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve, isAbsolute } from 'node:path'
import { DECS_HOME, readProjects } from './config.ts'
import { nodditEnv } from './env.ts'
import { leadFor } from './listeners.ts'
import { findLayout, initLayout, layoutFor, type Layout } from './paths.ts'

/**
 * The main session: one agent session that belongs to no project. It runs in
 * the projects' common parent (e.g. ~/Code), watches every registered project,
 * and files the owner's words into the right one. Its own notes live in a
 * machine-local store, `$NODDIT_HOME/main/decisions/`, which is never
 * registered as a project — commands reach it with `--dir ~/.decs/main`.
 */

export const MAIN_ROLE = 'main'
export const MAIN_AUTHOR = 'main-session'

export const mainStoreRoot = () => join(DECS_HOME, 'main')

const README = `# The main session's own notes

Machine-local; not a project, never registered. Use \`nod … --dir ${'$NODDIT_HOME'}/main\`.
`

/** The main session's store, created on first use. */
export function ensureMainStore(): Layout {
  const l = initLayout(mainStoreRoot())
  const readme = join(l.root, 'README.md')
  if (!existsSync(readme)) writeFileSync(readme, README)
  return l
}

export const isInside = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Registered projects strictly below `dir`. */
export function projectsBelow(dir: string, roots: string[] = readProjects().map((p) => p.root)): string[] {
  return roots.filter((r) => isInside(r, dir))
}

/**
 * Is this process the main session? `NODDIT_ROLE=main` says so outright (what
 * `nod session start --main` sets). Otherwise a session whose cwd is in no
 * project but has registered projects below it — an agent opened by hand in
 * ~/Code — is one too.
 */
export function isMainSession(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, roots?: string[]): boolean {
  if (nodditEnv('ROLE', env) === MAIN_ROLE) return true
  if (findLayout(cwd)) return false
  return projectsBelow(cwd, roots).length > 0
}

/** The deepest directory every root sits in; the home directory when they only share `/`. */
export function commonParent(roots: string[]): string | null {
  if (!roots.length) return null
  let common = dirname(resolve(roots[0]))
  for (const r of roots.slice(1)) {
    while (!(isInside(r, common) || resolve(r) === common)) {
      const up = dirname(common)
      if (up === common) break
      common = up
    }
  }
  return common === parse(common).root ? homedir() : common
}

/** Every registered project, plus the main session's own store. */
export function mainWatchLayouts(): Layout[] {
  const projects = readProjects()
    .map((p) => layoutFor(resolve(p.root)))
    .filter((l) => existsSync(l.activeDir))
  return [...projects, ensureMainStore()]
}

/**
 * What the main session's monitor leaves alone: a project whose own lead
 * session is live handles its own briefs and answers. Its own store is always its.
 */
export function leftToProjectSession(projectRoot: string, now = Date.now()): boolean {
  if (layoutFor(projectRoot).projectRoot === layoutFor(mainStoreRoot()).projectRoot) return false
  return leadFor(projectRoot, now) !== undefined
}

/** Why `nod init` must not create decisions/ at `target` from a main session, or null when it may. */
export function initRefusal(target: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, roots?: string[]): 'main_container' | null {
  if (!isMainSession(cwd, env, roots)) return null
  const t = resolve(target)
  if (t === resolve(cwd) || projectsBelow(t, roots).length > 0) return 'main_container'
  return null
}
