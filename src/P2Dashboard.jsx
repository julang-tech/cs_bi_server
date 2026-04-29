import { Fragment, useEffect, useMemo, useState } from 'react'
import './P2Dashboard.css'
import { fetchRefundOverview, fetchRefundSpuTable } from './api/p2'

function formatDateInput(date) {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

function defaultDateRange() {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(end.getDate() - 29)
  return { date_from: formatDateInput(start), date_to: formatDateInput(end) }
}

function getWeekRange(weekValue) {
  if (!weekValue) return null

  const parts = weekValue.split('-W')
  if (parts.length !== 2) return null

  const year = Number(parts[0])
  const week = Number(parts[1])

  if (!Number.isFinite(year) || !Number.isFinite(week)) return null

  const jan4 = new Date(year, 0, 4)
  const jan4Day = jan4.getDay() || 7
  const week1Monday = new Date(jan4)

  week1Monday.setDate(jan4.getDate() - jan4Day + 1)

  const start = new Date(week1Monday)
  start.setDate(week1Monday.getDate() + (week - 1) * 7)

  const end = new Date(start)
  end.setDate(start.getDate() + 6)

  return {
    date_from: formatDateInput(start),
    date_to: formatDateInput(end),
  }
}

function getMonthRange(monthValue) {
  if (!monthValue) return null

  const [y, m] = monthValue.split('-').map(Number)

  if (!Number.isFinite(y) || !Number.isFinite(m)) return null

  const start = new Date(y, m - 1, 1)
  const end = new Date(y, m, 0)

  return {
    date_from: formatDateInput(start),
    date_to: formatDateInput(end),
  }
}

function weekToDateRange(weekValue) {
  return getWeekRange(weekValue)
}

function formatInt(n) {
  if (n === null || n === undefined) return '--'

  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(n ?? 0)
}

function formatCompactM(n) {
  if (n === null || n === undefined) return '--'

  const abs = Math.abs(n)

  // 6 位数开始用 M
  if (abs >= 100000) {
    return `${(n / 1e6).toFixed(2).replace(/\.00$/, '')}M`
  }

  // 小于 6 位：正常千分位
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(n)
}

function formatMoney(n) {
  if (n === null || n === undefined) return '--'
  return `¥${formatCompactM(n)}`
}

function formatRate(n) {
  if (n === null || n === undefined) return '--'
  return `${((n ?? 0) * 100).toFixed(1)}%`
}

function MetricCard({ title, value, tag, desc, highlight = false }) {
  const valueText = String(value ?? '--')
  const valueLength = Math.max(valueText.length, 4)

  return (
    <article
      className={`metric-card ${highlight ? 'metric-card--highlight' : ''}`}
      style={{ '--metric-value-chars': valueLength }}
    >
      <div className="metric-head">
        <h3 title={title}>{title}</h3>
        {tag ? <span className={`metric-tag metric-tag--${tag.tone}`}>{tag.label}</span> : null}
      </div>

      <div className="metric-value" title={valueText}>
        {value}
      </div>

      <p className="metric-desc">{desc}</p>
    </article>
  )
}

function P2Dashboard() {
  const initial = useMemo(
    () => ({
      ...defaultDateRange(),
      grain: 'month',
      category: '',
      spu: '',
      skc: '',
      channel: '',
      listing_date_from: '',
      listing_date_to: '',
      top_n: 5,
    }),
    [],
  )

  const [filters, setFilters] = useState(initial)
  const [submitted, setSubmitted] = useState(initial)
  const [overview, setOverview] = useState(null)
  const [tableData, setTableData] = useState([])
  const [expandedSpu, setExpandedSpu] = useState({})
  const [sortKey, setSortKey] = useState('refund_amount')
  const [timeStartValue, setTimeStartValue] = useState(initial.date_from)
  const [timeEndValue, setTimeEndValue] = useState(initial.date_to)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      setLoading(true)
      setError('')

      try {
        const fetchTopN = Math.max(Number(submitted.top_n || 5), 20)
        const fetchFilters = { ...submitted, top_n: fetchTopN }

        const [overviewResp, tableResp] = await Promise.all([
          fetchRefundOverview(fetchFilters, controller.signal),
          fetchRefundSpuTable(fetchFilters, controller.signal),
        ])

        setOverview(overviewResp)
        setTableData(tableResp.rows ?? [])
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        setLoading(false)
      }
    }

    load()

    return () => controller.abort()
  }, [submitted])

  useEffect(() => {
    if (!tableData.length) {
      setExpandedSpu({})
      return
    }

    setExpandedSpu((prev) => {
      const next = {}

      for (const row of tableData) {
        if (prev[row.spu]) next[row.spu] = true
      }

      return next
    })
  }, [tableData])

  useEffect(() => {
    if (filters.grain === 'day') {
      setTimeStartValue(filters.date_from)
      setTimeEndValue(filters.date_to)
      return
    }

    if (filters.grain === 'month') {
      setTimeStartValue(filters.date_from.slice(0, 7))
      setTimeEndValue(filters.date_to.slice(0, 7))
      return
    }

    const toWeekText = (dateStr) => {
      const d = new Date(dateStr)
      const target = new Date(d)
      const day = target.getDay() || 7

      target.setDate(target.getDate() + (4 - day))

      const yearStart = new Date(target.getFullYear(), 0, 1)
      const weekNo = Math.ceil(((target - yearStart) / 86400000 + 1) / 7)

      return `${target.getFullYear()}-W${String(weekNo).padStart(2, '0')}`
    }

    setTimeStartValue(toWeekText(filters.date_from))
    setTimeEndValue(toWeekText(filters.date_to))
  }, [filters.grain, filters.date_from, filters.date_to])

  const displayedRows = useMemo(() => {
    const rows = [...tableData]

    const getValue = (row) => {
      if (sortKey === 'refund_qty') return row.refund_qty ?? 0
      if (sortKey === 'refund_qty_ratio') return row.refund_qty_ratio ?? 0
      if (sortKey === 'refund_amount_ratio') return row.refund_amount_ratio ?? 0
      return row.refund_amount ?? 0
    }

    rows.sort((a, b) => getValue(b) - getValue(a))

    return rows.slice(0, Number(submitted.top_n || 5))
  }, [tableData, sortKey, submitted.top_n])

  const cards = overview?.cards ?? {}

  const getRefundMetricClass = (key) =>
    `refund-metric-cell ${sortKey === key ? 'sorted-metric-cell' : ''}`.trim()

  return (
    <main className="refund-dashboard">
      <section className="filter-panel">
        <div className="filter-grid">
          <label>
            时间维度
            <select
              value={filters.grain}
              onChange={(e) => setFilters((p) => ({ ...p, grain: e.target.value }))}
            >
              <option value="day">按天</option>
              <option value="week">按周</option>
              <option value="month">按月</option>
            </select>
          </label>

          <label>
            开始月份
            <input
              type={filters.grain === 'day' ? 'date' : filters.grain === 'week' ? 'week' : 'month'}
              value={timeStartValue}
              onChange={(e) => {
                const v = e.target.value

                setTimeStartValue(v)

                if (filters.grain === 'day') {
                  setFilters((p) => ({ ...p, date_from: v }))
                } else if (filters.grain === 'week') {
                  const r = weekToDateRange(v)
                  if (r) setFilters((p) => ({ ...p, date_from: r.date_from }))
                } else {
                  const r = getMonthRange(v)
                  if (r) setFilters((p) => ({ ...p, date_from: r.date_from }))
                }
              }}
            />
          </label>

          <label>
            结束月份
            <input
              type={filters.grain === 'day' ? 'date' : filters.grain === 'week' ? 'week' : 'month'}
              value={timeEndValue}
              onChange={(e) => {
                const v = e.target.value

                setTimeEndValue(v)

                if (filters.grain === 'day') {
                  setFilters((p) => ({ ...p, date_to: v }))
                } else if (filters.grain === 'week') {
                  const r = weekToDateRange(v)
                  if (r) setFilters((p) => ({ ...p, date_to: r.date_to }))
                } else {
                  const r = getMonthRange(v)
                  if (r) setFilters((p) => ({ ...p, date_to: r.date_to }))
                }
              }}
            />
          </label>

          <label>
            品类
            <input
              placeholder="primary_product_type"
              value={filters.category}
              onChange={(e) => setFilters((p) => ({ ...p, category: e.target.value }))}
            />
          </label>

          <label>
            SPU
            <input
              placeholder="SPU ID"
              value={filters.spu}
              onChange={(e) => setFilters((p) => ({ ...p, spu: e.target.value }))}
            />
          </label>

          <label>
            SKC
            <input
              placeholder="SKC"
              value={filters.skc}
              onChange={(e) => setFilters((p) => ({ ...p, skc: e.target.value }))}
            />
          </label>

          <label>
            Top N SPU
            <input
              type="number"
              min={1}
              max={30}
              value={filters.top_n}
              onChange={(e) => setFilters((p) => ({ ...p, top_n: Number(e.target.value || 5) }))}
            />
          </label>

          <button className="apply-btn" onClick={() => setSubmitted(filters)}>
            查询
          </button>
        </div>
      </section>

      {error ? <section className="error-box">{error}</section> : null}
      {loading ? <section className="loading-box">加载中...</section> : null}

      <section className="metric-grid">
        <MetricCard
          title="订单数"
          tag={{ label: '基础分母', tone: 'mint' }}
          value={formatInt(cards.order_count)}
          desc="指定周期内订单总数，用于退款订单占比计算。"
        />

        <MetricCard
          title="销量"
          tag={{ label: '销售件数', tone: 'teal' }}
          value={formatInt(cards.sales_qty)}
          desc="指定周期内商品销售件数（剔除保险与价格调整行）。"
        />

        <MetricCard
          title="退款订单数"
          tag={{ label: '按订单时间', tone: 'rose' }}
          value={formatInt(cards.refund_order_count)}
          desc="指定周期内发生退款的订单数。"
          highlight
        />

        <MetricCard
          title="退款金额"
          tag={{ label: '退款总额', tone: 'rose' }}
          value={formatMoney(cards.refund_amount)}
          desc="指定周期内发生退款金额总和。"
          highlight
        />

        <MetricCard
          title="GMV"
          tag={{ label: '口径①', tone: 'mint' }}
          value={formatMoney(cards.gmv)}
          desc="订单金额（实付+折扣+客诉代金券）。"
        />

        <MetricCard
          title="净实付金额"
          tag={{ label: '口径②', tone: 'mint' }}
          value={formatMoney(cards.net_received_amount)}
          desc="GMV剔除客诉代金券后的实收。"
        />

        <MetricCard
          title="净GMV"
          tag={{ label: '口径③', tone: 'mint' }}
          value={formatMoney(cards.net_revenue_amount)}
          desc="净实付金额再剔除退款后的净口径。"
        />

        <MetricCard
          title="退款金额占比"
          tag={{ label: '重点监控', tone: 'rose' }}
          value={formatRate(cards.refund_amount_ratio)}
          desc="退款金额 / 总实收金额。"
          highlight
        />
      </section>

      <section className="table-wrap">
        <div className="table-head">
          <div>
            <h3>商品退款表现表</h3>
          </div>

          <div className="table-sort-tools">
            <label>
              排序字段
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
                <option value="refund_amount">退款金额</option>
                <option value="refund_qty">退款数</option>
                <option value="refund_qty_ratio">退款数占比</option>
                <option value="refund_amount_ratio">退款金额占比</option>
              </select>
            </label>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>SPU</th>
                <th>SKC</th>
                <th>销量</th>
                <th>销售额</th>
                <th>退款数</th>
                <th>退款金额</th>
                <th>退款数占比</th>
                <th>退款金额占比</th>
              </tr>
            </thead>

            <tbody>
              {displayedRows.map((spuRow) => (
                <Fragment key={spuRow.spu}>
                  {(() => {
                    const firstSkc = (spuRow.skc_rows ?? []).find(
                      (row) => row.skc && row.skc !== 'UNKNOWN_SKC',
                    )?.skc

                    return (
                      <tr
                        key={`${spuRow.spu}-spu`}
                        className="spu-row"
                        onClick={() => {
                          setExpandedSpu((prev) => ({
                            ...prev,
                            [spuRow.spu]: !prev[spuRow.spu],
                          }))
                        }}
                      >
                        <td className="spu-click-cell">
                          <span className="expand-icon">
                            {expandedSpu[spuRow.spu] ? '−' : '+'}
                          </span>
                          <span className="spu-cell-btn">{spuRow.spu}</span>
                        </td>

                        <td>{firstSkc ?? '-'}</td>
                        <td>{formatInt(spuRow.sales_qty)}</td>
                        <td>{formatMoney(spuRow.sales_amount)}</td>
                        <td className={getRefundMetricClass('refund_qty')}>
                          {formatInt(spuRow.refund_qty)}
                        </td>
                        <td className={getRefundMetricClass('refund_amount')}>
                          {formatMoney(spuRow.refund_amount)}
                        </td>
                        <td className={getRefundMetricClass('refund_qty_ratio')}>
                          {formatRate(spuRow.refund_qty_ratio)}
                        </td>
                        <td className={getRefundMetricClass('refund_amount_ratio')}>
                          {formatRate(spuRow.refund_amount_ratio)}
                        </td>
                      </tr>
                    )
                  })()}

                  {expandedSpu[spuRow.spu]
                    ? (spuRow.skc_rows ?? [])
                        .filter((skcRow) => skcRow.skc && skcRow.skc !== 'UNKNOWN_SKC')
                        .map((skcRow) => (
                          <tr key={`${spuRow.spu}-${skcRow.skc}`} className="skc-row">
                            <td className="spu-click-cell skc-spu-cell">
                              <span className="expand-icon expand-icon--placeholder" />
                              <span>{spuRow.spu}</span>
                            </td>

                            <td className="skc-cell">{skcRow.skc}</td>
                            <td>{formatInt(skcRow.sales_qty)}</td>
                            <td>{formatMoney(skcRow.sales_amount)}</td>
                            <td className={getRefundMetricClass('refund_qty')}>
                              {formatInt(skcRow.refund_qty)}
                            </td>
                            <td className={getRefundMetricClass('refund_amount')}>
                              {formatMoney(skcRow.refund_amount)}
                            </td>

                            <td className={getRefundMetricClass('refund_qty_ratio')}>
                              {formatRate(
                                spuRow.sales_qty ? skcRow.refund_qty / spuRow.sales_qty : 0,
                              )}
                            </td>

                            <td className={getRefundMetricClass('refund_amount_ratio')}>
                              {formatRate(
                                spuRow.sales_amount
                                  ? skcRow.refund_amount / spuRow.sales_amount
                                  : 0,
                              )}
                            </td>
                          </tr>
                        ))
                    : null}
                </Fragment>
              ))}

              {!loading && displayedRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    暂无符合条件的数据
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

export default P2Dashboard