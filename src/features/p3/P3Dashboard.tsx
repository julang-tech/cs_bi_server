import { useEffect, useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart } from '../../shared/components/FocusLineChart'
import { FocusSummaryBlock } from '../../shared/components/FocusSummaryBlock'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchDashboard, fetchDrilldownOptions, fetchProductRanking } from '../../api/p3'
import { formatInteger, formatPercent } from '../../shared/utils/format'
import { buildFocusTrend, formatFocusBucketLabel } from '../../shared/utils/focusTrend'
import { aggregateFocusMetric, type FocusAggregationMetric, type FocusSelection } from '../../shared/utils/focusAggregation'
import { buildDirectionalDelta, type DeltaMode, type MetricPolarity } from '../../shared/utils/delta'
import {
  getRealtimeCurrentPeriod, getRealtimePreviousPeriod, getRealtimeDefaultHistoryRange,
  getRealtimeCurrentPeriodLabel, getRealtimePreviousPeriodLabel, getRealtimePresetHistoryRange,
} from '../../shared/utils/datePeriod'
import { resolveDataAsOfLabel } from '../../shared/utils/dataAsOf'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { IssueStructure } from './IssueStructure'
import { ProductComplaintRanking } from './ProductComplaintRanking'
import type { Grain, P3Dashboard as P3DashboardData, P3IssueShareItem, P3ProductRankingRow } from '../../api/types'

type P3DateBasis = 'record_date' | 'order_date'

const COMPLAINT_METRIC_DESCRIPTIONS: Record<P3DateBasis, Partial<Record<string, string>>> = {
  record_date: {
    complaint_count: '客诉登记时间口径：按 CS 在飞书登记的记录日期归属客诉量。',
    complaint_rate: '客诉登记时间口径：登记时间客诉量 ÷ 同期订单销量，适合看运营录入视角，不是严格订单 cohort 率。',
  },
  order_date: {
    complaint_count: '订单时间口径：按客诉关联订单的下单日期归属客诉量。',
    complaint_rate: '订单时间口径：该批订单产生的客诉量 ÷ 该批订单销量，是最接近 cohort 的客诉率。',
  },
}

function getComplaintMetricDescription(key: string, dateBasis: P3DateBasis) {
  const base = getMetricDescription(`p3.${key}`)
  const basisText = COMPLAINT_METRIC_DESCRIPTIONS[dateBasis][key]
  return basisText ? `${base} ${basisText}` : base
}

export default function P3Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [dateBasis, setDateBasis] = useState<P3DateBasis>('record_date')
  const today = useMemo(() => new Date(), [])
  const [historyRange, setHistoryRange] = useState(() => getRealtimeDefaultHistoryRange('day', today))
  const [activeMetricKey, setActiveMetricKey] = useState('complaint_rate')
  const [focusSelection, setFocusSelection] = useState<FocusSelection>({ type: 'all' })

  const currentPeriod = useMemo(() => getRealtimeCurrentPeriod(grain, today), [grain, today])
  const previousPeriod = useMemo(() => getRealtimePreviousPeriod(grain, today), [grain, today])
  const previousPeriodLabel = useMemo(() => getRealtimePreviousPeriodLabel(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getRealtimeDefaultHistoryRange(next, today))
    setFocusSelection({ type: 'all' })
  }

  // Drop the historical bucket selection whenever the time window or basis
  // shifts — the bucket may no longer exist in the new history.
  useEffect(() => {
    setFocusSelection({ type: 'all' })
  }, [historyRange.date_from, historyRange.date_to, dateBasis])

  const baseFilters = { grain, date_basis: dateBasis } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P3DashboardData>({
    baseFilters,
    currentPeriod, previousPeriod, historyRange,
    fetcher: (filters, signal) => fetchDashboard(filters as never, signal),
  })
  const dataAsOfLabel = resolveDataAsOfLabel(current?.meta, { cadence: 'hourly' }) ?? currentPeriod.date_to

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
      description: getComplaintMetricDescription('complaint_count', dateBasis),
      currentValue: current?.summary.complaint_count,
      previousValue: previous?.summary.complaint_count,
      historyTrend: history?.trends.complaint_count ?? [],
      formatter: formatInteger, deltaMode: 'percent' as DeltaMode, polarity: 'negative' as MetricPolarity, isRate: false,
    },
    {
      key: 'complaint_rate', label: '客诉率', sparkline: true,
      description: getComplaintMetricDescription('complaint_rate', dateBasis),
      currentValue: current?.summary.complaint_rate,
      previousValue: previous?.summary.complaint_rate,
      historyTrend: history?.trends.complaint_rate ?? [],
      formatter: (n: number) => formatPercent(n, 2), deltaMode: 'pp' as DeltaMode, polarity: 'negative' as MetricPolarity, isRate: true,
    },
  ]

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
      aggregationMode: c.isRate ? 'nonAdditive' : 'additive',
    }
  })

  const focusSummarySelection: FocusSelection = { type: 'all' }
  const focusSummaryBlocks = focusMetrics.map((metric, index) => ({
    metric,
    blockLabel: `区块 ${String.fromCharCode(65 + index)} · ${metric.label}`,
    summary: aggregateFocusMetric(
      metric,
      focusSummarySelection,
      (bucket) => formatFocusBucketLabel(bucket, grain),
    ),
  }))

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
      currentPeriodSection={
        <KpiSection
            title={getRealtimeCurrentPeriodLabel(grain)}
            subtitle={`数据截至 ${dataAsOfLabel}`}
            variant="current"
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
        </KpiSection>
      }
      focusSummaryBlock={loading ? null : (
        <div className="focus-summary-blocks" aria-label="四个 KPI 的焦点范围统计">
          {focusSummaryBlocks.map(({ metric, blockLabel, summary }) => (
            <FocusSummaryBlock
              key={metric.key}
              metricLabel={metric.label}
              blockLabel={blockLabel}
              selection={focusSummarySelection}
              summary={summary}
            />
          ))}
        </div>
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
        <>
          <IssueStructure dashboard={history} options={options} />
          <ProductComplaintRanking
            rows={ranking}
            loading={extLoading}
            error={extError}
            dateBasis={dateBasis}
          />
        </>
      }
    />
  )
}
