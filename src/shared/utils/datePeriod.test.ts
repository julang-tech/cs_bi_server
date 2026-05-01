import { describe, it, expect } from 'vitest'
import {
  formatDateInput, parseDateInput, shiftDate,
  getDataReadyDate, getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange,
  getCurrentPeriodLabel,
  alignHistoryRangeToGrain, isHistoryRangeValid,
  getPeriodCount, getPeriodLengthDays,
  formatWeekInput, formatMonthInput,
  weekInputToRange, monthInputToRange,
} from './datePeriod'

const today = new Date(2026, 4, 1, 12)  // 2026-05-01 12:00; ready date = 2026-04-30
const beforeCutoff = new Date(2026, 4, 2, 2, 59)  // ready date = 2026-04-30
const afterCutoff = new Date(2026, 4, 2, 3, 0)  // ready date = 2026-05-01

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

describe('getDataReadyDate', () => {
  it('uses T-2 before the 03:00 BigQuery backfill cutoff', () => {
    expect(formatDateInput(getDataReadyDate(beforeCutoff))).toBe('2026-04-30')
  })
  it('uses T-1 at and after the 03:00 BigQuery backfill cutoff', () => {
    expect(formatDateInput(getDataReadyDate(afterCutoff))).toBe('2026-05-01')
  })
})

describe('getCurrentPeriod (rolling windows aligned to data readiness)', () => {
  it('day = ready date to ready date', () => {
    expect(getCurrentPeriod('day', today)).toEqual({
      date_from: '2026-04-30', date_to: '2026-04-30',
    })
  })
  it('week = latest 7 ready days', () => {
    expect(getCurrentPeriod('week', today)).toEqual({
      date_from: '2026-04-24', date_to: '2026-04-30',
    })
  })
  it('month = latest 30 ready days', () => {
    expect(getCurrentPeriod('month', today)).toEqual({
      date_from: '2026-04-01', date_to: '2026-04-30',
    })
  })
  it('does not move to yesterday before the 03:00 cutoff', () => {
    expect(getCurrentPeriod('day', beforeCutoff)).toEqual({
      date_from: '2026-04-30', date_to: '2026-04-30',
    })
  })
  it('moves to yesterday at the 03:00 cutoff', () => {
    expect(getCurrentPeriod('day', afterCutoff)).toEqual({
      date_from: '2026-05-01', date_to: '2026-05-01',
    })
  })
  it('month remains a rolling 30-day window when the ready date is mid-month', () => {
    expect(getCurrentPeriod('month', new Date(2026, 4, 15, 12))).toEqual({
      date_from: '2026-04-15', date_to: '2026-05-14',
    })
  })
})

describe('getCurrentPeriodLabel', () => {
  it('names the rolling current periods', () => {
    expect(getCurrentPeriodLabel('day')).toBe('昨日')
    expect(getCurrentPeriodLabel('week')).toBe('近 7 天')
    expect(getCurrentPeriodLabel('month')).toBe('近 30 天')
  })
})

describe('getPreviousPeriod', () => {
  it('day = T-2 to T-2', () => {
    expect(getPreviousPeriod('day', today)).toEqual({
      date_from: '2026-04-29', date_to: '2026-04-29',
    })
  })
  it('week = prior 7-day rolling window', () => {
    expect(getPreviousPeriod('week', today)).toEqual({
      date_from: '2026-04-17', date_to: '2026-04-23',
    })
  })
  it('month = prior 30-day rolling window', () => {
    expect(getPreviousPeriod('month', today)).toEqual({
      date_from: '2026-03-02', date_to: '2026-03-31',
    })
  })
})

describe('getDefaultHistoryRange', () => {
  it('day = 14 days ending at the ready date', () => {
    expect(getDefaultHistoryRange('day', today)).toEqual({
      date_from: '2026-04-17', date_to: '2026-04-30',
    })
  })
  it('week = 7 complete prior weeks plus the ready-date week to date', () => {
    expect(getDefaultHistoryRange('week', today)).toEqual({
      date_from: '2026-03-09', date_to: '2026-04-30',
    })
  })
  it('month = previous month plus the ready-date month to date', () => {
    expect(getDefaultHistoryRange('month', today)).toEqual({
      date_from: '2026-03-01', date_to: '2026-04-30',
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
  it('rejects dates after the ready date', () => {
    expect(isHistoryRangeValid(
      { date_from: '2026-04-15', date_to: '2026-05-01' }, 'day', beforeCutoff,
    )).toBe(false)
  })
  it('accepts dates through the ready date', () => {
    expect(isHistoryRangeValid(
      { date_from: '2026-04-15', date_to: '2026-04-30' }, 'day', beforeCutoff,
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
