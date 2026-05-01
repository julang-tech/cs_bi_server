import { Fragment, useEffect, useMemo, useState } from 'react'
import { useSpuSkcPicker } from './useSpuSkcPicker'
import { fetchRefundSpuTable, fetchRefundSpuSkcOptions } from '../../api/p2'
import { formatInteger, formatMoney, formatPercent } from '../../shared/utils/format'
import type { P2Filters, P2SpuRow } from '../../api/types'

interface ProductRefundTableProps {
  baseFilters: P2Filters
}

type SortKey =
  | 'sales_qty'
  | 'sales_amount'
  | 'refund_qty'
  | 'refund_amount'
  | 'refund_qty_ratio'
  | 'refund_amount_ratio'

interface SortState {
  key: SortKey
  direction: 'asc' | 'desc'
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return formatPercent(value, 1)
}

export function ProductRefundTable({ baseFilters }: ProductRefundTableProps) {
  const [top20Rows, setTop20Rows] = useState<P2SpuRow[]>([])
  const [filteredRows, setFilteredRows] = useState<P2SpuRow[]>([])
  const [spuOptions, setSpuOptions] = useState<string[]>([])
  const [skcOptions, setSkcOptions] = useState<string[]>([])
  const [spuSkcPairs, setSpuSkcPairs] = useState<Array<{ spu: string; skc: string }>>([])
  const [expandedSpu, setExpandedSpu] = useState<Record<string, boolean>>({})
  const [sortState, setSortState] = useState<SortState>({ key: 'refund_amount', direction: 'desc' })
  const [spuPickerOpen, setSpuPickerOpen] = useState(false)
  const [skcPickerOpen, setSkcPickerOpen] = useState(false)
  const [listingDateFrom, setListingDateFrom] = useState('')
  const [listingDateTo, setListingDateTo] = useState('')
  const [confirmKey, setConfirmKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const picker = useSpuSkcPicker({ spuOptions, skcOptions, pairs: spuSkcPairs })
  const {
    pendingSpus, pendingSkcs, selectedSpus, selectedSkcs,
    spuKeyword, skcKeyword, filteredSpuOptions, filteredSkcOptions,
    setSpuKeyword, setSkcKeyword,
    toggleSpuPending, toggleSkcPending,
    applyPending, clearAll,
  } = picker

  // Initial / base-filter-driven fetch: top-20 rows + SPU/SKC options
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')

    const fetchFilters: P2Filters = {
      ...baseFilters,
      category: '',
      spu: '',
      skc: '',
      top_n: 20,
    }

    Promise.all([
      fetchRefundSpuTable(fetchFilters, controller.signal),
      fetchRefundSpuSkcOptions(fetchFilters, controller.signal),
    ])
      .then(([tableResp, optionsResp]) => {
        setTop20Rows(tableResp.rows ?? [])
        setFilteredRows([])
        setSpuOptions(optionsResp?.options?.spus ?? [])
        setSkcOptions(optionsResp?.options?.skcs ?? [])
        setSpuSkcPairs(optionsResp?.options?.pairs ?? [])
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
        setError((err as Error).message || '商品退款表加载失败')
      })
      .finally(() => setLoading(false))

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFilters.grain, baseFilters.channel, baseFilters.date_from, baseFilters.date_to])

  // Filter-driven fetch: top-500 rows scoped by picker / listing dates
  useEffect(() => {
    const controller = new AbortController()
    const hasFilters =
      selectedSpus.length > 0 ||
      selectedSkcs.length > 0 ||
      Boolean(listingDateFrom) ||
      Boolean(listingDateTo)

    if (!hasFilters) {
      return () => controller.abort()
    }

    fetchRefundSpuTable(
      {
        ...baseFilters,
        category: '',
        spu: '',
        skc: '',
        spu_list: selectedSpus,
        skc_list: selectedSkcs,
        listing_date_from: listingDateFrom || '',
        listing_date_to: listingDateTo || '',
        top_n: 500,
      },
      controller.signal,
    )
      .then((resp) => setFilteredRows(resp.rows ?? []))
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpus, selectedSkcs, confirmKey, baseFilters.grain, baseFilters.channel, baseFilters.date_from, baseFilters.date_to])

  // Reset expanded state when active row set changes
  useEffect(() => {
    const hasTableFilters =
      selectedSpus.length > 0 || selectedSkcs.length > 0 || filteredRows.length > 0
    const activeRows = hasTableFilters ? filteredRows : top20Rows
    if (!activeRows.length) {
      setExpandedSpu({})
      return
    }
    setExpandedSpu((prev) => {
      const next: Record<string, boolean> = {}
      for (const row of activeRows) {
        if (prev[row.spu]) next[row.spu] = true
      }
      return next
    })
  }, [top20Rows, filteredRows, selectedSpus.length, selectedSkcs.length])

  const displayedRows = useMemo(() => {
    const hasTableFilters =
      selectedSpus.length > 0 || selectedSkcs.length > 0 || filteredRows.length > 0
    const sourceRows = hasTableFilters ? filteredRows : top20Rows
    const rows = [...sourceRows]

    const getValue = (row: P2SpuRow): number => {
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
  }, [top20Rows, filteredRows, selectedSpus, selectedSkcs, sortState])

  const getMetricClass = (key: SortKey) =>
    `refund-metric-cell ${sortState.key === key ? 'sorted-metric-cell' : ''}`.trim()

  const toggleSort = (key: SortKey) => {
    setSortState((current) => {
      if (current.key === key) {
        return { ...current, direction: current.direction === 'desc' ? 'asc' : 'desc' }
      }
      return { key, direction: 'desc' }
    })
  }

  function handleConfirm() {
    applyPending()
    setConfirmKey((k) => k + 1)
    if (!pendingSpus.length && !pendingSkcs.length && !listingDateFrom && !listingDateTo) {
      setFilteredRows([])
    }
    setSpuPickerOpen(false)
    setSkcPickerOpen(false)
  }

  function handleClear() {
    clearAll()
    setFilteredRows([])
    setListingDateFrom('')
    setListingDateTo('')
    setSpuPickerOpen(false)
    setSkcPickerOpen(false)
  }

  const showActions =
    pendingSpus.length > 0 ||
    pendingSkcs.length > 0 ||
    Boolean(listingDateFrom) ||
    Boolean(listingDateTo) ||
    selectedSpus.length > 0 ||
    selectedSkcs.length > 0

  return (
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
                  value={listingDateFrom}
                  onChange={(e) => setListingDateFrom(e.target.value)}
                />
              </label>
              <label className="listing-date-field">
                <input
                  type="date"
                  value={listingDateTo}
                  onChange={(e) => setListingDateTo(e.target.value)}
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
                          onChange={(e) => toggleSpuPending(item, e.target.checked)}
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
                          onChange={(e) => toggleSkcPending(item, e.target.checked)}
                        />
                        <span>{item}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {showActions ? (
            <div className="table-sort-tools-row table-sort-tools-row--actions">
              <button
                type="button"
                className="picker-trigger picker-trigger--confirm"
                onClick={handleConfirm}
              >
                确认查询
              </button>
              <button
                type="button"
                className="picker-trigger picker-trigger--clear"
                onClick={handleClear}
              >
                清空
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {error ? <section className="error-box">{error}</section> : null}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="th-center">SPU</th>
              <th className="th-center">SKC</th>
              {([
                { key: 'sales_qty', label: '销量' },
                { key: 'sales_amount', label: '销售额' },
                { key: 'refund_qty', label: '退款数' },
                { key: 'refund_amount', label: '退款金额' },
                { key: 'refund_qty_ratio', label: '退款数占比' },
                { key: 'refund_amount_ratio', label: '退款金额占比' },
              ] as Array<{ key: SortKey; label: string }>).map((col) => (
                <th key={col.key}>
                  <button
                    type="button"
                    className={`sort-header-btn ${sortState.key === col.key ? 'sort-header-btn--active' : ''}`}
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}
                    {sortState.key === col.key ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {displayedRows.map((spuRow) => {
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
                  <td className={getMetricClass('sales_qty')}>{formatInteger(spuRow.sales_qty)}</td>
                  <td className={getMetricClass('sales_amount')}>{formatMoney(spuRow.sales_amount)}</td>
                  <td className={getMetricClass('refund_qty')}>{formatInteger(spuRow.refund_qty)}</td>
                  <td className={getMetricClass('refund_amount')}>{formatMoney(spuRow.refund_amount)}</td>
                  <td className={getMetricClass('refund_qty_ratio')}>{formatRate(spuRow.refund_qty_ratio)}</td>
                  <td className={getMetricClass('refund_amount_ratio')}>{formatRate(spuRow.refund_amount_ratio)}</td>
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
                        <td className={getMetricClass('sales_qty')}>{formatInteger(skcRow.sales_qty)}</td>
                        <td className={getMetricClass('sales_amount')}>{formatMoney(skcRow.sales_amount)}</td>
                        <td className={getMetricClass('refund_qty')}>{formatInteger(skcRow.refund_qty)}</td>
                        <td className={getMetricClass('refund_amount')}>{formatMoney(skcRow.refund_amount)}</td>
                        <td className={getMetricClass('refund_qty_ratio')}>
                          {formatRate(spuRow.sales_qty ? skcRow.refund_qty / spuRow.sales_qty : 0)}
                        </td>
                        <td className={getMetricClass('refund_amount_ratio')}>
                          {formatRate(spuRow.sales_amount ? skcRow.refund_amount / spuRow.sales_amount : 0)}
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
            })}
            {!loading && displayedRows.length === 0 ? (
              <tr key="empty">
                <td colSpan={8} className="empty-cell">暂无符合条件的数据</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
