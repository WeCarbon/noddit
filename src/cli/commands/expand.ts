import { readFileSync } from 'node:fs'
import { bool, one, oneLine, type Args } from '../args.ts'
import { guardOtherAuthor, readStdin, requireDecision, resolveAuthor, resolveStore, shellRole } from '../context.ts'
import { isHumanTask } from '../../core/assignee.ts'
import { refOf } from '../../core/ref.ts'
import { dim, toJSON } from '../../core/render.ts'
import { assertTitleFits } from '../../core/title.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.expand')

/** `nod expand <id>` — write the full description of a brief; the owner's words under `## 原话` stay. */
export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  if (!args._.length) throw new Error(`${t('cli.claim.whichNode')}\n\n${help()}`)
  const bodyFile = one(args, 'body-file', 'f')
  const description = (one(args, 'body') ?? (bodyFile ? readFileSync(bodyFile, 'utf8') : await readStdin())).trim()
  if (!description) throw new Error(`${t('cli.expand.needBody')}\n\n${help()}`)
  const title = one(args, 'title')
  if (title) assertTitleFits(oneLine(title))

  const store = resolveStore(args, { allowRegistry: true })
  let d = requireDecision(store, args._[0], args)
  if (isHumanTask(d) && shellRole() === 'agent' && !bool(args, 'force')) throw new Error(t('cli.lifecycle.humanTask', { ref: refOf(d) }))
  // Expanding an unclaimed brief takes it, atomically, like `nod claim`.
  if (d.intake && !d.claimedBy) d = store.claim(d, resolveAuthor(args)).node
  guardOtherAuthor(store, d, args)
  const next = store.expand(d, { description, title: title ? oneLine(title) : undefined })
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
  else {
    console.log(t('cli.expand.done', { ref: refOf(next), title: next.title }))
    console.log(dim(t('cli.expand.next', { ref: refOf(next) })))
  }
  return 0
}
