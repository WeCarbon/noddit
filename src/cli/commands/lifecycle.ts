import { isDeferred, statusLabel } from '../../core/status.ts'
import { bool, many, one, optionsAndDefault, questionsFromArgs, type Args } from '../args.ts'
import { guardOtherAuthor, readStdin, rememberStarted, requireDecision, resolveAuthor, resolveStore, shellRole, warnOtherAuthor } from '../context.ts'
import { isHumanTask } from '../../core/assignee.ts'
import { optionsWithoutCost } from '../../core/option-costs.ts'
import { refOf } from '../../core/ref.ts'
import { dim, toJSON } from '../../core/render.ts'
import { recordAuthor } from '../../core/session-nodes.ts'
import { type Decision } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'

/** `decs start | done | close | ask` — moving one node through its life. */
const HELP_KEYS: Record<string, string> = {
  start: 'cli.help.start',
  done: 'cli.help.done',
  close: 'cli.help.close',
  ask: 'cli.help.ask',
}
const help = (verb: string) => t(HELP_KEYS[verb] ?? 'cli.help.start')
const helpAll = () => Object.values(HELP_KEYS).map((k) => t(k)).join('\n\n')

function report(args: Args, d: Decision, what: string): void {
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(d)))
  else console.log(`${refOf(d)} ${what} · ${statusLabel(d.state)}${d.archived ? dim(` → ${d.file}`) : ''}`)
}

export async function run(args: Args, verb = ''): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(HELP_KEYS[verb] ? help(verb) : helpAll())
    return 0
  }
  if (!args._.length) throw new Error(`${t('cli.lifecycle.whichNode')}\n\n${help(verb)}`)
  const store = resolveStore(args, { allowRegistry: true })
  const force = bool(args, 'force')

  if (verb === 'ask') {
    const d = requireDecision(store, args._[0], args)
    guardOtherAuthor(store, d, args)
    const { options, default: def } = optionsAndDefault(args)
    const questions = questionsFromArgs(args)
    const text = one(args, 'text') ?? ((await readStdin()).trim() || undefined)
    let next = store.ask(d, { options, default: def, text, author: resolveAuthor(args), questions, summary: one(args, 'summary') })
    // --attach: the draft goes with the question that presents it (its own section when there is text).
    const sources = many(args, 'attach')
    if (sources.length) {
      const groups = many(args, 'label')
      const captions = many(args, 'caption')
      const approveOn = many(args, 'approve-on').flatMap((v) => v.split(/[,，\s]+/)).filter(Boolean)
      next = store.attach(next, sources, {
        link: bool(args, 'link'),
        groups: groups.length ? groups : undefined,
        captions: captions.length ? captions : undefined,
        approvalContent: bool(args, 'approval-content'),
        approveOn: approveOn.length ? approveOn : undefined,
        to: text ? 'last' : undefined,
        by: resolveAuthor(args),
      })
    }
    warnOtherAuthor(next.author, refOf(next), next.claimedBy)
    report(args, next, t('cli.lifecycle.waitingOnOwner', { count: next.options.length }))
    const bare = shellRole() === 'agent' ? optionsWithoutCost(next) : []
    if (bare.length) console.error(t('cli.send.optionsWithoutCost', { keys: bare.join(' '), id: next.id }))
    if (!bool(args, 'json') && shellRole() === 'agent') console.log(dim(t('cli.lifecycle.askNext')))
    return 0
  }

  for (const ref of args._) {
    const d = requireDecision(store, ref, args)
    // Starting a brief goes through `claim`, which settles (and says) who has it.
    if (!(verb === 'start' && d.intake)) guardOtherAuthor(store, d, args)
    if (verb === 'start') {
      // The owner's own to-do: an agent doesn't work on it (`--force` when the owner said so).
      if (isHumanTask(d) && shellRole() === 'agent' && !force) throw new Error(t('cli.lifecycle.humanTask', { ref: refOf(d) }))
      // The owner put it aside: an agent leaves it until it comes back.
      if (isDeferred(d) && shellRole() === 'agent' && !force) throw new Error(t('cli.lifecycle.deferredByOwner', { ref: refOf(d) }))
      const author = shellRole() === 'agent' ? resolveAuthor(args) : undefined
      // N267: nod start under any author — explicit, NODDIT_AUTHOR, or the branch guess —
      // is remembered for this session, not just an explicit --author (resolveAuthor's own case).
      if (author) recordAuthor(author)
      // Starting a brief is taking it: the same atomic claim as `nod claim`.
      const node = d.intake ? store.claim(d, author ?? resolveAuthor(args), { force }).node : d
      const started = store.start(node, { force })
      report(args, started, t('cli.lifecycle.started'))
      if (author && rememberStarted(store, started, author) && !bool(args, 'json') && ref === args._.at(-1))
        console.log(dim(t('cli.lifecycle.currentNode', { ref: refOf(started) })))
    }
    else if (verb === 'done') {
      if (d.state === 'needs_decision' && !force)
        throw new Error(t('cli.lifecycle.stillNeedsDecision', { ref: refOf(d) }))
      report(args, store.complete(d, { note: one(args, 'note'), author: resolveAuthor(args) }), t('cli.lifecycle.done'))
    } else if (verb === 'close') {
      const reason = one(args, 'reason')
      if (!reason || reason === 'true') throw new Error(`${t('cli.lifecycle.needReason')}\n\n${help('close')}`)
      report(args, store.close(d, reason), t('cli.lifecycle.closed', { reason }))
    } else throw new Error(`unknown verb ${verb}`)
  }
  return 0
}
