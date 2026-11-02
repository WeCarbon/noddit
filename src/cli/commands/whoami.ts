import { bool, type Args } from '../args.ts'
import { nodditEnv } from '../../core/env.ts'
import { currentIdentity, currentSession } from '../../core/identity.ts'
import { harnessOf } from '../../core/listeners.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.whoami')

/** `nod whoami` — the identity (`core/identity.ts`) this process writes under
 *  right now: the invisible `<!-- nod:by=… -->` marker, and what `--mine`
 *  matches. Mainly for checking `NODDIT_IDENTITY` took effect, or why it didn't. */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const identity = currentIdentity()
  const session = currentSession()
  const explicit = Boolean(nodditEnv('IDENTITY'))
  const author = nodditEnv('AUTHOR')
  if (bool(args, 'json')) {
    console.log(JSON.stringify({
      identity: identity ?? null,
      explicit,
      author: author ?? null,
      session: session ?? null,
      harness: harnessOf(),
    }))
    return 0
  }
  if (!identity) {
    console.log(t('cli.whoami.none'))
    return 0
  }
  const source = explicit ? t('cli.whoami.fromAgent') : t('cli.whoami.fromAuthorSession')
  console.log(t('cli.whoami.identity', { identity, source }))
  return 0
}
