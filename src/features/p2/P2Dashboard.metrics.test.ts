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

  it('passes refund date basis and uses dynamic refund metric tooltips', () => {
    expect(source).toContain("const [dateBasis, setDateBasis] = useState<'order_date' | 'refund_date'>('order_date')")
    expect(source).toContain("date_basis: dateBasis")
    expect(source).toContain('<option value="order_date">订单时间</option>')
    expect(source).toContain('<option value="refund_date">退款时间</option>')
    expect(source).toContain('getRefundMetricDescription')
    expect(source).toContain('订单时间口径')
    expect(source).toContain('退款时间口径')
  })

  it('passes full Shopify domains for store filtering', () => {
    expect(source).toContain("value: '2vnpww-33.myshopify.com'")
    expect(source).toContain("value: 'lintico-fr.myshopify.com'")
    expect(source).toContain("value: 'lintico-uk.myshopify.com'")
  })

  it('uses all KPI FocusSummaryBlock aggregations instead of the legacy chart summary map', () => {
    const summarySource = source.slice(
      source.indexOf('  const focusSummaryBlocks'),
      source.indexOf('  return ('),
    )

    expect(source).toContain('FocusSummaryBlock')
    expect(summarySource).toContain('focusSummaryBlocks')
    expect(summarySource).toContain('aggregateFocusMetric')
    expect(summarySource).toContain('focusSelection')
    expect(source).toContain('区块 ${String.fromCharCode(65 + index)} · ${metric.label}')
    expect(source).not.toContain('summaryByKey')
    expect(summarySource).not.toContain('previousHistory')
    expect(summarySource).not.toContain('delta,')
  })
})
