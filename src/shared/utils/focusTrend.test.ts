import { describe, expect, it } from 'vitest'
import { buildFocusTrend, formatFocusBucketLabel, splitFocusTrend } from './focusTrend'

describe('splitFocusTrend', () => {
  it('keeps complete daily data solid', () => {
    const result = splitFocusTrend(
      [
        { bucket: '2026-04-30', value: 10 },
        { bucket: '2026-05-01', value: 20 },
      ],
      'day',
      { date_from: '2026-05-01', date_to: '2026-05-01' },
    )

    expect(result.history).toHaveLength(2)
    expect(result.current).toEqual([])
  })

  it('splits an incomplete week bucket into the dashed current segment', () => {
    const result = splitFocusTrend(
      [
        { bucket: '2026-W17', value: 10 },
        { bucket: '2026-W18', value: 20 },
      ],
      'week',
      { date_from: '2026-04-27', date_to: '2026-05-01' },
    )

    expect(result.history).toEqual([{ bucket: '2026-W17', value: 10 }])
    expect(result.current).toEqual([{ bucket: '2026-W18', value: 20 }])
  })

  it('keeps a complete fallback week solid', () => {
    const result = splitFocusTrend(
      [
        { bucket: '2026-W17', value: 10 },
        { bucket: '2026-W18', value: 20 },
      ],
      'week',
      { date_from: '2026-04-27', date_to: '2026-05-03' },
    )

    expect(result.history).toHaveLength(2)
    expect(result.current).toEqual([])
  })

  it('splits an incomplete month bucket into the dashed current segment', () => {
    const result = splitFocusTrend(
      [
        { bucket: '2026-04-01', value: 10 },
        { bucket: '2026-05-01', value: 20 },
      ],
      'month',
      { date_from: '2026-05-01', date_to: '2026-05-14' },
    )

    expect(result.history).toEqual([{ bucket: '2026-04-01', value: 10 }])
    expect(result.current).toEqual([{ bucket: '2026-05-01', value: 20 }])
  })
})

describe('formatFocusBucketLabel', () => {
  it('normalizes week and month buckets for display', () => {
    expect(formatFocusBucketLabel('2026-05-01', 'week')).toBe('2026-W18')
    expect(formatFocusBucketLabel('2026-W18', 'week')).toBe('2026-W18')
    expect(formatFocusBucketLabel('2026-05-01', 'month')).toBe('2026-05')
    expect(formatFocusBucketLabel('2026-05', 'month')).toBe('2026-05')
  })
})

describe('buildFocusTrend', () => {
  it('splits the realtime current day when the caller marks day buckets as incomplete', () => {
    const result = buildFocusTrend(
      [
        { bucket: '2026-05-01', value: 10 },
        { bucket: '2026-05-02', value: 20 },
      ],
      'day',
      { date_from: '2026-05-02', date_to: '2026-05-02' },
      20,
      { currentDayIsIncomplete: true },
    )

    expect(result.history).toEqual([{ bucket: '2026-05-01', value: 10 }])
    expect(result.current).toEqual([{ bucket: '2026-05-02', value: 20 }])
  })

  it('splits the incomplete current week when it is already present in history data', () => {
    const result = buildFocusTrend(
      [
        { bucket: '2026-W17', value: 10 },
        { bucket: '2026-W18', value: 20 },
      ],
      'week',
      { date_from: '2026-04-27', date_to: '2026-05-01' },
      20,
    )

    expect(result.history).toEqual([{ bucket: '2026-W17', value: 10 }])
    expect(result.current).toEqual([{ bucket: '2026-W18', value: 20 }])
  })

  it('appends the current point when the selected history range stops before it', () => {
    const result = buildFocusTrend(
      [{ bucket: '2026-04-01', value: 10 }],
      'month',
      { date_from: '2026-05-01', date_to: '2026-05-14' },
      20,
    )

    expect(result.history).toEqual([{ bucket: '2026-04-01', value: 10 }])
    expect(result.current).toEqual([{ bucket: '2026-05-14', value: 20 }])
  })
})
