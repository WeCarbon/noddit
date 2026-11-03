import { bool, one, type Args } from '../args.ts'
import { resolveStore } from '../context.ts'
import { nodditEnv } from '../../core/env.ts'
import { AGENTS, hostEnv, launchPlan, realRoot, runPlan, type AgentCli, type LaunchPlan } from '../../core/launch.ts'
import { runGotoSession } from '../../core/goto-session.ts'
import { leadFor, listenersFor, projectSessions, type Listener } from '../../core/listeners.ts'
import { bold, dim } from '../../core/render.ts'
import type { Layout } from '../../core/paths.ts'
import type { SessionTerminal } from '../../core/terminal.ts'
import { durationText } from '../../i18n/time.ts'
import { t } from '../../i18n/index.ts'

export type StartResult =
  | { ok: true; started: boolean; plan: LaunchPlan }
  | { ok: false; reason: 'already_listening'; session: Omit<Listener, 'roots'> }

export type GotoResult = { ok: true; terminal: SessionTerminal } | { ok: false; reason: 'no_terminal_session' | 'not_found' }

const who = (l: Pick<Listener, 'author' | 'harness' | 'pid'>) => l.author ?? l.harness ?? `pid ${l.pid}`

export function agentArg(raw: string | undefined): AgentCli {
  const a = (raw ?? nodditEnv('AGENT') ?? 'claude').toLowerCase()
  if (!(AGENTS as readonly string[]).includes(a)) throw new Error(t('cli.session.badAgent', { agent: a, agents: AGENTS.join(' | ') }))
  return a as AgentCli
}

/**
 * Opens a new terminal window in the project's real root running `agent`,
 * unless a lead session is already listening there. `dryRun` builds the plan only.
 */
export function startSession(layout: Layout, agent: AgentCli, opts: { dryRun?: boolean } = {}): StartResult {
  const root = realRoot(layout.projectRoot)
  const lead = leadFor(root)
  if (lead) {
    const { roots: _roots, ...session } = lead
    return { ok: false, reason: 'already_listening', session }
  }
  const plan = launchPlan(agent, root, hostEnv())
  if (opts.dryRun || !plan.exec) return { ok: true, started: false, plan }
  runPlan(plan)
  return { ok: true, started: true, plan }
}

export function describeStart(r: StartResult, project: string): string {
  if (!r.ok) return t('cli.session.alreadyListening', { project, who: who(r.session), since: durationText(Date.now() - Date.parse(r.session.started_at)) })
  if (!r.plan.exec) return t('cli.session.noTerminal', { command: r.plan.command })
  if (!r.started) return [`${t('cli.session.dryRun', { terminal: r.plan.terminal })}`, r.plan.script ?? [r.plan.exec.file, ...r.plan.exec.args].join(' ')].join('\n')
  return t('cli.session.started', { terminal: r.plan.terminal, agent: r.plan.agent, root: r.plan.root })
}

/**
 * Among a project's live listeners, the lead session `nod session goto` switches to:
 * one with a recorded terminal (core/terminal.ts), the most recently seen when more
 * than one qualifies — never a sub-agent's own session, only the project's main one.
 */
export function pickGotoTerminal(sessions: Pick<Listener, 'role' | 'terminal' | 'last_seen'>[]): SessionTerminal | undefined {
  return sessions
    .filter((s): s is Pick<Listener, 'role' | 'terminal' | 'last_seen'> & { terminal: SessionTerminal } => s.role === 'lead' && Boolean(s.terminal))
    .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))[0]?.terminal
}

/**
 * Brings the project's main session's terminal window/tab to the front, or says there is
 * nothing to switch to. `dryRun` finds and reports the target without running the AppleScript
 * (the desktop app's background/screenshot mode forces this, the same way it does for `start`).
 */
export function gotoSession(layout: Layout, opts: { dryRun?: boolean } = {}): GotoResult {
  const root = realRoot(layout.projectRoot)
  const terminal = pickGotoTerminal(listenersFor(root))
  if (!terminal) return { ok: false, reason: 'no_terminal_session' }
  if (opts.dryRun) return { ok: true, terminal }
  return runGotoSession(terminal) ? { ok: true, terminal } : { ok: false, reason: 'not_found' }
}

export function describeGoto(r: GotoResult, project: string): string {
  return r.ok ? t('cli.session.gotoFound', { project }) : t('cli.session.gotoNotFound', { project })
}

/** `nod sessions` / `nod session list` and `nod session start`. */
export function run(args: Args, name: string): number {
  if (bool(args, 'help', 'h')) {
    console.log(t('cli.help.session'))
    return 0
  }
  const verb = name === 'sessions' ? 'list' : (args._[0] ?? 'list')
  const asJson = bool(args, 'json')
  if (verb === 'start') {
    const store = resolveStore(args)
    const layout = store.primary
    // `--agent` is also note's role flag, so it parses as a switch: `--agent codex` leaves codex positional.
    const given = one(args, 'agent')
    const agent = given && given !== 'true' ? given : given ? args._[1] : undefined
    const r = startSession(layout, agentArg(agent), { dryRun: bool(args, 'dry-run') })
    if (asJson) console.log(JSON.stringify({ ...r, project: store.projectName(layout), dry_run: bool(args, 'dry-run') }))
    else (r.ok ? console.log : console.error)(describeStart(r, store.projectName(layout)))
    return r.ok ? 0 : 1
  }
  if (verb === 'goto') {
    const store = resolveStore(args)
    const layout = store.primary
    const dryRun = bool(args, 'dry-run')
    const r = gotoSession(layout, { dryRun })
    if (asJson) console.log(JSON.stringify({ ...r, dry_run: dryRun }))
    else (r.ok ? console.log : console.error)(describeGoto(r, store.projectName(layout)))
    return r.ok ? 0 : 1
  }
  if (verb !== 'list') throw new Error(`${t('cli.session.unknownVerb', { verb })}\n\n${t('cli.help.session')}`)

  const store = resolveStore(args, { allowRegistry: true })
  const projects = projectSessions(store)
  if (asJson) {
    console.log(JSON.stringify({ projects }))
    return 0
  }
  const now = Date.now()
  for (const p of projects) {
    if (!p.sessions.length) {
      console.log(`○ ${bold(`${p.letter} ${p.project}`)} · ${dim(t('cli.session.none'))}`)
      continue
    }
    console.log(`● ${bold(`${p.letter} ${p.project}`)}`)
    for (const s of p.sessions)
      console.log(
        `  ${who(s)}${s.harness && s.author ? dim(` (${s.harness})`) : ''} · ${s.role === 'lead' ? t('cli.session.lead') : t('cli.session.teammate')} · ${dim(t('cli.session.since', { duration: durationText(now - Date.parse(s.started_at)) }))}`,
      )
  }
  return 0
}
