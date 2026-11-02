import { dayKey, parseWhen } from '../../core/fuzzy-date.ts'
import { isDeferred, statusLabel } from '../../core/status.ts'
import { nowStamp } from '../../core/store.ts'
import { dayText } from '../../i18n/time.ts'
import { bool, one, type Args } from '../args.ts'
import { requireDecision, resolveAuthor, resolveStore, shellRole } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { type NoteRole } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.defer')

/** `--until fri` / `3d` / `2026-11-15` / `下周一`: the start of that day (or the time given), which must still be ahead. */
export function deferUntil(raw: string, now = new Date()): Date {
  const when = parseWhen(raw, now)
  if (!when) throw new Error(t('cli.date.unreadable', { value: raw }))
  if (when.at.getTime() <= now.getTime()) throw new Error(t('cli.defer.untilPast', { value: raw, date: dayText(when.day, now) }))
  return when.at
}

export async function run(args: Args, verb = 'defer'): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  if (!args._.length) throw new Error(`${t('cli.lifecycle.whichNode')}\n\n${help()}`)
  if (bool(args, 'human') && bool(args, 'agent')) throw new Error(t('cli.push.humanOrAgentOnly'))
  const off = verb === 'undefer' || bool(args, 'off')
  const role: NoteRole = bool(args, 'human') ? 'human' : bool(args, 'agent') ? 'agent' : shellRole()
  const by = one(args, 'by') ?? (role === 'human' ? 'owner' : resolveAuthor(args))
  const untilRaw = one(args, 'until')
  if (off && untilRaw) throw new Error(t('cli.defer.untilWithOff'))
  const until = untilRaw ? deferUntil(untilRaw) : undefined
  const store = resolveStore(args, { allowRegistry: true })
  for (const ref of args._) {
    const d = requireDecision(store, ref, args)
    const next = off ? store.undefer(d, { by, role }) : store.defer(d, { by, role, until: until && nowStamp(until) })
    if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
    else {
      const what = off
        ? d.deferredAt
          ? t('cli.defer.undeferred')
          : t('cli.defer.wasNotDeferred')
        : until
          ? t('cli.defer.deferredUntil', { date: dayText(dayKey(until)) })
          : isDeferred(d) && !d.deferredUntil
            ? t('cli.defer.wasAlreadyDeferred')
            : t('cli.defer.deferred')
      console.log(`${refOf(next)} ${what} · ${statusLabel(next.state)}`)
    }
  }
  return 0
}
