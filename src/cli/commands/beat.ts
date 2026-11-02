import { bool, one, type Args } from '../args.ts'
import { guardOtherAuthor, requireDecision, resolveAuthor, resolveStore } from '../context.ts'
import { nodditNodeEnv } from '../../core/env.ts'
import { NOTE_KIND } from '../../core/format.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.beat')

/**
 * `nod beat [<id>…] [--note "…"]` — "I'm still on it": counts as a reply to
 * a check-in (`core/checkins.ts` resets on any write, via `Store.write()`),
 * touches `updated_at`, and writes a visible note only when `--note` is
 * given (otherwise `store.rewrite` — the same silent touch `nod migrate
 * --upgrade` uses).
 */
export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const ids = args._.length ? args._ : [nodditNodeEnv()].filter((x): x is string => Boolean(x))
  if (!ids.length) throw new Error(`${t('cli.beat.whichNode')}\n\n${help()}`)
  const note = one(args, 'note')
  const store = resolveStore(args, { allowRegistry: true })
  const author = resolveAuthor(args)
  const asJson = bool(args, 'json')

  for (const ref of ids) {
    const d = requireDecision(store, ref, args)
    guardOtherAuthor(store, d, args)
    const next = note ? store.note(d, { text: note, role: 'agent', author, kind: NOTE_KIND.heartbeat }) : store.rewrite(d)
    if (asJson) console.log(JSON.stringify(toJSON(next)))
    else console.log(`${refOf(next)} ${t('cli.beat.done')}`)
  }
  return 0
}
