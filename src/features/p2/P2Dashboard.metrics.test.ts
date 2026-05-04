import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p2/P2Dashboard.tsx'), 'utf8')

describe('P2 overview focus chart summary', () => {
  it('uses realtime current-period helpers and dashed incomplete current buckets', () => {
    expect(source).toContain('getRealtimeCurrentPeriod')
    expect(source).toContain('getRealtimeDefaultHistoryRange')
    expect(source).toContain('getRealtimeCurrentPeriodLabel')
    expect(source).toContain('getRealtimePresetHistoryRange')
    expect(source).toContain('resolveDataAsOfLabel')
    expect(source).toContain('currentDayIsIncomplete: true')
    expect(source).not.toContain('getCurrentPeriod(grain)')
    expect(source).not.toContain('getDefaultHistoryRange')
  })

  it('marks refund metrics as negative and revenue/order metrics as positive for delta coloring', () => {
    const cardsSource = source.slice(
      source.indexOf('  const cards: Array<{'),
      source.indexOf('  const enrichedCards'),
    )

    expect(cardsSource).toContain("key: 'gmv'")
    expect(cardsSource).toContain("key: 'refund_amount_ratio'")
    expect(cardsSource).toContain("polarity: 'positive'")
    expect(cardsSource).toContain("polarity: 'negative'")
  })

  it('does not compute hidden previous-range deltas for the focus chart summary', () => {
    const summarySource = source.slice(
      source.indexOf('  // Per-metric summary line for focus chart'),
      source.indexOf('  return ('),
    )

    expect(summarySource).toContain('summaryByKey')
    expect(summarySource).not.toContain('previousHistory')
    expect(summarySource).not.toContain('delta,')
  })
})
