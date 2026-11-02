import { bool, one, type Args } from '../args.ts'
import { requireDecision, resolveAuthor, resolveStore, shellRole } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { nowStamp } from '../../core/store.ts'
import { parseDuration } from '../../core/duration.ts'
import { NOTE_KIND } from '../../core/format.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.flag')

type How = 'important' | 'milestone' | 'normal'

const HOW: Record<string, How> = { important: 'important', milestone: 'milestone', normal: 'normal', off: 'normal', none: 'normal' }

/** A date alone (`2026-11-15`) means the end of that day, here; a time or `3d` is taken as given. */
export function milestoneDue(raw: string, now = new Date()): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (day) return nowStamp(new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59))
  if (/\d{4}-\d{2}-\d{2}/.test(raw)) {
    if (Number.isNaN(Date.parse(raw))) throw new Error(t('cli.send.badDue', { value: raw }))
    return raw
  }
  return nowStamp(new Date(now.getTime() + parseDuration(raw)))
}

/**
 * `nod flag <id> important | milestone [--due <date>] | normal`. The owner's to set:
 * run by an agent, it only records a proposal on the node, unless `--force` (the owner
 * said so in a conversation).
 */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const [ref, raw] = args._
  if (!ref || !raw) throw new Error(`${t('cli.flag.which')}\n\n${help()}`)
  const how = HOW[raw.toLowerCase()]
  if (!how) throw new Error(t('cli.flag.badHow', { value: raw }))
  const dueRaw = one(args, 'due')
  const due = dueRaw ? milestoneDue(dueRaw) : undefined
  const store = resolveStore(args, { allowRegistry: true })
  const d = requireDecision(store, ref, args)
  const change = how === 'important' ? { important: true, due } : how === 'milestone' ? { milestone: true, due } : { important: false, milestone: false, due }
  const label = how === 'milestone' ? t('cli.flag.milestone', { due: (due ?? d.due ?? '').slice(0, 16).replace('T', ' ') }) : t(`cli.flag.${how}`)

  if (shellRole() === 'agent' && !bool(args, 'force')) {
    // Agents propose; the owner decides.
    const proposal = t('cli.flag.proposal', { what: label })
    const next = store.note(d, { text: proposal, role: 'agent', author: resolveAuthor(args), kind: NOTE_KIND.addendum })
    if (bool(args, 'json')) console.log(JSON.stringify({ ...toJSON(next), proposed: how }))
    else console.log(t('cli.flag.proposed', { ref: refOf(d), what: label }))
    return 0
  }
  const next = store.flag(d, change)
  if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
  else console.log(t('cli.flag.done', { ref: refOf(next), what: label }))
  return 0
}
