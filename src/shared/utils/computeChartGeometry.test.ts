import { describe, it, expect } from 'vitest'
import { computeChartGeometry } from './computeChartGeometry'

describe('computeChartGeometry', () => {
  it('projects items into bounds', () => {
    const result = computeChartGeometry({ items: [
      { value: 0 }, { value: 50 }, { value: 100 },
    ]})
    expect(result.points).toHaveLength(3)
    expect(result.points[0].x).toBe(8)    // left bound
    expect(result.points[2].x).toBe(96)   // right bound
    expect(result.points[2].y).toBe(10)   // top bound (max value)
    expect(result.points[0].y).toBe(86)   // bottom bound (min value)
  })

  it('returns single-point at center x=50', () => {
    const result = computeChartGeometry({ items: [{ value: 5 }] })
    expect(result.points[0].x).toBe(50)
  })

  it('handles all-zero items without divide-by-zero', () => {
    const result = computeChartGeometry({ items: [
      { value: 0 }, { value: 0 }, { value: 0 },
    ]})
    expect(Number.isFinite(result.points[0].y)).toBe(true)
  })

  it('builds pointsString and areaString', () => {
    const result = computeChartGeometry({ items: [
      { value: 0 }, { value: 100 },
    ]})
    expect(result.pointsString).toBe('8,86 96,10')
    expect(result.areaString.startsWith('8,86')).toBe(true)
    expect(result.areaString.endsWith('96,86')).toBe(true)
  })

  it('respects yMinOverride / yMaxOverride', () => {
    const result = computeChartGeometry({
      items: [{ value: 50 }],
      yMinOverride: 0,
      yMaxOverride: 100,
    })
    expect(result.points[0].y).toBeCloseTo((10 + 86) / 2, 1)
  })
})
