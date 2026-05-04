import { describe, expect, it } from 'vitest'
import { formatDataAsOf } from './dataAsOf'

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
})
