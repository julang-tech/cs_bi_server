import { describe, expect, it } from 'vitest'
import {
  METRIC_DEFINITION_GROUPS,
  getMetricDefinition,
  getMetricDescription,
} from './metricDefinitions'

describe('metric definitions', () => {
  it('documents global data readiness and currency rules', () => {
    expect(getMetricDefinition('global.data_ready_cutoff')?.detail).toContain('03:00')
    expect(getMetricDefinition('global.currency_usd')?.detail).toContain('USD')
  })

  it('documents refund and complaint rate formulas', () => {
    expect(getMetricDefinition('p2.refund_amount_ratio')?.formula).toContain('退款金额')
    expect(getMetricDefinition('p2.refund_amount_ratio')?.formula).toContain('净实付金额')
    expect(getMetricDefinition('p3.complaint_rate')?.formula).toContain('客诉量')
    expect(getMetricDefinition('p3.complaint_rate')?.formula).toContain('销量')
  })

  it('provides short descriptions for KPI tooltips', () => {
    expect(getMetricDescription('p2.gmv')).toContain('GMV')
    expect(getMetricDescription('p3.complaint_rate')).toContain('客诉率')
  })

  it('does not duplicate definition ids', () => {
    const ids = METRIC_DEFINITION_GROUPS.flatMap((group) =>
      group.sections.flatMap((section) => section.items.map((item) => item.id)),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})
