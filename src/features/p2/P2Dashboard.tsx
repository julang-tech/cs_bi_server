import { useEffect, useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart } from '../../shared/components/FocusLineChart'
import { FocusSummaryBlock } from '../../shared/components/FocusSummaryBlock'
import { KpiCard, type MetricTone } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchRefundOverview } from '../../api/p2'
import { formatInteger, formatMoney, formatPercent } from '../../shared/utils/format'
import { buildFocusTrend, formatFocusBucketLabel } from '../../shared/utils/focusTrend'
import { aggregateFocusMetric, type FocusAggregationMetric, type FocusSelection } from '../../shared/utils/focusAggregation'
import { buildDirectionalDelta, type DeltaMode, type MetricPolarity } from '../../shared/utils/delta'
import {
  getRealtimeCurrentPeriod, getRealtimePreviousPeriod, getRealtimeDefaultHistoryRange,
  getRealtimeCurrentPeriodLabel, getRealtimePreviousPeriodLabel, getRealtimePresetHistoryRange,
} from '../../shared/utils/datePeriod'
import { resolveDataAsOfLabel } from '../../shared/utils/dataAsOf'
import { getMetricDescription } from '../../shared/metricDefinitions'
import { ProductRefundTable } from './ProductRefundTable'
import type { Grain, P2Filters, P2Overview, P2OverviewCards, TrendPoint } from '../../api/types'

const STORE_OPTIONS = [
  { value: '2vnpww-33.myshopify.com', label: '2vnpww-33 (US)' },
  { value: 'lintico-fr.myshopify.com', label: 'lintico-fr' },
  { value: 'lintico-uk.myshopify.com', label: 'lintico-uk' },
]

type CardKey = keyof P2OverviewCards
type P2DateBasis = 'order_date' | 'refund_date'

const REFUND_METRIC_DESCRIPTIONS: Record<P2DateBasis, Partial<Record<CardKey, string>>> = {
  order_date: {
    refund_order_count: '退款影响：该指标会随退款发生而增加，并受页面“退款口径”影响。订单时间口径：统计所选下单时间范围内，当前累计发生过退款的订单数。',
    refund_amount: '退款影响：该指标会随退款发生而增加，并直接扣减净 GMV。订单时间口径：统计所选下单时间范围内订单的当前累计退款金额。',
    net_revenue_amount: '退款影响：净 GMV 会扣除退款，退款金额越高，该指标越低；订单时间口径下反映同批订单的累计退款扣减。',
    refund_amount_ratio: '退款影响：分子是退款金额，退款越高该占比越高；净实付金额只作为分母，不扣退款。订单时间口径：所选下单时间范围内订单的当前累计退款金额 ÷ 同批订单净实付金额。',
  },
  refund_date: {
    refund_order_count: '退款影响：该指标会随退款发生而增加，并受页面“退款口径”影响。退款时间口径：统计所选时间范围内实际发生退款事件的订单数。',
    refund_amount: '退款影响：该指标会随退款发生而增加，并直接扣减净 GMV。退款时间口径：统计所选时间范围内实际发生的退款金额。',
    net_revenue_amount: '退款影响：净 GMV 会扣除退款，退款金额越高，该指标越低；退款时间口径下反映当期退款流入造成的扣减。',
    refund_amount_ratio: '退款影响：分子是退款金额，退款越高该占比越高；净实付金额只作为分母，不扣退款。退款时间口径：所选时间范围内实际发生退款金额 ÷ 同期订单时间范围内净实付金额。',
  },
}

const REFUND_TONE_METRICS = new Set<CardKey>([
  'refund_order_count',
  'refund_amount',
  'net_revenue_amount',
  'refund_amount_ratio',
])

function getMetricTone(key: CardKey): MetricTone {
  return REFUND_TONE_METRICS.has(key) ? 'refund' : 'neutral'
}

function getRefundMetricDescription(key: CardKey, dateBasis: P2DateBasis) {
  const base = getMetricDescription(`p2.${key}`)
  const basisText = REFUND_METRIC_DESCRIPTIONS[dateBasis][key]
  return basisText ? `${base} ${basisText}` : base
}

export default function P2Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [store, setStore] = useState<string>('')
  const [dateBasis, setDateBasis] = useState<'order_date' | 'refund_date'>('order_date')
  const today = useMemo(() => new Date(), [])
  const [historyRange, setHistoryRange] = useState(() => getRealtimeDefaultHistoryRange('day', today))
  const [activeMetricKey, setActiveMetricKey] = useState<CardKey>('gmv')
  const [focusSelection, setFocusSelection] = useState<FocusSelection>({ type: 'all' })

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
  }, [historyRange.date_from, historyRange.date_to, store, dateBasis])

  const baseFilters = { grain, channel: store, date_basis: dateBasis } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P2Overview>({
    baseFilters,
    currentPeriod, previousPeriod, historyRange,
    fetcher: (filters, signal) => fetchRefundOverview(filters as never, signal),
  })
  const dataAsOfLabel = resolveDataAsOfLabel(current?.meta, { cadence: 'hourly' }) ?? currentPeriod.date_to

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
    tone: MetricTone
  }> = [
    { key: 'order_count', label: '订单数', sparkline: true, formatter: formatInteger, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.order_count'), tone: getMetricTone('order_count') },
    { key: 'sales_qty', label: '销量', sparkline: false, formatter: formatInteger, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.sales_qty'), tone: getMetricTone('sales_qty') },
    { key: 'refund_order_count', label: '退款订单数', sparkline: false, formatter: formatInteger, deltaMode: 'percent', polarity: 'negative', isRate: false, description: getRefundMetricDescription('refund_order_count', dateBasis), tone: getMetricTone('refund_order_count') },
    { key: 'refund_amount', label: '退款金额', sparkline: true, formatter: formatMoney, deltaMode: 'percent', polarity: 'negative', isRate: false, description: getRefundMetricDescription('refund_amount', dateBasis), tone: getMetricTone('refund_amount') },
    { key: 'gmv', label: 'GMV', sparkline: true, formatter: formatMoney, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.gmv'), tone: getMetricTone('gmv') },
    { key: 'net_received_amount', label: '净实付金额', sparkline: false, formatter: formatMoney, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getMetricDescription('p2.net_received_amount'), tone: getMetricTone('net_received_amount') },
    { key: 'net_revenue_amount', label: '净 GMV', sparkline: false, formatter: formatMoney, deltaMode: 'percent', polarity: 'positive', isRate: false, description: getRefundMetricDescription('net_revenue_amount', dateBasis), tone: getMetricTone('net_revenue_amount') },
    { key: 'refund_amount_ratio', label: '退款金额占比', sparkline: true, formatter: formatPercent1, deltaMode: 'pp', polarity: 'negative', isRate: true, description: getRefundMetricDescription('refund_amount_ratio', dateBasis), tone: getMetricTone('refund_amount_ratio') },
  ]

  const enrichedCards = cards.map((c) => {
    const currentValue = current?.cards[c.key]
    const previousValue = previous?.cards[c.key]
    const historyTrend: TrendPoint[] = history?.trends?.[c.key] ?? []
    return { ...c, currentValue, previousValue, historyTrend }
  })

  const focusMetrics: FocusAggregationMetric[] = enrichedCards.map((c) => {
    const trend = buildFocusTrend(c.historyTrend, grain, currentPeriod, c.currentValue, {
      currentDayIsIncomplete: true,
    })
    return {
      key: c.key,
      label: c.label,
      formatter: c.formatter,
      history: trend.history,
      current: trend.current,
      tone: c.tone,
      aggregationMode: c.isRate ? 'nonAdditive' : 'additive',
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
          extras={
            <div className="filter-bar__group">
              <span className="filter-bar__label">退款口径</span>
              <select
                className="select-control"
                value={dateBasis}
                onChange={(e) => setDateBasis(e.target.value as typeof dateBasis)}
              >
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
      currentPeriodSection={
        <KpiSection
            title={getRealtimeCurrentPeriodLabel(grain)}
            subtitle={`数据截至 ${dataAsOfLabel}`}
            variant="current"
          >
            {enrichedCards.map((c) => {
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
                  onSelect={(next) => setActiveMetricKey(next as CardKey)}
                  sparkline={c.historyTrend}
                  sparklineTone={c.tone}
                  tone={c.tone}
                />
              )
            })}
        </KpiSection>
      }
      focusSummaryBlock={loading ? null : (
        <div className="focus-summary-blocks" aria-label="P2 KPI 的焦点范围统计">
          {focusSummaryBlocks.map(({ metric, blockLabel, summary }) => (
            <FocusSummaryBlock
              key={metric.key}
              metricLabel={metric.label}
              blockLabel={blockLabel}
              selection={focusSelection}
              summary={summary}
              onReset={metric.key === focusMetrics[0]?.key ? () => setFocusSelection({ type: 'all' }) : undefined}
            />
          ))}
        </div>
      )}
      focusChart={loading ? null : (
        <FocusLineChart
          metrics={focusMetrics}
          activeKey={activeMetricKey}
          onActiveKeyChange={(next) => setActiveMetricKey(next as CardKey)}
          bucketFormatter={(bucket) => formatFocusBucketLabel(bucket, grain)}
          selection={focusSelection}
          onSelectionChange={setFocusSelection}
        />
      )}
      extensions={
        <ProductRefundTable baseFilters={{ ...baseFilters, ...historyRange } as P2Filters} />
      }
    />
  )
}
