import { test } from 'node:test'
import assert from 'node:assert/strict'

import { daysFromToday, parseFuzzyDate, parseWhen, suggestDates, untilDay } from '../src/core/fuzzy-date.ts'
import { dayFromToday, dayText } from '../src/i18n/time.ts'
import { setLang } from '../src/i18n/index.ts'

// Monday 2 November 2026, mid-morning local time.
const MON = new Date(2026, 10, 2, 10, 30)
const p = (s: string, now = MON) => parseFuzzyDate(s, now)

test('relative words: today, tomorrow, yesterday and their short forms', () => {
  assert.equal(p('today'), '2026-11-02')
  assert.equal(p('Tomorrow'), '2026-11-03')
  assert.equal(p('tmr'), '2026-11-03')
  assert.equal(p('yesterday'), '2026-11-01')
  assert.equal(p('  TOMORROW  '), '2026-11-03')
})

test('weekdays are the nearest one, today included; next/last skip this one', () => {
  assert.equal(p('mon'), '2026-11-02')
  assert.equal(p('fri'), '2026-11-06')
  assert.equal(p('friday'), '2026-11-06')
  assert.equal(p('sun'), '2026-11-08')
  assert.equal(p('next mon'), '2026-11-09')
  assert.equal(p('last fri'), '2026-10-30')
  assert.equal(p('this wed'), '2026-11-04')
})

test('spans: 3d, 2w, in 3 days, 3 days ago, N weeks and months', () => {
  assert.equal(p('3d'), '2026-11-05')
  assert.equal(p('+3d'), '2026-11-05')
  assert.equal(p('2w'), '2026-11-16')
  assert.equal(p('in 3 days'), '2026-11-05')
  assert.equal(p('3 days later'), '2026-11-05')
  assert.equal(p('3 days ago'), '2026-10-30')
  assert.equal(p('2 weeks'), '2026-11-16')
  assert.equal(p('in 1 month'), '2026-12-01')
})

test('next/last/this week, month, quarter, year start on their first day (weeks on Monday)', () => {
  assert.equal(p('next week'), '2026-11-09')
  assert.equal(p('this week'), '2026-11-02')
  assert.equal(p('last week'), '2026-10-26')
  assert.equal(p('next month'), '2026-12-01')
  assert.equal(p('next quarter'), '2027-01-01')
  assert.equal(p('next year'), '2027-01-01')
  assert.equal(p('q1'), '2026-01-01')
  assert.equal(p('q3 2027'), '2027-07-01')
})

test('calendar dates: ISO, month/day, day month, month day — a month already over means next year', () => {
  assert.equal(p('2026-11-15'), '2026-11-15')
  assert.equal(p('11/15'), '2026-11-15')
  assert.equal(p('11/15/27'), '2027-11-15')
  assert.equal(p('15 nov'), '2026-11-15')
  assert.equal(p('15th november'), '2026-11-15')
  assert.equal(p('nov 15'), '2026-11-15')
  assert.equal(p('Nov 15, 2027'), '2027-11-15')
  assert.equal(p('3 mar'), '2027-03-03', 'March is over this year')
  assert.equal(p('jan'), '2027-01-01')
  assert.equal(p('15'), '2026-11-15')
  assert.equal(p('2027'), '2027-01-01')
})

test('impossible days and nonsense read as nothing', () => {
  assert.equal(p('2026-02-30'), null)
  assert.equal(p('31 nov'), null)
  assert.equal(p('13/01'), null)
  assert.equal(p('blah'), null)
  assert.equal(p(''), null)
})

test('Chinese: 明天, 后天, 下周一, 周五, 3天后, 两周后, 下个月, 月底, 11月15日, 15号', () => {
  assert.equal(p('今天'), '2026-11-02')
  assert.equal(p('明天'), '2026-11-03')
  assert.equal(p('后天'), '2026-11-04')
  assert.equal(p('大后天'), '2026-11-05')
  assert.equal(p('下周一'), '2026-11-09')
  assert.equal(p('周五'), '2026-11-06')
  assert.equal(p('星期天'), '2026-11-08')
  assert.equal(p('这周三'), '2026-11-04')
  assert.equal(p('上周五'), '2026-10-30')
  assert.equal(p('3天后'), '2026-11-05')
  assert.equal(p('三天后'), '2026-11-05')
  assert.equal(p('十二天后'), '2026-11-14')
  assert.equal(p('两周后'), '2026-11-16')
  assert.equal(p('2个月后'), '2027-01-01')
  assert.equal(p('下周'), '2026-11-09')
  assert.equal(p('下个月'), '2026-12-01')
  assert.equal(p('月底'), '2026-11-30')
  assert.equal(p('11月15日'), '2026-11-15')
  assert.equal(p('2027年3月1日'), '2027-03-01')
  assert.equal(p('11.15'), '2026-11-15')
  assert.equal(p('15号'), '2026-11-15')
})

test('Traditional Chinese reads the same: 下週一, 後天, 兩個月後', () => {
  assert.equal(p('下週一'), '2026-11-09')
  assert.equal(p('後天'), '2026-11-04')
  assert.equal(p('兩個月後'), '2027-01-01')
})

test('a full date-time is taken as given; a day means its start', () => {
  const timed = parseWhen('2026-11-15T09:00', MON)!
  assert.equal(timed.timed, true)
  assert.equal(timed.at.getHours(), 9)
  const day = parseWhen('fri', MON)!
  assert.equal(day.timed, false)
  assert.equal(day.day, '2026-11-06')
  assert.equal(day.at.getTime(), new Date(2026, 10, 6).getTime())
  assert.equal(parseWhen('nope', MON), null)
  assert.equal(untilDay(new Date(2026, 10, 6).toISOString()), '2026-11-06')
  assert.equal(daysFromToday('2026-11-06', MON), 4)
})

test('suggestions: the parsed day first, then the matching ready-made picks, no day twice', () => {
  const all = suggestDates('', MON)
  assert.deepEqual(all.map((s) => s.key), ['tomorrow', 'dayAfter', 'nextMonday', 'nextMonth'], 'in a week is next Monday here, so it is left out')
  const typed = suggestDates('tom', MON)
  assert.deepEqual(typed.map((s) => s.key), ['parsed'], 'tom parses as tomorrow; the canned tomorrow is the same day')
  assert.equal(typed[0].date, '2026-11-03')
  assert.ok(suggestDates('下周', MON).some((s) => s.key === 'parsed' && s.date === '2026-11-09'))
  assert.deepEqual(suggestDates('zzz', MON), [])
})

test('a day is written the way each language writes it', () => {
  try {
    setLang('en')
    assert.equal(dayText('2026-11-06', MON), 'Fri, Nov 6')
    assert.equal(dayText('2027-01-04', MON), 'Mon, Jan 4, 2027')
    assert.equal(dayFromToday('2026-11-03', MON), 'tomorrow')
    assert.equal(dayFromToday('2026-11-05', MON), 'in 3 days')
    setLang('zh-Hans')
    assert.equal(dayText('2026-11-06', MON), '11月6日周五')
    assert.equal(dayFromToday('2026-11-05', MON), '3天后')
    setLang('fr')
    assert.equal(dayFromToday('2026-11-03', MON), 'demain')
  } finally {
    setLang('en')
  }
})
