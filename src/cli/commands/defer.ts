import { dayKey, parseWhen, untilDay } from '../../core/fuzzy-date.ts'
import { isDeferred, statusLabel } from '../../core/status.ts'
import { nowStamp } from '../../core/store.ts'
import { dayText } from '../../i18n/time.ts'
import { bool, one, type Args } from '../args.ts'
import { requireDecision, resolveAuthor, resolveStore, shellRole } from '../context.ts'
import { refOf } from '../../core/ref.ts'
import { toJSON } from '../../core/render.ts'
import { type Decision, type NoteRole } from '../../core/types.ts'
import { t } from '../../i18n/index.ts'
import { everyArg } from './send.ts'

const help = () => t('cli.help.defer')

/** `--until fri` / `3d` / `2026-11-15` / `下周一`: the start of that day (or the time given), which must still be ahead. */
export function deferUntil(raw: string, now = new Date()): Date {
  const when = parseWhen(raw, now)
  if (!when) throw new Error(t('cli.date.unreadable', { value: raw }))
  if (when.at.getTime() <= now.getTime()) throw new Error(t('cli.defer.untilPast', { value: raw, date: dayText(when.day, now) }))
  return when.at
}

/**
 * `nod defer` and `nod hold` are two spellings of one 延迟: `--on` (or a node already waiting
 * given a new day) makes it an active wait; a day alone, or nothing, a passive deferral.
 */
export async function run(args: Args, verb = 'defer'): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(verb === 'hold' ? t('cli.help.hold') : help())
    return 0
  }
  if (!args._.length) throw new Error(`${t('cli.lifecycle.whichNode')}\n\n${help()}`)
  if (bool(args, 'human') && bool(args, 'agent')) throw new Error(t('cli.push.humanOrAgentOnly'))
  const off = verb === 'undefer' || bool(args, 'off')
  const role: NoteRole = bool(args, 'human') ? 'human' : bool(args, 'agent') ? 'agent' : shellRole()
  const by = one(args, 'by') ?? (role === 'human' ? 'owner' : resolveAuthor(args))
  const untilRaw = one(args, 'until')
  const onRaw = one(args, 'on')
  const on = onRaw && onRaw !== 'true' ? onRaw.trim() : undefined
  if (onRaw === 'true') throw new Error(`${t('cli.lifecycle.needOn')}\n\n${t('cli.help.hold')}`)
  if (off && (untilRaw || on)) throw new Error(t('cli.defer.untilWithOff'))
  const everyRaw = one(args, 'every')
  if (everyRaw !== undefined && (untilRaw || on || off)) throw new Error(t('cli.defer.everyAlone'))
  const every = everyRaw === undefined || everyRaw === 'true' ? undefined : everyArg(everyRaw)
  const until = untilRaw ? deferUntil(untilRaw) : undefined
  const store = resolveStore(args, { allowRegistry: true })
  for (const ref of args._) {
    const d = requireDecision(store, ref, args)
    if (!off && (on || (d.state === 'waiting' && until)) && !until && !(d.state === 'waiting' && d.waitingUntil))
      throw new Error(`${t('cli.lifecycle.needUntil')}\n\n${t('cli.help.hold')}`)
    const byEvery = everyRaw !== undefined
    const next = off ? store.undelay(d, { by, role }) : byEvery ? store.delayEvery(d, { by, role, every }) : store.delay(d, { by, role, until: until && nowStamp(until), on })
    const back = byEvery ? new Date(next.waitingUntil ?? next.deferredUntil ?? '') : until
    if (bool(args, 'json')) console.log(JSON.stringify(toJSON(next)))
    else console.log(`${refOf(next)} ${off ? offText(d) : delayText(d, next, back)} · ${statusLabel(next.state)}`)
  }
  return 0
}

function offText(before: Decision): string {
  if (before.state === 'waiting') return t('cli.lifecycle.holdOff')
  return before.deferredAt ? t('cli.defer.undeferred') : t('cli.defer.wasNotDeferred')
}

function delayText(before: Decision, next: Decision, until: Date | undefined): string {
  if (next.state === 'waiting') {
    const day = next.waitingUntil ? dayText(untilDay(next.waitingUntil) ?? next.waitingUntil) : ''
    return day ? t('cli.lifecycle.waitingOnUntil', { on: next.waitingOn ?? '', date: day }) : t('cli.lifecycle.waitingOnWhat', { on: next.waitingOn ?? '' })
  }
  if (until) return t('cli.defer.deferredUntil', { date: dayText(dayKey(until)) })
  return isDeferred(before) && !before.deferredUntil && before.state !== 'waiting' ? t('cli.defer.wasAlreadyDeferred') : t('cli.defer.deferred')
}
