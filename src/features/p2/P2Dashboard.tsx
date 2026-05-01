import { useMemo, useState } from 'react'
import { DashboardShell } from '../../shared/components/DashboardShell'
import { FilterBar } from '../../shared/components/FilterBar'
import { FocusLineChart, type FocusMetricSpec } from '../../shared/components/FocusLineChart'
import { KpiCard } from '../../shared/components/KpiCard'
import { KpiSection } from '../../shared/components/KpiSection'
import { useDashboardData } from '../../shared/hooks/useDashboardData'
import { fetchRefundOverview } from '../../api/p2'
import { formatInteger, formatMoney, formatPercent } from '../../shared/utils/format'
import {
  getCurrentPeriod, getPreviousPeriod, getDefaultHistoryRange, getPeriodCount,
} from '../../shared/utils/datePeriod'
import { ProductRefundTable } from './ProductRefundTable'
import type { Grain, P2Filters, P2Overview, P2OverviewCards, TrendPoint } from '../../api/types'

const STORE_OPTIONS = [
  { value: '2vnpww-33', label: '2vnpww-33 (US)' },
  { value: 'lintico-fr', label: 'lintico-fr' },
  { value: 'lintico-uk', label: 'lintico-uk' },
]

type CardKey = keyof P2OverviewCards

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
      tone: diff > 0 ? ('up' as const) : ('down' as const),
      text: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff * 100).toFixed(2)}pp`,
    }
  }
  if (!previous) return { tone: 'muted' as const, text: '-' }
  const ratio = ((current ?? 0) - previous) / previous
  if (ratio === 0) return { tone: 'neutral' as const, text: '0.0%' }
  return {
    tone: ratio > 0 ? ('up' as const) : ('down' as const),
    text: `${ratio > 0 ? '↑' : '↓'} ${Math.abs(ratio * 100).toFixed(1)}%`,
  }
}

export default function P2Dashboard() {
  const [grain, setGrain] = useState<Grain>('day')
  const [store, setStore] = useState<string>('')
  const [historyRange, setHistoryRange] = useState(() => getDefaultHistoryRange('day'))

  const currentPeriod = useMemo(() => getCurrentPeriod(grain), [grain])
  const previousPeriod = useMemo(() => getPreviousPeriod(grain), [grain])

  function handleGrainChange(next: Grain) {
    setGrain(next)
    setHistoryRange(getDefaultHistoryRange(next))
  }

  const baseFilters = { grain, channel: store } as const

  const { current, previous, history, loading, error } = useDashboardData<typeof baseFilters, P2Overview>({
    baseFilters,
    currentPeriod, previousPeriod, historyRange,
    fetcher: (filters, signal) => fetchRefundOverview(filters as never, signal),
  })

  const periodCount = getPeriodCount(historyRange, grain)
  const periodLabelByGrain = { day: '天', week: '周', month: '月' } as const

  const formatPercent1 = (n: number) => formatPercent(n, 1)

  const cards: Array<{
    key: CardKey
    label: string
    sparkline: boolean
    formatter: (n: number) => string
    deltaMode: 'percent' | 'pp'
    isRate: boolean
  }> = [
    { key: 'order_count', label: '订单数', sparkline: true, formatter: formatInteger, deltaMode: 'percent', isRate: false },
    { key: 'sales_qty', label: '销量', sparkline: false, formatter: formatInteger, deltaMode: 'percent', isRate: false },
    { key: 'refund_order_count', label: '退款订单数', sparkline: false, formatter: formatInteger, deltaMode: 'percent', isRate: false },
    { key: 'refund_amount', label: '退款金额', sparkline: true, formatter: formatMoney, deltaMode: 'percent', isRate: false },
    { key: 'gmv', label: 'GMV', sparkline: true, formatter: formatMoney, deltaMode: 'percent', isRate: false },
    { key: 'net_received_amount', label: '净实付金额', sparkline: false, formatter: formatMoney, deltaMode: 'percent', isRate: false },
    { key: 'net_revenue_amount', label: '净 GMV', sparkline: false, formatter: formatMoney, deltaMode: 'percent', isRate: false },
    { key: 'refund_amount_ratio', label: '退款金额占比', sparkline: true, formatter: formatPercent1, deltaMode: 'pp', isRate: true },
  ]

  const enrichedCards = cards.map((c) => {
    const currentValue = current?.cards[c.key]
    const previousValue = previous?.cards[c.key]
    const historyTrend: TrendPoint[] = history?.trends?.[c.key] ?? []
    const currentTrend: TrendPoint[] = current
      ? [{ bucket: currentPeriod.date_to, value: current.cards[c.key] ?? 0 }]
      : []
    return { ...c, currentValue, previousValue, historyTrend, currentTrend }
  })

  const focusMetrics: FocusMetricSpec[] = enrichedCards.map((c) => ({
    key: c.key,
    label: c.label,
    formatter: c.formatter,
    history: c.historyTrend,
    current: c.currentTrend,
  }))

  return (
    <DashboardShell
      filterBar={
        <FilterBar
          grain={grain} onGrainChange={handleGrainChange}
          historyRange={historyRange} onHistoryRangeChange={setHistoryRange}
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
      currentPeriodSection={
        <KpiSection title="当前周期" subtitle={`数据截至 ${currentPeriod.date_to}（T-1）`} variant="current">
          {enrichedCards.map((c) => (
            <KpiCard
              key={c.key}
              variant="current"
              label={c.label}
              value={loading ? '--' : c.formatter(c.currentValue ?? 0)}
              delta={loading ? undefined : buildDelta(c.currentValue, c.previousValue, c.deltaMode)}
              periodAverage="-"
              sparkline={c.sparkline ? c.historyTrend : undefined}
            />
          ))}
        </KpiSection>
      }
      focusChart={loading ? null : <FocusLineChart metrics={focusMetrics} defaultKey="gmv" />}
      historySection={
        <KpiSection
          title="历史区间"
          subtitle={`${historyRange.date_from} - ${historyRange.date_to} · 共 ${periodCount} 个完整周期 · 按${periodLabelByGrain[grain]}聚合`}
          variant="history"
        >
          {enrichedCards.map((c) => {
            const total = c.historyTrend.reduce((s, p) => s + p.value, 0)
            if (c.isRate) {
              const mean = c.historyTrend.length ? total / c.historyTrend.length : 0
              const peak = c.historyTrend.length ? Math.max(...c.historyTrend.map((p) => p.value)) : 0
              return (
                <KpiCard key={c.key} variant="history" label={c.label}
                  total={c.formatter(mean)} periodAverage={c.formatter(mean)}
                  rateMode={{ mean: c.formatter(mean), peak: c.formatter(peak) }} />
              )
            }
            return (
              <KpiCard key={c.key} variant="history" label={c.label}
                total={loading ? '--' : c.formatter(total)}
                periodAverage={loading ? '--' : c.formatter(c.historyTrend.length ? total / c.historyTrend.length : 0)} />
            )
          })}
        </KpiSection>
      }
      extensions={
        <ProductRefundTable baseFilters={{ ...baseFilters, ...historyRange } as P2Filters} />
      }
    />
  )
}
