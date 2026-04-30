import { useEffect, useMemo, useState } from 'react'
import {
  fetchDashboard,
  fetchDrilldownOptions,
  fetchProductRanking,
} from './api/p3'
import { ProductRankingSection, SummaryCard, TableSection, TrendSection } from './dashboardComponents'
import {
  DATE_BASIS_OPTIONS,
  GRAIN_OPTIONS,
  ISSUE_COPY,
  buildDelta,
  createDefaultFilters,
  formatInteger,
  formatPercent,
  getMetricWindow,
  getMetricWindowLabel,
  getPreviousDateWindow,
  sortIssueShare,
} from './dashboardUtils'

export default function P3Dashboard() {
  const defaultFilters = useMemo(() => createDefaultFilters(), [])
  const [filters, setFilters] = useState(defaultFilters)
  const [dashboard, setDashboard] = useState(null)
  const [metricDashboard, setMetricDashboard] = useState(null)
  const [previousMetricDashboard, setPreviousMetricDashboard] = useState(null)
  const [options, setOptions] = useState([])
  const [ranking, setRanking] = useState([])
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [rankingLoading, setRankingLoading] = useState(true)
  const [dashboardError, setDashboardError] = useState('')
  const [rankingError, setRankingError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function loadDashboard() {
      setDashboardLoading(true)
      setRankingLoading(true)
      setDashboardError('')
      setRankingError('')
      const currentFilters = filters
      const metricWindow = getMetricWindow(filters.grain, filters.date_to)
      const metricFilters = { ...filters, ...metricWindow }
      const previousMetricFilters = { ...filters, ...getPreviousDateWindow(metricWindow) }

      try {
        const [
          dashboardResponse,
          metricDashboardResponse,
          previousMetricDashboardResponse,
          drilldownOptionsResponse,
          rankingResponse,
        ] = await Promise.all([
          fetchDashboard(currentFilters, controller.signal),
          fetchDashboard(metricFilters, controller.signal),
          fetchDashboard(previousMetricFilters, controller.signal),
          fetchDrilldownOptions(currentFilters, controller.signal),
          fetchProductRanking(currentFilters, controller.signal),
        ])

        setDashboard(dashboardResponse)
        setMetricDashboard(metricDashboardResponse)
        setPreviousMetricDashboard(previousMetricDashboardResponse)
        setOptions(drilldownOptionsResponse.options ?? [])
        setRanking(rankingResponse.ranking ?? [])
      } catch (error) {
        if (error.name !== 'AbortError') {
          setDashboard(null)
          setMetricDashboard(null)
          setPreviousMetricDashboard(null)
          setOptions([])
          setRanking([])
          setDashboardError(error.message || 'P3 总览加载失败，请稍后重试。')
          setRankingError(error.message || '商品排行加载失败，请稍后重试。')
        }
      } finally {
        if (!controller.signal.aborted) {
          setDashboardLoading(false)
          setRankingLoading(false)
        }
      }
    }

    loadDashboard()
    return () => controller.abort()
  }, [filters])

  const updateDateFilter = (field, value) => {
    if (!value) {
      return
    }

    setFilters((current) => {
      const next = { ...current, [field]: value }
      if (next.date_from > next.date_to) {
        return current
      }
      return next
    })
  }

  const summary = metricDashboard?.summary
  const rangeSummary = dashboard?.summary
  const previousSummary = previousMetricDashboard?.summary
  const metricWindowLabel = getMetricWindowLabel(filters.grain)

  const issueRows = useMemo(
    () => sortIssueShare(dashboard?.issue_share, options, dashboard?.summary?.sales_qty ?? 0),
    [dashboard?.issue_share, options, dashboard?.summary?.sales_qty],
  )
  const salesDelta = buildDelta(summary?.sales_qty, previousSummary?.sales_qty, 'percent')
  const complaintDelta = buildDelta(
    summary?.complaint_count,
    previousSummary?.complaint_count,
    'percent',
  )
  const complaintRateDelta = buildDelta(
    summary?.complaint_rate,
    previousSummary?.complaint_rate,
    'pp',
  )

  const issueColumns = [
    {
      key: 'label',
      label: '客诉原因',
      render: (row) => (
        <span className={`issue-label ${ISSUE_COPY[row.major_issue_type].accent}`}>{row.label}</span>
      ),
    },
    {
      key: 'estimatedRate',
      label: '客诉率',
      render: (row) => formatPercent(row.estimatedRate, 2),
    },
    {
      key: 'ratio',
      label: '客诉占比',
      render: (row) => formatPercent(row.ratio, 1),
    },
  ]

  return (
    <main className="dashboard-shell">
      <section className="toolbar-panel">
        <div className="toolbar-group">
          <span className="toolbar-label">时间粒度</span>
          <div className="segmented-control" role="tablist" aria-label="粒度切换">
            {GRAIN_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segment-button ${filters.grain === option.value ? 'segment-button--active' : ''}`}
                onClick={() => setFilters((current) => ({ ...current, grain: option.value }))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">时间口径</span>
          <div className="segmented-control" role="tablist" aria-label="时间口径切换">
            {DATE_BASIS_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segment-button ${
                  filters.date_basis === option.value ? 'segment-button--active' : ''
                }`}
                onClick={() => setFilters((current) => ({ ...current, date_basis: option.value }))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-group toolbar-group--dates">
          <span className="toolbar-label">日期范围</span>
          <div className="date-range-control">
            <label className="date-field">
              <span>开始</span>
              <input
                type="date"
                value={filters.date_from}
                max={filters.date_to}
                onChange={(event) => updateDateFilter('date_from', event.target.value)}
              />
            </label>
            <label className="date-field">
              <span>结束</span>
              <input
                type="date"
                value={filters.date_to}
                min={filters.date_from}
                onChange={(event) => updateDateFilter('date_to', event.target.value)}
              />
            </label>
          </div>
        </div>
      </section>

      {dashboardError ? <section className="status-banner status-banner--error">{dashboardError}</section> : null}

      <section className="summary-grid">
        <SummaryCard
          title="订单数"
          value={dashboardLoading ? '--' : formatInteger(summary?.sales_qty)}
          rangeLabel="范围总量"
          rangeValue={dashboardLoading ? '--' : formatInteger(rangeSummary?.sales_qty)}
          description="按订单时间窗统计的订单量，用于观察客诉规模对应的订单基数。"
          badge={{ label: dashboardLoading ? '计算中' : salesDelta.text, tone: salesDelta.tone }}
          tone="sales"
        />
        <SummaryCard
          title="客诉量"
          value={dashboardLoading ? '--' : formatInteger(summary?.complaint_count)}
          rangeLabel="范围总量"
          rangeValue={dashboardLoading ? '--' : formatInteger(rangeSummary?.complaint_count)}
          description="按当前时间口径统计进入面板的标准化客诉记录数。"
          badge={{
            label: dashboardLoading ? '计算中' : complaintDelta.text,
            tone: complaintDelta.tone,
          }}
          tone="complaints"
        />
        <SummaryCard
          title="客诉率"
          value={dashboardLoading ? '--' : formatPercent(summary?.complaint_rate, 2)}
          rangeLabel="范围总量"
          rangeValue={dashboardLoading ? '--' : formatPercent(rangeSummary?.complaint_rate, 2)}
          description="按订单数口径观察问题密度，优先识别异常商品与异常分类。"
          badge={{
            label: dashboardLoading ? '计算中' : complaintRateDelta.text,
            tone: complaintRateDelta.tone,
          }}
          tone="rate"
        />
      </section>

      <div className="metric-window-note">
        主数值为截至 {filters.date_to} 的{metricWindowLabel}；范围总量按当前日期范围计算。
      </div>

      <TrendSection dashboard={dashboard} />

      <TableSection
        title="问题结构分析"
        hint="客诉率为按订单数估算的分类客诉率"
        columns={issueColumns}
        rows={issueRows}
        emptyCopy="暂无问题结构数据"
      />

      <ProductRankingSection rows={ranking} loading={rankingLoading} error={rankingError} />
    </main>
  )
}
