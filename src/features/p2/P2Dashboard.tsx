import { useEffect, useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec, type FocusMetricSummary } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchRefundOverview } from '../../api/p2'
import { formatInteger, formatMoney, formatPercent } from '../../shared/utils/format'
import { buildFocusTrend, formatFocusBucketLabel } from '../../shared/utils/focusTrend'
import { buildDirectionalDelta, type DeltaMode, type MetricPolarity } from '../../shared/utils/delta'
import {
  getRealtimeCurrentPeriod, getRealtimePreviousPeriod, getRealtimeDefaultHistoryRange, getPeriodCount,
  getRealtimeCurrentPeriodLabel, getRealtimePreviousPeriodLabel, getRealtimePresetHistoryRange,
} from '../../shared/utils/datePeriod'
import { resolveDataAsOfLabel } from '../../shared/utils/dataAsOf'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { ProductRefundTable } from './ProductRefundTable'
import type { Grain, P2Filters, P2Overview, P2OverviewCards, TrendPoint } from '../../api/types'

const STORE_OPTIONS = [
  { value: '2vnpww-33', label: '2vnpww-33 (US)' },
  { value: 'lintico-fr', label: 'lintico-fr' },
  { value: 'lintico-uk', label: 'lintico-uk' },
]

type CardKey = keyof P2OverviewCards

export default function P2Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [store, setStore] = useState<string>('')
  const today = useMemo(() => new Date(), [])
  const [historyRange, setHistoryRange] = useState(() => getRealtimeDefaultHistoryRange('day', today))
  const [activeMetricKey, setActiveMetricKey] = useState<CardKey>('gmv')
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)

  const currentPeriod = useMemo(() => getRealtimeCurrentPeriod(grain, today), [grain, today])
  const previousPeriod = useMemo(() => getRealtimePreviousPeriod(grain, today), [grain, today])
  const previousPeriodLabel = useMemo(() => getRealtimePreviousPeriodLabel(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getRealtimeDefaultHistoryRange(next, today))
    setSelectedBucket(null)
  }

  useEffect(() => {
    setSelectedBucket(null)
  }, [historyRange.date_from, historyRange.date_to, store])

  const baseFilters = { grain, channel: store } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P2Overview>({
    baseFilters,
    currentPeriod, previousPeriod, historyRange,
    fetcher: (filters, signal) => fetchRefundOverview(filters as never, signal),
  })
  const dataAsOfLabel = resolveDataAsOfLabel(current?.meta, { cadence: 'hourly' }) ?? currentPeriod.date_to

  const periodCount = getPeriodCount(historyRange, grain)

  const formatPercent1 = (n: number) => formatPercent(n, 1)

  const cards: Array<{
    key: CardKey
    label: string
    sparkline: boolean
    formatter: (n: number) => string
    deltaMode: DeltaMode
    polarity: MetricPolarity
    isRate: boolean
    description: string
  }> = [
    { key: 'order_count', label: '订单数', sparkline: true, formatter: formatInteger, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.order_count') },
    { key: 'sales_qty', label: '销量', sparkline: false, formatter: formatInteger, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.sales_qty') },
    { key: 'refund_order_count', label: '退款订单数', sparkline: false, formatter: formatInteger, deltaMode: 'percent', polarity: 'negative', isRate: false, description: getMetricDescription('p2.refund_order_count') },
    { key: 'refund_amount', label: '退款金额', sparkline: true, formatter: formatMoney, deltaMode: 'percent', polarity: 'negative', isRate: false, description: getMetricDescription('p2.refund_amount') },
    { key: 'gmv', label: 'GMV', sparkline: true, formatter: formatMoney, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.gmv') },
    { key: 'net_received_amount', label: '净实付金额', sparkline: false, formatter: formatMoney, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.net_received_amount') },
    { key: 'net_revenue_amount', label: '净 GMV', sparkline: false, formatter: formatMoney, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.net_revenue_amount') },
    { key: 'refund_amount_ratio', label: '退款金额占比', sparkline: true, formatter: formatPercent1, deltaMode: 'pp', polarity: 'negative', isRate: true, description: getMetricDescription('p2.refund_amount_ratio') },
  ]

  const enrichedCards = cards.map((c) => {
    const currentValue = current?.cards[c.key]
    const previousValue = previous?.cards[c.key]
    const historyTrend: TrendPoint[] = history?.trends?.[c.key] ?? []
    return { ...c, currentValue, previousValue, historyTrend }
  })

  const focusMetrics: FocusMetricSpec[] = enrichedCards.map((c) => {
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
  for (const c of enrichedCards) {
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
          storeOptions={STORE_OPTIONS}
          store={store}
          onStoreChange={setStore}
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
            {enrichedCards.map((c) => {
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
                  onSelect={(next) => setActiveMetricKey(next as CardKey)}
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
          onActiveKeyChange={(next) => setActiveMetricKey(next as CardKey)}
          bucketFormatter={(bucket) => formatFocusBucketLabel(bucket, grain)}
          summaryByKey={summaryByKey}
          selectedBucket={selectedBucket}
          onBucketSelect={setSelectedBucket}
        />
      )}
      extensions={
        <ProductRefundTable baseFilters={{ ...baseFilters, ...historyRange } as P2Filters} />
      }
    />
  )
}
