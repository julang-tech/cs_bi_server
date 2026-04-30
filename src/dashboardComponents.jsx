import { useState } from 'react'
import {
  RANKING_PAGE_SIZE_OPTIONS,
  buildSparklineArea,
  buildSparklinePoints,
  formatInteger,
  formatPercent,
} from './dashboardUtils'

export function MiniSparkline({ items }) {
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

export function SummaryCard({
  title,
  value,
  rangeValue,
  rangeLabel,
  extraMetrics = [],
  description,
  badge,
  tone,
  layout = 'stacked',
  className = '',
}) {
  const cardClassName = ['summary-card', `summary-card--${tone}`, `summary-card--${layout}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <article className={cardClassName}>
      <div className="summary-card__header">
        <h2>{title}</h2>
        <span className={`summary-badge summary-badge--${badge.tone}`}>{badge.label}</span>
      </div>
      <div className="summary-card__body">
        <div className="summary-card__value">{value}</div>
        {rangeLabel || rangeValue ? (
          <div className="summary-card__secondary">
            <span>{rangeLabel}</span>
            <strong>{rangeValue}</strong>
          </div>
        ) : null}
      </div>
      {extraMetrics.length ? (
        <div className="summary-card__metrics">
          {extraMetrics.map((item) => (
            <span key={item.label}>
              {item.label}
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      ) : null}
      <p className="summary-card__description">{description}</p>
    </article>
  )
}

function formatTrendDelta(firstValue, latestValue, mode) {
  const diff = latestValue - firstValue

  if (mode === 'pp') {
    if (diff === 0) {
      return '较首期 0.00pp'
    }
    return `较首期 ${diff > 0 ? '+' : '-'}${Math.abs(diff * 100).toFixed(2)}pp`
  }

  if (!firstValue) {
    return diff === 0 ? '较首期 0.0%' : '首期为 0'
  }

  const ratio = diff / firstValue
  if (ratio === 0) {
    return '较首期 0.0%'
  }
  return `较首期 ${ratio > 0 ? '+' : '-'}${Math.abs(ratio * 100).toFixed(1)}%`
}

function getTrendPointData(items) {
  const values = items.map((item) => item.value)
  const minValue = Math.min(...values, 0)
  const maxValue = Math.max(...values, 0)
  const safeRange = maxValue === minValue ? 1 : maxValue - minValue
  const bounds = {
    left: 8,
    right: 96,
    top: 10,
    bottom: 86,
  }
  const xRange = bounds.right - bounds.left
  const yRange = bounds.bottom - bounds.top

  return {
    minValue,
    maxValue,
    points: items.map((item, index) => ({
      ...item,
      index,
      x: items.length === 1 ? 50 : bounds.left + (index / (items.length - 1)) * xRange,
      y: bounds.bottom - ((item.value - minValue) / safeRange) * yRange,
    })),
  }
}

export function TrendChart({ title, items, tone, formatter, deltaMode = 'percent' }) {
  const [tooltip, setTooltip] = useState(null)

  if (!items?.length) {
    return (
      <article className={`trend-card trend-card--${tone}`}>
        <h3>{title}</h3>
        <div className="mini-placeholder">暂无趋势数据</div>
      </article>
    )
  }

  const { points: pointData, minValue, maxValue } = getTrendPointData(items)
  const firstPoint = pointData[0]
  const latestPoint = pointData[pointData.length - 1]
  const points = pointData.map((item) => `${item.x},${item.y}`).join(' ')
  const tooltipClassName = ['trend-tooltip', tooltip?.x > 82 ? 'trend-tooltip--left' : ''].filter(Boolean).join(' ')
  const deltaText = formatTrendDelta(firstPoint.value, latestPoint.value, deltaMode)

  return (
    <article className={`trend-card trend-card--${tone}`}>
      <div className="trend-card__header">
        <div>
          <h3>{title}</h3>
          <span className="trend-card__delta">{deltaText}</span>
        </div>
        <div className="trend-card__latest">
          <span>最新</span>
          <strong>{formatter(latestPoint.value)}</strong>
        </div>
      </div>
      <div className="trend-chart" onMouseLeave={() => setTooltip(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${title}趋势`}>
          <g className="trend-chart__grid" aria-hidden="true">
            {[25, 50, 75].map((line) => (
              <line key={line} x1="8" x2="96" y1={line} y2={line} />
            ))}
          </g>
          {tooltip ? (
            <line
              className="trend-chart__reference-line"
              x1={tooltip.x}
              x2={tooltip.x}
              y1="10"
              y2="86"
            />
          ) : null}
          <polyline className="trend-chart__line" fill="none" points={points} />
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
              <circle className="trend-chart__hit-circle" cx={item.x} cy={item.y} r="7" />
            </g>
          ))}
        </svg>
        <span className="trend-chart__axis-label trend-chart__axis-label--top">
          {formatter(maxValue)}
        </span>
        <span className="trend-chart__axis-label trend-chart__axis-label--bottom">
          {formatter(minValue)}
        </span>
        <div className="trend-chart__bucket-labels" aria-hidden="true">
          <span>{firstPoint.bucket}</span>
          <span>{latestPoint.bucket}</span>
        </div>
        {tooltip ? (
          <div
            className={tooltipClassName}
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

export function MultiLineTrendChart({ series, ariaLabel = '总览趋势' }) {
  const [tooltip, setTooltip] = useState(null)
  const allValues = series.flatMap((item) => item.items.map((point) => point.value))
  const minValue = Math.min(...allValues, 0)
  const maxValue = Math.max(...allValues, 0)
  const safeRange = maxValue === minValue ? 1 : maxValue - minValue
  const longestSeries = series.reduce(
    (current, item) => (item.items.length > current.items.length ? item : current),
    series[0],
  )
  const pointCount = longestSeries?.items.length ?? 0
  const chartBounds = {
    left: 8,
    right: 96,
    top: 10,
    bottom: 86,
  }
  const firstPoint = longestSeries?.items[0]
  const latestPoint = longestSeries?.items[longestSeries.items.length - 1]
  const axisFormatter = series[0]?.formatter ?? formatInteger

  function getPointData(items) {
    const xRange = chartBounds.right - chartBounds.left
    const yRange = chartBounds.bottom - chartBounds.top

    return items.map((item, index) => ({
      ...item,
      x: items.length === 1 ? 50 : chartBounds.left + (index / (items.length - 1)) * xRange,
      y: chartBounds.bottom - ((item.value - minValue) / safeRange) * yRange,
    }))
  }

  function getTooltipClassName(point) {
    return ['trend-tooltip', point.x > 82 ? 'trend-tooltip--left' : ''].filter(Boolean).join(' ')
  }

  if (!pointCount) {
    return <div className="empty-state">暂无趋势数据</div>
  }

  return (
    <div className="p1-trend-chart" onMouseLeave={() => setTooltip(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <g className="p1-trend-gridlines" aria-hidden="true">
          {[25, 50, 75].map((line) => (
            <line key={line} x1="8" x2="96" y1={line} y2={line} />
          ))}
        </g>
        {tooltip ? (
          <line
            className="trend-chart__reference-line"
            x1={tooltip.x}
            x2={tooltip.x}
            y1="10"
            y2="86"
          />
        ) : null}
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
            <circle className="trend-chart__hit-circle" cx={item.x} cy={item.y} r="7" />
          </g>
        ))}
      </svg>
      <span className="trend-chart__axis-label trend-chart__axis-label--top">
        {axisFormatter(maxValue)}
      </span>
      <span className="trend-chart__axis-label trend-chart__axis-label--bottom">
        {axisFormatter(minValue)}
      </span>
      <div className="trend-chart__bucket-labels" aria-hidden="true">
        <span>{firstPoint?.bucket}</span>
        <span>{latestPoint?.bucket}</span>
      </div>
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

export function TrendSection({ dashboard }) {
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
        deltaMode="pp"
      />
    </section>
  )
}

export function TableSection({ title, hint, columns, rows, emptyCopy, rowTone, onRowClick, children }) {
  return (
    <section className="table-card">
      <div className="table-card__header">
        <h3>{title}</h3>
        {hint ? <span className="table-card__hint">{hint}</span> : null}
      </div>
      {children ? <div className="table-card__content">{children}</div> : null}
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

export function ProductRankingSection({ rows, loading, error }) {
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
