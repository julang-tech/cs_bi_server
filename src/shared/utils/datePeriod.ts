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

function shiftMonthClamped(date: Date, months: number): Date {
  const targetMonthStart = new Date(date.getFullYear(), date.getMonth() + months, 1)
  const targetMonthEnd = endOfMonth(targetMonthStart)
  return new Date(
    targetMonthStart.getFullYear(),
    targetMonthStart.getMonth(),
    Math.min(date.getDate(), targetMonthEnd.getDate()),
  )
}

const DATA_READY_HOUR = 3

// BigQuery backfills the previous 72 hours at 03:00 local time. Before then,
// yesterday may be partial, so dashboards must stop at T-2.
export function getDataReadyDate(today: Date = new Date()): Date {
  return shiftDate(today, today.getHours() < DATA_READY_HOUR ? -2 : -1)
}

function latestCompleteWeek(readyDate: Date): PeriodWindow {
  const readyWeekEnd = endOfWeek(readyDate)
  const end = readyWeekEnd <= readyDate ? readyWeekEnd : shiftDate(startOfWeek(readyDate), -1)
  return {
    date_from: formatDateInput(shiftDate(end, -6)),
    date_to: formatDateInput(end),
  }
}

function latestCompleteMonth(readyDate: Date): PeriodWindow {
  const readyMonthEnd = endOfMonth(readyDate)
  const month = readyMonthEnd <= readyDate
    ? readyDate
    : new Date(readyDate.getFullYear(), readyDate.getMonth() - 1, 1)
  return {
    date_from: formatDateInput(startOfMonth(month)),
    date_to: formatDateInput(endOfMonth(month)),
  }
}

function currentWeekPeriod(today: Date): PeriodWindow {
  const readyDate = getDataReadyDate(today)
  const currentWeekStart = startOfWeek(today)
  if (readyDate >= currentWeekStart) {
    return {
      date_from: formatDateInput(currentWeekStart),
      date_to: formatDateInput(readyDate),
    }
  }
  return latestCompleteWeek(readyDate)
}

function currentMonthPeriod(today: Date): PeriodWindow {
  const readyDate = getDataReadyDate(today)
  const currentMonthStart = startOfMonth(today)
  if (readyDate >= currentMonthStart) {
    return {
      date_from: formatDateInput(currentMonthStart),
      date_to: formatDateInput(readyDate),
    }
  }
  return latestCompleteMonth(readyDate)
}

export function getCurrentPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const end = getDataReadyDate(today)
  if (grain === 'day') return { date_from: formatDateInput(end), date_to: formatDateInput(end) }
  if (grain === 'week') return currentWeekPeriod(today)
  return currentMonthPeriod(today)
}

export function getPreviousPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const current = getCurrentPeriod(grain, today)
  const currentStart = parseDateInput(current.date_from)
  if (grain === 'day') {
    const day = shiftDate(currentStart, -1)
    return { date_from: formatDateInput(day), date_to: formatDateInput(day) }
  }
  if (grain === 'week') {
    const end = shiftDate(currentStart, -1)
    return { date_from: formatDateInput(shiftDate(end, -6)), date_to: formatDateInput(end) }
  }
  const previousMonth = new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1)
  return {
    date_from: formatDateInput(startOfMonth(previousMonth)),
    date_to: formatDateInput(endOfMonth(previousMonth)),
  }
}

export function getCurrentPeriodLabel(grain: Grain, today: Date = new Date()): string {
  if (grain === 'day') return '昨日'
  const current = getCurrentPeriod(grain, today)
  if (grain === 'week') {
    return current.date_from === formatDateInput(startOfWeek(today)) ? '本周至今' : '上周'
  }
  return current.date_from === formatDateInput(startOfMonth(today)) ? '本月至今' : '上月'
}

export function getPreviousPeriodLabel(grain: Grain): string {
  if (grain === 'day') return '前日'
  if (grain === 'week') return '上周'
  return '上月'
}

// Default history range = complete BI buckets up to the latest ready period.
export function getDefaultHistoryRange(grain: Grain, today: Date = new Date()): PeriodWindow {
  const readyDate = getDataReadyDate(today)
  if (grain === 'day') {
    // 1 month ending at the ready date inclusive.
    return {
      date_from: formatDateInput(shiftDate(readyDate, -29)),
      date_to: formatDateInput(readyDate),
    }
  }
  if (grain === 'week') {
    const currentWeek = currentWeekPeriod(today)
    const end = parseDateInput(currentWeek.date_to)
    return {
      date_from: formatDateInput(shiftDate(shiftMonthClamped(end, -2), 1)),
      date_to: currentWeek.date_to,
    }
  }
  const currentMonth = currentMonthPeriod(today)
  const monthStart = parseDateInput(currentMonth.date_from)
  const startMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() - 2, 1)
  return { date_from: formatDateInput(startMonth), date_to: currentMonth.date_to }
}

export function getPresetHistoryRange(
  preset: number | 'week_to_date' | 'month_to_date',
  today: Date = new Date(),
): PeriodWindow {
  const end = getDataReadyDate(today)
  if (preset === 'week_to_date') {
    return { date_from: formatDateInput(startOfWeek(end)), date_to: formatDateInput(end) }
  }
  if (preset === 'month_to_date') {
    return { date_from: formatDateInput(startOfMonth(end)), date_to: formatDateInput(end) }
  }
  return {
    date_from: formatDateInput(shiftDate(end, -(preset - 1))),
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

// History range is valid if it doesn't reach past the latest ready date.
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
