import { useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec, type FocusMetricSummary } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchP1Dashboard } from '../../api/p1'
import { formatHours, formatInteger } from '../../shared/utils/format'
import {
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange, getPeriodCount,
  getCurrentPeriodLabel,
} from '../../shared/utils/datePeriod'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { WorkloadAnalysis } from './WorkloadAnalysis'
import type { Grain, P1Dashboard as P1DashboardData, TrendPoint } from '../../api/types'

const AGENT_OPTIONS = [
  { value: '', label: '全部客服' },
  { value: 'Mira', label: 'Mira' },
  { value: 'Wendy', label: 'Wendy' },
  { value: 'Lila', label: 'Lila' },
  { value: 'Chloe', label: 'Chloe' },
  { value: 'Mia', label: 'Mia' },
  { value: 'Jovie', label: 'Jovie' },
]

function buildDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  mode: 'percent' | 'pp',
) {
  if (previous === null || previous === undefined) return { tone: 'muted' as const, text: '-' }
  if (mode === 'pp') {
    const diff = (current ?? 0) - (previous ?? 0)
    if (diff === 0) return { tone: 'neutral' as const, text: '0.00pp' }
    return {
      tone: diff > 0 ? 'up' as const : 'down' as const,
      text: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff * 100).toFixed(2)}pp`,
    }
  }
  if (!previous) return { tone: 'muted' as const, text: '-' }
  const ratio = ((current ?? 0) - previous) / previous
  if (ratio === 0) return { tone: 'neutral' as const, text: '0.0%' }
  return {
    tone: ratio > 0 ? 'up' as const : 'down' as const,
    text: `${ratio > 0 ? '↑' : '↓'} ${Math.abs(ratio * 100).toFixed(1)}%`,
  }
}

export default function P1Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [agentName, setAgentName] = useState<string>('')
  const [historyRange, setHistoryRange] = useState(() => getDefaultHistoryRange('day'))
  const [activeMetricKey, setActiveMetricKey] = useState('inbound_email_count')

  const currentPeriod = useMemo(() => getCurrentPeriod(grain), [grain])
  const previousPeriod = useMemo(() => getPreviousPeriod(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getDefaultHistoryRange(next))
  }

  const baseFilters = { grain, agent_name: agentName } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P1DashboardData>({
    baseFilters,
    currentPeriod,
    previousPeriod,
    historyRange,
    fetcher: (filters, signal) => fetchP1Dashboard(filters as never, signal),
  })

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
      currentTrend: current
        ? [{ bucket: currentPeriod.date_to, value: current.summary.inbound_email_count }]
        : [],
      formatter: formatInteger,
      deltaMode: 'percent' as const,
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
      currentTrend: current
        ? [{ bucket: currentPeriod.date_to, value: current.summary.outbound_email_count }]
        : [],
      formatter: formatInteger,
      deltaMode: 'percent' as const,
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
      currentTrend: current
        ? [{ bucket: currentPeriod.date_to, value: current.summary.avg_queue_hours }]
        : [],
      formatter: (n: number) => formatHours(n, 1),
      deltaMode: 'percent' as const,
      isRate: false,
    },
    {
      key: 'first_response_timeout_count',
      label: '首次响应超时次数',
      description: getMetricDescription('p1.first_response_timeout_count'),
      sparkline: true,
      currentValue: current?.summary.first_response_timeout_count,
      previousValue: previous?.summary.first_response_timeout_count,
      historyTrend: (history?.trends.first_response_timeout_count ?? []) as TrendPoint[],
      currentTrend: current
        ? [{ bucket: currentPeriod.date_to, value: current.summary.first_response_timeout_count }]
        : [],
      formatter: formatInteger,
      deltaMode: 'percent' as const,
      isRate: false,
    },
  ]

  const focusMetrics: FocusMetricSpec[] = cards.map((c) => ({
    key: c.key,
    label: c.label,
    formatter: c.formatter,
    history: c.historyTrend,
    current: c.currentTrend,
  }))

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
    <DashboardShell
      filterBar={
        <FilterBar
          grain={grain}
          onGrainChange={handleGrainChange}
          historyRange={historyRange}
          onHistoryRangeChange={setHistoryRange}
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
        <KpiSection title={getCurrentPeriodLabel(grain)} subtitle={`数据截至 ${currentPeriod.date_to}`} variant="current">
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
                delta={loading ? undefined : buildDelta(c.currentValue, c.previousValue, c.deltaMode)}
                secondaryLabel="上期"
                secondaryValue={secondaryValue}
                metricKey={c.key}
                active={activeMetricKey === c.key}
                onSelect={setActiveMetricKey}
                sparkline={c.historyTrend}
              />
            )
          })}
        </KpiSection>
      }
      focusChart={loading ? null : (
        <FocusLineChart
          metrics={focusMetrics}
          activeKey={activeMetricKey}
          onActiveKeyChange={setActiveMetricKey}
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
  )
}
