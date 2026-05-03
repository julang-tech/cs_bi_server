import { describe, expect, it } from 'vitest'
import { buildDirectionalDelta } from './delta'

describe('buildDirectionalDelta', () => {
  it('colors positive metrics green when they increase and red when they decrease', () => {
    expect(buildDirectionalDelta(120, 100, 'percent', 'positive')).toEqual({
      tone: 'up',
      text: '↑ 20.0%',
    })
    expect(buildDirectionalDelta(80, 100, 'percent', 'positive')).toEqual({
      tone: 'down',
      text: '↓ 20.0%',
    })
  })

  it('colors negative metrics red when they increase and green when they decrease', () => {
    expect(buildDirectionalDelta(120, 100, 'percent', 'negative')).toEqual({
      tone: 'down',
      text: '↑ 20.0%',
    })
    expect(buildDirectionalDelta(80, 100, 'percent', 'negative')).toEqual({
      tone: 'up',
      text: '↓ 20.0%',
    })
  })

  it('keeps pp text formatting while applying metric polarity', () => {
    expect(buildDirectionalDelta(0.08, 0.071, 'pp', 'negative')).toEqual({
      tone: 'down',
      text: '↑ 0.90pp',
    })
  })

  it('keeps neutral metrics gray while still showing the numeric direction', () => {
    expect(buildDirectionalDelta(120, 100, 'percent', 'neutral')).toEqual({
      tone: 'neutral',
      text: '↑ 20.0%',
    })
    expect(buildDirectionalDelta(80, 100, 'percent', 'neutral')).toEqual({
      tone: 'neutral',
      text: '↓ 20.0%',
    })
  })

  it('uses neutral and muted tones for unchanged or unavailable comparisons', () => {
    expect(buildDirectionalDelta(100, 100, 'percent', 'positive')).toEqual({
      tone: 'neutral',
      text: '0.0%',
    })
    expect(buildDirectionalDelta(100, null, 'percent', 'positive')).toEqual({
      tone: 'muted',
      text: '-',
    })
    expect(buildDirectionalDelta(100, 0, 'percent', 'positive')).toEqual({
      tone: 'muted',
      text: '-',
    })
  })
})
