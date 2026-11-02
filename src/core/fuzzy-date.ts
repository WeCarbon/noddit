/**
 * Loose date input → a calendar day (`YYYY-MM-DD`, local time). Only the day
 * matters here: a month, quarter or year alone means its first day.
 *
 * English: today / tomorrow / yesterday; mon … sunday (the nearest one, today
 *   included); next / last <weekday>; 3d / 2w / in 3 days / 3 days later /
 *   3 days ago; N weeks / months; next / last / this week / month / quarter /
 *   year; 14 / 14th (this month); 2026-11-15; 11/15[/2026]; nov 15 / 15 nov
 *   [2026]; nov [2026]; q3 [2026]; 2026.
 * Chinese: 今天 / 明天 / 后天 / 大后天 / 昨天 / 前天; 周一…周日 / 星期一…星期天
 *   (the nearest one); 下周三 / 上周五 / 这周二; N 天后 / N 天前 / N 周后 /
 *   N 个月后; 下周 / 上周 / 下个月 / 月初 / 月底 / 明年; 11月15日 / 11.15 / 15号.
 */

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
}
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
}
const ZH_WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const ZH_DIGIT: Record<string, number> = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const WD = Object.keys(WEEKDAYS).join('|')
const MO = Object.keys(MONTHS).join('|')
const ORD = '(?:st|nd|rd|th)?'
const ZH_N = '(\\d+|[一二两三四五六七八九十]+)'

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)

/** The day if it exists (no 31 November), else null. */
function valid(y: number, mo: number, da: number): string | null {
  const d = new Date(y, mo, da)
  return d.getMonth() === mo && d.getDate() === da ? dayKey(d) : null
}

/** Days until the next `target` weekday; today counts when `inclusive`. */
function untilWeekday(now: Date, target: number, inclusive: boolean): number {
  const delta = (target - now.getDay() + 7) % 7
  return delta === 0 ? (inclusive ? 0 : 7) : delta
}

function sinceWeekday(now: Date, target: number): number {
  const delta = (now.getDay() - target + 7) % 7
  return delta === 0 ? 7 : delta
}

/** A month given without a year is this year's, unless it is already over. */
const upcomingYear = (now: Date, mo: number) => (mo < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear())

/** `3`, `三`, `十二`, `二十` → a number. */
function zhNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? ZH_DIGIT[m[1]] : 1) * 10 + (m[2] ? ZH_DIGIT[m[2]] : 0)
  return s.length === 1 && s in ZH_DIGIT ? ZH_DIGIT[s] : null
}

/** Monday of this week — weeks start on Monday. */
const startOfWeek = (now: Date) => addDays(now, -((now.getDay() + 6) % 7))
/** Offset from Monday for a weekday number (Sunday is the 7th day). */
const fromMonday = (weekday: number) => (weekday + 6) % 7

function chinese(s: string, now: Date): string | null | undefined {
  const day = (d: Date) => dayKey(d)
  const words: Record<string, () => Date> = {
    今天: () => now, 今日: () => now,
    明天: () => addDays(now, 1), 明日: () => addDays(now, 1),
    后天: () => addDays(now, 2), 大后天: () => addDays(now, 3),
    昨天: () => addDays(now, -1), 昨日: () => addDays(now, -1), 前天: () => addDays(now, -2),
    下周: () => addDays(startOfWeek(now), 7), 下星期: () => addDays(startOfWeek(now), 7),
    上周: () => addDays(startOfWeek(now), -7), 上星期: () => addDays(startOfWeek(now), -7),
    下个月: () => addMonths(now, 1), 下月: () => addMonths(now, 1),
    月初: () => new Date(now.getFullYear(), now.getMonth(), 1),
    月底: () => new Date(now.getFullYear(), now.getMonth() + 1, 0),
    月末: () => new Date(now.getFullYear(), now.getMonth() + 1, 0),
    明年: () => new Date(now.getFullYear() + 1, 0, 1),
  }
  if (s in words) return day(words[s]())
  let m: RegExpExecArray | null
  if ((m = /^(下|上|这|本)?\s*(?:周|星期|礼拜)([一二三四五六日天])$/.exec(s))) {
    const offset = fromMonday(ZH_WEEKDAY[m[2]])
    if (m[1] === '下') return day(addDays(startOfWeek(now), 7 + offset))
    if (m[1] === '上') return day(addDays(startOfWeek(now), -7 + offset))
    if (m[1]) return day(addDays(startOfWeek(now), offset))
    return day(addDays(now, untilWeekday(now, ZH_WEEKDAY[m[2]], true)))
  }
  const relative: [RegExp, (n: number) => Date][] = [
    [new RegExp(`^${ZH_N}\\s*(?:天|日)(?:后|之后|以后)$`), (n) => addDays(now, n)],
    [new RegExp(`^${ZH_N}\\s*(?:天|日)前$`), (n) => addDays(now, -n)],
    [new RegExp(`^${ZH_N}\\s*(?:周|个?星期|个?礼拜)(?:后|之后|以后)$`), (n) => addDays(now, n * 7)],
    [new RegExp(`^${ZH_N}\\s*个?月(?:后|之后|以后)$`), (n) => addMonths(now, n)],
  ]
  for (const [re, at] of relative) {
    if ((m = re.exec(s))) {
      const n = zhNumber(m[1])
      return n === null ? null : day(at(n))
    }
  }
  if ((m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?$/.exec(s))) {
    const mo = Number(m[2]) - 1
    return valid(m[1] ? Number(m[1]) : upcomingYear(now, mo), mo, Number(m[3]))
  }
  if ((m = /^(\d{1,2})[日号]$/.exec(s))) return valid(now.getFullYear(), now.getMonth(), Number(m[1]))
  if ((m = /^(\d{1,2})\.(\d{1,2})$/.exec(s))) {
    const mo = Number(m[1]) - 1
    return valid(upcomingYear(now, mo), mo, Number(m[2]))
  }
  return undefined
}

function english(s: string, now: Date): string | null {
  const day = (d: Date) => dayKey(d)
  let m: RegExpExecArray | null
  if (s === 'today' || s === 'tod' || s === 'now') return day(now)
  if (s === 'tomorrow' || s === 'tom' || s === 'tmr' || s === 'tmrw') return day(addDays(now, 1))
  if (s === 'yesterday' || s === 'yest' || s === 'yda') return day(addDays(now, -1))
  if ((m = /^\+?(?:in )?(\d+) ?(d|w)$/.exec(s))) return day(addDays(now, Number(m[1]) * (m[2] === 'w' ? 7 : 1)))
  if ((m = /^(?:in )?(\d+) days?(?: (?:later|from now|ahead))?$/.exec(s))) return day(addDays(now, Number(m[1])))
  if ((m = /^(\d+) days? ago$/.exec(s))) return day(addDays(now, -Number(m[1])))
  if ((m = /^(?:in )?(\d+) weeks?(?: (?:later|from now))?$/.exec(s))) return day(addDays(now, 7 * Number(m[1])))
  if ((m = /^(\d+) weeks? ago$/.exec(s))) return day(addDays(now, -7 * Number(m[1])))
  if ((m = /^(?:in )?(\d+) months?(?: (?:later|from now))?$/.exec(s))) return day(addMonths(now, Number(m[1])))
  if ((m = /^(\d+) months? ago$/.exec(s))) return day(addMonths(now, -Number(m[1])))
  if ((m = /^(next|last|this) (week|month|quarter|year)$/.exec(s))) {
    const dir = m[1] === 'next' ? 1 : m[1] === 'last' ? -1 : 0
    if (m[2] === 'week') return day(addDays(startOfWeek(now), dir * 7))
    if (m[2] === 'month') return day(addMonths(now, dir))
    if (m[2] === 'quarter') return day(new Date(now.getFullYear(), (Math.floor(now.getMonth() / 3) + dir) * 3, 1))
    return day(new Date(now.getFullYear() + dir, 0, 1))
  }
  if ((m = new RegExp(`^(next|last|this) (${WD})$`).exec(s))) {
    const target = WEEKDAYS[m[2]]
    if (m[1] === 'next') return day(addDays(now, untilWeekday(now, target, false)))
    if (m[1] === 'last') return day(addDays(now, -sinceWeekday(now, target)))
    return day(addDays(startOfWeek(now), fromMonday(target)))
  }
  if (s in WEEKDAYS) return day(addDays(now, untilWeekday(now, WEEKDAYS[s], true)))
  if ((m = /^q([1-4])(?: (\d{4}))?$/.exec(s))) return day(new Date(m[2] ? Number(m[2]) : now.getFullYear(), (Number(m[1]) - 1) * 3, 1))
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) {
    const mo = Number(m[1]) - 1
    const y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : upcomingYear(now, mo)
    return mo < 0 || mo > 11 ? null : valid(y, mo, Number(m[2]))
  }
  if ((m = new RegExp(`^(${MO})\\.? (\\d{1,2})${ORD}(?:,? (\\d{4}))?$`).exec(s))) {
    const mo = MONTHS[m[1]]
    return valid(m[3] ? Number(m[3]) : upcomingYear(now, mo), mo, Number(m[2]))
  }
  if ((m = new RegExp(`^(\\d{1,2})${ORD} (${MO})\\.?(?:,? (\\d{4}))?$`).exec(s))) {
    const mo = MONTHS[m[2]]
    return valid(m[3] ? Number(m[3]) : upcomingYear(now, mo), mo, Number(m[1]))
  }
  if ((m = new RegExp(`^(${MO})(?: (\\d{4}))?$`).exec(s))) {
    const mo = MONTHS[m[1]]
    return day(new Date(m[2] ? Number(m[2]) : upcomingYear(now, mo), mo, 1))
  }
  if ((m = /^(\d{4})$/.exec(s))) return day(new Date(Number(m[1]), 0, 1))
  if ((m = new RegExp(`^(\\d{1,2})${ORD}$`).exec(s))) return valid(now.getFullYear(), now.getMonth(), Number(m[1]))
  return null
}

/** The day `input` means, as `YYYY-MM-DD`; null when it can't be read. */
export function parseFuzzyDate(input: string, now: Date = new Date()): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // Traditional forms read the same as simplified ones.
    .replace(/[週後個禮兩號這]/g, (c) => ({ 週: '周', 後: '后', 個: '个', 禮: '礼', 兩: '两', 號: '号', 這: '这' })[c]!)
  if (!s) return null
  const zh = chinese(s, now)
  return zh === undefined ? english(s, now) : zh
}

/** The local day an ISO stamp falls on — what a `deferred_until` reads as; undefined if it doesn't parse. */
export function untilDay(stamp: string): string | undefined {
  const at = new Date(stamp)
  return Number.isNaN(at.getTime()) ? undefined : dayKey(at)
}

/** Local midnight of a `YYYY-MM-DD` day. */
export function startOfDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Whole days from today to `key`: 0 today, 1 tomorrow, -1 yesterday. */
export function daysFromToday(key: string, now: Date = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((startOfDay(key).getTime() - today.getTime()) / 86_400_000)
}

/** A full ISO date-time (`2026-11-15T09:00`) is taken as given; anything else goes through `parseFuzzyDate`. */
export function parseWhen(input: string, now: Date = new Date()): { day: string; at: Date; timed: boolean } | null {
  const raw = input.trim()
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(raw)) {
    const at = new Date(raw.replace(' ', 'T'))
    return Number.isNaN(at.getTime()) ? null : { day: dayKey(at), at, timed: true }
  }
  const day = parseFuzzyDate(raw, now)
  return day ? { day, at: startOfDay(day), timed: false } : null
}

/** Ready-made picks offered while the owner types; each is a phrase `parseFuzzyDate` reads. */
export const DATE_SUGGESTIONS: { key: string; phrase: string; hints: string[] }[] = [
  { key: 'tomorrow', phrase: 'tomorrow', hints: ['tomorrow', 'tom', 'tmr', '明天', '明', 'demain', 'غدا'] },
  { key: 'dayAfter', phrase: '后天', hints: ['后天', '後天', 'day after', 'après-demain'] },
  { key: 'nextMonday', phrase: '下周一', hints: ['next mon', 'next week', 'monday', '下周', '下周一', '周一', '下週', 'lundi'] },
  { key: 'inAWeek', phrase: '7d', hints: ['week', '1 week', '7', '7d', '一周', '一週', 'semaine'] },
  { key: 'nextMonth', phrase: 'next month', hints: ['next month', 'month', '下个月', '下月', '下個月', 'mois'] },
]

/** Suggestions for what has been typed so far: the parsed day first, then the matching ready-made picks. */
export function suggestDates(query: string, now: Date = new Date(), limit = 5): { key: string; date: string; parsed: boolean }[] {
  const q = query.trim().toLowerCase()
  const out: { key: string; date: string; parsed: boolean }[] = []
  const parsed = parseFuzzyDate(q, now)
  if (parsed) out.push({ key: 'parsed', date: parsed, parsed: true })
  for (const s of DATE_SUGGESTIONS) {
    if (out.length >= limit) break
    if (q && !s.hints.some((h) => h.includes(q) || q.includes(h))) continue
    const date = parseFuzzyDate(s.phrase, now)!
    if (!out.some((o) => o.date === date)) out.push({ key: s.key, date, parsed: false })
  }
  return out
}
