import { describe, expect, it } from 'vitest'
import {
  METRIC_DEFINITION_GROUPS,
  getMetricDefinition,
  getMetricDescription,
} from './metricDefinitions'

describe('metric definitions', () => {
  it('documents global data readiness and currency rules', () => {
    expect(getMetricDefinition('global.data_ready_cutoff')?.detail).toContain('凌晨 3 点')
    expect(getMetricDefinition('global.realtime_cutoff')?.detail).toContain('实时')
    expect(getMetricDefinition('global.current_period')?.detail).toContain('上上周')
    expect(getMetricDefinition('global.currency_usd')?.detail).toMatch(/美元|USD/)
    expect(getMetricDefinition('global.history_alignment')?.short).toContain('周一')
    expect(getMetricDefinition('global.agent_filter')?.short).toContain('客服')
  })

  it('documents refund and complaint rate formulas', () => {
    expect(getMetricDefinition('p2.refund_amount_ratio')?.formula).toContain('退款金额')
    expect(getMetricDefinition('p2.refund_amount_ratio')?.formula).toContain('净实付金额')
    expect(getMetricDefinition('p3.complaint_rate')?.formula).toContain('客诉量')
    expect(getMetricDefinition('p3.complaint_rate')?.formula).toContain('销量')
  })

  it('provides short descriptions for KPI tooltips', () => {
    expect(getMetricDefinition('p2.gmv')?.name).toBe('GMV')
    expect(getMetricDescription('p3.complaint_rate')).toContain('客诉率')
  })

  it('documents P1 dashboard v2 SLA and backlog metrics', () => {
    expect(getMetricDefinition('p1.first_response_timeout_count')).toBeUndefined()
    expect(getMetricDefinition('p1.late_reply_count')?.short).toContain('回复')
    expect(getMetricDefinition('p1.unreplied_count')?.detail).toContain('无法归属到坐席')
    expect(getMetricDefinition('p1.avg_unreplied_wait_hours')?.short).toContain('已经等了')
  })

  it('uses current table display copy in metric documentation', () => {
    expect(getMetricDefinition('global.history_range')?.name).toBe('时间范围')
    expect(getMetricDefinition('p1.agent_reply_span_hours')?.name).toBe('在席时长')
    expect(getMetricDefinition('p1.agent_hourly_reply_span')?.name).toBe('每小时回信均值')
    expect(getMetricDefinition('p1.agent_hourly_reply_schedule')).toBeUndefined()
    expect(getMetricDefinition('p2.product_refund_table')?.short).toContain('Top50')
    expect(getMetricDefinition('p2.product_refund_table')?.short).toMatch(/每页.*10.*20.*50/)
    expect(getMetricDefinition('p3.product_ranking')?.short).toContain('Top50')
    expect(getMetricDefinition('p3.product_ranking')?.short).toMatch(/每页.*10.*20.*50/)
    expect(getMetricDefinition('p3.date_basis')?.short).toContain('客诉登记时间')
    expect(getMetricDefinition('p3.issue_refund_count')?.name).toContain('退款')
    expect(getMetricDefinition('p1.agent_qa_reply_counts')?.short).toContain('优秀')
    expect(getMetricDefinition('p1.outbound_email_count')?.detail).toContain('KPI 主值和同比使用当前周期')
    expect(getMetricDefinition('p1.agent_outbound_email_count')?.short).toContain('所选历史时间范围')
    expect(getMetricDefinition('p1.agent_qa_reply_counts')?.detail).toContain('三档合计不等于总回邮数')
  })

  it('does not duplicate definition ids', () => {
    const ids = METRIC_DEFINITION_GROUPS.flatMap((group) =>
      group.sections.flatMap((section) => section.items.map((item) => item.id)),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})
