import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p1/P1Dashboard.tsx'), 'utf8')

describe('P1 overview KPI composition', () => {
  it('uses the v2 trendable SLA metrics in current and history KPI cards', () => {
    const cardsSource = source.slice(
      source.indexOf('  const cards = ['),
      source.indexOf('  const backlogSnapshot'),
    )

    expect(cardsSource).toContain("label: '来邮数'")
    expect(cardsSource).toContain("label: '回邮数'")
    expect(cardsSource).toContain("label: '平均会话排队时长'")
    expect(cardsSource).toContain("label: '已回复但延迟'")
    expect(cardsSource).toContain("polarity: 'neutral'")
    expect(cardsSource).toContain("polarity: 'negative'")
    expect(cardsSource).toContain('late_reply_count')
    expect(cardsSource).not.toContain('unreplied_count')
    expect(cardsSource).not.toContain('avg_unreplied_wait_hours')
    expect(cardsSource).not.toContain('first_response_timeout_count')
    expect(cardsSource).not.toContain('首封邮件数')
    expect(cardsSource).not.toContain('还没回复数')
  })

  it('renders backlog fields as a current snapshot outside focus chart metrics', () => {
    expect(source).toContain('backlogSnapshot')
    expect(source).toContain('<dt>当前积压未回</dt>')
    expect(source).toContain('<dt>当前积压平均等待</dt>')
    expect(source).toContain('backlogModalOpen')
    expect(source).toContain('fetchP1BacklogMails')
    expect(source).toContain('markP1BacklogMailNeedsReply')
    expect(source).toContain('p1-backlog-modal')
    expect(source).toContain('待 review')
    expect(source).toContain('当前快照，不受历史范围影响')
    expect(source).toContain('当前快照，不受历史时间范围影响')
    expect(source).toContain('customer_email')
    expect(source).toContain('客户邮箱')
    expect(source).toContain('发件邮箱')
    expect(source).toContain('is_manually_reviewed')
    expect(source).not.toContain('body?.en')

    const focusSource = source.slice(
      source.indexOf('  const focusMetrics: FocusAggregationMetric[]'),
      source.indexOf('  const focusSummaryBlocks'),
    )

    expect(focusSource).not.toContain('unreplied_count')
    expect(focusSource).not.toContain('avg_unreplied_wait_hours')
  })

  it('uses history agent workload for the selected time range table', () => {
    const workloadSource = source.slice(
      source.indexOf('      extensions={'),
      source.indexOf('    />', source.indexOf('      extensions={')),
    )

    expect(workloadSource).toContain('workloadRows={history?.agent_workload ?? []}')
    expect(workloadSource).not.toContain('workloadRows={current?.agent_workload ?? []}')
  })

  it('loads backlog mails as a current snapshot without unsupported agent filters', () => {
    const backlogFetchSource = source.slice(
      source.indexOf('  const loadBacklogMails'),
      source.indexOf('  useEffect(() => {', source.indexOf('  const loadBacklogMails')),
    )

    expect(backlogFetchSource).toContain('fetchP1BacklogMails')
    expect(backlogFetchSource).toContain('limit: 100')
    expect(backlogFetchSource).not.toContain('agent_name')
    expect(backlogFetchSource).not.toContain('date_from')
    expect(backlogFetchSource).not.toContain('date_to')
    expect(backlogFetchSource).not.toContain('grain')
  })

  it('refreshes dashboard data after marking a backlog mail', () => {
    const markSource = source.slice(
      source.indexOf('  async function markMail'),
      source.indexOf('  const visibleP1Note'),
    )

    expect(markSource).toContain('markP1BacklogMailNeedsReply')
    expect(markSource).toContain('loadBacklogMails')
    expect(markSource).toContain('refetch()')
  })

  it('uses MailDB realtime periods instead of global data readiness periods', () => {
    expect(source).toContain('getRealtimeCurrentPeriod')
    expect(source).toContain('getRealtimeDefaultHistoryRange')
    expect(source).toContain('getRealtimeCurrentPeriodLabel')
    expect(source).toContain('resolveDataAsOfLabel')
    expect(source).toContain('currentDayIsIncomplete: true')
    expect(source).toContain('KPI 主值为当前周期')
    expect(source).toContain('迷你趋势和下方趋势图为所选历史范围')
    expect(source).not.toContain('getCurrentPeriod(grain)')
    expect(source).not.toContain('getDefaultHistoryRange(next)')
  })

  it('uses all KPI FocusSummaryBlock aggregations instead of the legacy chart summary map', () => {
    const summaryStart = source.indexOf('  const focusSummaryBlocks')
    const summarySource = source.slice(
      summaryStart,
      source.indexOf('  return (', summaryStart),
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

  it('builds customer service filter options from workload data instead of a hardcoded list', () => {
    expect(source).not.toContain('const AGENT_OPTIONS')
    expect(source).not.toContain("value: 'Jovie'")
    expect(source).toContain('buildAgentFilterOptions')
    expect(source).toContain('history?.agent_workload')
    expect(source).toContain('agentOptions.map')
  })

  it('hides the internal schedule-table missing note from the dashboard banner', () => {
    expect(source).toContain('visibleP1Note')
    expect(source).toContain('工时表暂未接入')
  })
})
