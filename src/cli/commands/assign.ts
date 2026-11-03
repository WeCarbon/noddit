import { assigneeArg, isHumanTask, isMilestoneWord } from '../../core/assignee.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { bool, one, type Args } from '../args.ts'
import { requireDecision, resolveStore, shellRole } from '../context.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.assign')

/**
 * `nod assign <id> me|ai|milestone`. An agent may hand the owner a to-do;
 * taking one of the owner's back for an AI is the owner's call, so it needs
 * `--force`. `milestone` is the third kind — never needs `--force` either
 * way, since it isn't anyone's to-do to take back.
 */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [ref, who] = args._
  if (!ref || !who) throw new Error(`${t('cli.assign.which')}\n\n${help()}`)
  const milestone = isMilestoneWord(who)
  const assignee = milestone ? undefined : assigneeArg(who)
  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  if (milestone) {
    const next = store.setMilestone(d, true)
    if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
    else console.log(t('cli.assign.toMilestone', { ref: refOf(next) }))
    return 0
  }
  const role = bool(args, 'human') ? 'human' : bool(args, 'agent') ? 'agent' : shellRole()
  if (!assignee && isHumanTask(d) && role === 'agent' && !bool(args, 'force')) throw new Error(t('cli.assign.agentTakesHuman', { ref: refOf(d) }))
  // The owner handing their own to-do to an AI is a request, heard by the AI's monitor.
  const handOff = !assignee && isHumanTask(d) && role === 'human'
  const note = one(args, 'note')
  const next = handOff ? store.handToAi(d, { by: one(args, 'by') ?? 'owner', text: note }) : store.assign(d, assignee)
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
  else console.log(t(handOff ? 'cli.assign.handedToAi' : assignee ? 'cli.assign.toHuman' : 'cli.assign.toAi', { ref: refOf(next) }))
  return 0
}
