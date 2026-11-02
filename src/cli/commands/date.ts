import { parseWhen, suggestDates } from '../../core/fuzzy-date.ts'
import { bool, type Args } from '../args.ts'
import { t } from '../../i18n/index.ts'
import { dayFromToday, dayText } from '../../i18n/time.ts'

const help = () => t('cli.help.date')

/**
 * `nod date "<text>" [--json]`: what a loose date means — "fri", "3d",
 * "下周一" — and what to offer while it's being typed, so a window can
 * preview a `--until` / `--due` entry live.
 */
export function run(args: Args): number {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  const text = args._.join(' ').trim()
  const now = new Date()
  const when = text ? parseWhen(text, now) : null
  const describe = (day: string) => ({ date: day, text: dayText(day, now), relative: dayFromToday(day, now) })
  const label = (key: string) => (key === 'parsed' ? text : t(`cli.date.suggest.${key}`))
  const suggestions = suggestDates(text, now).map((s) => ({ key: s.key, label: label(s.key), parsed: s.parsed, ...describe(s.date) }))
  if (bool(args, 'json')) {
    const parsed = when ? { ...describe(when.day), at: when.at.toISOString(), timed: when.timed } : { date: null, text: null, relative: null, at: null, timed: false }
    console.log(JSON.stringify({ input: text, ok: Boolean(when), ...parsed, suggestions, hint: t('cli.date.hint') }))
    return text && !when ? 1 : 0
  }
  if (!text) {
    for (const s of suggestions) console.log(`${s.date}  ${s.label} · ${s.text} · ${s.relative}`)
    return 0
  }
  if (!when) {
    console.error(t('cli.date.unreadable', { value: text }))
    return 1
  }
  console.log(`${when.day}  ${dayText(when.day, now)} · ${dayFromToday(when.day, now)}`)
  return 0
}
