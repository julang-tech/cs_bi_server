import type { Grain, PeriodWindow } from '../../api/types'

export function formatDateInput(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseDateInput(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function shiftDate(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

// ISO Monday-start
function startOfWeek(date: Date): Date {
  const day = date.getDay() || 7  // Sunday → 7
  return shiftDate(date, -(day - 1))
}

function endOfWeek(date: Date): Date {
  return shiftDate(startOfWeek(date), 6)
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

const DATA_READY_HOUR = 3

// BigQuery backfills the previous 72 hours at 03:00 local time. Before then,
// yesterday may be partial, so dashboards must stop at T-2.
export function getDataReadyDate(today: Date = new Date()): Date {
  return shiftDate(today, today.getHours() < DATA_READY_HOUR ? -2 : -1)
}

// Rolling-window semantics: the "current period" for a given grain is the most
// recent N ready days. day=1, week=7, month=30. This avoids the day-1 / Monday
// edge case where calendar-aligned current periods have no data.
function rollingDays(grain: Grain): number {
  if (grain === 'day') return 1
  if (grain === 'week') return 7
  return 30
}

export function getCurrentPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const end = getDataReadyDate(today)
  const start = shiftDate(end, -(rollingDays(grain) - 1))
  return { date_from: formatDateInput(start), date_to: formatDateInput(end) }
}

export function getPreviousPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const days = rollingDays(grain)
  const end = shiftDate(getDataReadyDate(today), -days)  // one full window before current
  const start = shiftDate(end, -(days - 1))
  return { date_from: formatDateInput(start), date_to: formatDateInput(end) }
}

export function getCurrentPeriodLabel(grain: Grain): string {
  if (grain === 'day') return '昨日'
  if (grain === 'week') return '近 7 天'
  return '近 30 天'
}

// Default history range = N most recent calendar buckets up to the ready date.
// Bucket = day/week/month per grain. The trailing bucket may be partial
// (current week-to-date / month-to-date) and is rendered with in-progress
// styling by the chart.
export function getDefaultHistoryRange(grain: Grain, today: Date = new Date()): PeriodWindow {
  const readyDate = getDataReadyDate(today)
  if (grain === 'day') {
    // 14 days ending at the ready date inclusive.
    return {
      date_from: formatDateInput(shiftDate(readyDate, -13)),
      date_to: formatDateInput(readyDate),
    }
  }
  if (grain === 'week') {
    // 8 weeks: 7 complete prior weeks + the ready-date week to date.
    const startMonday = shiftDate(startOfWeek(readyDate), -7 * 7)
    return { date_from: formatDateInput(startMonday), date_to: formatDateInput(readyDate) }
  }
  // 2 months: 1 complete prior month + the ready-date month to date.
  const startMonth = new Date(readyDate.getFullYear(), readyDate.getMonth() - 1, 1)
  return { date_from: formatDateInput(startMonth), date_to: formatDateInput(readyDate) }
}

export function getPresetHistoryRange(days: number, today: Date = new Date()): PeriodWindow {
  const end = getDataReadyDate(today)
  return {
    date_from: formatDateInput(shiftDate(end, -(days - 1))),
    date_to: formatDateInput(end),
  }
}

export function alignHistoryRangeToGrain(window: PeriodWindow, grain: Grain): PeriodWindow {
  if (grain === 'day') return window
  const start = parseDateInput(window.date_from)
  const end = parseDateInput(window.date_to)
  if (grain === 'week') {
    return {
      date_from: formatDateInput(startOfWeek(start)),
      date_to: formatDateInput(endOfWeek(end)),
    }
  }
  return {
    date_from: formatDateInput(startOfMonth(start)),
    date_to: formatDateInput(endOfMonth(end)),
  }
}

// History range is valid if it doesn't reach past the latest ready date. Cards
// use rolling windows independently; chart and cards are decoupled, so overlap
// is fine.
export function isHistoryRangeValid(
  _window: PeriodWindow, _grain: Grain, _today: Date = new Date(),
): boolean {
  return _window.date_to <= formatDateInput(getDataReadyDate(_today))
}

export function getPeriodCount(window: PeriodWindow, grain: Grain): number {
  const start = parseDateInput(window.date_from)
  const end = parseDateInput(window.date_to)
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  if (grain === 'day') return days
  if (grain === 'week') return Math.round(days / 7)
  // month: count by year/month diff
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1
}

export function getPeriodLengthDays(window: PeriodWindow): number {
  const start = parseDateInput(window.date_from)
  const end = parseDateInput(window.date_to)
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

// Same-length range immediately before the given window. Used for "vs 上一区间"
// comparison on the focus chart summary line.
export function getPreviousHistoryRange(window: PeriodWindow): PeriodWindow {
  const days = getPeriodLengthDays(window)
  const newEnd = shiftDate(parseDateInput(window.date_from), -1)
  const newStart = shiftDate(newEnd, -(days - 1))
  return { date_from: formatDateInput(newStart), date_to: formatDateInput(newEnd) }
}

// ---------- ISO week / month helpers for grain-aware HTML inputs ----------

// ISO week number (1..53), Monday-start, weeks belong to year of their Thursday.
function isoWeekParts(date: Date): { year: number; week: number } {
  // Copy to avoid mutating caller; normalise to UTC midnight.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7  // Sun=0 → 7
  // Move to the Thursday of the same ISO week.
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return { year: d.getUTCFullYear(), week }
}

export function formatWeekInput(date: Date): string {
  const { year, week } = isoWeekParts(date)
  return `${year}-W${`${week}`.padStart(2, '0')}`
}

export function formatMonthInput(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  return `${y}-${m}`
}

// Monday of ISO week `week` in `year`.
function isoWeekMonday(year: number, week: number): Date {
  // Jan 4 is always in ISO week 1.
  const jan4 = new Date(year, 0, 4)
  const jan4Day = jan4.getDay() || 7
  const week1Monday = shiftDate(jan4, -(jan4Day - 1))
  return shiftDate(week1Monday, (week - 1) * 7)
}

export function weekInputToRange(raw: string, role: 'from' | 'to'): string | null {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(raw)
  if (!match) return null
  const year = Number(match[1])
  const week = Number(match[2])
  if (!year || !week || week < 1 || week > 53) return null
  const monday = isoWeekMonday(year, week)
  const target = role === 'from' ? monday : shiftDate(monday, 6)
  return formatDateInput(target)
}

export function monthInputToRange(raw: string, role: 'from' | 'to'): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(raw)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!year || !month || month < 1 || month > 12) return null
  const date = role === 'from'
    ? new Date(year, month - 1, 1)
    : new Date(year, month, 0)  // day 0 of next month = last day of this month
  return formatDateInput(date)
}
