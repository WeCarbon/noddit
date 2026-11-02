import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { DECS_HOME } from '../../core/config.ts'
import { nodditEnv } from '../../core/env.ts'
import { many, bool, one, type Args } from '../args.ts'
import { resolveAuthor, resolveStore } from '../context.ts'
import { askIfDue, staleNagDue, staleTasksOf } from '../../core/checkins.ts'
import { parseDuration, parseSince } from '../../core/duration.ts'
import { currentIdentity } from '../../core/identity.ts'
import { findLayout } from '../../core/paths.ts'
import { listSources, sourceEventsSince } from '../../core/sources.ts'
import { DEFERRAL_CLOCK, isLatestNoteOwnerFacing, nowStamp, ownedBy, sameAgent, type ChangeEvent } from '../../core/store.ts'
import { isUnclaimedBrief, originalWords } from '../../core/intake.ts'
import { HEARTBEAT_MS, harnessOf, removeHeartbeat, writeHeartbeat } from '../../core/listeners.ts'
import type { Decision } from '../../core/types.ts'
import { refOf as refOfNode } from '../../core/ref.ts'
import { NOTE_KIND, noteKindKey } from '../../core/format.ts'
import { settingValue } from '../../core/settings.ts'
import { durationText } from '../../i18n/time.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.monitor')

interface ProcInfo {
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
function processInfo(pid: number, platform: NodeJS.Platform = process.platform): ProcInfo | null {
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
function locateSession(): { pid: number; info?: ProcInfo } {
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

function sessionPid(): number {
  return locateSession().pid
}

/** The `--agent-name` a teammate session's agent process was started with; undefined for a lead. */
export function teammateName(command: string): string | undefined {
  return /(?:^|\s)--agent-name[ =](\S+)/.exec(command)?.[1]
}

interface TeamMember {
  name?: string
  agentType?: string
  cwd?: string
  isActive?: boolean
  /** `in-process` (Agent-tool teammates, sharing the lead's own process and
   *  cwd) vs `tmux`/`iterm2`/other (a separate OS process in its own pane). */
  backendType?: string
}
interface TeamConfig {
  members?: TeamMember[]
}

/**
 * Fallback for when the `--agent-name` argv walk fails (a different Claude
 * Code build, or no `ps`/PowerShell reachable): `~/.claude/teams/<team>/
 * config.json` lists every member with the directory it runs in. The
 * member whose `cwd` is this process's cwd (or an ancestor of it) is this
 * session — but only when that's unambiguous:
 *   - never the team-lead itself (agentType team-lead is never a teammate);
 *   - never an `in-process` member (N141): an Agent-tool teammate shares
 *     the lead's own process and cwd, so cwd can't tell the two apart —
 *     inferring one from "a team exists" misidentified the *lead's own*
 *     monitor as whichever in-process teammate it last spawned;
 *   - never when the lead's own cwd in the same config matches too (cwd
 *     alone can't tell lead and teammate apart there either — skip that
 *     team rather than guess), and never when two different members tie.
 */
export function teammateFromTeamConfig(cwd: string = process.cwd(), home: string = homedir()): string | undefined {
  const root = join(home, '.claude', 'teams')
  let teams: string[]
  try {
    teams = readdirSync(root)
  } catch {
    return undefined
  }
  // One-directional on purpose: this process's cwd must be at or *inside* the
  // recorded directory. The reverse — a member's recorded cwd sitting inside
  // this (broader) cwd — says nothing about who's asking; a lead running from
  // a repo root isn't "covered by" a teammate's deeper worktree just because
  // that worktree happens to live under the same root.
  // Exact directory only: a member recorded at a broad folder (another team's
  // teammate at ~/Code) must not claim every project underneath it.
  const within = (recorded: string) => cwd === recorded
  let best: { name: string; len: number } | undefined
  let ambiguous = false
  for (const team of teams) {
    let cfg: TeamConfig
    try {
      cfg = JSON.parse(readFileSync(join(root, team, 'config.json'), 'utf8')) as TeamConfig
    } catch {
      continue
    }
    const members = cfg.members ?? []
    const lead = members.find((m) => m.agentType === 'team-lead')
    // The lead's own recorded cwd matches too — cwd can't distinguish the lead's
    // session from a teammate's at that length or anything less specific, so
    // only a teammate match strictly more specific than the lead's own counts
    // (e.g. a nested worktree). Equal (the common case: they share a cwd
    // outright, as in-process teammates always do) is the lead, not a guess.
    const leadLen = lead?.cwd && within(lead.cwd) ? lead.cwd.length : -1
    for (const m of members) {
      if (!m.name || !m.cwd || m.agentType === 'team-lead' || m.isActive === false || m.backendType === 'in-process') continue
      if (!within(m.cwd) || m.cwd.length <= leadLen) continue
      if (best && m.cwd.length === best.len && m.name !== best.name) ambiguous = true
      if (!best || m.cwd.length > best.len) best = { name: m.name, len: m.cwd.length }
    }
  }
  return ambiguous ? undefined : best?.name
}

function sessionCommand(): string {
  const teammate = nodditEnv('TEAMMATE')
  if (teammate !== undefined) return teammate ? `--agent-name ${teammate}` : ''
  const { pid, info } = locateSession()
  // Windows's CommandLine from the walk above is already the full command;
  // `ps`'s `comm=` is only the image name, so POSIX needs one more call.
  if (process.platform === 'win32') return info?.comm ?? ''
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** Where this session's monitor got to, so re-arming with a bare `decs monitor` resumes from here. */
function cursorFile(roots: string[], mine: string | undefined): string {
  const key = createHash('sha1').update(JSON.stringify([sessionPid(), [...roots].sort(), mine ?? ''])).digest('hex').slice(0, 16)
  return join(DECS_HOME, 'monitor', `${key}.json`)
}

function loadCursor(file: string): string | undefined {
  try {
    const { cursor } = JSON.parse(readFileSync(file, 'utf8')) as { cursor?: string }
    // A day-old cursor belongs to a session that is long gone; start fresh.
    return cursor && Date.now() - Date.parse(cursor) < 86_400_000 ? cursor : undefined
  } catch {
    return undefined
  }
}

function saveCursor(file: string, cursor: string): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ cursor }))
    renameSync(tmp, file)
  } catch {
    /* resuming is a convenience; the watch itself goes on */
  }
}

/** One line, so a multi-paragraph reply does not become several notifications. */
const flat = (s: string | null | undefined, max = 160) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function kindLabel(kind: string | undefined): string {
  if (!kind) return t('common.noteKind.reply')
  const key = noteKindKey(kind)
  return key ? t(`common.noteKind.${key}`) : kind
}

function nodeLine(e: ChangeEvent): string {
  const what =
    e.event === 'answered'
      ? t('cli.monitor.ownerAnswered', { choice: e.choice ? ` ${e.choice}` : '' })
      : e.event === 'reopened'
        ? t('cli.monitor.ownerReopened')
        : t('cli.monitor.ownerKind', { kind: kindLabel(e.kind) })
  const text = flat(e.text)
  return `${e.ref} ${t('cli.monitor.line', { what, title: e.title })}${text ? ` —— ${text}` : ''}  since=${e.at}`
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const here = bool(args, 'here')
  if (here && !findLayout()) return 0
  const allProjects = bool(args, 'all-projects')
  const explicitDirs = many(args, 'dir', 'd').length > 0
  // Default scope is this project alone — the same thing --here does, minus
  // exiting when there's none. Every other registered project needs
  // --all-projects spelled out; otherwise an agent re-arming a bare `nod
  // monitor` from inside project A never hears about project B's events.
  if (!here && !allProjects && !explicitDirs && !findLayout()) {
    process.stderr.write(`${t('cli.monitor.noProjectHere')}\n`)
    return 0
  }
  const store = resolveStore(args, { allowRegistry: allProjects, preferRegistry: allProjects })
  const explicitlyScoped = Boolean(one(args, 'author')) || bool(args, 'mine') || bool(args, 'all')
  // A teammate watches only its own nodes even when the plugin starts it without --mine; a lead watches everything.
  // The session's own argv decides when it can be read; the team config is
  // only a fallback when it can't (no ps, an unrecognised build).
  const command = explicitlyScoped ? '' : sessionCommand()
  const teammate = explicitlyScoped ? undefined : command ? teammateName(command) : teammateFromTeamConfig()
  const author = one(args, 'author') ?? (bool(args, 'mine') ? resolveAuthor(args) : teammate)
  // N141: this session wasn't told to filter (no --mine/--author/--all) but
  // detected itself as a teammate anyway — surprising enough, and wrong
  // often enough, that a lead should see it called out rather than silently
  // missing everything that isn't that one name's.
  const autoFiltered = !explicitlyScoped && Boolean(teammate)
  // This process's own identity (core/identity.ts) — a write it made itself
  // never needs to be reported back to it, however it's signed (N41: the
  // lead relaying the owner's own words with `--human --by owner(...)`
  // otherwise immediately echoes right back to the lead's own monitor).
  const myIdentity = currentIdentity()
  // Whose nodes this monitor asks check-ins for (core/checkins.ts): --mine's
  // own author; for a bare lead, whatever it would sign as, so "the lead's
  // monitor without --mine also sees nodes it filed" — never undefined just
  // because --mine wasn't passed.
  const checkinAuthor = author ?? (() => { try { return resolveAuthor(args) } catch { return undefined } })()
  const asJson = bool(args, 'json')
  const updates = bool(args, 'updates')
  const withSources = !bool(args, 'no-sources')
  const interval = Math.max(200, Number(one(args, 'interval') ?? 2000) || 2000)
  const unclaimedMs = parseDuration(one(args, 'unclaimed-after') ?? settingValue('unclaimed-after').value)
  const sinceArg = one(args, 'since')
  const stateFile = cursorFile(store.layouts.map((l) => l.projectRoot), author)
  const resumed = sinceArg ? undefined : loadCursor(stateFile)
  let cursor = sinceArg ? parseSince(sinceArg) : (resumed ?? nowStamp(new Date(), { ms: true }))

  // Which sources are "mine": registered with an owner_agent this author matches, or with none.
  const mySource = (project: string, name: string): boolean => {
    if (!author) return true
    const s = listSources(store, Date.now()).find((x) => x.project === project && x.name === name)
    return !s?.ownerAgent || sameAgent(s.ownerAgent, author) || sameAgent(author, s.ownerAgent)
  }

  // Events at the cursor's own instant can come back on the next pass; a key
  // per event keeps each one to a single notification.
  const seen = new Map<string, number>()
  /** Each uncollected answer is reported once (per answer), not every pass. */
  const unclaimed = new Set<string>()
  const idleExitMs = parseDuration(one(args, 'idle-exit') ?? settingValue('idle-exit').value)
  let lastEventAt = Date.now()
  const emit = (key: string, at: string, text: string, json: Record<string, unknown>) => {
    if (seen.has(key)) return
    seen.set(key, Date.parse(at))
    lastEventAt = Date.now()
    process.stdout.write(`${asJson ? JSON.stringify(json) : text}\n`)
  }

  const versions = new Map<string, string>()
  /** Any write at all — an agent's progress, a new node, one archived — as one line of refs, for a window that redraws.
   *  `owner_facing`: refs among them whose latest note is an agent's first reply to a human post — the
   *  owner can see it on the bench, so the desktop app notifies on it too (N47). */
  const reportUpdates = (first: boolean) => {
    const changed: string[] = []
    const ownerFacing: string[] = []
    const now = new Map(store.all().filter((d) => !author || sameAgent(d.author, author)).map((d) => [`${d.project}#${d.id}`, d]))
    for (const [key, d] of now) {
      const version = JSON.stringify([d.updatedAt, d.state, d.archived, d.notes.length, d.answer?.at, d.deferredAt, d.progress, d.title])
      if (versions.get(key) !== version && !first) {
        changed.push(refOfNode(d))
        if (isLatestNoteOwnerFacing(d)) ownerFacing.push(refOfNode(d))
      }
      versions.set(key, version)
    }
    const gone = [...versions.keys()].filter((k) => !now.has(k))
    for (const k of gone) versions.delete(k)
    if (!changed.length && !gone.length) return
    lastEventAt = Date.now()
    process.stdout.write(
      asJson
        ? `${JSON.stringify({ event: 'updated', refs: changed, gone, owner_facing: ownerFacing, at: nowStamp(new Date(), { ms: true }) })}\n`
        : `DECS-UPDATED ${changed.join(' ')}${ownerFacing.length ? `  (owner-facing: ${ownerFacing.join(' ')})` : ''}\n`,
    )
  }

  /**
   * 派活: each unclaimed brief goes out once as DECS-BRIEF (all of them on
   * start), and once more if it is still unclaimed after --unclaimed-after.
   * A lead hears every brief; a --mine/teammate monitor only those filed under its own nodes.
   */
  const briefSeen = new Set<string>()
  const reportBriefs = () => {
    const items = store.all()
    const byKey = new Map(items.map((d) => [`${d.project}#${d.id}`, d]))
    const underMine = (d: Decision) => {
      for (let p = d.parent, n = 0; p !== undefined && n < 50; n++) {
        const up = byKey.get(`${d.project}#${p}`)
        if (!up) return false
        if (ownedBy(up, author!)) return true
        p = up.parent
      }
      return false
    }
    for (const d of items) {
      if (!isUnclaimedBrief(d) || (author && !underMine(d))) continue
      const base = `${d.project}|${d.id}`
      const age = Date.now() - Date.parse(d.created)
      const words = originalWords(d)
      const extra = words && flat(words) !== d.title ? ` —— ${flat(words)}` : ''
      const json = { event: 'brief', ref: refOfNode(d), id: d.id, project: d.project, title: d.title, text: words ?? d.title, parent_ref: d.parent !== undefined ? refOfNode({ ...d, id: d.parent }) : null, since: cursor }
      if (!briefSeen.has(`b|${base}`)) {
        briefSeen.add(`b|${base}`)
        lastEventAt = Date.now()
        process.stdout.write(asJson ? `${JSON.stringify({ ...json, reminder: false })}\n` : `DECS-BRIEF ${t('cli.monitor.brief', { ref: refOfNode(d), title: d.title, extra })}  since=${cursor}\n`)
      }
      // Independent of the line above: a brief already overdue the first time it's seen
      // (a monitor that just started, or a slow first pass) gets both messages at once,
      // rather than losing the reminder because it looked old on arrival.
      if (age >= unclaimedMs && !briefSeen.has(`r|${base}`)) {
        briefSeen.add(`r|${base}`)
        lastEventAt = Date.now()
        process.stdout.write(
          asJson
            ? `${JSON.stringify({ ...json, reminder: true, minutes: Math.round(age / 60_000) })}\n`
            : `DECS-BRIEF ${t('cli.monitor.briefUnclaimed', { ref: refOfNode(d), title: d.title, duration: durationText(age) })}\n`,
        )
      }
    }
  }

  /**
   * `nod defer --until`: a deferral whose day has come is ended (by this monitor, or
   * whichever bench got there first), and each one goes out once as NODDIT-UNDEFERRED.
   */
  const reportBackFromDeferral = () => {
    store.returnDueDeferrals()
    for (const d of store.all()) {
      if (author && !ownedBy(d, author)) continue
      const note = d.notes.findLast((n) => n.kind === NOTE_KIND.undeferred && n.author === DEFERRAL_CLOCK)
      if (!note || Date.parse(note.at) < Date.parse(cursor) - 60_000) continue
      emit(`b|${d.project}|${d.id}|${note.at}`, note.at, `NODDIT-UNDEFERRED ${t('cli.monitor.backFromDeferral', { ref: refOfNode(d), title: d.title })}`, {
        event: 'undeferred', ref: refOfNode(d), id: d.id, project: d.project, title: d.title, at: note.at,
      })
    }
  }

  /** A waiting node's check-back day has come: one NODDIT-CHECK-BACK line for its agent. */
  const reportCheckBacks = () => {
    store.remindDueWaits()
    for (const d of store.all()) {
      if (d.state !== 'waiting' || (author && !ownedBy(d, author))) continue
      const note = d.notes.findLast((n) => n.author === DEFERRAL_CLOCK && n.kind === NOTE_KIND.addendum)
      if (!note || Date.parse(note.at) < Date.parse(cursor) - 60_000) continue
      emit(`w|${d.project}|${d.id}|${note.at}`, note.at, `NODDIT-CHECK-BACK ${t('cli.monitor.checkBack', { ref: refOfNode(d), on: d.waitingOn ?? '', title: d.title })}`, {
        event: 'check_back', ref: refOfNode(d), id: d.id, project: d.project, title: d.title, on: d.waitingOn ?? null, at: note.at,
      })
    }
  }

  const pass = (first = false) => {
    const startedAt = nowStamp(new Date(), { ms: true })
    if (updates) {
      try {
        reportUpdates(first)
      } catch (err) {
        process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
      }
    }
    try {
      for (const e of store.changes(cursor, { author, role: 'human' })) {
        if (e.event === 'created' || e.event === 'completed' || e.event === 'closed') continue
        // A brief's 原话 is reported once, as DECS-BRIEF below.
        if (e.kind === NOTE_KIND.original) continue
        // This session's own write (e.g. relaying the owner's words), however it's signed.
        if (myIdentity && e.writer === myIdentity) continue
        emit(`n|${e.project}|${e.id}|${e.event}|${e.at}`, e.at, nodeLine(e), { ...e, since: e.at })
      }
      if (withSources) {
        for (const e of sourceEventsSince(store, cursor)) {
          if (e.kind === 'gone' || !mySource(e.project, e.source)) continue
          const what = e.kind === 'new' ? t('cli.monitor.sourceNew') : t('cli.monitor.sourceChanged')
          const text = `${e.projectLetter}·${e.source}#${e.id} ${t('cli.monitor.line', { what, title: flat(e.title) })}${e.state ? ` [${e.state}]` : ''}${e.url ? ` ${e.url}` : ''}  since=${e.at}`
          emit(`s|${e.project}|${e.source}|${e.id}|${e.kind}|${e.at}`, e.at, text, { ...e, event: `source_${e.kind}`, since: e.at })
        }
      }
    } catch (err) {
      // One bad read (a file mid-rename) must not end the watch — but the
      // agent should know, so it goes out as an event of its own.
      process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
      return
    }
    // Safety net: an answer nobody collected goes out regardless of who
    // filed the node — a lead watching --mine would otherwise miss answers
    // on nodes it filed under a lane's name.
    try {
      // Picking up answers nobody collected is the lead's job.
      for (const d of teammate ? [] : store.queue({})) {
        const at = d.answer?.at ?? d.notes.filter((n) => n.role === 'human').at(-1)?.at
        const age = at ? Date.now() - Date.parse(at) : NaN
        if (!(age >= unclaimedMs)) continue
        const key = `u|${d.project}|${d.id}|${at}`
        if (unclaimed.has(key) || seen.has(`q|${d.project}|${d.id}`)) continue
        unclaimed.add(key)
        const mins = Math.round(age / 60_000)
        process.stdout.write(
          asJson
            ? `${JSON.stringify({ event: 'unclaimed', ref: refOfNode(d), id: d.id, project: d.project, title: d.title, author: d.author, minutes: mins })}\n`
            : `DECS-UNCLAIMED ${t('cli.monitor.unclaimed', { ref: refOfNode(d), duration: durationText(age), title: d.title, author: d.author })}\n`,
        )
      }
    } catch (err) {
      process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
    }
    try {
      reportBriefs()
    } catch (err) {
      process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
    }
    try {
      reportBackFromDeferral()
    } catch (err) {
      process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
    }
    try {
      reportCheckBacks()
    } catch (err) {
      process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
    }
    // Check-ins (core/checkins.ts): rides along whatever this pass already
    // printed where there was anything to ride on, but a node idle long
    // enough with nothing else happening still gets asked — just at most
    // once per span either way (askIfDue/staleNagDue's own spacing).
    if (checkinAuthor) {
      try {
        for (const d of store.all()) {
          if (!ownedBy(d, checkinAuthor)) continue
          const asked = askIfDue(store.layoutOf(d), d)
          if (!asked) continue
          lastEventAt = Date.now()
          const sinceMs = Date.now() - Date.parse(d.activeAt || d.updatedAt || d.created || '')
          process.stdout.write(
            asJson
              ? `${JSON.stringify({ event: 'checkin', ref: refOfNode(d), id: d.id, project: d.project, asked: asked.asked, unanswered: asked.unanswered })}\n`
              : `NODDIT-CHECKIN ${refOfNode(d)} ${t('cli.monitor.checkin', { duration: durationText(sinceMs) })}\n`,
          )
        }
      } catch (err) {
        process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
      }
    }
    // Stale tasks (N47): the lead's job, project-wide — not gated by
    // checkinAuthor/--mine, since a lane's own monitor only ever sees its
    // own nodes and stale tasks are a project health question, not an
    // ownership one.
    if (!author) {
      try {
        const due: Decision[] = []
        for (const d of staleTasksOf(store.all())) {
          if (staleNagDue(store.layoutOf(d), d)) due.push(d)
        }
        if (due.length) {
          lastEventAt = Date.now()
          const shown = due.slice(0, 3)
          const refs = shown.map((d) => refOfNode(d))
          process.stdout.write(
            asJson
              ? `${JSON.stringify({ event: 'stale_tasks', refs, count: due.length })}\n`
              : `NODDIT-STALE ${refs.join(' ')} ${t('cli.monitor.stale', { count: due.length })}\n`,
          )
        }
      } catch (err) {
        process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
      }
    }
    cursor = startedAt
    saveCursor(stateFile, cursor)
    const keep = Date.parse(cursor) - 120_000
    for (const [k, ts] of seen) if (ts < keep) seen.delete(k)
  }

  process.stderr.write(
    `${t('cli.monitor.watching', {
      count: store.layouts.length,
      author: author ? t(autoFiltered ? 'cli.monitor.onlyAuthorAuto' : 'cli.monitor.onlyAuthor', { author }) : '',
      from: resumed ? t('cli.monitor.resuming', { cursor }) : t('cli.monitor.startingAt', { cursor }),
    })}\n`,
  )
  // N141: never silent about this — a lead that got misidentified as a
  // teammate otherwise just quietly misses everything that isn't that name's.
  if (autoFiltered) {
    const warn = t('cli.monitor.autoFilteredWarn', { author })
    process.stderr.write(`${warn}\n`)
    process.stdout.write(asJson ? `${JSON.stringify({ event: 'warn', kind: 'auto_filtered_as_teammate', author })}\n` : `DECS-WARN ${warn}\n`)
  }
  // Already-answered, uncollected nodes go out first, so an answer that
  // landed before this monitor started isn't missed.
  try {
    for (const d of store.queue({ author })) {
      const text = t('cli.monitor.notCollected', { what: d.answer?.choice ? t('cli.monitor.repliedChoice', { choice: d.answer.choice }) : t('cli.monitor.hasReply') })
      emit(`q|${d.project}|${d.id}`, nowStamp(), `${t('cli.monitor.queued', { ref: refOfNode(d), title: d.title, text })}  since=${cursor}`, {
        event: 'queued', ref: refOfNode(d), id: d.id, project: d.project, title: d.title, choice: d.answer?.choice ?? null, since: cursor,
      })
    }
  } catch (err) {
    process.stdout.write(`DECS-ERROR ${flat((err as Error).message)}\n`)
  }
  const listenerKey = createHash('sha1').update(`${process.pid}|${stateFile}`).digest('hex').slice(0, 16)
  const startedListening = nowStamp(new Date(), { ms: true })
  const beat = () =>
    writeHeartbeat(listenerKey, {
      pid: process.pid,
      roots: store.layouts.map((l) => l.projectRoot),
      author: author ?? nodditEnv('AUTHOR') ?? null,
      harness: harnessOf(),
      role: author ? 'teammate' : 'lead',
      started_at: startedListening,
      last_seen: nowStamp(new Date(), { ms: true }),
    })
  // A window redrawing (--updates) is not an agent that will pick up a brief.
  const heartbeat = !updates && !bool(args, 'no-heartbeat')
  if (heartbeat) {
    beat()
    process.on('exit', () => removeHeartbeat(listenerKey))
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => process.exit(0))
  let lastBeat = Date.now()
  pass(true)
  const parent = Number(one(args, 'with-parent') ?? 0)
  setInterval(() => {
    if (heartbeat && Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now()
      beat()
    }
    // A window that started this monitor and then died (or was killed) takes it along.
    if (parent > 0 && !alive(parent)) process.exit(0)
    pass()
    if (idleExitMs > 0 && Date.now() - lastEventAt >= idleExitMs) {
      process.stdout.write(`DECS-IDLE ${t('cli.monitor.idle', { duration: durationText(idleExitMs) })}\n`)
      process.exit(0)
    }
  }, interval)
  return new Promise<number>(() => {})
}
