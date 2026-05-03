import { useEffect, useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec, type FocusMetricSummary } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchP1BacklogMails, fetchP1Dashboard, markP1BacklogMailNeedsReply } from '../../api/p1'
import { formatHours, formatInteger } from '../../shared/utils/format'
import { buildFocusTrend, formatFocusBucketLabel } from '../../shared/utils/focusTrend'
import { buildDirectionalDelta, type DeltaMode, type MetricPolarity } from '../../shared/utils/delta'
import {
  getRealtimeCurrentPeriod, getRealtimePreviousPeriod, getRealtimeDefaultHistoryRange, getPeriodCount,
  getRealtimeCurrentPeriodLabel, getRealtimePreviousPeriodLabel, getRealtimePresetHistoryRange,
} from '../../shared/utils/datePeriod'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { WorkloadAnalysis } from './WorkloadAnalysis'
import { sortBacklogMailsByWaitDesc } from './backlogMails'
import type { Grain, P1BacklogMail, P1Dashboard as P1DashboardData, TrendPoint } from '../../api/types'

const AGENT_OPTIONS = [
  { value: '', label: '全部客服' },
  { value: 'Mira', label: 'Mira' },
  { value: 'Wendy', label: 'Wendy' },
  { value: 'Lila', label: 'Lila' },
  { value: 'Chloe', label: 'Chloe' },
  { value: 'Mia', label: 'Mia' },
  { value: 'Jovie', label: 'Jovie' },
]

function formatBacklogNote(note: string) {
  if (note === 'agent_filter_unsupported') {
    return '当前积压邮件暂不支持按客服过滤。'
  }
  return note
}

function formatBacklogSender(mail: P1BacklogMail) {
  const email = mail.customer_email || mail.from_email
  if (mail.from_name && email) return `${mail.from_name} · ${email}`
  return mail.from_name || email || '未知客户'
}

function shouldShowEnvelopeEmail(mail: P1BacklogMail) {
  return Boolean(mail.from_email && mail.customer_email && mail.from_email !== mail.customer_email)
}

export default function P1Dashboard() {
  const today = useMemo(() => new Date(), [])
  const [grain, setGrain] = useState<Grain>('day')
  const [agentName, setAgentName] = useState<string>('')
  const [historyRange, setHistoryRange] = useState(() => getRealtimeDefaultHistoryRange('day', today))
  const [activeMetricKey, setActiveMetricKey] = useState('inbound_email_count')
  const [backlogModalOpen, setBacklogModalOpen] = useState(false)
  const [backlogMails, setBacklogMails] = useState<P1BacklogMail[]>([])
  const [backlogLoading, setBacklogLoading] = useState(false)
  const [backlogError, setBacklogError] = useState<string | null>(null)
  const [backlogNotes, setBacklogNotes] = useState<string[]>([])
  const [expandedMailId, setExpandedMailId] = useState<number | null>(null)
  const [markingMailId, setMarkingMailId] = useState<number | null>(null)

  const currentPeriod = useMemo(() => getRealtimeCurrentPeriod(grain, today), [grain, today])
  const previousPeriod = useMemo(() => getRealtimePreviousPeriod(grain, today), [grain, today])
  const previousPeriodLabel = useMemo(() => getRealtimePreviousPeriodLabel(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getRealtimeDefaultHistoryRange(next, today))
  }

  const baseFilters = { grain, agent_name: agentName } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P1DashboardData>({
    baseFilters,
    currentPeriod,
    previousPeriod,
    historyRange,
    fetcher: (filters, signal) => fetchP1Dashboard(filters as never, signal),
  })

  async function loadBacklogMails(signal?: AbortSignal) {
    setBacklogLoading(true)
    setBacklogError(null)
    try {
      const result = await fetchP1BacklogMails({
        date_from: currentPeriod.date_from,
        date_to: currentPeriod.date_to,
        grain,
        agent_name: agentName,
        limit: 100,
      }, signal)
      const sortedItems = sortBacklogMailsByWaitDesc(result.items)
      setBacklogMails(sortedItems)
      setBacklogNotes(result.meta?.notes ?? [])
      setExpandedMailId((currentId) =>
        currentId && sortedItems.some((item) => item.mail_id === currentId) ? currentId : null,
      )
    } catch (err) {
      if (signal?.aborted) return
      setBacklogNotes([])
      setBacklogError(err instanceof Error ? err.message : '积压邮件列表加载失败')
    } finally {
      if (!signal?.aborted) setBacklogLoading(false)
    }
  }

  useEffect(() => {
    if (!backlogModalOpen) return
    const controller = new AbortController()
    void loadBacklogMails(controller.signal)
    return () => controller.abort()
  }, [backlogModalOpen, currentPeriod.date_from, currentPeriod.date_to, grain, agentName])

  async function markMail(mailId: number, needsReply: boolean) {
    setMarkingMailId(mailId)
    setBacklogError(null)
    try {
      await markP1BacklogMailNeedsReply(mailId, needsReply)
      await loadBacklogMails()
    } catch (err) {
      setBacklogError(err instanceof Error ? err.message : '标记失败')
    } finally {
      setMarkingMailId(null)
    }
  }

  const visibleP1Note = current?.meta?.notes?.find(
    (note) => !note.includes('工时表暂未接入'),
  )

  const periodCount = getPeriodCount(historyRange, grain)

  const cards = [
    {
      key: 'inbound_email_count',
      label: '来邮数',
      description: getMetricDescription('p1.inbound_email_count'),
      sparkline: true,
      currentValue: current?.summary.inbound_email_count,
      previousValue: previous?.summary.inbound_email_count,
      historyTrend: (history?.trends.inbound_email_count ?? []) as TrendPoint[],
      formatter: formatInteger,
      deltaMode: 'percent' as DeltaMode,
      polarity: 'neutral' as MetricPolarity,
      isRate: false,
    },
    {
      key: 'outbound_email_count',
      label: '回邮数',
      description: getMetricDescription('p1.outbound_email_count'),
      sparkline: true,
      currentValue: current?.summary.outbound_email_count,
      previousValue: previous?.summary.outbound_email_count,
      historyTrend: (history?.trends.outbound_email_count ?? []) as TrendPoint[],
      formatter: formatInteger,
      deltaMode: 'percent' as DeltaMode,
      polarity: 'neutral' as MetricPolarity,
      isRate: false,
    },
    {
      key: 'avg_queue_hours',
      label: '平均会话排队时长',
      description: getMetricDescription('p1.avg_queue_hours'),
      sparkline: true,
      currentValue: current?.summary.avg_queue_hours,
      previousValue: previous?.summary.avg_queue_hours,
      historyTrend: (history?.trends.avg_queue_hours ?? []) as TrendPoint[],
      formatter: (n: number) => formatHours(n, 1),
      deltaMode: 'percent' as DeltaMode,
      polarity: 'negative' as MetricPolarity,
      isRate: false,
    },
    {
      key: 'late_reply_count',
      label: '已回复但延迟',
      description: getMetricDescription('p1.late_reply_count'),
      sparkline: true,
      currentValue: current?.summary.late_reply_count,
      previousValue: previous?.summary.late_reply_count,
      historyTrend: (history?.trends.late_reply_count ?? []) as TrendPoint[],
      formatter: formatInteger,
      deltaMode: 'percent' as DeltaMode,
      polarity: 'negative' as MetricPolarity,
      isRate: false,
    },
  ]

  const backlogSnapshot = {
    unrepliedCount: loading ? '--' : formatInteger(current?.summary.unreplied_count ?? 0),
    avgUnrepliedWait: loading ? '--' : formatHours(current?.summary.avg_unreplied_wait_hours ?? 0, 1),
  }

  const focusMetrics: FocusMetricSpec[] = cards.map((c) => {
    const trend = buildFocusTrend(c.historyTrend, grain, currentPeriod, c.currentValue, {
      currentDayIsIncomplete: true,
    })
    return {
      key: c.key,
      label: c.label,
      formatter: c.formatter,
      history: trend.history,
      current: trend.current,
    }
  })

  // Per-metric summary line for focus chart
  const rangeLabel = grain === 'day' ? `近 ${periodCount} 天`
    : grain === 'week' ? `近 ${periodCount} 周`
    : `近 ${periodCount} 月`
  const summaryByKey: Record<string, FocusMetricSummary> = {}
  for (const c of cards) {
    const total = c.historyTrend.reduce((s, p) => s + p.value, 0)
    const count = c.historyTrend.length
    const mean = count ? total / count : 0
    summaryByKey[c.key] = {
      items: [
        { label: `${rangeLabel}累计`, value: count ? c.formatter(total) : '--' },
        { label: '区间均值', value: count ? c.formatter(mean) : '--' },
      ],
    }
  }

  return (
    <>
    <DashboardShell
      filterBar={
        <FilterBar
          grain={grain}
          onGrainChange={handleGrainChange}
          historyRange={historyRange}
          onHistoryRangeChange={setHistoryRange}
          maxDate={today}
          presetRangeBuilder={(value) => getRealtimePresetHistoryRange(value, today)}
          extras={
            <div className="filter-bar__group">
              <span className="filter-bar__label">客服姓名</span>
              <select
                className="select-control"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              >
                {AGENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          }
        />
      }
      banner={
        error ? <section className="status-banner status-banner--error">{error}</section> :
        visibleP1Note ? (
          <section className="status-banner status-banner--info">
            {visibleP1Note}
          </section>
        ) : null
      }
      currentPeriodSection={
        <KpiSection
          title={getRealtimeCurrentPeriodLabel(grain)}
          subtitle={`数据截至 ${currentPeriod.date_to}`}
          variant="current"
          className="kpi-section--p1-current"
        >
          {cards.map((c) => {
            const secondaryValue = loading || c.previousValue === undefined || c.previousValue === null
              ? '--'
              : c.formatter(c.previousValue)
            return (
              <KpiCard
                key={c.key}
                variant="current"
                label={c.label}
                description={c.description}
                value={loading ? '--' : c.formatter(c.currentValue ?? 0)}
                delta={loading ? undefined : buildDirectionalDelta(
                  c.currentValue,
                  c.previousValue,
                  c.deltaMode,
                  c.polarity,
                )}
                secondaryLabel={previousPeriodLabel}
                secondaryValue={secondaryValue}
                metricKey={c.key}
                active={activeMetricKey === c.key}
                onSelect={setActiveMetricKey}
                sparkline={c.historyTrend}
              />
            )
          })}
          <button
            type="button"
            className="p1-backlog-snapshot"
            aria-label="查看当前积压邮件"
            onClick={() => setBacklogModalOpen(true)}
          >
            <div className="p1-backlog-snapshot__header">
              <h3>当前积压</h3>
              <span>待 review &gt;</span>
            </div>
            <dl className="p1-backlog-snapshot__items">
              <div>
                <dt>当前积压未回</dt>
                <dd>{backlogSnapshot.unrepliedCount}</dd>
              </div>
              <div>
                <dt>当前积压平均等待</dt>
                <dd>{backlogSnapshot.avgUnrepliedWait}</dd>
              </div>
            </dl>
          </button>
        </KpiSection>
      }
      focusChart={loading ? null : (
        <FocusLineChart
          metrics={focusMetrics}
          activeKey={activeMetricKey}
          onActiveKeyChange={setActiveMetricKey}
          bucketFormatter={(bucket) => formatFocusBucketLabel(bucket, grain)}
          summaryByKey={summaryByKey}
        />
      )}
      extensions={
        <WorkloadAnalysis
          workloadRows={current?.agent_workload ?? []}
          loading={loading}
        />
      }
    />
    {backlogModalOpen ? (
      <div className="p1-backlog-modal" role="dialog" aria-modal="true" aria-label="当前积压邮件列表">
        <div className="p1-backlog-modal__backdrop" onClick={() => setBacklogModalOpen(false)} />
        <section className="p1-backlog-modal__panel">
          <header className="p1-backlog-modal__header">
            <div>
              <h2>当前积压邮件</h2>
              <span>{backlogMails.length} 项</span>
            </div>
            <button type="button" onClick={() => setBacklogModalOpen(false)}>关闭</button>
          </header>
          {backlogError ? <div className="status-banner status-banner--error">{backlogError}</div> : null}
          {!backlogError && backlogNotes.length > 0 ? (
            <div className="status-banner status-banner--info">
              {backlogNotes.map(formatBacklogNote).join('；')}
            </div>
          ) : null}
          <div className="p1-backlog-modal__body">
            {backlogLoading ? (
              <div className="p1-backlog-modal__empty">加载中...</div>
            ) : backlogMails.length === 0 ? (
              <div className="p1-backlog-modal__empty">暂无当前积压邮件</div>
            ) : (
              <div className="p1-backlog-list">
                {backlogMails.map((mail) => {
                  const expanded = expandedMailId === mail.mail_id
                  const title = mail.subject || mail.preview || `#${mail.mail_id}`
                  return (
                    <article key={mail.mail_id} className="p1-backlog-list__item">
                      <button
                        type="button"
                        className="p1-backlog-list__summary"
                        aria-expanded={expanded}
                        onClick={() => setExpandedMailId(expanded ? null : mail.mail_id)}
                      >
                        <span>
                          <strong>{title}</strong>
                          <small>{formatBacklogSender(mail)}</small>
                        </span>
                        <em>{formatHours(mail.wait_hours, 1)}</em>
                      </button>
                      {expanded ? (
                        <div className="p1-backlog-list__detail">
                          <div className="p1-backlog-list__meta">
                            <span>收到时间 {mail.received_at}</span>
                            <span>客户邮箱 {mail.customer_email || mail.from_email || '--'}</span>
                            {shouldShowEnvelopeEmail(mail) ? (
                              <span>发件邮箱 {mail.from_email}</span>
                            ) : null}
                            <span>{mail.needs_reply === false ? '不需回复' : '仍需回复'}</span>
                            <span>{mail.is_manually_reviewed ? '人工已确认' : '尚未人工确认'}</span>
                          </div>
                          <div className="p1-backlog-list__translations">
                            <section>
                              <h4>原文</h4>
                              <p>{mail.body?.original || mail.preview || '--'}</p>
                            </section>
                            <section>
                              <h4>中文</h4>
                              <p>{mail.body?.zh || '--'}</p>
                            </section>
                          </div>
                          <div className="p1-backlog-list__actions">
                            <button
                              type="button"
                              disabled={markingMailId === mail.mail_id}
                              onClick={() => void markMail(mail.mail_id, true)}
                            >
                              标记仍需回复
                            </button>
                            <button
                              type="button"
                              disabled={markingMailId === mail.mail_id}
                              onClick={() => void markMail(mail.mail_id, false)}
                            >
                              标记不需回复
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    ) : null}
    </>
  )
}
