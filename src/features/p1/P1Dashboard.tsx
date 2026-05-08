import { useCallback, useEffect, useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart } from '../../shared/components/FocusLineChart'
import { FocusSummaryBlock } from '../../shared/components/FocusSummaryBlock'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import {
  fetchP1AgentMailNameMappings,
  fetchP1BacklogMails,
  fetchP1Dashboard,
  markP1BacklogMailNeedsReply,
  saveP1AgentMailNameMappings,
} from '../../api/p1'
import { formatHours, formatInteger } from '../../shared/utils/format'
import { buildFocusTrend, formatFocusBucketLabel } from '../../shared/utils/focusTrend'
import { aggregateFocusMetric, type FocusAggregationMetric, type FocusSelection } from '../../shared/utils/focusAggregation'
import { buildDirectionalDelta, type DeltaMode, type MetricPolarity } from '../../shared/utils/delta'
import {
  getRealtimeCurrentPeriod, getRealtimePreviousPeriod, getRealtimeDefaultHistoryRange,
  getRealtimeCurrentPeriodLabel, getRealtimePreviousPeriodLabel,
} from '../../shared/utils/datePeriod'
import { resolveDataAsOfLabel } from '../../shared/utils/dataAsOf'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { WorkloadAnalysis, buildAgentFilterOptions } from './WorkloadAnalysis'
import { AgentNameMappingModal } from './AgentNameMappingModal'
import { sortBacklogMailsByWaitDesc } from './backlogMails'
import type { Grain, P1AgentMailNameMapping, P1AgentRow, P1BacklogMail, P1Dashboard as P1DashboardData, TrendPoint } from '../../api/types'

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
  const [focusSelection, setFocusSelection] = useState<FocusSelection>({ type: 'all' })
  const [backlogModalOpen, setBacklogModalOpen] = useState(false)
  const [backlogMails, setBacklogMails] = useState<P1BacklogMail[]>([])
  const [backlogLoading, setBacklogLoading] = useState(false)
  const [backlogError, setBacklogError] = useState<string | null>(null)
  const [backlogNotes, setBacklogNotes] = useState<string[]>([])
  const [expandedMailId, setExpandedMailId] = useState<number | null>(null)
  const [markingMailId, setMarkingMailId] = useState<number | null>(null)
  const [mappingModalOpen, setMappingModalOpen] = useState(false)
  const [agentMailNameMappings, setAgentMailNameMappings] = useState<P1AgentMailNameMapping[]>([])
  const [agentOptionSourceRows, setAgentOptionSourceRows] = useState<P1AgentRow[]>([])
  const [mappingLoadingError, setMappingLoadingError] = useState<string | null>(null)
  const [mappingSaving, setMappingSaving] = useState(false)

  const currentPeriod = useMemo(() => getRealtimeCurrentPeriod(grain, today), [grain, today])
  const previousPeriod = useMemo(() => getRealtimePreviousPeriod(grain, today), [grain, today])
  const previousPeriodLabel = useMemo(() => getRealtimePreviousPeriodLabel(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getRealtimeDefaultHistoryRange(next, today))
    setFocusSelection({ type: 'all' })
  }

  useEffect(() => {
    setFocusSelection({ type: 'all' })
  }, [historyRange.date_from, historyRange.date_to, agentName])

  const baseFilters = { grain, agent_name: agentName } as const

  const { current, previous, history, loading, error, refetch } = useDashboardData<typeof baseFilters, P1DashboardData>({
    baseFilters,
    currentPeriod,
    previousPeriod,
    historyRange,
    fetcher: (filters, signal) => fetchP1Dashboard(filters as never, signal),
  })
  const dataAsOfLabel = resolveDataAsOfLabel(current?.meta, { cadence: '5min' }) ?? currentPeriod.date_to

  useEffect(() => {
    if (!agentName && history?.agent_workload?.length) {
      setAgentOptionSourceRows(history.agent_workload)
    }
  }, [agentName, history?.agent_workload])

  const agentOptions = useMemo(() => {
    const sourceRows = agentOptionSourceRows.length ? agentOptionSourceRows : (history?.agent_workload ?? [])
    const options = buildAgentFilterOptions(sourceRows, agentMailNameMappings)
    if (agentName && !options.some((option) => option.value === agentName)) {
      return [...options, { value: agentName, label: agentName }]
    }
    return options
  }, [agentMailNameMappings, agentName, agentOptionSourceRows, history?.agent_workload])

  const loadBacklogMails = useCallback(async (signal?: AbortSignal) => {
    setBacklogLoading(true)
    setBacklogError(null)
    try {
      const result = await fetchP1BacklogMails({
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
  }, [])

  useEffect(() => {
    if (!backlogModalOpen) return
    const controller = new AbortController()
    void loadBacklogMails(controller.signal)
    return () => controller.abort()
  }, [backlogModalOpen, loadBacklogMails])

  async function markMail(mailId: number, needsReply: boolean) {
    setMarkingMailId(mailId)
    setBacklogError(null)
    try {
      await markP1BacklogMailNeedsReply(mailId, needsReply)
      await loadBacklogMails()
      refetch()
    } catch (err) {
      setBacklogError(err instanceof Error ? err.message : '标记失败')
    } finally {
      setMarkingMailId(null)
    }
  }


  const loadAgentMailNameMappings = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await fetchP1AgentMailNameMappings(signal)
      setAgentMailNameMappings(result.mappings)
      setMappingLoadingError(null)
    } catch (err) {
      if (signal?.aborted) return
      setMappingLoadingError(err instanceof Error ? err.message : '映射配置加载失败')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadAgentMailNameMappings(controller.signal)
    return () => controller.abort()
  }, [loadAgentMailNameMappings])

  async function saveAgentMailNameMappingConfig(mappings: P1AgentMailNameMapping[]) {
    setMappingSaving(true)
    setMappingLoadingError(null)
    try {
      const result = await saveP1AgentMailNameMappings({ mappings })
      setAgentMailNameMappings(result.mappings)
      setMappingModalOpen(false)
    } catch (err) {
      setMappingLoadingError(err instanceof Error ? err.message : '映射配置保存失败')
    } finally {
      setMappingSaving(false)
    }
  }

  const visibleP1Note = current?.meta?.notes?.find(
    (note) => !note.includes('工时表暂未接入'),
  )

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

  const focusMetrics: FocusAggregationMetric[] = cards.map((c) => {
    const trend = buildFocusTrend(c.historyTrend, grain, currentPeriod, c.currentValue, {
      currentDayIsIncomplete: true,
    })
    return {
      key: c.key,
      label: c.label,
      formatter: c.formatter,
      history: trend.history,
      current: trend.current,
      aggregationMode: c.key === 'avg_queue_hours' ? 'nonAdditive' : 'additive',
    }
  })

  const focusSummaryBlocks = focusMetrics.map((metric, index) => ({
    metric,
    blockLabel: `区块 ${String.fromCharCode(65 + index)} · ${metric.label}`,
    summary: aggregateFocusMetric(
      metric,
      focusSelection,
      (bucket) => formatFocusBucketLabel(bucket, grain),
    ),
  }))
  const focusSummaryRangeLabel = focusSummaryBlocks[0]?.summary.label ?? '完整范围'

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
          extras={
            <div className="filter-bar__group p1-agent-filter">
              <span className="filter-bar__label p1-agent-filter__label">客服姓名</span>
              <select
                className="select-control p1-agent-filter__select"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              >
                {agentOptions.map((opt) => (
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
          subtitle={`数据截至 ${dataAsOfLabel}；KPI 主值为当前周期，迷你趋势和下方趋势图为所选历史范围`}
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
              <div>
                <span className="p1-backlog-snapshot__eyebrow">当前快照</span>
                <h3>当前积压</h3>
              </div>
              <span className="p1-backlog-snapshot__scope">不受历史范围影响</span>
            </div>
            <dl className="p1-backlog-snapshot__items">
              <div>
                <dt>未回</dt>
                <dd>{backlogSnapshot.unrepliedCount}</dd>
              </div>
              <div>
                <dt>平均等待</dt>
                <dd>{backlogSnapshot.avgUnrepliedWait}</dd>
              </div>
            </dl>
            <span className="p1-backlog-snapshot__entry">查看待处理邮件 &gt;</span>
          </button>
        </KpiSection>
      }
      focusSummaryBlock={loading ? null : (
        <section className="focus-summary-panel" aria-label="P1 KPI 的焦点范围统计">
          <header className="focus-summary-panel__header">
            <div>
              <span className="focus-summary-panel__eyebrow">焦点范围统计</span>
              <h2>焦点范围：{focusSummaryRangeLabel}</h2>
            </div>
            {focusSelection.type !== 'all' ? (
              <button type="button" className="focus-summary-panel__reset" onClick={() => setFocusSelection({ type: 'all' })}>
                重置为完整范围
              </button>
            ) : null}
          </header>
          <div className="focus-summary-blocks">
            {focusSummaryBlocks.map(({ metric, blockLabel, summary }) => (
              <FocusSummaryBlock
                key={metric.key}
                metricLabel={metric.label}
                blockLabel={blockLabel}
                selection={focusSelection}
                summary={summary}
              />
            ))}
          </div>
        </section>
      )}
      focusChart={loading ? null : (
        <FocusLineChart
          metrics={focusMetrics}
          activeKey={activeMetricKey}
          onActiveKeyChange={setActiveMetricKey}
          bucketFormatter={(bucket) => formatFocusBucketLabel(bucket, grain)}
          selection={focusSelection}
          onSelectionChange={setFocusSelection}
        />
      )}
      extensions={
        <WorkloadAnalysis
          workloadRows={history?.agent_workload ?? []}
          loading={loading}
          historyRange={historyRange}
          mappings={agentMailNameMappings}
          onOpenMappingConfig={() => setMappingModalOpen(true)}
        />
      }
    />
    {mappingModalOpen ? (
      <AgentNameMappingModal
        mappings={agentMailNameMappings}
        saving={mappingSaving}
        error={mappingLoadingError}
        onClose={() => setMappingModalOpen(false)}
        onSave={(mappings) => void saveAgentMailNameMappingConfig(mappings)}
      />
    ) : null}
    {backlogModalOpen ? (
      <div className="p1-backlog-modal" role="dialog" aria-modal="true" aria-label="当前积压邮件列表">
        <div className="p1-backlog-modal__backdrop" onClick={() => setBacklogModalOpen(false)} />
        <section className="p1-backlog-modal__panel">
          <header className="p1-backlog-modal__header">
            <div>
              <h2>当前积压邮件</h2>
              <span>{backlogMails.length} 项 · 当前快照，不受历史时间范围影响</span>
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
