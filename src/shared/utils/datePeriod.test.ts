import { describe, it, expect } from 'vitest'
import {
  formatDateInput, parseDateInput, shiftDate,
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange,
  alignHistoryRangeToGrain, isHistoryRangeValid,
  getPeriodCount, getPeriodLengthDays,
  formatWeekInput, formatMonthInput,
  weekInputToRange, monthInputToRange,
} from './datePeriod'

const today = new Date(2026, 4, 1)  // 2026-05-01 (Friday); T-1 = 2026-04-30 (Thursday)

describe('formatDateInput / parseDateInput / shiftDate', () => {
  it('round-trips a date', () => {
    const d = new Date(2026, 4, 1)
    expect(formatDateInput(d)).toBe('2026-05-01')
    const parsed = parseDateInput('2026-05-01')
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(4)
    expect(parsed.getDate()).toBe(1)
  })
  it('shifts by days', () => {
    expect(formatDateInput(shiftDate(new Date(2026, 4, 1), -1))).toBe('2026-04-30')
    expect(formatDateInput(shiftDate(new Date(2026, 4, 1), 1))).toBe('2026-05-02')
  })
})

describe('getCurrentPeriod (A semantics)', () => {
  it('day = T-1 to T-1', () => {
    expect(getCurrentPeriod('day', today)).toEqual({
      date_from: '2026-04-30', date_to: '2026-04-30',
    })
  })
  it('week = full Mon-Sun containing T-1', () => {
    // T-1 = 2026-04-30 (Thu). Monday of that week = 2026-04-27. Sunday = 2026-05-03.
    expect(getCurrentPeriod('week', today)).toEqual({
      date_from: '2026-04-27', date_to: '2026-05-03',
    })
  })
  it('month = full month containing T-1', () => {
    // T-1 = 2026-04-30. Month = April 2026.
    expect(getCurrentPeriod('month', today)).toEqual({
      date_from: '2026-04-01', date_to: '2026-04-30',
    })
  })
})

describe('getPreviousPeriod', () => {
  it('day = T-2 to T-2', () => {
    expect(getPreviousPeriod('day', today)).toEqual({
      date_from: '2026-04-29', date_to: '2026-04-29',
    })
  })
  it('week = full prior Mon-Sun', () => {
    expect(getPreviousPeriod('week', today)).toEqual({
      date_from: '2026-04-20', date_to: '2026-04-26',
    })
  })
  it('month = full prior month', () => {
    expect(getPreviousPeriod('month', today)).toEqual({
      date_from: '2026-03-01', date_to: '2026-03-31',
    })
  })
})

describe('getDefaultHistoryRange', () => {
  it('day = 14 days ending T-2', () => {
    expect(getDefaultHistoryRange('day', today)).toEqual({
      date_from: '2026-04-16', date_to: '2026-04-29',
    })
  })
  it('week = 8 prior complete weeks', () => {
    // Last completed Sunday = 2026-04-26. 8 weeks back's Monday = 2026-03-02.
    expect(getDefaultHistoryRange('week', today)).toEqual({
      date_from: '2026-03-02', date_to: '2026-04-26',
    })
  })
  it('month = 2 prior complete months', () => {
    expect(getDefaultHistoryRange('month', today)).toEqual({
      date_from: '2026-02-01', date_to: '2026-03-31',
    })
  })
})

describe('alignHistoryRangeToGrain', () => {
  it('day passes through', () => {
    const w = { date_from: '2026-04-15', date_to: '2026-04-28' }
    expect(alignHistoryRangeToGrain(w, 'day')).toEqual(w)
  })
  it('week aligns to Mon-Sun bounds', () => {
    expect(alignHistoryRangeToGrain(
      { date_from: '2026-04-15', date_to: '2026-04-28' }, 'week',
    )).toEqual({ date_from: '2026-04-13', date_to: '2026-05-03' })
  })
  it('month aligns to 1st-last bounds', () => {
    expect(alignHistoryRangeToGrain(
      { date_from: '2026-02-15', date_to: '2026-04-10' }, 'month',
    )).toEqual({ date_from: '2026-02-01', date_to: '2026-04-30' })
  })
})

describe('isHistoryRangeValid', () => {
  it('rejects overlap with current period', () => {
    expect(isHistoryRangeValid(
      { date_from: '2026-04-15', date_to: '2026-04-30' }, 'day', today,
    )).toBe(false)
  })
  it('accepts non-overlapping', () => {
    expect(isHistoryRangeValid(
      { date_from: '2026-04-15', date_to: '2026-04-29' }, 'day', today,
    )).toBe(true)
  })
})

describe('getPeriodLengthDays', () => {
  it('counts inclusive day span', () => {
    expect(getPeriodLengthDays({ date_from: '2026-04-15', date_to: '2026-04-28' })).toBe(14)
    expect(getPeriodLengthDays({ date_from: '2026-04-30', date_to: '2026-04-30' })).toBe(1)
  })
})

describe('formatWeekInput / formatMonthInput', () => {
  it('formats month input as YYYY-MM', () => {
    expect(formatMonthInput(new Date(2026, 0, 15))).toBe('2026-01')
    expect(formatMonthInput(new Date(2026, 11, 1))).toBe('2026-12')
  })
  it('formats ISO week of a Thursday', () => {
    // 2026-04-30 is a Thursday → ISO week 18 of 2026.
    expect(formatWeekInput(new Date(2026, 3, 30))).toBe('2026-W18')
  })
  it('handles year-boundary weeks (ISO week belongs to year of Thursday)', () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(formatWeekInput(new Date(2026, 0, 1))).toBe('2026-W01')
    // 2025-12-29 (Mon) belongs to ISO week 1 of 2026 (Thursday is 2026-01-01).
    expect(formatWeekInput(new Date(2025, 11, 29))).toBe('2026-W01')
    // 2024-12-30 (Mon) belongs to ISO week 1 of 2025 (Thursday is 2025-01-02).
    expect(formatWeekInput(new Date(2024, 11, 30))).toBe('2025-W01')
  })
})

describe('weekInputToRange', () => {
  it('returns Monday for from-role', () => {
    // ISO week 18 of 2026: Monday = 2026-04-27, Sunday = 2026-05-03.
    expect(weekInputToRange('2026-W18', 'from')).toBe('2026-04-27')
  })
  it('returns Sunday for to-role', () => {
    expect(weekInputToRange('2026-W18', 'to')).toBe('2026-05-03')
  })
  it('handles ISO week 1 spanning year boundary', () => {
    // ISO week 1 of 2026: Mon 2025-12-29 → Sun 2026-01-04.
    expect(weekInputToRange('2026-W01', 'from')).toBe('2025-12-29')
    expect(weekInputToRange('2026-W01', 'to')).toBe('2026-01-04')
    // ISO week 1 of 2025: Mon 2024-12-30 → Sun 2025-01-05.
    expect(weekInputToRange('2025-W01', 'from')).toBe('2024-12-30')
    expect(weekInputToRange('2025-W01', 'to')).toBe('2025-01-05')
  })
  it('round-trips with formatWeekInput', () => {
    const sampleDates = [
      new Date(2026, 0, 1), new Date(2026, 3, 30), new Date(2026, 11, 31),
      new Date(2025, 11, 29), new Date(2024, 11, 30),
    ]
    for (const d of sampleDates) {
      const week = formatWeekInput(d)
      const monday = weekInputToRange(week, 'from')!
      // The Monday's own ISO week label must equal the original label.
      expect(formatWeekInput(parseDateInput(monday))).toBe(week)
    }
  })
  it('rejects malformed input', () => {
    expect(weekInputToRange('not-a-week', 'from')).toBeNull()
    expect(weekInputToRange('2026-W00', 'from')).toBeNull()
    expect(weekInputToRange('2026-W54', 'from')).toBeNull()
  })
})

describe('monthInputToRange', () => {
  it('returns 1st for from-role', () => {
    expect(monthInputToRange('2026-04', 'from')).toBe('2026-04-01')
  })
  it('returns last day for to-role', () => {
    expect(monthInputToRange('2026-04', 'to')).toBe('2026-04-30')
    expect(monthInputToRange('2026-02', 'to')).toBe('2026-02-28')
    expect(monthInputToRange('2024-02', 'to')).toBe('2024-02-29')  // leap
    expect(monthInputToRange('2026-12', 'to')).toBe('2026-12-31')
  })
  it('rejects malformed input', () => {
    expect(monthInputToRange('2026-13', 'from')).toBeNull()
    expect(monthInputToRange('2026-00', 'from')).toBeNull()
    expect(monthInputToRange('not-a-month', 'from')).toBeNull()
  })
})

describe('getPeriodCount', () => {
  it('day count is inclusive day diff', () => {
    expect(getPeriodCount(
      { date_from: '2026-04-15', date_to: '2026-04-28' }, 'day',
    )).toBe(14)
  })
  it('week count is whole weeks', () => {
    expect(getPeriodCount(
      { date_from: '2026-03-02', date_to: '2026-04-26' }, 'week',
    )).toBe(8)
  })
  it('month count is whole months', () => {
    expect(getPeriodCount(
      { date_from: '2026-02-01', date_to: '2026-03-31' }, 'month',
    )).toBe(2)
  })
})
