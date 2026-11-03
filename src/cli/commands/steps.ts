import { bool, one, type Args } from '../args.ts'
import { hasSessionNode, looksLikeRef, requireDecision, resolveAuthor, resolveStore, sessionNode } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { currentStepLabel, makeSteps, markStep, parseSteps, stepProgress } from '../../core/steps.ts'
import { t } from '../../i18n/index.ts'

/**
 * `decs steps` / `decs step` — one module for both, same reason
 * `cli/commands/lifecycle.ts` is one module for start/done/close/ask: they
 * are two faces of one thing, a node's step list.
 */
const HELP_KEYS: Record<string, string> = { steps: 'cli.help.steps', step: 'cli.help.step' }
const help = (verb: string) => t(HELP_KEYS[verb] ?? 'cli.help.steps')
const helpAll = () => Object.values(HELP_KEYS).map((k) => t(k)).join('\n\n')

export async function run(args: Args, verb = ''): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(HELP_KEYS[verb] ? help(verb) : helpAll())
    return 0
  }
  // `nod steps "a" "b"` / `nod step 2`: no id in front means this session's node.
  const implicit = hasSessionNode() && (verb === 'step' ? args._.length === 1 : !args._.length || !looksLikeRef(args._[0]))
  const ref = implicit ? undefined : args._[0]
  const rest = implicit ? args._ : args._.slice(1)
  if (!ref && !implicit) throw new Error(`${t('cli.lifecycle.whichNode')}\n\n${help(verb)}`)

  const store = resolveStore(args, { allowRegistry: true })
  const d = ref ? requireDecision(store, ref, args) : sessionNode(store, args)
  if (!d) throw new Error(`${t('cli.lifecycle.whichNode')}\n\n${help(verb)}`)

  let next
  if (verb === 'steps') {
    if (!rest.length) throw new Error(`${t('cli.steps.needOneStep')}\n\n${help('steps')}`)
    const steps = makeSteps(rest)
    next = store.progress(d, { steps, progress: 0 })
  } else if (verb === 'step') {
    const n = Number(rest[0])
    if (!Number.isInteger(n)) throw new Error(`${t('cli.steps.usage')}\n\n${help('step')}`)
    const steps = markStep(parseSteps(d.steps), n)
    const label = currentStepLabel(steps)
    const extra = one(args, 'note')
    const note = `step ${n}/${steps.length} · ${label}${extra ? ` — ${extra}` : ''}`
    next = store.progress(d, {
      steps,
      progress: stepProgress(steps),
      progressMsg: label,
      note,
      by: resolveAuthor(args),
    })
  } else {
    throw new Error(`unknown verb ${verb}`)
  }

  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
  else console.log(`${refOf(next)} ${next.progress}%${next.progressMsg ? ` ${next.progressMsg}` : ''}`)
  return 0
}
