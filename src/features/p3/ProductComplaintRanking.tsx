import { useMemo, useState } from 'react'
import { formatInteger, formatPercent } from '../../shared/utils/format'
import type { P3ProductRankingRow } from '../../api/types'

const RANKING_PAGE_SIZE_OPTIONS = [10, 20, 50]

interface ProductComplaintRankingProps {
  rows: P3ProductRankingRow[]
  loading: boolean
  error: string
}

interface RankingPaginationProps {
  pageSize: number
  setPageSize: (size: number) => void
  safePage: number
  pageCount: number
  setPage: (updater: number | ((current: number) => number)) => void
}

function RankingPagination({ pageSize, setPageSize, safePage, pageCount, setPage }: RankingPaginationProps) {
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

export function ProductComplaintRanking({ rows, loading, error }: ProductComplaintRankingProps) {
  const [expandedSpus, setExpandedSpus] = useState<Set<string>>(() => new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const topRows = useMemo(() => rows.slice(0, 50), [rows])

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

  const pageCount = Math.max(1, Math.ceil(topRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const startIndex = (safePage - 1) * pageSize
  const visibleRows = topRows.slice(startIndex, startIndex + pageSize)

  return (
    <section className="table-card ranking-card">
      <div className="table-card__header">
        <div>
          <h3>商品客诉表现表</h3>
          <p className="table-card__hint">默认按客诉量排序拉取 Top50 SPU，每页展示 10 条，可展开查看对应 SKC 明细。</p>
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
