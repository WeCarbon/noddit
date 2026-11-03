import { bool, type Args } from '../args.ts'
import { rememberStarted, requireDecision, resolveAuthor, resolveStore } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { dim, toJSON } from '../../core/render.ts'
import { ClaimedError, roleOf } from '../../core/store.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.claim')

/** `nod claim <id>` — take a brief the owner filed, so no other session expands it too. */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  if (!args._.length) throw new Error(`${t('cli.claim.whichNode')}\n\n${help()}`)
  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, args._[0], args)
  const force = bool(args, 'force')
  const asJson = bool(args, 'json')
  // Briefs, and nodes the owner wrote by hand; an agent's node is that agent's.
  if (!d.intake && roleOf(d.author) !== 'human' && !force) throw new Error(t('cli.claim.notABrief', { ref: refOf(d), author: d.author }))
  try {
    const author = resolveAuthor(args)
    const { node, already } = store.claim(d, author, { force })
    rememberStarted(store, node, author)
    if (asJson) console.log(JSON.stringify({ ok: true, already, ...toJSON(node) }))
    else {
      console.log(already ? t('cli.claim.alreadyYours', { ref: refOf(node) }) : t('cli.claim.claimed', { ref: refOf(node) }))
      if (!already) console.log(dim(t('cli.claim.next', { ref: refOf(node) })))
    }
    return 0
  } catch (e) {
    if (!(e instanceof ClaimedError)) throw e
    if (asJson) console.log(JSON.stringify({ ok: false, already: false, ...toJSON(e.node) }))
    console.error(e.message)
    return 1
  }
}
