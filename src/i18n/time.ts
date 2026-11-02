import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import updateLocale from 'dayjs/plugin/updateLocale.js'
import 'dayjs/locale/zh-cn.js'
import 'dayjs/locale/zh-tw.js'
import 'dayjs/locale/fr.js'
import 'dayjs/locale/ar.js'
import { lang, type Lang } from './index.ts'

dayjs.extend(relativeTime)
dayjs.extend(updateLocale)

const DAYJS_LOCALE: Record<Lang, string> = { en: 'en', 'zh-Hans': 'zh-cn', 'zh-Hant': 'zh-tw', fr: 'fr', ar: 'ar' }

type Unit = 'minute' | 'hour' | 'day' | 'month' | 'year'

/** dayjs's Arabic misses the dual and the 11+ forms ("منذ 2 أيام"); Intl knows them. Latin digits, like the rest of the UI. */
function arabic(unit: Unit, single = false) {
  const ago = new Intl.RelativeTimeFormat('ar-u-nu-latn', { numeric: 'always' })
  const span = new Intl.NumberFormat('ar-u-nu-latn', { style: 'unit', unit, unitDisplay: 'long' })
  // dayjs hands the singular keys (h, d, …) the previous unit's count; they always mean one.
  return (count: number, withoutSuffix: boolean, _key: string, isFuture: boolean) => {
    const n = single ? 1 : count
    return withoutSuffix ? span.format(n) : ago.format(isFuture ? n : -n, unit)
  }
}

dayjs.updateLocale('ar', {
  relativeTime: {
    future: '%s',
    past: '%s',
    s: (_n: number, withoutSuffix: boolean) => (withoutSuffix ? 'ثوانٍ' : 'قبل لحظات'),
    m: arabic('minute', true),
    mm: arabic('minute'),
    h: arabic('hour', true),
    hh: arabic('hour'),
    d: arabic('day', true),
    dd: arabic('day'),
    M: arabic('month', true),
    MM: arabic('month'),
    y: arabic('year', true),
    yy: arabic('year'),
  },
})

type When = string | number | Date

/** "3 days ago" / "3 天前" / "il y a 3 jours" / "قبل 3 أيام", in the current language. */
export function fromNow(at: When, now: When = Date.now()): string {
  const d = dayjs(at)
  return d.isValid() ? d.locale(DAYJS_LOCALE[lang()]).from(dayjs(now)) : String(at)
}

/** The same span without "ago": "3 days" / "3 天" — for "waited 3 days". */
export function elapsed(at: When, now: When = Date.now()): string {
  const d = dayjs(at)
  return d.isValid() ? d.locale(DAYJS_LOCALE[lang()]).from(dayjs(now), true) : ''
}

/** A length of time on its own: `durationText(90 * 60_000)` → "2 hours". */
export function durationText(ms: number): string {
  return elapsed(0, Math.max(0, ms))
}

const INTL_LOCALE: Record<Lang, string> = { en: 'en', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', fr: 'fr', ar: 'ar-u-nu-latn' }

const dayOf = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** A calendar day (`YYYY-MM-DD`) the way the current language writes it: "Fri, Nov 13" / "11月13日周五"; the year only when it isn't this one. */
export function dayText(key: string, now: Date = new Date()): string {
  const day = dayOf(key)
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }
  return new Intl.DateTimeFormat(INTL_LOCALE[lang()], opts).format(day)
}

/** "tomorrow" / "in 3 days" / "明天" / "3天后" — whole days from today to `key`. */
export function dayFromToday(key: string, now: Date = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((dayOf(key).getTime() - today.getTime()) / 86_400_000)
  return new Intl.RelativeTimeFormat(INTL_LOCALE[lang()], { numeric: 'auto' }).format(days, 'day')
}
