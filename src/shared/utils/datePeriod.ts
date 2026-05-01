// TODO(Task 2.4): Replace local Grain/PeriodWindow types with imports from '../../api/types'
//   once src/api/types.ts is created. Then delete the local copies below.
type Grain = 'day' | 'week' | 'month'
interface PeriodWindow { date_from: string; date_to: string }

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
