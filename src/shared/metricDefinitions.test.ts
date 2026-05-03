import { describe, expect, it } from 'vitest'
import {
  METRIC_DEFINITION_GROUPS,
  getMetricDefinition,
  getMetricDescription,
} from './metricDefinitions'

describe('metric definitions', () => {
  it('documents global data readiness and currency rules', () => {
    expect(getMetricDefinition('global.data_ready_cutoff')?.detail).toContain('03:00')
    expect(getMetricDefinition('global.current_period')?.short).toContain('本周/本月至今')
    expect(getMetricDefinition('global.current_period')?.detail).toContain('上上周')
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

  it('documents P1 dashboard v2 SLA and backlog metrics', () => {
    expect(getMetricDefinition('p1.first_response_timeout_count')).toBeUndefined()
    expect(getMetricDefinition('p1.late_reply_count')?.short).toContain('已回复')
    expect(getMetricDefinition('p1.unreplied_count')?.detail).toContain('无法归属到具体坐席')
    expect(getMetricDefinition('p1.avg_unreplied_wait_hours')?.short).toContain('平均已等待')
  })

  it('uses current table display copy in metric documentation', () => {
    expect(getMetricDefinition('global.history_range')?.name).toBe('时间范围')
    expect(getMetricDefinition('p1.agent_reply_span_hours')?.name).toBe('回信时长')
    expect(getMetricDefinition('p1.agent_hourly_reply_span')?.name).toBe('每小时回信均值')
    expect(getMetricDefinition('p1.agent_hourly_reply_schedule')).toBeUndefined()
    expect(getMetricDefinition('p2.product_refund_table')?.short).toContain('Top50')
    expect(getMetricDefinition('p2.product_refund_table')?.short).toContain('每页展示 10 行')
    expect(getMetricDefinition('p3.product_ranking')?.short).toContain('Top50')
    expect(getMetricDefinition('p3.product_ranking')?.short).toContain('每页展示 10 行')
  })

  it('does not duplicate definition ids', () => {
    const ids = METRIC_DEFINITION_GROUPS.flatMap((group) =>
      group.sections.flatMap((section) => section.items.map((item) => item.id)),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})
