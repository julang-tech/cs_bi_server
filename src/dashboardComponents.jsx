import { useState } from 'react'
import {
  RANKING_PAGE_SIZE_OPTIONS,
  buildChartPointData,
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

export function SummaryCard({ title, value, rangeValue, rangeLabel, extraMetrics = [], description, badge, tone }) {
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

export function TrendChart({ title, items, tone, formatter }) {
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

export function MultiLineTrendChart({ series, ariaLabel = '总览趋势' }) {
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
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
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
