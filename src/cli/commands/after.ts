import { bool, type Args } from '../args.ts'
import { guardOtherAuthor, requireDecision, resolveStore } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { t } from '../../i18n/index.ts'

/** `nod after <id> <dep>…` — queue a node behind others; `--clear` lets it start freely. */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(t('cli.help.after'))
    return 0
  }
  const [ref, ...deps] = args._
  const clear = bool(args, 'clear')
  if (!ref || (!deps.length && !clear)) throw new Error(t('cli.help.after'))
  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  guardOtherAuthor(store, d, args)
  const resolved = deps.map((r) => refOf(requireDecision(store, r, args)))
  const next = store.setAfter(d, clear ? [] : resolved)
  console.log(clear ? t('cli.after.cleared', { ref: refOf(next) }) : t('cli.after.set', { ref: refOf(next), deps: resolved.join(', ') }))
  return 0
}
