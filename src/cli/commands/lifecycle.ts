import { deferUntil } from './defer.ts'
import { untilDay } from '../../core/fuzzy-date.ts'
import { nowStamp } from '../../core/store.ts'
import { dayText } from '../../i18n/time.ts'
import { statusLabel } from '../../core/status.ts'
import { bool, many, one, optionsAndDefault, type Args } from '../args.ts'
import { guardOtherAuthor, readStdin, requireDecision, resolveAuthor, resolveStore, shellRole, warnOtherAuthor } from '../context.ts'
import { isHumanTask } from '../../core/assignee.ts'
import { refOf } from '../../core/ref.ts'
import { dim, toJSON } from '../../core/render.ts'
import { type Decision } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'

/** `decs start | done | close | ask` — moving one node through its life. */
const HELP_KEYS: Record<string, string> = {
  start: 'cli.help.start',
  done: 'cli.help.done',
  close: 'cli.help.close',
  hold: 'cli.help.hold',
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
    const text = one(args, 'text') ?? ((await readStdin()).trim() || undefined)
    let next = store.ask(d, { options, default: def, text, author: resolveAuthor(args) })
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
    return 0
  }

  for (const ref of args._) {
    const d = requireDecision(store, ref, args)
    // Starting a brief goes through `claim`, which settles (and says) who has it.
    if (!(verb === 'start' && d.intake)) guardOtherAuthor(store, d, args)
    if (verb === 'start') {
      // The owner's own to-do: an agent doesn't work on it (`--force` when the owner said so).
      if (isHumanTask(d) && shellRole() === 'agent' && !force) throw new Error(t('cli.lifecycle.humanTask', { ref: refOf(d) }))
      // Starting a brief is taking it: the same atomic claim as `nod claim`.
      const node = d.intake ? store.claim(d, resolveAuthor(args), { force }).node : d
      report(args, store.start(node, { force }), t('cli.lifecycle.started'))
    }
    else if (verb === 'hold') {
      const raw = one(args, 'on')
      const on = raw && raw !== 'true' ? raw : undefined
      const untilRaw = one(args, 'until')
      const waiting = d.state === 'waiting'
      // Already waiting: --until alone moves the day, --on alone changes who and keeps the day.
      if (!on && !(waiting && untilRaw)) throw new Error(`${t('cli.lifecycle.needOn')}\n\n${help('hold')}`)
      // Every wait has a day to check back on.
      if (!untilRaw && !(waiting && d.waitingUntil)) throw new Error(`${t('cli.lifecycle.needUntil')}\n\n${help('hold')}`)
      const until = untilRaw ? nowStamp(deferUntil(untilRaw)) : undefined
      const role = shellRole()
      const next = store.hold(d, on, role === 'human' ? (one(args, 'by') ?? 'owner') : resolveAuthor(args), { until, role })
      const day = next.waitingUntil ? dayText(untilDay(next.waitingUntil) ?? next.waitingUntil) : ''
      report(args, next, day ? t('cli.lifecycle.waitingOnUntil', { on: next.waitingOn ?? '', date: day }) : t('cli.lifecycle.waitingOnWhat', { on: next.waitingOn ?? '' }))
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
