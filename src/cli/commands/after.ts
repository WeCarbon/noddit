import { bool, one, type Args } from '../args.ts'
import { guardOtherAuthor, requireDecision, resolveStore } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { t } from '../../i18n/index.ts'

/**
 * `nod after <id> <dep>…` — queue a node behind others; `--clear` lets it start freely.
 * `nod after --before <dep> <id> <id>…` hangs that same one dependency on several nodes at
 * once, instead of running the plain form once per id.
 */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(t('cli.help.after'))
    return 0
  }
  const store = resolveStore(args, { allowRegistry: true })
  const before = one(args, 'before')
  if (before !== undefined) {
    const ids = args._
    if (!ids.length) throw new Error(t('cli.help.after'))
    const dep = refOf(requireDecision(store, before, args))
    const refs = ids.map((ref) => {
      const d = requireDecision(store, ref, args)
      guardOtherAuthor(store, d, args)
      return refOf(store.setAfter(d, [dep]))
    })
    console.log(t('cli.after.setMany', { refs: refs.join(', '), dep }))
    return 0
  }
  const [ref, ...deps] = args._
  const clear = bool(args, 'clear')
  if (!ref || (!deps.length && !clear)) throw new Error(t('cli.help.after'))
  const d = requireDecision(store, ref, args)
  guardOtherAuthor(store, d, args)
  const resolved = deps.map((r) => refOf(requireDecision(store, r, args)))
  const next = store.setAfter(d, clear ? [] : resolved)
  console.log(clear ? t('cli.after.cleared', { ref: refOf(next) }) : t('cli.after.set', { ref: refOf(next), deps: resolved.join(', ') }))
  return 0
}
