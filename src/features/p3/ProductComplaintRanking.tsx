import { useMemo, useState } from 'react'
import { formatInteger, formatPercent } from '../../shared/utils/format'
import type { P3ProductRankingRow } from '../../api/types'

const RANKING_PAGE_SIZE_OPTIONS = [10, 20, 50]

type SortKey = 'sales_qty' | 'complaint_count' | 'complaint_rate'
interface SortState {
  key: SortKey
  direction: 'asc' | 'desc'
}

interface ProductComplaintRankingProps {
  rows: P3ProductRankingRow[]
  loading: boolean
  error: string
  dateBasis: 'record_date' | 'order_date' | 'refund_date'
}

interface RankingPaginationProps {
  ariaLabel: string
  pageSize: number
  setPageSize: (size: number) => void
  safePage: number
  pageCount: number
  setPage: (updater: number | ((current: number) => number)) => void
}

const COMPLAINT_RANKING_COPY = {
  record_date: {
    title: '商品客诉登记流入表',
    hint: '登记时间口径：客诉量按飞书登记时间归属；同期销量按下单时间统计，仅作参考分母，登记流入率不是订单 cohort 客诉率。',
    salesQty: '同期销量',
    complaintCount: '登记客诉量',
    complaintRate: '登记流入率',
  },
  order_date: {
    title: '商品客诉表现表',
    hint: '订单 cohort 口径：按下单时间圈定商品销售批次，客诉量统计这批订单产生的客诉；客诉率用于判断商品真实客诉风险。',
    salesQty: '销量',
    complaintCount: '客诉量',
    complaintRate: '客诉率',
  },
  refund_date: {
    title: '商品退款客诉流入表',
    hint: '退款时间口径：客诉量按关联退款事件时间归属；同期销量按下单时间统计，仅作参考分母，退款流入率不是订单 cohort 客诉率。',
    salesQty: '同期销量',
    complaintCount: '退款客诉量',
    complaintRate: '退款流入率',
  },
} as const

function RankingPagination({
  ariaLabel,
  pageSize,
  setPageSize,
  safePage,
  pageCount,
  setPage,
}: RankingPaginationProps) {
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
      <div className="pagination-buttons" role="group" aria-label={ariaLabel}>
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

export function ProductComplaintRanking({
  rows,
  loading,
  error,
  dateBasis,
}: ProductComplaintRankingProps) {
  const [expandedSpus, setExpandedSpus] = useState<Set<string>>(() => new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  // Default 客诉率倒序 — match user's spec for "异常商品先看到的"工作流.
  const [sortState, setSortState] = useState<SortState>({ key: 'complaint_rate', direction: 'desc' })

  // First slice the upstream Top50 (which is server-sorted by 客诉量 desc),
  // then re-sort locally by the user's chosen column. SKC children re-sort
  // by the same key so parent + child stays consistent.
  const topRows = useMemo(() => {
    const sliced = rows.slice(0, 50)
    const sorted = [...sliced].sort((a, b) => {
      const av = a[sortState.key] ?? 0
      const bv = b[sortState.key] ?? 0
      const diff = av - bv
      return sortState.direction === 'asc' ? diff : -diff
    })
    return sorted.map((row) => ({
      ...row,
      children: [...row.children].sort((a, b) => {
        const av = a[sortState.key] ?? 0
        const bv = b[sortState.key] ?? 0
        const diff = av - bv
        return sortState.direction === 'asc' ? diff : -diff
      }),
    }))
  }, [rows, sortState])

  function toggleSpu(spu: string) {
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

  function toggleSort(key: SortKey) {
    setSortState((current) => {
      if (current.key === key) {
        return { ...current, direction: current.direction === 'desc' ? 'asc' : 'desc' }
      }
      return { key, direction: 'desc' }
    })
    setPage(1)
  }

  const pageCount = Math.max(1, Math.ceil(topRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const startIndex = (safePage - 1) * pageSize
  const visibleRows = topRows.slice(startIndex, startIndex + pageSize)
  const copy = COMPLAINT_RANKING_COPY[dateBasis]
  const columns: Array<{ key: SortKey; label: string }> = [
    { key: 'sales_qty', label: copy.salesQty },
    { key: 'complaint_count', label: copy.complaintCount },
    { key: 'complaint_rate', label: copy.complaintRate },
  ]

  return (
    <section className="table-card ranking-card">
      <div className="table-card__header">
        <div>
          <h3>{copy.title}</h3>
          <p className="table-card__hint">{copy.hint} 默认按客诉率倒序展示 Top50 SPU，每页 10 / 20 / 50 条可切换；点击表头列名可切换排序，可展开查看对应 SKC 明细。</p>
        </div>
        {topRows.length ? (
          <RankingPagination
            ariaLabel={`${copy.title}分页`}
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
                {columns.map((col) => (
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
                    <td data-label={copy.salesQty}>{formatInteger(row.sales_qty)}</td>
                    <td data-label={copy.complaintCount}>{formatInteger(row.complaint_count)}</td>
                    <td data-label={copy.complaintRate}>{formatPercent(row.complaint_rate)}</td>
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
                    <td data-label={copy.salesQty}>{formatInteger(child.sales_qty)}</td>
                    <td data-label={copy.complaintCount}>{formatInteger(child.complaint_count)}</td>
                    <td data-label={copy.complaintRate}>{formatPercent(child.complaint_rate)}</td>
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
