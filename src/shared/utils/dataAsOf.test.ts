import { describe, expect, it } from 'vitest'
import { formatDataAsOf, resolveDataAsOfLabel } from './dataAsOf'

describe('formatDataAsOf', () => {
  it('formats valid timestamps in local dashboard time', () => {
    const formatted = formatDataAsOf('2026-05-04T06:07:00.000Z')

    expect(formatted).toMatch(/^2026-05-04 \d{2}:07$/)
  })

  it('returns null for absent or invalid timestamps', () => {
    expect(formatDataAsOf(null)).toBeNull()
    expect(formatDataAsOf(undefined)).toBeNull()
    expect(formatDataAsOf('not-a-date')).toBeNull()
  })

  it('uses cache generation when upstream data_as_of is missing', () => {
    expect(resolveDataAsOfLabel({
      data_as_of: null,
      cache_generation: '2026-05-05T07:15:30.000Z',
    })).toMatch(/^2026-05-05 \d{2}:15$/)
  })

  it('adds the dashboard refresh cadence when requested', () => {
    expect(formatDataAsOf('2026-05-04T06:05:00.000Z', { cadence: '5min' }))
      .toMatch(/^2026-05-04 \d{2}:05（约 5 分钟更新）$/)

    expect(resolveDataAsOfLabel({
      data_as_of: '2026-05-04T06:05:00.000Z',
    }, { cadence: 'hourly' })).toMatch(/^2026-05-04 \d{2}:05（约 1 小时更新）$/)
  })
})
