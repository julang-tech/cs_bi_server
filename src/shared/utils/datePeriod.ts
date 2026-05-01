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

export function getCurrentPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const tMinus1 = shiftDate(today, -1)
  if (grain === 'day') {
    return { date_from: formatDateInput(tMinus1), date_to: formatDateInput(tMinus1) }
  }
  if (grain === 'week') {
    return {
      date_from: formatDateInput(startOfWeek(tMinus1)),
      date_to: formatDateInput(endOfWeek(tMinus1)),
    }
  }
  return {
    date_from: formatDateInput(startOfMonth(tMinus1)),
    date_to: formatDateInput(endOfMonth(tMinus1)),
  }
}

export function getPreviousPeriod(grain: Grain, today: Date = new Date()): PeriodWindow {
  const current = getCurrentPeriod(grain, today)
  const currentStart = parseDateInput(current.date_from)
  if (grain === 'day') {
    const prev = shiftDate(currentStart, -1)
    return { date_from: formatDateInput(prev), date_to: formatDateInput(prev) }
  }
  if (grain === 'week') {
    const prevMonday = shiftDate(currentStart, -7)
    return {
      date_from: formatDateInput(prevMonday),
      date_to: formatDateInput(shiftDate(prevMonday, 6)),
    }
  }
  const prevMonth = new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1)
  return {
    date_from: formatDateInput(prevMonth),
    date_to: formatDateInput(endOfMonth(prevMonth)),
  }
}

export function getDefaultHistoryRange(grain: Grain, today: Date = new Date()): PeriodWindow {
  const current = getCurrentPeriod(grain, today)
  const currentStart = parseDateInput(current.date_from)
  if (grain === 'day') {
    const end = shiftDate(currentStart, -1)  // T-2 (currentStart is T-1)
    return { date_from: formatDateInput(shiftDate(end, -13)), date_to: formatDateInput(end) }
  }
  if (grain === 'week') {
    const lastSunday = shiftDate(currentStart, -1)
    const startMonday = shiftDate(lastSunday, -(7 * 8 - 1))
    return { date_from: formatDateInput(startMonday), date_to: formatDateInput(lastSunday) }
  }
  const startMonth = new Date(currentStart.getFullYear(), currentStart.getMonth() - 2, 1)
  const endMonth = endOfMonth(new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1))
  return { date_from: formatDateInput(startMonth), date_to: formatDateInput(endMonth) }
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

export function isHistoryRangeValid(
  window: PeriodWindow, grain: Grain, today: Date = new Date(),
): boolean {
  const current = getCurrentPeriod(grain, today)
  return window.date_to < current.date_from
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
