import { Fragment, useEffect, useMemo, useState } from 'react'
import './P2Dashboard.css'
import { fetchRefundOverview, fetchRefundSpuSkcOptions, fetchRefundSpuTable } from './api/p2'

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

function toWeekText(dateStr) {
  const d = new Date(dateStr)
  const target = new Date(d)
  const day = target.getDay() || 7

  target.setDate(target.getDate() + (4 - day))

  const yearStart = new Date(target.getFullYear(), 0, 1)
  const weekNo = Math.ceil(((target - yearStart) / 86400000 + 1) / 7)

  return `${target.getFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

function formatInt(n) {
  if (n === null || n === undefined) return '--'

  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(n ?? 0)
}

function formatCompactM(n) {
  if (n === null || n === undefined) return '--'
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(n)
}

function formatMoney(n) {
  if (n === null || n === undefined) return '--'
  return `$${formatCompactM(n)}`
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
          <div className="metric-head-actions">
            {tag ? <span className={`metric-tag metric-tag--${tag.tone}`}>{tag.label}</span> : null}
            <span className="metric-help" tabIndex={0} aria-label={desc}>
              ?
              <span className="metric-help__tooltip" role="tooltip">
                {desc}
              </span>
            </span>
          </div>
        </div>

        <div className="metric-value" title={valueText}>
          {value}
        </div>
      </article>
    )
}

function P2Dashboard() {
  const initial = useMemo(
    () => ({
      ...defaultDateRange(),
      grain: 'month',
      channel: '',
      listing_date_from: '',
      listing_date_to: '',
      top_n: 20,
    }),
    [],
  )

  const [filters, setFilters] = useState(initial)
  const [submitted, setSubmitted] = useState(initial)
  const [confirmKey, setConfirmKey] = useState(0)
  const [overview, setOverview] = useState(null)
  const [top20Rows, setTop20Rows] = useState([])
  const [filteredRows, setFilteredRows] = useState([])
  const [spuOptions, setSpuOptions] = useState([])
  const [skcOptions, setSkcOptions] = useState([])
  const [spuSkcPairs, setSpuSkcPairs] = useState([])
  const [expandedSpu, setExpandedSpu] = useState({})
  const [sortState, setSortState] = useState({ key: 'refund_amount', direction: 'desc' })
  const [spuPickerOpen, setSpuPickerOpen] = useState(false)
  const [skcPickerOpen, setSkcPickerOpen] = useState(false)
  const [spuKeyword, setSpuKeyword] = useState('')
  const [skcKeyword, setSkcKeyword] = useState('')
  const [selectedSpus, setSelectedSpus] = useState([])
  const [selectedSkcs, setSelectedSkcs] = useState([])
  const [pendingSpus, setPendingSpus] = useState([])
  const [pendingSkcs, setPendingSkcs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      setLoading(true)
      setError('')

      try {
        const fetchTopN = 20
        const { listing_date_from: _ldf, listing_date_to: _ldt, ...rest } = submitted
        const fetchFilters = {
          ...rest,
          category: '',
          spu: '',
          skc: '',
          top_n: fetchTopN,
        }

        const [overviewResp, tableResp, optionsResp] = await Promise.all([
          fetchRefundOverview(fetchFilters, controller.signal),
          fetchRefundSpuTable(fetchFilters, controller.signal),
          fetchRefundSpuSkcOptions(fetchFilters, controller.signal),
        ])

        setOverview(overviewResp)
        const topRows = tableResp.rows ?? []
        setTop20Rows(topRows)
        setFilteredRows([])
        setSpuOptions(optionsResp?.options?.spus ?? [])
        setSkcOptions(optionsResp?.options?.skcs ?? [])
        setSpuSkcPairs(optionsResp?.options?.pairs ?? [])
        setSelectedSpus([])
        setSelectedSkcs([])
        setPendingSpus([])
        setPendingSkcs([])
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
    const controller = new AbortController()
    const hasFilters =
      selectedSpus.length > 0 ||
      selectedSkcs.length > 0 ||
      filters.listing_date_from ||
      filters.listing_date_to

    if (!hasFilters) {
      return () => controller.abort()
    }

    async function loadFilteredRows() {
      try {
        const resp = await fetchRefundSpuTable(
          {
            ...submitted,
            category: '',
            spu: '',
            skc: '',
            spu_list: selectedSpus,
            skc_list: selectedSkcs,
            listing_date_from: filters.listing_date_from || '',
            listing_date_to: filters.listing_date_to || '',
            top_n: 500,
          },
          controller.signal,
        )
        setFilteredRows(resp.rows ?? [])
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
      }
    }

    loadFilteredRows()
    return () => controller.abort()
  }, [selectedSpus, selectedSkcs, submitted, confirmKey])

  useEffect(() => {
    const hasTableFilters =
      selectedSpus.length > 0 || selectedSkcs.length > 0 || filteredRows.length > 0
    const activeRows = hasTableFilters ? filteredRows : top20Rows
    if (!activeRows.length) {
      setExpandedSpu({})
      return
    }

    setExpandedSpu((prev) => {
      const next = {}

      for (const row of activeRows) {
        if (prev[row.spu]) next[row.spu] = true
      }

      return next
    })
  }, [top20Rows, filteredRows, selectedSpus.length, selectedSkcs.length])

  const filteredSpuOptions = useMemo(
    () => spuOptions.filter((item) => item.toLowerCase().includes(spuKeyword.trim().toLowerCase())),
    [spuOptions, spuKeyword],
  )
  const filteredSkcOptions = useMemo(
    () => skcOptions.filter((item) => item.toLowerCase().includes(skcKeyword.trim().toLowerCase())),
    [skcOptions, skcKeyword],
  )
  const skcsBySpu = useMemo(() => {
    const map = new Map()
    for (const pair of spuSkcPairs) {
      if (!pair?.spu || !pair?.skc) continue
      const list = map.get(pair.spu) ?? []
      list.push(pair.skc)
      map.set(pair.spu, list)
    }
    return map
  }, [spuSkcPairs])
  const spusBySkc = useMemo(() => {
    const map = new Map()
    for (const pair of spuSkcPairs) {
      if (!pair?.spu || !pair?.skc) continue
      const list = map.get(pair.skc) ?? []
      list.push(pair.spu)
      map.set(pair.skc, list)
    }
    return map
  }, [spuSkcPairs])

  useEffect(() => {
    setPendingSpus((prev) => prev.filter((item) => spuOptions.includes(item)))
    setSelectedSpus((prev) => prev.filter((item) => spuOptions.includes(item)))
  }, [spuOptions])

  useEffect(() => {
    setPendingSkcs((prev) => prev.filter((item) => skcOptions.includes(item)))
    setSelectedSkcs((prev) => prev.filter((item) => skcOptions.includes(item)))
  }, [skcOptions])

  const displayedRows = useMemo(() => {
    const hasTableFilters =
      selectedSpus.length > 0 || selectedSkcs.length > 0 || filteredRows.length > 0
    const sourceRows = hasTableFilters ? filteredRows : top20Rows
    const rows = [...sourceRows]

    const getValue = (row) => {
      if (sortState.key === 'sales_qty') return row.sales_qty ?? 0
      if (sortState.key === 'sales_amount') return row.sales_amount ?? 0
      if (sortState.key === 'refund_qty') return row.refund_qty ?? 0
      if (sortState.key === 'refund_qty_ratio') return row.refund_qty_ratio ?? 0
      if (sortState.key === 'refund_amount_ratio') return row.refund_amount_ratio ?? 0
      return row.refund_amount ?? 0
    }

    rows.sort((a, b) => {
      const diff = getValue(a) - getValue(b)
      return sortState.direction === 'asc' ? diff : -diff
    })

    if (!hasTableFilters) return rows.slice(0, 5)
    return rows
  }, [top20Rows, filteredRows, selectedSpus, selectedSkcs, sortState, filters.listing_date_from, filters.listing_date_to])

  const cards = overview?.cards ?? {}
  const headerDateInputType = filters.grain === 'day' ? 'date' : filters.grain === 'week' ? 'week' : 'month'
  const headerStartValue =
    filters.grain === 'day' ? filters.date_from : filters.grain === 'week' ? toWeekText(filters.date_from) : filters.date_from.slice(0, 7)
  const headerEndValue =
    filters.grain === 'day' ? filters.date_to : filters.grain === 'week' ? toWeekText(filters.date_to) : filters.date_to.slice(0, 7)

  const updateHeaderFilter = (nextPartial) => {
    setFilters((prev) => {
      const next = { ...prev, ...nextPartial }
      setSubmitted(next)
      return next
    })
  }

  const getMetricClass = (key) =>
    `refund-metric-cell ${sortState.key === key ? 'sorted-metric-cell' : ''}`.trim()
  const toggleSort = (key) => {
    setSortState((current) => {
      if (current.key === key) {
        return {
          ...current,
          direction: current.direction === 'desc' ? 'asc' : 'desc',
        }
      }
      return { key, direction: 'desc' }
    })
  }
  const renderedTableRows = useMemo(
    () => [
      ...displayedRows.map((spuRow) => {
        const firstSkc = (spuRow.skc_rows ?? []).find(
          (row) => row.skc && row.skc !== 'UNKNOWN_SKC',
        )?.skc
        const spuRowNode = (
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
              <span className="spu-cell-btn">{spuRow.spu}</span>
            </td>

            <td>{firstSkc ?? '-'}</td>
            <td className={getMetricClass('sales_qty')}>{formatInt(spuRow.sales_qty)}</td>
            <td className={getMetricClass('sales_amount')}>{formatMoney(spuRow.sales_amount)}</td>
            <td className={getMetricClass('refund_qty')}>
              {formatInt(spuRow.refund_qty)}
            </td>
            <td className={getMetricClass('refund_amount')}>
              {formatMoney(spuRow.refund_amount)}
            </td>
            <td className={getMetricClass('refund_qty_ratio')}>
              {formatRate(spuRow.refund_qty_ratio)}
            </td>
            <td className={getMetricClass('refund_amount_ratio')}>
              {formatRate(spuRow.refund_amount_ratio)}
            </td>
          </tr>
        )
        const skcNodes = expandedSpu[spuRow.spu]
          ? (spuRow.skc_rows ?? [])
              .filter((skcRow) => skcRow.skc && skcRow.skc !== 'UNKNOWN_SKC')
              .map((skcRow) => (
                <tr key={`${spuRow.spu}-${skcRow.skc}`} className="skc-row">
                  <td className="spu-click-cell skc-spu-cell">
                    <span>{spuRow.spu}</span>
                  </td>

                  <td className="skc-cell">{skcRow.skc}</td>
                  <td className={getMetricClass('sales_qty')}>{formatInt(skcRow.sales_qty)}</td>
                  <td className={getMetricClass('sales_amount')}>{formatMoney(skcRow.sales_amount)}</td>
                  <td className={getMetricClass('refund_qty')}>
                    {formatInt(skcRow.refund_qty)}
                  </td>
                  <td className={getMetricClass('refund_amount')}>
                    {formatMoney(skcRow.refund_amount)}
                  </td>

                  <td className={getMetricClass('refund_qty_ratio')}>
                    {formatRate(
                      spuRow.sales_qty ? skcRow.refund_qty / spuRow.sales_qty : 0,
                    )}
                  </td>

                  <td className={getMetricClass('refund_amount_ratio')}>
                    {formatRate(
                      spuRow.sales_amount
                        ? skcRow.refund_amount / spuRow.sales_amount
                        : 0,
                    )}
                  </td>
                </tr>
              ))
          : []

        return (
          <Fragment key={spuRow.spu}>
            {spuRowNode}
            {skcNodes}
          </Fragment>
        )
      }),
      !loading && displayedRows.length === 0 ? (
        <tr key="empty">
          <td colSpan={8} className="empty-cell">
            暂无符合条件的数据
          </td>
        </tr>
      ) : null,
    ],
    [displayedRows, expandedSpu, loading, sortState.key],
  )

  return (
    <main className="refund-dashboard">
      <section className="filter-panel">
        <div className="filter-grid filter-grid--toolbar-like">
          <div className="toolbar-group">
            <span className="toolbar-label">时间粒度</span>
            <div className="segmented-control" role="tablist" aria-label="粒度切换">
              {[
                { value: 'day', label: '按天' },
                { value: 'week', label: '按周' },
                { value: 'month', label: '按月' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`segment-button ${filters.grain === option.value ? 'segment-button--active' : ''}`}
                  onClick={() => updateHeaderFilter({ grain: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          
          <div className="toolbar-group">
            <span className="toolbar-label">店铺</span>
            <select
              className="store-select"
              value={filters.channel}
              onChange={(e) => updateHeaderFilter({ channel: e.target.value })}
            >
              <option value="">全部</option>
              <option value="2vnpww-33">2vnpww-33 (US)</option>
              <option value="lintico-fr">lintico-fr</option>
              <option value="lintico-uk">lintico-uk</option>
            </select>
          </div>
          
          <div className="toolbar-group toolbar-group--dates">
            <span className="toolbar-label">日期范围</span>
            <div className="date-range-control">
              <label className="date-field">
                <span>开始</span>
                <input
                  type={headerDateInputType}
                  value={headerStartValue}
                  onChange={(e) => {
                    const v = e.target.value
                    if (filters.grain === 'day') {
                      updateHeaderFilter({ date_from: v })
                    } else if (filters.grain === 'week') {
                      const r = weekToDateRange(v)
                      if (r) updateHeaderFilter({ date_from: r.date_from })
                    } else {
                      const r = getMonthRange(v)
                      if (r) updateHeaderFilter({ date_from: r.date_from })
                    }
                  }}
                />
              </label>
              <label className="date-field">
                <span>结束</span>
                <input
                  type={headerDateInputType}
                  value={headerEndValue}
                  onChange={(e) => {
                    const v = e.target.value
                    if (filters.grain === 'day') {
                      updateHeaderFilter({ date_to: v })
                    } else if (filters.grain === 'week') {
                      const r = weekToDateRange(v)
                      if (r) updateHeaderFilter({ date_to: r.date_to })
                    } else {
                      const r = getMonthRange(v)
                      if (r) updateHeaderFilter({ date_to: r.date_to })
                    }
                  }}
                />
              </label>
            </div>
          </div>

          
        </div>
      </section>

      {error ? <section className="error-box">{error}</section> : null}
      {loading ? <section className="loading-box">加载中...</section> : null}

      <section className="metric-grid">
        <MetricCard
          title="订单数"
          value={formatInt(cards.order_count)}
          desc="指定周期内订单总数，用于退款订单占比计算。"
        />

        <MetricCard
          title="销量"
          value={formatInt(cards.sales_qty)}
          desc="指定周期内商品销售件数（剔除保险与价格调整行）。"
        />

        <MetricCard
          title="退款订单数"
          value={formatInt(cards.refund_order_count)}
          desc="指定周期内发生退款的订单数。"
          highlight
        />

        <MetricCard
          title="退款金额"
          value={formatMoney(cards.refund_amount)}
          desc="指定周期内发生退款金额总和。"
          highlight
        />

        <MetricCard
          title="GMV"
          value={formatMoney(cards.gmv)}
          desc="订单金额（实付+折扣+客诉代金券）。"
        />

        <MetricCard
          title="净实付金额"
          value={formatMoney(cards.net_received_amount)}
          desc="GMV剔除客诉代金券后的实收。"
        />

        <MetricCard
          title="净GMV"
          value={formatMoney(cards.net_revenue_amount)}
          desc="净实付金额再剔除退款后的净口径。"
        />

        <MetricCard
          title="退款金额占比"
          value={formatRate(cards.refund_amount_ratio)}
          desc="退款金额 / 总实收金额。"
          highlight
        />
      </section>

      <section className="table-wrap">
        <div className="table-head">
          <div>
            <h3>商品退款表现表</h3>
            <p className="table-note">默认查询退款金额Top20再排序为Top5</p>
          </div>

          <div className="table-sort-tools">
            <div className="table-sort-tools-row">
            <div className="listing-date-group">
              <label className="listing-date-field">
                <span>上架时段</span>
                <input
                  type="date"
                  value={filters.listing_date_from}
                  onChange={(e) => setFilters((prev) => ({ ...prev, listing_date_from: e.target.value }))}
                />
              </label>
              <label className="listing-date-field">
                <input
                  type="date"
                  value={filters.listing_date_to}
                  onChange={(e) => setFilters((prev) => ({ ...prev, listing_date_to: e.target.value }))}
                />
              </label>
            </div>
            <div className="picker-wrap">
              <button
                type="button"
                className="picker-trigger"
                onClick={() => {
                  setSpuPickerOpen((v) => !v)
                  setSkcPickerOpen(false)
                }}
              >
                SPU筛选 {pendingSpus.length ? `(${pendingSpus.length})` : ''}
              </button>
              {spuPickerOpen ? (
                <div className="picker-panel">
                  <input
                    placeholder="请输入搜索内容"
                    value={spuKeyword}
                    onChange={(e) => setSpuKeyword(e.target.value)}
                  />
                  <div className="picker-list">
                    {filteredSpuOptions.map((item) => (
                      <label key={item} className="picker-item">
                        <input
                          type="checkbox"
                          checked={pendingSpus.includes(item)}
                          onChange={(e) => {
                            const spuRelatedSkcs = skcsBySpu.get(item) ?? []
                            setPendingSpus((prevSpus) => {
                              const nextSpus = e.target.checked
                                ? [...new Set([...prevSpus, item])]
                                : prevSpus.filter((v) => v !== item)
                              setPendingSkcs((prevSkcs) => {
                                if (e.target.checked) {
                                  return [...new Set([...prevSkcs, ...spuRelatedSkcs])]
                                }
                                const nextSpuSet = new Set(nextSpus)
                                const nextSkcs = prevSkcs.filter((skc) => {
                                  if (!spuRelatedSkcs.includes(skc)) return true
                                  const parentSpus = spusBySkc.get(skc) ?? []
                                  return parentSpus.some((spu) => nextSpuSet.has(spu))
                                })
                                return nextSkcs
                              })
                              return nextSpus
                            })
                          }}
                        />
                        <span>{item}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="picker-wrap">
              <button
                type="button"
                className="picker-trigger"
                onClick={() => {
                  setSkcPickerOpen((v) => !v)
                  setSpuPickerOpen(false)
                }}
              >
                SKC筛选 {pendingSkcs.length ? `(${pendingSkcs.length})` : ''}
              </button>
              {skcPickerOpen ? (
                <div className="picker-panel">
                  <input
                    placeholder="请输入搜索内容"
                    value={skcKeyword}
                    onChange={(e) => setSkcKeyword(e.target.value)}
                  />
                  <div className="picker-list">
                    {filteredSkcOptions.map((item) => (
                      <label key={item} className="picker-item">
                        <input
                          type="checkbox"
                          checked={pendingSkcs.includes(item)}
                          onChange={(e) => {
                            setPendingSkcs((prevSkcs) => {
                              const nextSkcs = e.target.checked
                                ? [...new Set([...prevSkcs, item])]
                                : prevSkcs.filter((v) => v !== item)
                              const nextSpuSet = new Set()
                              for (const skc of nextSkcs) {
                                const parentSpus = spusBySkc.get(skc) ?? []
                                for (const spu of parentSpus) nextSpuSet.add(spu)
                              }
                              setPendingSpus([...nextSpuSet])
                              return nextSkcs
                            })
                          }}
                        />
                        <span>{item}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            </div>
            {pendingSpus.length > 0 || pendingSkcs.length > 0 || filters.listing_date_from || filters.listing_date_to || selectedSpus.length > 0 || selectedSkcs.length > 0 ? (
            <div className="table-sort-tools-row table-sort-tools-row--actions">
              <button
                type="button"
                className="picker-trigger picker-trigger--confirm"
                onClick={() => {
                  setSelectedSpus(pendingSpus)
                  setSelectedSkcs(pendingSkcs)
                  setConfirmKey(k => k + 1)
                  if (!pendingSpus.length && !pendingSkcs.length && !filters.listing_date_from && !filters.listing_date_to) {
                    setFilteredRows([])
                  }
                  setSpuPickerOpen(false)
                  setSkcPickerOpen(false)
                }}
              >
                确认查询
              </button>
              <button
                type="button"
                className="picker-trigger picker-trigger--clear"
                onClick={() => {
                    setPendingSpus([])
                    setPendingSkcs([])
                    setSelectedSpus([])
                    setSelectedSkcs([])
                    setFilteredRows([])
                    setFilters((prev) => ({ ...prev, listing_date_from: '', listing_date_to: '' }))
                    setSpuPickerOpen(false)
                    setSkcPickerOpen(false)
                  }}
                >
                  清空
                </button>
            </div>
            ) : null}
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="th-center">SPU</th>
                <th className="th-center">SKC</th>
                <th>
                  <button
                    type="button"
                    className={`sort-header-btn ${sortState.key === 'sales_qty' ? 'sort-header-btn--active' : ''}`}
                    onClick={() => toggleSort('sales_qty')}
                  >
                    销量
                    {sortState.key === 'sales_qty' ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-header-btn ${sortState.key === 'sales_amount' ? 'sort-header-btn--active' : ''}`}
                    onClick={() => toggleSort('sales_amount')}
                  >
                    销售额
                    {sortState.key === 'sales_amount' ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-header-btn ${sortState.key === 'refund_qty' ? 'sort-header-btn--active' : ''}`}
                    onClick={() => toggleSort('refund_qty')}
                  >
                    退款数
                    {sortState.key === 'refund_qty' ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-header-btn ${sortState.key === 'refund_amount' ? 'sort-header-btn--active' : ''}`}
                    onClick={() => toggleSort('refund_amount')}
                  >
                    退款金额
                    {sortState.key === 'refund_amount' ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-header-btn ${sortState.key === 'refund_qty_ratio' ? 'sort-header-btn--active' : ''}`}
                    onClick={() => toggleSort('refund_qty_ratio')}
                  >
                    退款数占比
                    {sortState.key === 'refund_qty_ratio' ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-header-btn ${sortState.key === 'refund_amount_ratio' ? 'sort-header-btn--active' : ''}`}
                    onClick={() => toggleSort('refund_amount_ratio')}
                  >
                    退款金额占比
                    {sortState.key === 'refund_amount_ratio' ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              </tr>
            </thead>

            <tbody>{renderedTableRows}</tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

export default P2Dashboard
