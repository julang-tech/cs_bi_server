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

const PRODUCT_REFUND_FETCH_LIMIT = 50
const PRODUCT_REFUND_PAGE_SIZE_OPTIONS = [10, 20, 50] as const

const PRODUCT_REFUND_COPY = {
  order_date: {
    title: '商品退款表现表',
    note: '订单 cohort 口径：按下单时间圈定商品销售批次，退款量/退款金额统计这批订单当前累计退款；退款率用于判断商品真实退款风险。',
    salesQty: '销量',
    salesAmount: '销售额',
    refundQty: '退款量',
    refundAmount: '退款金额',
    refundQtyRatio: '退款量占比',
    refundAmountRatio: '退款金额占比',
  },
  refund_date: {
    title: '商品退款流入表',
    note: '退款时间口径：退款流入量/金额按退款发生时间归属；同期销量/销售额仍按下单时间统计，仅作参考分母，不是订单 cohort 退款率。',
    salesQty: '同期销量',
    salesAmount: '同期销售额',
    refundQty: '退款流入量',
    refundAmount: '退款流入金额',
    refundQtyRatio: '流入量/同期销量',
    refundAmountRatio: '流入额/同期销售额',
  },
} as const

export function ProductRefundTable({ baseFilters }: ProductRefundTableProps) {
  const [top50Rows, setTop50Rows] = useState<P2SpuRow[]>([])
  const [filteredRows, setFilteredRows] = useState<P2SpuRow[]>([])
  const [spuOptions, setSpuOptions] = useState<string[]>([])
  const [skcOptions, setSkcOptions] = useState<string[]>([])
  const [spuSkcPairs, setSpuSkcPairs] = useState<Array<{ spu: string; skc: string }>>([])
  const [expandedSpu, setExpandedSpu] = useState<Record<string, boolean>>({})
  const [sortState, setSortState] = useState<SortState>({ key: 'refund_amount', direction: 'desc' })
  const [productPickerOpen, setProductPickerOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PRODUCT_REFUND_PAGE_SIZE_OPTIONS[0])
  const [activeSpu, setActiveSpu] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const picker = useSpuSkcPicker({ spuOptions, skcOptions, pairs: spuSkcPairs })
  const {
    pendingSpus, pendingSkcs, selectedSpus, selectedSkcs,
    spuKeyword, skcKeyword, filteredSpuOptions,
    setSpuKeyword, setSkcKeyword,
    toggleSpuPending, toggleSkcPending,
    applyPending, clearAll,
  } = picker

  const skcsBySpu = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const pair of spuSkcPairs) {
      if (!pair.spu || !pair.skc) continue
      const list = map.get(pair.spu) ?? []
      if (!list.includes(pair.skc)) list.push(pair.skc)
      map.set(pair.spu, list)
    }
    return map
  }, [spuSkcPairs])

  // Initial / base-filter-driven fetch: top 50 rows + SPU/SKC options
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')

    const fetchFilters: P2Filters = {
      ...baseFilters,
      category: '',
      spu: '',
      skc: '',
      top_n: PRODUCT_REFUND_FETCH_LIMIT,
    }

    Promise.all([
      fetchRefundSpuTable(fetchFilters, controller.signal),
      fetchRefundSpuSkcOptions(fetchFilters, controller.signal),
    ])
      .then(([tableResp, optionsResp]) => {
        setTop50Rows(tableResp.rows ?? [])
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
  }, [baseFilters.grain, baseFilters.channel, baseFilters.date_basis, baseFilters.date_from, baseFilters.date_to])

  // Filter-driven fetch: top 50 rows scoped by picker selections
  useEffect(() => {
    const controller = new AbortController()
    const hasFilters =
      selectedSpus.length > 0 ||
      selectedSkcs.length > 0

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
        top_n: PRODUCT_REFUND_FETCH_LIMIT,
      },
      controller.signal,
    )
      .then((resp) => setFilteredRows(resp.rows ?? []))
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpus, selectedSkcs, baseFilters.grain, baseFilters.channel, baseFilters.date_basis, baseFilters.date_from, baseFilters.date_to])

  // Reset expanded state when active row set changes
  useEffect(() => {
    const hasTableFilters =
      selectedSpus.length > 0 || selectedSkcs.length > 0 || filteredRows.length > 0
    const activeRows = hasTableFilters ? filteredRows : top50Rows
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
  }, [top50Rows, filteredRows, selectedSpus.length, selectedSkcs.length])

  useEffect(() => {
    setPage(1)
  }, [
    selectedSpus,
    selectedSkcs,
    sortState,
    baseFilters.grain,
    baseFilters.channel,
    baseFilters.date_basis,
    baseFilters.date_from,
    baseFilters.date_to,
  ])

  const displayedRows = useMemo(() => {
    const hasTableFilters =
      selectedSpus.length > 0 || selectedSkcs.length > 0 || filteredRows.length > 0
    const sourceRows = hasTableFilters ? filteredRows : top50Rows
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

    return rows
  }, [top50Rows, filteredRows, selectedSpus, selectedSkcs, sortState])

  const pageCount = Math.max(1, Math.ceil(displayedRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const startIndex = (safePage - 1) * pageSize
  const visibleRows = displayedRows.slice(startIndex, startIndex + pageSize)

  const visibleActiveSpu = useMemo(() => {
    if (activeSpu && filteredSpuOptions.includes(activeSpu)) return activeSpu
    if (pendingSpus.length) {
      const firstPending = filteredSpuOptions.find((spu) => pendingSpus.includes(spu))
      if (firstPending) return firstPending
    }
    return filteredSpuOptions[0] ?? ''
  }, [activeSpu, filteredSpuOptions, pendingSpus])

  const activeSkcOptions = useMemo(() => {
    const source = visibleActiveSpu ? (skcsBySpu.get(visibleActiveSpu) ?? []) : skcOptions
    const keyword = skcKeyword.trim().toLowerCase()
    if (!keyword) return source
    return source.filter((skc) => skc.toLowerCase().includes(keyword))
  }, [skcKeyword, skcOptions, skcsBySpu, visibleActiveSpu])

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
    if (!pendingSpus.length && !pendingSkcs.length) {
      setFilteredRows([])
    }
    setProductPickerOpen(false)
  }

  function handleClear() {
    clearAll()
    setFilteredRows([])
    setProductPickerOpen(false)
  }

  const showActions =
    pendingSpus.length > 0 ||
    pendingSkcs.length > 0 ||
    selectedSpus.length > 0 ||
    selectedSkcs.length > 0

  const productFilterCount = pendingSpus.length + pendingSkcs.length
  const dateBasis = baseFilters.date_basis === 'refund_date' ? 'refund_date' : 'order_date'
  const copy = PRODUCT_REFUND_COPY[dateBasis]

  return (
    <section className="table-wrap">
      <div className="table-head">
        <div>
          <h3>{copy.title}</h3>
          <p className="table-note">{copy.note} 默认拉取退款金额 Top50；每页可切换 10 / 20 / 50 条。</p>
        </div>

        <div className="table-sort-tools">
          <div className="table-sort-tools-row">
            <div className="picker-wrap product-picker-wrap">
              <button
                type="button"
                className="picker-trigger"
                onClick={() => setProductPickerOpen((v) => !v)}
              >
                商品筛选 {productFilterCount ? `(${productFilterCount})` : ''}
              </button>
              {productPickerOpen ? (
                <div className="product-picker-panel">
                  <div className="product-picker-header">
                    <div>
                      <strong>商品筛选</strong>
                      <span>先选 SPU，再精确到 SKC</span>
                    </div>
                    <span>{pendingSpus.length} SPU / {pendingSkcs.length} SKC</span>
                  </div>

                  <div className="product-picker-body">
                    <div className="product-picker-column">
                      <label className="product-picker-search">
                        <span>SPU</span>
                        <input
                          placeholder="搜索 SPU"
                          value={spuKeyword}
                          onChange={(e) => setSpuKeyword(e.target.value)}
                        />
                      </label>
                      <div className="product-picker-list">
                        {filteredSpuOptions.map((item) => {
                          const checked = pendingSpus.includes(item)
                          const active = item === visibleActiveSpu
                          return (
                            <label
                              key={item}
                              className={[
                                'product-picker-item',
                                active ? 'product-picker-item--active' : '',
                              ].filter(Boolean).join(' ')}
                              onMouseEnter={() => setActiveSpu(item)}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  toggleSpuPending(item, e.target.checked)
                                  setActiveSpu(item)
                                }}
                              />
                              <span>{item}</span>
                              <small>{skcsBySpu.get(item)?.length ?? 0}</small>
                            </label>
                          )
                        })}
                      </div>
                    </div>

                    <div className="product-picker-column">
                      <label className="product-picker-search">
                        <span>SKC</span>
                        <input
                          placeholder={visibleActiveSpu ? `搜索 ${visibleActiveSpu} 的 SKC` : '搜索 SKC'}
                          value={skcKeyword}
                          onChange={(e) => setSkcKeyword(e.target.value)}
                        />
                      </label>
                      <div className="product-picker-list">
                        {activeSkcOptions.length ? activeSkcOptions.map((item) => (
                          <label key={item} className="product-picker-item">
                            <input
                              type="checkbox"
                              checked={pendingSkcs.includes(item)}
                              onChange={(e) => toggleSkcPending(item, e.target.checked)}
                            />
                            <span>{item}</span>
                          </label>
                        )) : (
                          <div className="product-picker-empty">暂无可选 SKC</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="product-picker-footer">
                    <button
                      type="button"
                      className="picker-trigger picker-trigger--clear"
                      onClick={handleClear}
                    >
                      清空
                    </button>
                    <button
                      type="button"
                      className="picker-trigger picker-trigger--confirm"
                      onClick={handleConfirm}
                    >
                      确认查询
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {showActions ? (
            <div className="table-sort-tools-row table-sort-tools-row--actions">
              <button
                type="button"
                className="picker-trigger picker-trigger--clear"
                onClick={handleClear}
              >
                清空
              </button>
            </div>
          ) : null}

          {displayedRows.length ? (
            <div className="ranking-pagination product-table-pagination">
              <label className="page-size-control">
                <span>每页</span>
                <select
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value))
                    setPage(1)
                  }}
                >
                  {PRODUCT_REFUND_PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <div className="pagination-buttons" role="group" aria-label={`${copy.title}分页`}>
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
                { key: 'sales_qty', label: copy.salesQty },
                { key: 'sales_amount', label: copy.salesAmount },
                { key: 'refund_qty', label: copy.refundQty },
                { key: 'refund_amount', label: copy.refundAmount },
                { key: 'refund_qty_ratio', label: copy.refundQtyRatio },
                { key: 'refund_amount_ratio', label: copy.refundAmountRatio },
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
            {visibleRows.map((spuRow) => {
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
