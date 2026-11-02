import { bool, type Args } from '../args.ts'
import { refOf } from '../../core/ref.ts'
import { requireDecision, resolveStore } from '../context.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.order')

export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const refs = args._
  if (!refs.length) throw new Error(`${t('cli.order.whichOne')}\n\n${help()}`)

  const store = resolveStore(args, { allowRegistry: true })
  const ds = refs.map((r) => requireDecision(store, r, args))
  const next = bool(args, 'clear') ? ds.map((d) => store.unarrange(d)) : store.arrange(ds)
  if (bool(args, 'json')) {
    console.log(JSON.stringify(next.map((d) => ({ ref: refOf(d), order: d.order ?? null })), null, 2))
    return 0
  }
  const list = next.map((d) => refOf(d)).join(' ')
  console.log(bool(args, 'clear') ? t('cli.order.cleared', { refs: list }) : t('cli.order.done', { refs: list }))
  return 0
}
