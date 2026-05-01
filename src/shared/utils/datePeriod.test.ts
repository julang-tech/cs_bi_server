import { describe, it, expect } from 'vitest'
import {
  formatDateInput, parseDateInput, shiftDate,
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange,
  alignHistoryRangeToGrain, isHistoryRangeValid,
  getPeriodCount,
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
