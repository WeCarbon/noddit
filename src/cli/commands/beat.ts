import { bool, one, type Args } from '../args.ts'
import { guardOtherAuthor, hasSessionNode, requireDecision, resolveAuthor, resolveStore, sessionNode } from '../context.ts'
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
  if (!args._.length && !hasSessionNode()) throw new Error(`${t('cli.beat.whichNode')}\n\n${help()}`)
  const note = one(args, 'note')
  const store = resolveStore(args, { allowRegistry: true })
  const author = resolveAuthor(args)
  const asJson = bool(args, 'json')
  const fallback = args._.length ? undefined : sessionNode(store, args)
  if (!args._.length && !fallback) throw new Error(`${t('cli.beat.whichNode')}\n\n${help()}`)
  const nodes = fallback ? [fallback] : args._.map((ref) => requireDecision(store, ref, args))

  for (const d of nodes) {
    guardOtherAuthor(store, d, args)
    const next = note ? store.note(d, { text: note, role: 'agent', author, kind: NOTE_KIND.heartbeat }) : store.rewrite(d)
    if (asJson) console.log(JSON.stringify(toJSON(next)))
    else console.log(`${refOf(next)} ${t('cli.beat.done')}`)
  }
  return 0
}
