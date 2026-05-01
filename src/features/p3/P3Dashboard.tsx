import { useEffect, useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec, type FocusMetricSummary } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchDashboard, fetchDrilldownOptions, fetchProductRanking } from '../../api/p3'
import { formatInteger, formatPercent } from '../../shared/utils/format'
import {
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange, getPeriodCount, getPeriodLengthDays,
  getCurrentPeriodLabel, getPreviousHistoryRange,
} from '../../shared/utils/datePeriod'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { IssueStructure } from './IssueStructure'
import { ProductComplaintRanking } from './ProductComplaintRanking'
import type { Grain, P3Dashboard as P3DashboardData, P3IssueShareItem, P3ProductRankingRow } from '../../api/types'

function buildDelta(current: number | null | undefined, previous: number | null | undefined, mode: 'percent' | 'pp') {
  if (previous === null || previous === undefined) return { tone: 'muted' as const, text: '-' }
  if (mode === 'pp') {
    const diff = (current ?? 0) - (previous ?? 0)
    if (diff === 0) return { tone: 'neutral' as const, text: '0.00pp' }
    return { tone: diff > 0 ? 'up' as const : 'down' as const, text: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff * 100).toFixed(2)}pp` }
  }
  if (!previous) return { tone: 'muted' as const, text: '-' }
  const ratio = ((current ?? 0) - previous) / previous
  if (ratio === 0) return { tone: 'neutral' as const, text: '0.0%' }
  return { tone: ratio > 0 ? 'up' as const : 'down' as const, text: `${ratio > 0 ? '↑' : '↓'} ${Math.abs(ratio * 100).toFixed(1)}%` }
}

export default function P3Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [dateBasis, setDateBasis] = useState<'order_date' | 'refund_date'>('order_date')
  const [historyRange, setHistoryRange] = useState(() => getDefaultHistoryRange('day'))
  const [activeMetricKey, setActiveMetricKey] = useState('complaint_rate')

  const currentPeriod = useMemo(() => getCurrentPeriod(grain), [grain])
  const previousPeriod = useMemo(() => getPreviousPeriod(grain), [grain])
  const previousHistoryRange = useMemo(() => getPreviousHistoryRange(historyRange), [historyRange])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getDefaultHistoryRange(next))
  }

  const baseFilters = { grain, date_basis: dateBasis } as const

  const { current, previous, history, previousHistory, loading, error } = useDashboardData<typeof baseFilters, P3DashboardData>({
    baseFilters,
    currentPeriod, previousPeriod, historyRange, previousHistoryRange,
    fetcher: (filters, signal) => fetchDashboard(filters as never, signal),
  })

  // Extension area data (independent fetches)
  const [options, setOptions] = useState<P3IssueShareItem[]>([])
  const [ranking, setRanking] = useState<P3ProductRankingRow[]>([])
  const [extLoading, setExtLoading] = useState(true)
  const [extError, setExtError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setExtLoading(true)
    setExtError('')
    Promise.all([
      fetchDrilldownOptions({ ...baseFilters, ...historyRange }, controller.signal),
      fetchProductRanking({ ...baseFilters, ...historyRange }, controller.signal),
    ])
      .then(([opts, rank]) => {
        setOptions(opts.options ?? [])
        setRanking(rank.ranking ?? [])
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
        setOptions([])
        setRanking([])
        setExtError((err as Error).message || '扩展区数据加载失败')
      })
      .finally(() => setExtLoading(false))
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grain, dateBasis, historyRange.date_from, historyRange.date_to])

  const periodCount = getPeriodCount(historyRange, grain)
  const currentPeriodDays = getPeriodLengthDays(currentPeriod)

  const cards = [
    {
      key: 'sales_qty', label: '订单数', sparkline: true,
      description: getMetricDescription('p3.sales_qty'),
      currentValue: current?.summary.sales_qty,
      previousValue: previous?.summary.sales_qty,
      historyTrend: history?.trends.sales_qty ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: current.summary.sales_qty }] : [],
      formatter: formatInteger, deltaMode: 'percent' as const, isRate: false,
    },
    {
      key: 'complaint_count', label: '客诉量', sparkline: true,
      description: getMetricDescription('p3.complaint_count'),
      currentValue: current?.summary.complaint_count,
      previousValue: previous?.summary.complaint_count,
      historyTrend: history?.trends.complaint_count ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: current.summary.complaint_count }] : [],
      formatter: formatInteger, deltaMode: 'percent' as const, isRate: false,
    },
    {
      key: 'complaint_rate', label: '客诉率', sparkline: true,
      description: getMetricDescription('p3.complaint_rate'),
      currentValue: current?.summary.complaint_rate,
      previousValue: previous?.summary.complaint_rate,
      historyTrend: history?.trends.complaint_rate ?? [],
      currentTrend: current ? [{ bucket: currentPeriod.date_to, value: current.summary.complaint_rate }] : [],
      formatter: (n: number) => formatPercent(n, 2), deltaMode: 'pp' as const, isRate: true,
    },
  ]

  const focusMetrics: FocusMetricSpec[] = cards.map((c) => ({
    key: c.key,
    label: c.label,
    formatter: c.formatter,
    history: c.historyTrend,
    current: c.currentTrend,
  }))

  // Build per-metric summary for the focus chart (区间累计/均值 + vs 上一区间)
  const rangeLabel = grain === 'day' ? `近 ${periodCount} 天`
    : grain === 'week' ? `近 ${periodCount} 周`
    : `近 ${periodCount} 月`
  function previousRangeTotal(key: 'sales_qty' | 'complaint_count' | 'complaint_rate'): number | null {
    const t = previousHistory?.trends?.[key] ?? null
    if (!t) return null
    return t.reduce((s, p) => s + p.value, 0)
  }
  const summaryByKey: Record<string, FocusMetricSummary> = {}
  for (const c of cards) {
    const total = c.historyTrend.reduce((s, p) => s + p.value, 0)
    const count = c.historyTrend.length
    const mean = count ? total / count : 0
    const peak = count ? Math.max(...c.historyTrend.map((p) => p.value)) : 0
    const prevTotal = previousRangeTotal(c.key as 'sales_qty' | 'complaint_count' | 'complaint_rate')
    const prevCount = previousHistory?.trends?.[c.key as 'sales_qty']?.length ?? 0
    const prevMean = prevCount && prevTotal !== null ? prevTotal / prevCount : null
    let delta: FocusMetricSummary['delta']
    if (c.isRate) {
      if (prevMean === null) delta = { tone: 'muted', text: '-' }
      else {
        const diff = mean - prevMean
        delta = diff === 0
          ? { tone: 'neutral', text: '0.00pp' }
          : { tone: diff > 0 ? 'up' : 'down', text: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff * 100).toFixed(2)}pp` }
      }
      summaryByKey[c.key] = {
        items: [
          { label: '区间均值', value: count ? c.formatter(mean) : '--' },
          { label: '区间峰值', value: count ? c.formatter(peak) : '--' },
        ],
        delta,
      }
    } else {
      if (prevTotal === null || prevTotal === 0) delta = { tone: 'muted', text: '-' }
      else {
        const ratio = (total - prevTotal) / prevTotal
        delta = ratio === 0
          ? { tone: 'neutral', text: '0.0%' }
          : { tone: ratio > 0 ? 'up' : 'down', text: `${ratio > 0 ? '↑' : '↓'} ${Math.abs(ratio * 100).toFixed(1)}%` }
      }
      summaryByKey[c.key] = {
        items: [
          { label: `${rangeLabel}累计`, value: count ? c.formatter(total) : '--' },
          { label: '区间均值', value: count ? c.formatter(mean) : '--' },
        ],
        delta,
      }
    }
  }

  return (
    <DashboardShell
      filterBar={
        <FilterBar
          grain={grain} onGrainChange={handleGrainChange}
          historyRange={historyRange} onHistoryRangeChange={setHistoryRange}
          extras={
            <div className="filter-bar__group">
              <span className="filter-bar__label">时间口径</span>
              <div className="segmented-control">
                {[
                  { value: 'order_date' as const, label: '订单时间' },
                  { value: 'refund_date' as const, label: '退款时间' },
                ].map((opt) => (
                  <button key={opt.value} type="button"
                    className={`segment-button ${dateBasis === opt.value ? 'segment-button--active' : ''}`}
                    onClick={() => setDateBasis(opt.value)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          }
        />
      }
      banner={
        error ? <section className="status-banner status-banner--error">{error}</section> :
        current?.meta?.partial_data ? (
          <section className="status-banner status-banner--info">
            {current.meta.notes?.[0] ?? '当前数据存在局部缺失。'}
          </section>
        ) : null
      }
      currentPeriodSection={
        <KpiSection title={getCurrentPeriodLabel(grain)} subtitle={`数据截至 ${currentPeriod.date_to}`} variant="current">
          {cards.map((c) => {
            const periodAverage = c.isRate
              ? (loading || c.currentValue === undefined || c.currentValue === null
                ? '--'
                : c.formatter(c.currentValue))
              : (loading || c.currentValue === undefined || c.currentValue === null
                ? '--'
                : c.formatter((c.currentValue ?? 0) / currentPeriodDays))
            return (
              <KpiCard
                key={c.key}
                variant="current"
                label={c.label}
                description={c.description}
                value={loading ? '--' : c.formatter(c.currentValue ?? 0)}
                delta={loading ? undefined : buildDelta(c.currentValue, c.previousValue, c.deltaMode)}
                periodAverage={periodAverage}
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
        <>
          <IssueStructure dashboard={history} options={options} />
          <ProductComplaintRanking rows={ranking} loading={extLoading} error={extError} />
        </>
      }
    />
  )
}
