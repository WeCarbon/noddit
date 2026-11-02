import { assigneeArg, isHumanTask } from '../../core/assignee.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { bool, type Args } from '../args.ts'
import { requireDecision, resolveStore, shellRole } from '../context.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.assign')

/**
 * `nod assign <id> me|ai`. An agent may hand the owner a to-do; taking one of
 * the owner's back for an AI is the owner's call, so it needs `--force`.
 */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [ref, who] = args._
  if (!ref || !who) throw new Error(`${t('cli.assign.which')}\n\n${help()}`)
  const assignee = assigneeArg(who)
  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  if (!assignee && isHumanTask(d) && shellRole() === 'agent' && !bool(args, 'force')) throw new Error(t('cli.assign.agentTakesHuman', { ref: refOf(d) }))
  const next = store.assign(d, assignee)
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
  else console.log(t(assignee ? 'cli.assign.toHuman' : 'cli.assign.toAi', { ref: refOf(next) }))
  return 0
}
