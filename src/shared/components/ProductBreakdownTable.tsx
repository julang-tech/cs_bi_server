import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ProductBreakdownColumn<Row> {
  key: string
  label: string
  render: (row: Row, context: { parent?: Row }) => ReactNode
  sortValue: (row: Row) => number | string
}

export interface ProductBreakdownRow<Row> {
  id: string
  spu: string
  skcLabel: string
  parent: Row
  children: Array<{ id: string; spu: string; skc: string; row: Row }>
}

interface ProductFilterOptions {
  spus: string[]
  skcs: string[]
  pairs: Array<{ spu: string; skc: string }>
}

interface ProductBreakdownTableProps<Row> {
  title: string
  note: string
  rows: Array<ProductBreakdownRow<Row>>
  columns: Array<ProductBreakdownColumn<Row>>
  defaultSortKey: string
  defaultSortDirection?: 'asc' | 'desc'
  loading?: boolean
  error?: string
  loadingText?: string
  emptyText?: string
  ariaLabel: string
  filterOptions?: ProductFilterOptions
  headerTooltips?: Record<string, string>
}

type TableView = 'spu' | 'skc'
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

function compareValue(a: number | string, b: number | string) {
  if (typeof a === 'string' || typeof b === 'string') return String(a).localeCompare(String(b))
  return a - b
}

export function ProductBreakdownTable<Row>({
  title,
  note,
  rows,
  columns,
  defaultSortKey,
  defaultSortDirection = 'desc',
  loading = false,
  error = '',
  loadingText = '正在加载...',
  emptyText = '暂无符合条件的数据',
  ariaLabel,
  filterOptions,
  headerTooltips,
}: ProductBreakdownTableProps<Row>) {
  const [expandedSpus, setExpandedSpus] = useState<Set<string>>(() => new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const [sortState, setSortState] = useState({ key: defaultSortKey, direction: defaultSortDirection })
  const [tableView, setTableView] = useState<TableView>('spu')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedSpus, setSelectedSpus] = useState<string[]>([])
  const [selectedSkcs, setSelectedSkcs] = useState<string[]>([])
  const [spuKeyword, setSpuKeyword] = useState('')
  const [skcKeyword, setSkcKeyword] = useState('')
  const [activeTooltip, setActiveTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const productPickerRef = useRef<HTMLDivElement | null>(null)

  const skcsBySpu = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const pair of filterOptions?.pairs ?? []) {
      if (!pair.spu || !pair.skc) continue
      const list = map.get(pair.spu) ?? []
      if (!list.includes(pair.skc)) list.push(pair.skc)
      map.set(pair.spu, list)
    }
    return map
  }, [filterOptions])

  useEffect(() => {
    if (!pickerOpen) return

    function closeOnOutsidePointer(event: MouseEvent | TouchEvent) {
      if (!(event.target instanceof Node)) return
      if (productPickerRef.current?.contains(event.target)) return
      setPickerOpen(false)
    }

    document.addEventListener('mousedown', closeOnOutsidePointer)
    document.addEventListener('touchstart', closeOnOutsidePointer)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePointer)
      document.removeEventListener('touchstart', closeOnOutsidePointer)
    }
  }, [pickerOpen])

  const filteredRows = useMemo(() => {
    const hasSpu = tableView === 'spu' && selectedSpus.length > 0
    const hasSkc = selectedSkcs.length > 0
    if (!hasSpu && !hasSkc) return rows
    return rows
      .filter((row) => !hasSpu || selectedSpus.includes(row.spu))
      .map((row) => ({
        ...row,
        children: row.children.filter((child) => !hasSkc || selectedSkcs.includes(child.skc)),
      }))
      .filter((row) => row.children.length > 0 || !hasSkc)
  }, [rows, selectedSkcs, selectedSpus, tableView])

  const sortedRows = useMemo(() => {
    const column = columns.find((col) => col.key === sortState.key) ?? columns[0]
    if (!column) return filteredRows
    return [...filteredRows]
      .sort((a, b) => {
        const diff = compareValue(column.sortValue(a.parent), column.sortValue(b.parent))
        return sortState.direction === 'asc' ? diff : -diff
      })
      .map((row) => ({
        ...row,
        children: [...row.children].sort((a, b) => {
          if (sortState.key === 'skc') {
            const diff = compareValue(a.skc, b.skc)
            return sortState.direction === 'asc' ? diff : -diff
          }
          const diff = compareValue(column.sortValue(a.row), column.sortValue(b.row))
          return sortState.direction === 'asc' ? diff : -diff
        }),
      }))
  }, [columns, filteredRows, sortState])

  const flatSkcRows = useMemo(() => {
    const rowsFlat = sortedRows.flatMap((row) =>
      row.children.map((child) => ({ ...child, parent: row.parent })),
    )
    if (sortState.key === 'skc') {
      return [...rowsFlat].sort((a, b) => {
        const diff = compareValue(a.skc, b.skc)
        return sortState.direction === 'asc' ? diff : -diff
      })
    }
    const column = columns.find((col) => col.key === sortState.key) ?? columns[0]
    if (!column) return rowsFlat
    return [...rowsFlat].sort((a, b) => {
      const diff = compareValue(column.sortValue(a.row), column.sortValue(b.row))
      return sortState.direction === 'asc' ? diff : -diff
    })
  }, [columns, sortedRows, sortState])

  const activeCount = tableView === 'skc' ? flatSkcRows.length : sortedRows.length
  const pageCount = Math.max(1, Math.ceil(activeCount / pageSize))
  const safePage = Math.min(page, pageCount)
  const startIndex = (safePage - 1) * pageSize
  const visibleRows = sortedRows.slice(startIndex, startIndex + pageSize)
  const visibleSkcs = flatSkcRows.slice(startIndex, startIndex + pageSize)

  const filteredSpuOptions = useMemo(() => {
    const source = filterOptions?.spus ?? []
    const keyword = spuKeyword.trim().toLowerCase()
    return keyword ? source.filter((item) => item.toLowerCase().includes(keyword)) : source
  }, [filterOptions, spuKeyword])

  const filteredSkcOptions = useMemo(() => {
    const source = tableView === 'skc'
      ? (filterOptions?.skcs ?? [])
      : selectedSpus[0] ? (skcsBySpu.get(selectedSpus[0]) ?? []) : (filterOptions?.skcs ?? [])
    const keyword = skcKeyword.trim().toLowerCase()
    return keyword ? source.filter((item) => item.toLowerCase().includes(keyword)) : source
  }, [filterOptions, selectedSpus, skcKeyword, skcsBySpu, tableView])

  useEffect(() => {
    setPage(1)
  }, [tableView, selectedSpus, selectedSkcs, sortState])

  useEffect(() => {
    setExpandedSpus((current) => {
      const next = new Set<string>()
      for (const row of sortedRows) {
        if (current.has(row.spu)) next.add(row.spu)
      }
      return next
    })
  }, [sortedRows])

  function toggleSort(key: string) {
    setSortState((current) => {
      if (current.key === key) return { ...current, direction: current.direction === 'desc' ? 'asc' : 'desc' }
      return { key, direction: 'desc' }
    })
  }

  function toggleSpu(spu: string) {
    setExpandedSpus((current) => {
      const next = new Set(current)
      if (next.has(spu)) next.delete(spu)
      else next.add(spu)
      return next
    })
  }

  const filterCount = tableView === 'skc' ? selectedSkcs.length : selectedSpus.length + selectedSkcs.length

  function renderHeaderLabel(key: string, label: string, sortMarker = '') {
    const tooltip = headerTooltips?.[key]
    if (!tooltip) return <>{label}{sortMarker}</>
    const tooltipText = tooltip
    function showTooltip(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return
      const rect = target.getBoundingClientRect()
      const width = Math.min(300, Math.max(220, tooltipText.length * 7))
      const margin = 12
      const x = Math.max(margin + width / 2, Math.min(window.innerWidth - margin - width / 2, rect.left + rect.width / 2))
      const y = rect.bottom + 8
      setActiveTooltip({ text: tooltipText, x, y })
    }
    return (
      <span
        className="table-header-tooltip-wrap"
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={() => setActiveTooltip(null)}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onBlur={() => setActiveTooltip(null)}
      >
        <span>{label}</span>
        {sortMarker ? <span aria-hidden>{sortMarker}</span> : null}
        <span className="table-header-tooltip-icon" aria-hidden>i</span>
      </span>
    )
  }

  return (
    <section className="table-wrap">
      <div className="table-head">
        <div>
          <h3>{title}</h3>
          <p className="table-note">{note}</p>
        </div>
        <div className="table-sort-tools">
          <div className="table-sort-tools-row">
            <div className="picker-wrap product-picker-wrap" ref={productPickerRef}>
              <button type="button" className="picker-trigger" onClick={() => setPickerOpen((v) => !v)}>
                {tableView === 'skc' ? 'SKC 筛选' : '商品筛选'} {filterCount ? `(${filterCount})` : ''}
              </button>
              {pickerOpen ? (
                <div className="product-picker-panel">
                  <div className="product-picker-header">
                    <div>
                      <strong>{tableView === 'skc' ? 'SKC 筛选' : '商品筛选'}</strong>
                      <span>{tableView === 'skc' ? '按 SKC 直接过滤明细行' : '先选 SPU，再精确到 SKC'}</span>
                    </div>
                    <span>{tableView === 'skc' ? `${selectedSkcs.length} SKC` : `${selectedSpus.length} SPU / ${selectedSkcs.length} SKC`}</span>
                  </div>
                  <div className={`product-picker-body ${tableView === 'skc' ? 'product-picker-body--skc-only' : ''}`}>
                    {tableView === 'spu' ? (
                      <div className="product-picker-column">
                        <label className="product-picker-search">
                          <span>SPU</span>
                          <input placeholder="搜索 SPU" value={spuKeyword} onChange={(e) => setSpuKeyword(e.target.value)} />
                        </label>
                        <div className="product-picker-list">
                          {filteredSpuOptions.map((item) => (
                            <label key={item} className="product-picker-item">
                              <input
                                type="checkbox"
                                checked={selectedSpus.includes(item)}
                                onChange={(e) => setSelectedSpus((current) => e.target.checked ? [...current, item] : current.filter((v) => v !== item))}
                              />
                              <span>{item}</span>
                              <small>{skcsBySpu.get(item)?.length ?? 0}</small>
                            </label>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="product-picker-column">
                      <label className="product-picker-search">
                        <span>SKC</span>
                        <input placeholder="搜索 SKC" value={skcKeyword} onChange={(e) => setSkcKeyword(e.target.value)} />
                      </label>
                      <div className="product-picker-list">
                        {filteredSkcOptions.map((item) => (
                          <label key={item} className="product-picker-item">
                            <input
                              type="checkbox"
                              checked={selectedSkcs.includes(item)}
                              onChange={(e) => setSelectedSkcs((current) => e.target.checked ? [...current, item] : current.filter((v) => v !== item))}
                            />
                            <span>{item}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="product-picker-footer">
                    <button type="button" className="picker-trigger picker-trigger--clear" onClick={() => { setSelectedSpus([]); setSelectedSkcs([]); }}>
                      清空
                    </button>
                    <button type="button" className="picker-trigger picker-trigger--confirm" onClick={() => setPickerOpen(false)}>
                      确认查询
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="picker-trigger view-toggle-trigger"
              onClick={() => {
                setTableView((current) => current === 'spu' ? 'skc' : 'spu')
                if (sortState.key === 'skc') setSortState({ key: defaultSortKey, direction: 'desc' })
              }}
            >
              {tableView === 'spu' ? 'SKC 明细' : 'SPU 汇总'}
            </button>
          </div>

          {activeCount ? (
            <div className="ranking-pagination product-table-pagination">
              <label className="page-size-control">
                <span>每页</span>
                <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}>
                  {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <div className="pagination-buttons" role="group" aria-label={ariaLabel}>
                <button type="button" className="toolbar-button pagination-button" onClick={() => setPage(1)} disabled={safePage === 1}>首页</button>
                <button type="button" className="toolbar-button pagination-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage === 1}>上一页</button>
                <span className="pagination-status">{safePage} / {pageCount}</span>
                <button type="button" className="toolbar-button pagination-button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={safePage === pageCount}>下一页</button>
                <button type="button" className="toolbar-button pagination-button" onClick={() => setPage(pageCount)} disabled={safePage === pageCount}>尾页</button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="empty-state">{loadingText}</div>
      ) : error ? (
        <div className="empty-state empty-state--error">{error}</div>
      ) : activeCount ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="th-center">{renderHeaderLabel('spu', 'SPU')}</th>
                <th className="th-center">
                  <button type="button" className={`sort-header-btn ${sortState.key === 'skc' ? 'sort-header-btn--active' : ''}`} onClick={() => toggleSort('skc')}>
                    {renderHeaderLabel('skc', 'SKC', sortState.key === 'skc' ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : '')}
                  </button>
                </th>
                {columns.map((col) => (
                  <th key={col.key}>
                    <button type="button" className={`sort-header-btn ${sortState.key === col.key ? 'sort-header-btn--active' : ''}`} onClick={() => toggleSort(col.key)}>
                      {renderHeaderLabel(col.key, col.label, sortState.key === col.key ? (sortState.direction === 'desc' ? ' ↓' : ' ↑') : '')}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableView === 'skc' ? visibleSkcs.map((child) => (
                <tr key={`${child.id}-flat`} className="skc-row skc-row--flat">
                  <td className="spu-click-cell skc-spu-cell"><span>{child.spu}</span></td>
                  <td className="skc-cell">{child.skc}</td>
                  {columns.map((col) => <td key={col.key} className="refund-metric-cell">{col.render(child.row, { parent: child.parent })}</td>)}
                </tr>
              )) : visibleRows.map((row) => {
                const expanded = expandedSpus.has(row.spu)
                return (
                  <Fragment key={row.id}>
                    <tr className="spu-row" onClick={() => toggleSpu(row.spu)}>
                      <td className="spu-click-cell"><span className="spu-cell-btn">{row.spu}</span></td>
                      <td className="skc-expand-cell">{row.skcLabel}</td>
                      {columns.map((col) => <td key={col.key} className="refund-metric-cell">{col.render(row.parent, {})}</td>)}
                    </tr>
                    {expanded ? row.children.map((child) => (
                      <tr key={child.id} className="skc-row">
                        <td className="spu-click-cell skc-spu-cell"><span>{child.spu}</span></td>
                        <td className="skc-cell">{child.skc}</td>
                        {columns.map((col) => <td key={col.key} className="refund-metric-cell">{col.render(child.row, { parent: row.parent })}</td>)}
                      </tr>
                    )) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state empty-state--table">{emptyText}</div>
      )}
      {activeTooltip
        ? createPortal(
            <span
              className="table-header-tooltip table-header-tooltip--portal"
              role="tooltip"
              style={{ left: `${activeTooltip.x}px`, top: `${activeTooltip.y}px` }}
            >
              {activeTooltip.text}
            </span>,
            document.body,
          )
        : null}
    </section>
  )
}
