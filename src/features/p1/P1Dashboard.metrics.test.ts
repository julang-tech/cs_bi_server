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
    expect(source).toContain('is_manually_reviewed')
    expect(source).not.toContain('body?.en')

    const focusSource = source.slice(
      source.indexOf('  const focusMetrics: FocusMetricSpec[]'),
      source.indexOf('  // Per-metric summary line for focus chart'),
    )

    expect(focusSource).not.toContain('unreplied_count')
    expect(focusSource).not.toContain('avg_unreplied_wait_hours')
  })

  it('uses MailDB realtime periods instead of global data readiness periods', () => {
    expect(source).toContain('getRealtimeCurrentPeriod')
    expect(source).toContain('getRealtimeDefaultHistoryRange')
    expect(source).toContain('getRealtimeCurrentPeriodLabel')
    expect(source).toContain('currentDayIsIncomplete: true')
    expect(source).not.toContain('getCurrentPeriod(grain)')
    expect(source).not.toContain('getDefaultHistoryRange(next)')
  })

  it('does not compute hidden previous-range deltas for the focus chart summary', () => {
    const summaryStart = source.indexOf('  // Per-metric summary line for focus chart')
    const summarySource = source.slice(
      summaryStart,
      source.indexOf('  return (', summaryStart),
    )

    expect(summarySource).toContain('summaryByKey')
    expect(summarySource).not.toContain('previousHistory')
    expect(summarySource).not.toContain('delta,')
  })

  it('hides the internal schedule-table missing note from the dashboard banner', () => {
    expect(source).toContain('visibleP1Note')
    expect(source).toContain('工时表暂未接入')
  })
})
