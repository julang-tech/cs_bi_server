import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p3/P3Dashboard.tsx'), 'utf8')

describe('P3 overview KPI composition', () => {
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

  it('keeps issue-type detail metrics out of current and history KPI cards', () => {
    const cardsSource = source.slice(
      source.indexOf('  const cards = ['),
      source.indexOf('  const focusMetrics: FocusMetricSpec[]'),
    )

    expect(cardsSource).toContain("label: '销量'")
    expect(cardsSource).toContain("label: '客诉量'")
    expect(cardsSource).toContain("label: '客诉率'")
    expect(cardsSource).toContain("polarity: 'positive'")
    expect(cardsSource).toContain("polarity: 'negative'")
    expect(cardsSource).not.toContain('产品问题客诉量')
    expect(cardsSource).not.toContain('物流问题客诉量')
    expect(cardsSource).not.toContain('仓库问题客诉量')
  })

  it('uses date-basis aware complaint metric tooltips', () => {
    expect(source).toContain('getComplaintMetricDescription')
    expect(source).toContain('客诉登记时间口径')
    expect(source).toContain('订单时间口径')
    expect(source).toContain('退款时间口径')
  })

  it('does not compute hidden previous-range deltas for the focus chart summary', () => {
    const summaryStart = source.indexOf('  // Build per-metric summary for the focus chart')
    const summarySource = source.slice(
      summaryStart,
      source.indexOf('  return (', summaryStart),
    )

    expect(summarySource).toContain('summaryByKey')
    expect(summarySource).not.toContain('previousHistory')
    expect(summarySource).not.toContain('delta,')
  })
})
