import { execSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { bool, many, one, oneLine, optionsAndDefault, questionsFromArgs, type Args } from '../args.ts'
import { optionsWithoutCost } from '../../core/option-costs.ts'
import { readStdin, resolveAuthor, resolveStore, shellRole, warnOtherAuthor } from '../context.ts'
import { briefTitle } from '../../core/intake.ts'
import { isListening } from '../../core/listeners.ts'
import { assigneeArg, HUMAN } from '../../core/assignee.ts'
import { milestoneDue } from './flag.ts'
import { nodditEnv, setNodditEnv } from '../../core/env.ts'
import { URGENCIES } from '../../core/order.ts'
import { parseOptions, splitFrontMatter } from '../../core/parse.ts'
import { refOf } from '../../core/ref.ts'
import { dim, toJSON } from '../../core/render.ts'
import { nowStamp } from '../../core/store.ts'
import { TITLE_MAX_COLS, assertTitleFits } from '../../core/title.ts'
import type { Decision, NewDecision, Urgency } from '../../core/types.ts'
import type { Layout } from '../../core/paths.ts'
import { t } from '../../i18n/index.ts'

function urgencyArg(raw: string | undefined): Urgency | undefined {
  if (raw === undefined) return undefined
  if (!(URGENCIES as readonly string[]).includes(raw)) throw new Error(t('cli.send.badUrgency', { urgencies: URGENCIES.join(' | '), value: raw }))
  return raw as Urgency
}

const help = () => t('cli.help.add', { max: TITLE_MAX_COLS, half: Math.floor(TITLE_MAX_COLS / 2) })

/** A piped document is a first-class input: front matter and a leading `# 标题` are both honoured. */
function fromPiped(text: string): { title?: string; body: string; meta: Record<string, unknown> } {
  const { data, body } = splitFrontMatter(text)
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  const h1 = /^#[ \t]+(.+?)[ \t]*$/.exec(lines[i] ?? '')
  if (h1) return { title: h1[1], body: lines.slice(i + 1).join('\n').trim(), meta: data }
  return { title: data.title ? String(data.title) : undefined, body: body.trim(), meta: data }
}

export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }

  const bodyFile = one(args, 'body-file', 'f')
  const raw =
    one(args, 'body') ?? (bodyFile ? readFileSync(bodyFile, 'utf8') : await readStdin())
  const piped = fromPiped(raw)

  const words = args._.join(' ').trim()
  const meta = piped.meta
  const { options: cliOptions, default: cliDefault } = optionsAndDefault(args)
  const questions = questionsFromArgs(args)
  const forWho = one(args, 'for') ?? (bool(args, 'human-task') ? 'me' : meta.assignee !== undefined ? String(meta.assignee) : undefined)
  const assignee = forWho !== undefined ? assigneeArg(forWho) : undefined
  if (assignee && (bool(args, 'brief') || cliOptions.length || questions.length || bool(args, 'fyi'))) throw new Error(t('cli.send.humanTaskIsTask'))
  const brief = !assignee && isBrief(args, { options: cliOptions.length > 0, questions: questions.length > 0, meta, body: piped.body })
  const milestone = bool(args, 'milestone')
  if (milestone && !one(args, 'due')) throw new Error(t('cli.send.milestoneNeedsDue'))

  const title = brief && words ? briefTitle(words) : words || piped.title
  if (!title) throw new Error(`${t('cli.send.titleRequired')}\n\n${help()}`)
  if (!brief) assertTitleFits(oneLine(title))

  const input: NewDecision = {
    title: oneLine(title),
    author: one(args, 'author', 'a') ?? (meta.author ? String(meta.author) : (brief || assignee === HUMAN) && shellRole() === 'human' ? 'owner' : resolveAuthor(args)),
    body: brief ? [words, piped.body].filter(Boolean).join('\n\n') : piped.body,
    options: cliOptions,
    questions,
    default: cliDefault ?? (meta.default !== undefined ? String(meta.default) : undefined),
    tags: many(args, 'tag').length ? many(args, 'tag') : Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    urgency: bool(args, 'important') ? 'high' : urgencyArg(one(args, 'urgency') ?? (meta.urgency !== undefined ? String(meta.urgency) : undefined)),
    milestone: milestone || undefined,
    assignee,
    due: dueOf(one(args, 'due') ?? (meta.due !== undefined ? String(meta.due) : undefined)),
    ifNoAnswer: one(args, 'if-no-answer') ?? (meta.if_no_answer !== undefined ? String(meta.if_no_answer) : undefined),
    reversible: yesNo(one(args, 'reversible') ?? (meta.reversible !== undefined ? String(meta.reversible) : undefined), 'reversible'),
    kind: bool(args, 'fyi') || meta.kind === 'fyi' ? 'fyi' : undefined,
    task: brief || Boolean(assignee) || bool(args, 'task'),
    intake: brief || undefined,
    parent: one(args, 'parent'),
    after: many(args, 'after').flatMap((s) => s.split(/[,\s]+/)).filter(Boolean),
    est: one(args, 'est'),
    when: one(args, 'when'),
    staleAfter: one(args, 'stale-after'),
    // Which session wrote this, so a bad entry can be traced back to its transcript.
    session: process.env.CLAUDE_SESSION_ID || nodditEnv('SESSION') || undefined,
  }

  const store = resolveStore(args)
  const d = store.create(input)
  warnOtherAuthor(d.author, refOf(d))

  if (brief) {
    const root = store.layoutOf(d).projectRoot
    const listening = isListening(root)
    const hook = listening ? 'none' : runBriefHook(d, root)
    if (bool(args, 'json')) console.log(JSON.stringify({ ...toJSON(d), listening, hook }))
    else {
      console.log(`${refOf(d)}  ${d.file}`)
      console.error(dim(listening ? t('cli.send.briefListening', { ref: refOf(d) }) : t('cli.send.briefNobody', { ref: refOf(d) })))
      if (!listening && hook !== 'ran' && process.stdin.isTTY && process.stderr.isTTY) await offerSession(store.layoutOf(d), d.project)
    }
    return 0
  }
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(d)))
  else {
    console.log(`${refOf(d)}  ${d.file}`)
    if (input.task && !assignee && !cliOptions.length && shellRole() === 'agent') console.error(dim(t('cli.send.taskNext', { ref: refOf(d) })))
    const bare = shellRole() === 'agent' ? optionsWithoutCost(d) : []
    if (bare.length) console.error(t('cli.send.optionsWithoutCost', { keys: bare.join(' '), id: d.id }))
  }
  if (bool(args, 'notify')) notify(d)
  return 0
}

/**
 * 派活: `--brief`, or a bare `nod add "a few words"` from the owner's own
 * terminal (or the app) — no options, no --task/--fyi, no explicit author.
 * `--no-brief` opts out.
 */
function isBrief(args: Args, given: { options: boolean; questions: boolean; meta: Record<string, unknown>; body: string }): boolean {
  if (bool(args, 'brief')) {
    if (given.options || given.questions || bool(args, 'fyi')) throw new Error(t('cli.send.briefNoOptions'))
    return true
  }
  if (bool(args, 'no-brief') || shellRole() !== 'human') return false
  if (given.options || given.questions || bool(args, 'task') || bool(args, 'fyi')) return false
  if (one(args, 'author', 'a') || given.meta.author || given.meta.kind || parseOptions(given.body).length) return false
  return true
}

/**
 * N111's hook point: nobody is listening in this project, so run
 * `$NODDIT_BRIEF_CMD` (or the older `$DECS_BRIEF_CMD`, detached — `nod add`
 * returns at once) with the brief in its environment. Unset, nothing runs;
 * what it does (notify, start an agent) is the owner's call.
 */
function runBriefHook(d: Decision, root: string): 'ran' | 'unset' | 'failed' {
  const cmd = nodditEnv('BRIEF_CMD')
  if (!cmd) return 'unset'
  try {
    const env = { ...process.env }
    setNodditEnv(env, 'ID', String(d.id))
    setNodditEnv(env, 'REF', refOf(d))
    setNodditEnv(env, 'TITLE', d.title)
    setNodditEnv(env, 'PROJECT', d.project)
    setNodditEnv(env, 'PROJECT_ROOT', root)
    setNodditEnv(env, 'FILE', d.file)
    const child = spawn(cmd, {
      shell: true,
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env,
    })
    child.on('error', () => {})
    child.unref()
    return 'ran'
  } catch {
    return 'failed'
  }
}

/** Nobody is listening and the owner is at a terminal: ask once whether to open a session. */
async function offerSession(layout: Layout, project: string): Promise<void> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const reply = (await rl.question(`${t('cli.send.startSession', { project })} `)).trim().toLowerCase()
  rl.close()
  if (!/^(y|yes|是|好|o|oui|نعم)/.test(reply)) return
  const { agentArg, describeStart, startSession } = await import('./session.ts')
  const r = startSession(layout, agentArg(undefined))
  console.error(describeStart(r, project))
}

/** `yes`/`no` and friends, because that is what people type for a flag like this. */
function yesNo(raw: string | undefined, flag: string): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (['yes', 'y', 'true', '1', '可逆', '是'].includes(v)) return true
  if (['no', 'n', 'false', '0', '不可逆', '否'].includes(v)) return false
  throw new Error(t('cli.send.badYesNo', { flag, value: raw }))
}

/** An ISO time, or a duration from now (`4h`) — stored as ISO either way. */
function dueOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  if (/\d{4}-\d{2}-\d{2}/.test(raw)) {
    if (Number.isNaN(Date.parse(raw))) throw new Error(t('cli.send.badDue', { value: raw }))
    return raw
  }
  return milestoneDue(raw)
}

/** Runs `$NODDIT_NOTIFY_CMD` (or the older `$DECS_NOTIFY_CMD`) if set — no built-in channel, since pinging by default gets muted. */
function notify(d: Decision): void {
  const cmd = nodditEnv('NOTIFY_CMD')
  if (!cmd) {
    console.error(dim(t('cli.send.notifyUnset')))
    return
  }
  try {
    const env = { ...process.env }
    setNodditEnv(env, 'ID', String(d.id))
    setNodditEnv(env, 'REF', refOf(d))
    setNodditEnv(env, 'TITLE', d.title)
    setNodditEnv(env, 'URGENCY', d.urgency ?? 'normal')
    setNodditEnv(env, 'AUTHOR', d.author)
    setNodditEnv(env, 'PROJECT', d.project)
    setNodditEnv(env, 'FILE', d.file)
    setNodditEnv(env, 'DUE', d.due ?? '')
    execSync(cmd, {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 15_000,
      env,
    })
  } catch (e) {
    // The entry is already written; a failed ping must not make the lane think it was not.
    console.error(dim(t('cli.send.notifyFailed', { reason: (e as Error).message.split('\n')[0] })))
  }
}
