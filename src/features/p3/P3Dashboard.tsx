import { useEffect, useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec, type FocusMetricSummary } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchDashboard, fetchDrilldownOptions, fetchProductRanking } from '../../api/p3'
import { formatInteger, formatPercent } from '../../shared/utils/format'
import { buildFocusTrend, formatFocusBucketLabel } from '../../shared/utils/focusTrend'
import { buildDirectionalDelta, type DeltaMode, type MetricPolarity } from '../../shared/utils/delta'
import {
  getRealtimeCurrentPeriod, getRealtimePreviousPeriod, getRealtimeDefaultHistoryRange, getPeriodCount,
  getRealtimeCurrentPeriodLabel, getRealtimePreviousPeriodLabel, getRealtimePresetHistoryRange,
} from '../../shared/utils/datePeriod'
import { formatDataAsOf } from '../../shared/utils/dataAsOf'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { IssueStructure } from './IssueStructure'
import { ProductComplaintRanking } from './ProductComplaintRanking'
import type { Grain, P3Dashboard as P3DashboardData, P3IssueShareItem, P3ProductRankingRow } from '../../api/types'

export default function P3Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [dateBasis, setDateBasis] = useState<'record_date' | 'order_date' | 'refund_date'>('record_date')
  const today = useMemo(() => new Date(), [])
  const [historyRange, setHistoryRange] = useState(() => getRealtimeDefaultHistoryRange('day', today))
  const [activeMetricKey, setActiveMetricKey] = useState('complaint_rate')
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)

  const currentPeriod = useMemo(() => getRealtimeCurrentPeriod(grain, today), [grain, today])
  const previousPeriod = useMemo(() => getRealtimePreviousPeriod(grain, today), [grain, today])
  const previousPeriodLabel = useMemo(() => getRealtimePreviousPeriodLabel(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getRealtimeDefaultHistoryRange(next, today))
    setSelectedBucket(null)
  }

  // Drop the historical bucket selection whenever the time window or basis
  // shifts — the bucket may no longer exist in the new history.
  useEffect(() => {
    setSelectedBucket(null)
  }, [historyRange.date_from, historyRange.date_to, dateBasis])

  const baseFilters = { grain, date_basis: dateBasis } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P3DashboardData>({
    baseFilters,
    currentPeriod, previousPeriod, historyRange,
    fetcher: (filters, signal) => fetchDashboard(filters as never, signal),
  })
  const dataAsOfLabel = formatDataAsOf(current?.meta?.data_as_of) ?? currentPeriod.date_to

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

  const cards = [
    {
      key: 'sales_qty', label: '销量', sparkline: true,
      description: getMetricDescription('p3.sales_qty'),
      currentValue: current?.summary.sales_qty,
      previousValue: previous?.summary.sales_qty,
      historyTrend: history?.trends.sales_qty ?? [],
      formatter: formatInteger, deltaMode: 'percent' as DeltaMode, polarity: 'positive' as MetricPolarity, isRate: false,
    },
    {
      key: 'order_count', label: '订单量', sparkline: true,
      description: getMetricDescription('p3.order_count'),
      currentValue: current?.summary.order_count,
      previousValue: previous?.summary.order_count,
      historyTrend: history?.trends.order_count ?? [],
      formatter: formatInteger, deltaMode: 'percent' as DeltaMode, polarity: 'positive' as MetricPolarity, isRate: false,
    },
    {
      key: 'complaint_count', label: '客诉量', sparkline: true,
      description: getMetricDescription('p3.complaint_count'),
      currentValue: current?.summary.complaint_count,
      previousValue: previous?.summary.complaint_count,
      historyTrend: history?.trends.complaint_count ?? [],
      formatter: formatInteger, deltaMode: 'percent' as DeltaMode, polarity: 'negative' as MetricPolarity, isRate: false,
    },
    {
      key: 'complaint_rate', label: '客诉率', sparkline: true,
      description: getMetricDescription('p3.complaint_rate'),
      currentValue: current?.summary.complaint_rate,
      previousValue: previous?.summary.complaint_rate,
      historyTrend: history?.trends.complaint_rate ?? [],
      formatter: (n: number) => formatPercent(n, 2), deltaMode: 'pp' as DeltaMode, polarity: 'negative' as MetricPolarity, isRate: true,
    },
  ]

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

  // Build per-metric summary for the focus chart from the visible range only.
  const rangeLabel = grain === 'day' ? `近 ${periodCount} 天`
    : grain === 'week' ? `近 ${periodCount} 周`
    : `近 ${periodCount} 月`
  const summaryByKey: Record<string, FocusMetricSummary> = {}
  for (const c of cards) {
    const total = c.historyTrend.reduce((s, p) => s + p.value, 0)
    const count = c.historyTrend.length
    const mean = count ? total / count : 0
    const peak = count ? Math.max(...c.historyTrend.map((p) => p.value)) : 0
    if (c.isRate) {
      summaryByKey[c.key] = {
        items: [
          { label: '区间均值', value: count ? c.formatter(mean) : '--' },
          { label: '区间峰值', value: count ? c.formatter(peak) : '--' },
        ],
      }
    } else {
      summaryByKey[c.key] = {
        items: [
          { label: `${rangeLabel}累计`, value: count ? c.formatter(total) : '--' },
          { label: '区间均值', value: count ? c.formatter(mean) : '--' },
        ],
      }
    }
  }

  return (
    <DashboardShell
      filterBar={
        <FilterBar
          grain={grain} onGrainChange={handleGrainChange}
          historyRange={historyRange} onHistoryRangeChange={setHistoryRange}
          maxDate={today}
          presetRangeBuilder={(value) => getRealtimePresetHistoryRange(value, today)}
          extras={
            <div className="filter-bar__group">
              <span className="filter-bar__label">时间口径</span>
              <select
                className="select-control"
                value={dateBasis}
                onChange={(e) => setDateBasis(e.target.value as typeof dateBasis)}
              >
                <option value="record_date">客诉登记时间</option>
                <option value="order_date">订单时间</option>
                <option value="refund_date">退款时间</option>
              </select>
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
      currentPeriodSection={(() => {
        const isHistorical = selectedBucket !== null
        const sectionTitle = isHistorical
          ? formatFocusBucketLabel(selectedBucket, grain)
          : getRealtimeCurrentPeriodLabel(grain)
        const sectionSubtitle = isHistorical
          ? '点击图表上的其他点切换，或重置回当前周期'
          : `数据截至 ${dataAsOfLabel}`
        return (
          <KpiSection
            title={sectionTitle}
            subtitle={sectionSubtitle}
            variant="current"
            action={isHistorical ? (
              <button type="button" onClick={() => setSelectedBucket(null)}>重置当前周期</button>
            ) : undefined}
          >
            {cards.map((c) => {
              // When a historical bucket is selected from the chart, override
              // the current/previous values from that bucket and the bucket
              // immediately before it. First bucket in range has no previous,
              // so no delta is shown (per user spec "区间第一天除外").
              let displayCurrent = c.currentValue
              let displayPrev: number | null | undefined = c.previousValue
              let displayPrevLabel = previousPeriodLabel
              let showDelta = true
              if (isHistorical) {
                const idx = c.historyTrend.findIndex((p) => p.bucket === selectedBucket)
                if (idx >= 0) {
                  displayCurrent = c.historyTrend[idx].value
                  if (idx > 0) {
                    displayPrev = c.historyTrend[idx - 1].value
                    displayPrevLabel = `vs ${formatFocusBucketLabel(c.historyTrend[idx - 1].bucket, grain)}`
                  } else {
                    displayPrev = null
                    displayPrevLabel = '区间起点'
                    showDelta = false
                  }
                }
              }
              const secondaryValue = loading || displayPrev === undefined || displayPrev === null
                ? '--'
                : c.formatter(displayPrev)
              return (
                <KpiCard
                  key={c.key}
                  variant="current"
                  label={c.label}
                  description={c.description}
                  value={loading ? '--' : c.formatter(displayCurrent ?? 0)}
                  delta={loading || !showDelta ? undefined : buildDirectionalDelta(
                    displayCurrent,
                    displayPrev,
                    c.deltaMode,
                    c.polarity,
                  )}
                  secondaryLabel={displayPrevLabel}
                  secondaryValue={secondaryValue}
                  metricKey={c.key}
                  active={activeMetricKey === c.key}
                  onSelect={setActiveMetricKey}
                  sparkline={c.historyTrend}
                />
              )
            })}
          </KpiSection>
        )
      })()}
      focusChart={loading ? null : (
        <FocusLineChart
          metrics={focusMetrics}
          activeKey={activeMetricKey}
          onActiveKeyChange={setActiveMetricKey}
          bucketFormatter={(bucket) => formatFocusBucketLabel(bucket, grain)}
          summaryByKey={summaryByKey}
          selectedBucket={selectedBucket}
          onBucketSelect={setSelectedBucket}
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
