import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { fetchP1Dashboard } from './api/p1'
import {
  fetchDashboard,
  fetchDrilldownOptions,
  fetchProductRanking,
} from './api/p3'

const PAGE_OPTIONS = [
  {
    value: 'p1',
    code: 'P1',
    title: '聊天数据看板',
    description: '查看客服接待规模与响应效率',
  },
  {
    value: 'p2',
    code: 'P2',
    title: '退款情况看板',
    description: '查看退款规模、占比与商品分布',
  },
  {
    value: 'p3',
    code: 'P3',
    title: '客诉总览看板',
    description: '查看销量、客诉量、客诉率和整体问题规模',
  },
]

const GRAIN_OPTIONS = [
  { value: 'day', label: '按天' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

const DATE_BASIS_OPTIONS = [
  { value: 'order_date', label: '订单时间' },
  { value: 'refund_date', label: '退款时间' },
]

const P3_DEFAULT_START_DATE = '2026-01-01'
const P1_DEFAULT_START_DATE = '2026-04-01'
const RANKING_PAGE_SIZE_OPTIONS = [5, 10, 20, 50]

const AGENT_OPTIONS = [
  { value: '', label: '全部客服' },
  { value: 'Mira', label: 'Mira' },
  { value: 'Wendy', label: 'Wendy' },
  { value: 'Lila', label: 'Lila' },
  { value: 'Chloe', label: 'Chloe' },
  { value: 'Mia', label: 'Mia' },
  { value: 'Jovie', label: 'Jovie' },
]

const ISSUE_ORDER = ['product', 'logistics', 'warehouse']

const ISSUE_COPY = {
  product: {
    label: '产品问题',
    accent: 'issue-row--product',
  },
  logistics: {
    label: '物流问题',
    accent: 'issue-row--logistics',
  },
  warehouse: {
    label: '仓库问题',
    accent: 'issue-row--warehouse',
  },
}

function formatDateInput(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDefaultFilters() {
  return {
    grain: 'week',
    date_basis: 'order_date',
    date_from: P3_DEFAULT_START_DATE,
    date_to: formatDateInput(shiftDate(new Date(), -1)),
  }
}

function createDefaultP1Filters() {
  return {
    grain: 'day',
    date_from: P1_DEFAULT_START_DATE,
    date_to: formatDateInput(shiftDate(new Date(), -1)),
    agent_name: '',
  }
}

function formatInteger(value) {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0)
}

function formatPercent(value, digits = 2) {
  return `${((value ?? 0) * 100).toFixed(digits)}%`
}

function formatHours(value, digits = 1) {
  return `${(value ?? 0).toFixed(digits)}h`
}

function formatDecimal(value, digits = 1) {
  return (value ?? 0).toFixed(digits)
}

function formatDeltaPercent(value) {
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value * 100).toFixed(1)}%`
}

function formatDeltaPp(value) {
  return `${value > 0 ? '↑' : '↓'} ${Math.abs(value * 100).toFixed(2)}pp`
}

function shiftDate(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function parseDateInput(value) {
  const [yearText, monthText, dayText] = value.split('-')
  return new Date(Number(yearText), Number(monthText) - 1, Number(dayText))
}

function getGrainDays(grain) {
  if (grain === 'day') {
    return 1
  }
  return grain === 'week' ? 7 : 30
}

function getMetricWindow(grain, dateTo) {
  const periodDays = getGrainDays(grain)
  const end = parseDateInput(dateTo)
  const start = shiftDate(end, -(periodDays - 1))
  return {
    date_from: formatDateInput(start),
    date_to: formatDateInput(end),
  }
}

function getPreviousDateWindow(window) {
  const start = parseDateInput(window.date_from)
  const end = parseDateInput(window.date_to)
  const lengthDays = Math.max(1, Math.round((end - start) / 86_400_000) + 1)
  const previousEnd = shiftDate(start, -1)
  const previousStart = shiftDate(previousEnd, -(lengthDays - 1))
  return {
    date_from: formatDateInput(previousStart),
    date_to: formatDateInput(previousEnd),
  }
}

function getMetricWindowLabel(grain) {
  if (grain === 'day') {
    return '末日'
  }
  return grain === 'week' ? '近7天' : '近30天'
}

function buildDelta(currentValue, previousValue, mode = 'percent') {
  if (previousValue === null || previousValue === undefined) {
    return { tone: 'muted', text: '--' }
  }

  if (mode === 'pp') {
    const diff = (currentValue ?? 0) - (previousValue ?? 0)
    if (diff === 0) {
      return { tone: 'neutral', text: '0.00pp' }
    }
    return {
      tone: diff > 0 ? 'up' : 'down',
      text: formatDeltaPp(diff),
    }
  }

  if (!previousValue) {
    return { tone: 'muted', text: '--' }
  }

  const ratio = ((currentValue ?? 0) - previousValue) / previousValue
  if (ratio === 0) {
    return { tone: 'neutral', text: '0.0%' }
  }

  return {
    tone: ratio > 0 ? 'up' : 'down',
    text: formatDeltaPercent(ratio),
  }
}

function buildSparklinePoints(items) {
  if (!items.length) {
    return ''
  }

  const max = Math.max(...items.map((item) => item.value), 0)
  const safeMax = max === 0 ? 1 : max

  return items
    .map((item, index) => {
      const x = items.length === 1 ? 50 : (index / (items.length - 1)) * 100
      const y = 100 - (item.value / safeMax) * 100
      return `${x},${y}`
    })
    .join(' ')
}

function buildSparklineArea(items) {
  if (!items.length) {
    return ''
  }

  const points = buildSparklinePoints(items)
  const firstX = items.length === 1 ? 50 : 0
  const lastX = items.length === 1 ? 50 : 100
  return `${firstX},100 ${points} ${lastX},100`
}

function buildChartPointData(items) {
  if (!items.length) {
    return []
  }

  const max = Math.max(...items.map((item) => item.value), 0)
  const safeMax = max === 0 ? 1 : max

  return items.map((item, index) => ({
    ...item,
    x: items.length === 1 ? 50 : (index / (items.length - 1)) * 100,
    y: 100 - (item.value / safeMax) * 100,
  }))
}

function sortIssueShare(items, options, salesQty) {
  const optionsByType = new Map((options ?? []).map((item) => [item.major_issue_type, item]))
  const issueByType = new Map((items ?? []).map((item) => [item.major_issue_type, item]))

  return ISSUE_ORDER.map((type) => {
    const item = issueByType.get(type)
    const option = optionsByType.get(type)
    const count = item?.count ?? option?.count ?? 0
    return {
      major_issue_type: type,
      label: item?.label ?? option?.label ?? ISSUE_COPY[type].label,
      count,
      ratio: item?.ratio ?? option?.ratio ?? 0,
      estimatedRate: salesQty ? count / salesQty : 0,
      target_page: option?.target_page ?? null,
    }
  })
}

function MiniSparkline({ items }) {
  if (!items?.length) {
    return <div className="mini-placeholder">当前卡片不展示趋势折线</div>
  }

  const points = buildSparklinePoints(items)
  const area = buildSparklineArea(items)

  return (
    <div className="mini-chart" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="summary-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polyline fill="url(#summary-gradient)" points={area} />
        <polyline className="mini-chart__line" fill="none" points={points} />
      </svg>
    </div>
  )
}

function SummaryCard({ title, value, rangeValue, rangeLabel, description, badge, tone }) {
  return (
    <article className={`summary-card summary-card--${tone}`}>
      <div className="summary-card__header">
        <h2>{title}</h2>
        <span className={`summary-badge summary-badge--${badge.tone}`}>{badge.label}</span>
      </div>
      <div className="summary-card__value">{value}</div>
      {rangeLabel || rangeValue ? (
        <div className="summary-card__secondary">
          <span>{rangeLabel}</span>
          <strong>{rangeValue}</strong>
        </div>
      ) : null}
      <p className="summary-card__description">{description}</p>
    </article>
  )
}

function TrendChart({ title, items, tone, formatter }) {
  const [tooltip, setTooltip] = useState(null)

  if (!items?.length) {
    return (
      <article className={`trend-card trend-card--${tone}`}>
        <h3>{title}</h3>
        <div className="mini-placeholder">暂无趋势数据</div>
      </article>
    )
  }

  const pointData = buildChartPointData(items)
  const points = pointData.map((item) => `${item.x},${item.y}`).join(' ')
  const area = buildSparklineArea(items)

  return (
    <article className={`trend-card trend-card--${tone}`}>
      <h3>{title}</h3>
      <div className="trend-chart" onMouseLeave={() => setTooltip(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${title}趋势`}>
          <defs>
            <linearGradient id={`trend-gradient-${tone}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <polyline fill={`url(#trend-gradient-${tone})`} points={area} />
          <polyline className="mini-chart__line" fill="none" points={points} />
          {pointData.map((item) => (
            <g
              key={item.bucket}
              className="trend-chart__hit-area"
              onMouseEnter={() => setTooltip({
                bucket: item.bucket,
                value: formatter(item.value),
                x: item.x,
                y: item.y,
              })}
              onFocus={() => setTooltip({
                bucket: item.bucket,
                value: formatter(item.value),
                x: item.x,
                y: item.y,
              })}
              tabIndex="0"
            >
              <circle className="trend-chart__hit-circle" cx={item.x} cy={item.y} r="5.5" />
              <circle className="trend-chart__point" cx={item.x} cy={item.y} r="2.2" />
            </g>
          ))}
        </svg>
        {tooltip ? (
          <div
            className="trend-tooltip"
            style={{
              left: `${tooltip.x}%`,
              top: `${tooltip.y}%`,
            }}
          >
            <span>{tooltip.bucket}</span>
            <strong>{title}：{tooltip.value}</strong>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function MultiLineTrendChart({ series }) {
  const [tooltip, setTooltip] = useState(null)
  const allValues = series.flatMap((item) => item.items.map((point) => point.value))
  const max = Math.max(...allValues, 0)
  const safeMax = max === 0 ? 1 : max
  const longestSeries = series.reduce(
    (current, item) => (item.items.length > current.items.length ? item : current),
    series[0],
  )
  const pointCount = longestSeries?.items.length ?? 0
  const chartBounds = {
    left: 4,
    right: 96,
    top: 8,
    bottom: 92,
  }

  function getPointData(items) {
    const xRange = chartBounds.right - chartBounds.left
    const yRange = chartBounds.bottom - chartBounds.top

    return items.map((item, index) => ({
      ...item,
      x: items.length === 1 ? 50 : chartBounds.left + (index / (items.length - 1)) * xRange,
      y: chartBounds.bottom - (item.value / safeMax) * yRange,
    }))
  }

  function getTooltipClassName(point) {
    const horizontal = point.x > 82 ? 'p1-trend-tooltip--left' : ''
    const vertical = point.y < 24 ? 'p1-trend-tooltip--below' : ''
    return ['trend-tooltip', 'p1-trend-tooltip', horizontal, vertical].filter(Boolean).join(' ')
  }

  if (!pointCount) {
    return <div className="empty-state">暂无趋势数据</div>
  }

  return (
    <div className="p1-trend-chart" onMouseLeave={() => setTooltip(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="总览趋势">
        <g className="p1-trend-gridlines" aria-hidden="true">
          {[20, 40, 60, 80].map((line) => (
            <line key={line} x1="0" x2="100" y1={line} y2={line} />
          ))}
        </g>
        {series.map((line) => {
          const pointData = getPointData(line.items)
          const points = pointData.map((item) => `${item.x},${item.y}`).join(' ')

          return (
            <polyline
              key={line.key}
              className={`p1-trend-line p1-trend-line--${line.key}`}
              fill="none"
              points={points}
            />
          )
        })}
        {getPointData(longestSeries.items).map((item, index) => (
          <g
            key={item.bucket}
            className="trend-chart__hit-area"
            onMouseEnter={() => setTooltip({ bucket: item.bucket, index, x: item.x, y: item.y })}
            onFocus={() => setTooltip({ bucket: item.bucket, index, x: item.x, y: item.y })}
            tabIndex="0"
          >
            <line className="p1-trend-hit-line" x1={item.x} x2={item.x} y1="0" y2="100" />
            <circle className="trend-chart__hit-circle" cx={item.x} cy={item.y} r="5.5" />
          </g>
        ))}
      </svg>
      {tooltip ? (
        <div className={getTooltipClassName(tooltip)} style={{ left: `${tooltip.x}%`, top: `${tooltip.y}%` }}>
          <span>{tooltip.bucket}</span>
          {series.map((line) => (
            <strong key={line.key}>{line.label}：{line.formatter(line.items[tooltip.index]?.value ?? 0)}</strong>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TrendSection({ dashboard }) {
  return (
    <section className="trend-grid" aria-label="指标趋势">
      <TrendChart
        title="订单数"
        tone="sales"
        items={dashboard?.trends?.sales_qty ?? []}
        formatter={formatInteger}
      />
      <TrendChart
        title="客诉量"
        tone="complaints"
        items={dashboard?.trends?.complaint_count ?? []}
        formatter={formatInteger}
      />
      <TrendChart
        title="客诉率"
        tone="rate"
        items={dashboard?.trends?.complaint_rate ?? []}
        formatter={(value) => formatPercent(value, 2)}
      />
    </section>
  )
}

function TableSection({ title, hint, columns, rows, emptyCopy, rowTone, onRowClick }) {
  return (
    <section className="table-card">
      <div className="table-card__header">
        <h3>{title}</h3>
        {hint ? <span className="table-card__hint">{hint}</span> : null}
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const content = (
                  <>
                    {columns.map((column) => (
                      <td key={column.key} data-label={column.label}>
                        {column.render ? column.render(row, index) : row[column.key]}
                      </td>
                    ))}
                  </>
                )

                if (onRowClick) {
                  return (
                    <tr
                      key={`${title}-${index}`}
                      className={`is-clickable ${rowTone ? rowTone(row) : ''}`}
                      onClick={() => onRowClick(row)}
                    >
                      {content}
                    </tr>
                  )
                }

                return <tr key={`${title}-${index}`}>{content}</tr>
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state empty-state--table">{emptyCopy}</div>
      )}
    </section>
  )
}

function PlaceholderPage({ title }) {
  return (
    <main className="placeholder-shell">
      <section className="placeholder-shell__body" aria-label={`${title} 页面占位`} />
    </main>
  )
}

function RankingPagination({ pageSize, setPageSize, safePage, pageCount, setPage }) {
  return (
    <div className="ranking-pagination">
      <label className="page-size-control">
        <span>每页</span>
        <select
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value))
            setPage(1)
          }}
        >
          {RANKING_PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
      <div className="pagination-buttons" role="group" aria-label="商品客诉表现表分页">
        <button
          type="button"
          className="toolbar-button pagination-button"
          onClick={() => setPage(1)}
          disabled={safePage === 1}
        >
          首页
        </button>
        <button
          type="button"
          className="toolbar-button pagination-button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={safePage === 1}
        >
          上一页
        </button>
        <span className="pagination-status">{safePage} / {pageCount}</span>
        <button
          type="button"
          className="toolbar-button pagination-button"
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          disabled={safePage === pageCount}
        >
          下一页
        </button>
        <button
          type="button"
          className="toolbar-button pagination-button"
          onClick={() => setPage(pageCount)}
          disabled={safePage === pageCount}
        >
          尾页
        </button>
      </div>
    </div>
  )
}

function ProductRankingSection({ rows, loading, error }) {
  const [expandedSpus, setExpandedSpus] = useState(() => new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(5)
  const topRows = rows.slice(0, 20)

  function toggleSpu(spu) {
    setExpandedSpus((current) => {
      const next = new Set(current)
      if (next.has(spu)) {
        next.delete(spu)
      } else {
        next.add(spu)
      }
      return next
      })
  }

  const pageCount = Math.max(1, Math.ceil(topRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const startIndex = (safePage - 1) * pageSize
  const visibleRows = topRows.slice(startIndex, startIndex + pageSize)

  return (
    <section className="table-card ranking-card">
      <div className="table-card__header">
        <div>
          <h3>商品客诉表现表</h3>
          <p className="table-card__hint">默认按客诉量排序，仅展示 Top20 SPU，可展开查看对应 SKC 明细。</p>
        </div>
        {topRows.length ? (
          <RankingPagination
            pageSize={pageSize}
            setPageSize={setPageSize}
            safePage={safePage}
            pageCount={pageCount}
            setPage={setPage}
          />
        ) : (
          <span className="summary-badge summary-badge--warm">SPU / SKC</span>
        )}
      </div>

      {loading ? (
        <div className="empty-state">正在加载商品排行...</div>
      ) : error ? (
        <div className="empty-state empty-state--error">{error}</div>
      ) : topRows.length ? (
        <div className="table-scroll">
          <table className="data-table ranking-table">
            <thead>
              <tr>
                <th>排名</th>
                <th>SPU</th>
                <th>SKC</th>
                <th>销量</th>
                <th>客诉量</th>
                <th>客诉率</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.flatMap((row, index) => {
                const expanded = expandedSpus.has(row.spu)
                const parentRow = (
                  <tr key={`spu-${row.spu}`} className="ranking-row ranking-row--parent">
                    <td data-label="排名">
                      <span className="rank-pill">{startIndex + index + 1}</span>
                    </td>
                    <td data-label="SPU"><strong>{row.spu}</strong></td>
                    <td data-label="SKC">
                      <button type="button" className="ranking-toggle" onClick={() => toggleSpu(row.spu)}>
                        <span>全部</span>
                        <span className={`ranking-chevron ${expanded ? 'ranking-chevron--open' : ''}`}>
                          ▾
                        </span>
                      </button>
                    </td>
                    <td data-label="销量">{formatInteger(row.sales_qty)}</td>
                    <td data-label="客诉量">{formatInteger(row.complaint_count)}</td>
                    <td data-label="客诉率">{formatPercent(row.complaint_rate)}</td>
                  </tr>
                )

                if (!expanded) {
                  return [parentRow]
                }

                const children = row.children.map((child) => (
                  <tr key={`skc-${row.spu}-${child.skc}`} className="ranking-row ranking-row--child">
                    <td data-label="排名">-</td>
                    <td data-label="SPU">{row.spu}</td>
                    <td data-label="SKC">{child.skc}</td>
                    <td data-label="销量">{formatInteger(child.sales_qty)}</td>
                    <td data-label="客诉量">{formatInteger(child.complaint_count)}</td>
                    <td data-label="客诉率">{formatPercent(child.complaint_rate)}</td>
                  </tr>
                ))

                return [parentRow, ...children]
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state empty-state--table">暂无商品排行数据</div>
      )}
    </section>
  )
}

function P1Dashboard() {
  const defaultFilters = useMemo(() => createDefaultP1Filters(), [])
  const [filters, setFilters] = useState(defaultFilters)
  const [dashboard, setDashboard] = useState(null)
  const [metricDashboard, setMetricDashboard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function loadDashboard() {
      setLoading(true)
      setError('')

      try {
        const metricWindow = getMetricWindow(filters.grain, filters.date_to)
        const metricFilters = { ...filters, ...metricWindow }
        const [dashboardResponse, metricDashboardResponse] = await Promise.all([
          fetchP1Dashboard(filters, controller.signal),
          fetchP1Dashboard(metricFilters, controller.signal),
        ])
        setDashboard(dashboardResponse)
        setMetricDashboard(metricDashboardResponse)
      } catch (loadError) {
        if (loadError.name !== 'AbortError') {
          setDashboard(null)
          setMetricDashboard(null)
          setError(loadError.message || 'P1 聊天数据加载失败，请稍后重试。')
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
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
  const metricWindowLabel = getMetricWindowLabel(filters.grain)
  const agentRows = dashboard?.agent_workload ?? []
  const trendSeries = [
    {
      key: 'inbound',
      label: '来邮数',
      items: dashboard?.trends?.inbound_email_count ?? [],
      formatter: formatInteger,
    },
    {
      key: 'outbound',
      label: '回邮数',
      items: dashboard?.trends?.outbound_email_count ?? [],
      formatter: formatInteger,
    },
    {
      key: 'timeout',
      label: '超时次数',
      items: dashboard?.trends?.first_response_timeout_count ?? [],
      formatter: formatInteger,
    },
  ]

  const workloadColumns = [
    {
      key: 'agent_name',
      label: '客服姓名',
      render: (row) => <strong>{row.agent_name}</strong>,
    },
    {
      key: 'outbound_email_count',
      label: '总回邮数',
      render: (row) => formatInteger(row.outbound_email_count),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_span',
      label: '每小时回邮数均值（首末封）',
      render: (row) => formatDecimal(row.avg_outbound_emails_per_hour_by_span),
    },
    {
      key: 'avg_outbound_emails_per_hour_by_schedule',
      label: '每小时回邮数均值（工时表）',
      render: (row) => formatDecimal(row.avg_outbound_emails_per_hour_by_schedule),
    },
    {
      key: 'qa_reply_counts',
      label: '质检结果回邮数',
      render: (row) => {
        const qa = row.qa_reply_counts ?? {}
        return `${formatInteger(qa.excellent)} / ${formatInteger(qa.pass)} / ${formatInteger(qa.fail)}`
      },
    },
  ]

  return (
    <main className="dashboard-shell p1-dashboard">
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
          <span className="toolbar-label">客服姓名</span>
          <label className="select-control">
            <select
              value={filters.agent_name}
              onChange={(event) => setFilters((current) => ({ ...current, agent_name: event.target.value }))}
            >
              {AGENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
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

      {error ? <section className="status-banner status-banner--error">{error}</section> : null}
      {dashboard?.meta?.partial_data ? (
        <section className="status-banner status-banner--info">
          {dashboard.meta.notes?.[0] ?? '当前数据存在局部缺失。'}
        </section>
      ) : null}

      <section className="summary-grid p1-summary-grid">
        <SummaryCard
          title="来邮数"
          value={loading ? '--' : formatInteger(summary?.inbound_email_count)}
          rangeLabel="范围总量"
          rangeValue={loading ? '--' : formatInteger(rangeSummary?.inbound_email_count)}
          description="客户发送邮件的封数，按自然日汇总后作为总体待处理规模口径。"
          badge={{ label: '客户邮件封数', tone: 'cool' }}
          tone="sales"
        />
        <SummaryCard
          title="回邮数"
          value={loading ? '--' : formatInteger(summary?.outbound_email_count)}
          rangeLabel="范围总量"
          rangeValue={loading ? '--' : formatInteger(rangeSummary?.outbound_email_count)}
          description="客服回复邮件的封数，反映坐席实际处理量。"
          badge={{ label: '客服回复封数', tone: 'rose' }}
          tone="complaints"
        />
        <SummaryCard
          title="平均会话排队时长"
          value={loading ? '--' : formatHours(summary?.avg_queue_hours, 1)}
          rangeLabel="范围总量"
          rangeValue={loading ? '--' : formatHours(rangeSummary?.avg_queue_hours, 1)}
          description="客户邮件到人工回复的时间差均值，用于衡量响应效率。"
          badge={{ label: '客户首封到人工首回', tone: 'cool' }}
          tone="rate"
        />
        <SummaryCard
          title="首次响应超时次数"
          value={loading ? '--' : formatInteger(summary?.first_response_timeout_count)}
          rangeLabel="范围总量"
          rangeValue={loading ? '--' : formatInteger(rangeSummary?.first_response_timeout_count)}
          description="客户首封邮件到人工首回时间差大于 24 小时的次数。"
          badge={{ label: '>24h', tone: 'deep' }}
          tone="complaints"
        />
      </section>

      <div className="metric-window-note">
        主数值为截至 {filters.date_to} 的{metricWindowLabel}；范围总量按当前日期范围计算。
      </div>

      <section className="p1-main-grid">
        <section className="table-card p1-trend-card">
          <div className="table-card__header">
            <div>
              <h3>总览趋势</h3>
              <p className="table-card__hint">展示来邮数、回邮数和首次响应超时次数。</p>
            </div>
            <div className="p1-trend-legend" aria-label="趋势图例">
              <span className="p1-legend-item p1-legend-item--inbound">来邮数</span>
              <span className="p1-legend-item p1-legend-item--outbound">回邮数</span>
              <span className="p1-legend-item p1-legend-item--timeout">超时次数</span>
            </div>
          </div>
          {loading ? <div className="empty-state">正在加载趋势数据...</div> : <MultiLineTrendChart series={trendSeries} />}
        </section>

        <TableSection
          title="坐席工作量分析"
          hint="质检结果回邮数展示顺序：优秀 / 达标 / 不合格"
          columns={workloadColumns}
          rows={loading ? [] : agentRows}
          emptyCopy={loading ? '正在加载坐席数据...' : '暂无坐席工作量数据'}
        />
      </section>
    </main>
  )
}

function P3Dashboard() {
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

function App() {
  const [activePage, setActivePage] = useState('p1')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true)
  const activePageMeta = PAGE_OPTIONS.find((item) => item.value === activePage) ?? PAGE_OPTIONS[2]

  return (
    <div className={`app-shell ${isSidebarCollapsed ? 'app-shell--sidebar-collapsed' : ''}`}>
      <aside className={`side-nav ${isSidebarCollapsed ? 'side-nav--collapsed' : ''}`}>
        <div className="side-nav__brand">
          <div className="side-nav__brand-copy">
            {!isSidebarCollapsed ? (
              <>
                <span className="eyebrow">Julang BI</span>
                <strong>客服看板</strong>
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="side-nav__toggle"
            onClick={() => setIsSidebarCollapsed((current) => !current)}
            aria-label={isSidebarCollapsed ? '展开导航栏' : '收起导航栏'}
            title={isSidebarCollapsed ? '展开导航栏' : '收起导航栏'}
          >
            {isSidebarCollapsed ? '›' : '‹'}
          </button>
        </div>
        <nav className="side-nav__menu" aria-label="看板导航">
          {PAGE_OPTIONS.map((page) => (
            <button
              key={page.value}
              type="button"
              className={`side-nav__item ${activePage === page.value ? 'side-nav__item--active' : ''}`}
              onClick={() => setActivePage(page.value)}
            >
              <span className="side-nav__code">{page.code}</span>
              {!isSidebarCollapsed ? (
                <span className="side-nav__text">
                  <strong>{page.title}</strong>
                  <small>{page.description}</small>
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </aside>

      <section className="app-content">
        {activePage === 'p1' ? (
          <P1Dashboard />
        ) : activePage === 'p3' ? (
          <P3Dashboard />
        ) : (
          <PlaceholderPage title={activePageMeta.title} description={activePageMeta.description} />
        )}
      </section>
    </div>
  )
}

export default App
