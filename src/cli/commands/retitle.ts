import { bool, one, oneLine, type Args } from '../args.ts'
import { requireDecision, resolveAuthor, resolveStore, shellRole } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { dim } from '../../core/render.ts'
import { toJSON } from '../../core/render.ts'
import { TITLE_MAX_COLS, assertTitleFits } from '../../core/title.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.retitle', { max: TITLE_MAX_COLS, half: Math.floor(TITLE_MAX_COLS / 2) })

export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [ref, ...rest] = args._
  const title = oneLine(rest.join(' '))
  if (!ref || !title) throw new Error(`${t('cli.retitle.usage')}\n\n${help()}`)
  assertTitleFits(title)

  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  const role = bool(args, 'human') ? 'human' : bool(args, 'agent') ? 'agent' : shellRole()
  const by = one(args, 'by') ?? (role === 'human' ? 'owner' : resolveAuthor(args))
  const next = store.retitle(d, title, { by, role, expect: one(args, 'expect') })
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
  else console.log(next === d ? t('cli.retitle.unchanged', { ref: refOf(d) }) : `${refOf(next)} ${dim(d.title)} → ${next.title}`)
  return 0
}
