import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p2/ProductRefundTable.tsx'), 'utf8')

describe('ProductRefundTable controls', () => {
  it('uses one grouped product picker instead of separate SPU and SKC triggers', () => {
    expect(source).toContain('商品筛选')
    expect(source).toContain('product-picker-panel')
    expect(source).toContain('product-picker-column')
    expect(source).not.toContain('SPU筛选')
    expect(source).not.toContain('SKC筛选')
    expect(source).not.toContain('上架时段')
    expect(source).not.toContain('listing-date-group')
  })

  it('closes the product picker when clicking outside like the date range picker', () => {
    expect(source).toContain('useRef')
    expect(source).toContain('productPickerRef')
    expect(source).toContain("document.addEventListener('mousedown', closeOnOutsidePointer)")
    expect(source).toContain("document.addEventListener('touchstart', closeOnOutsidePointer)")
    expect(source).toContain('productPickerRef.current?.contains(event.target)')
    expect(source).toContain('setProductPickerOpen(false)')
    expect(source).toContain("document.removeEventListener('mousedown', closeOnOutsidePointer)")
    expect(source).toContain("document.removeEventListener('touchstart', closeOnOutsidePointer)")
    expect(source).toContain('ref={productPickerRef}')
  })

  it('fetches the top 50 refund rows and lets users switch page size', () => {
    expect(source).toContain('PRODUCT_REFUND_FETCH_LIMIT = 50')
    expect(source).toContain('PRODUCT_REFUND_PAGE_SIZE_OPTIONS = [10, 20, 50]')
    expect(source).toContain('top_n: PRODUCT_REFUND_FETCH_LIMIT')
    expect(source).toContain('默认拉取退款金额 Top50')
    expect(source).toContain('visibleRows')
    expect(source).toContain('activeRowCount')
    expect(source).toContain('page-size-control')
    expect(source).not.toContain('Top20')
    expect(source).not.toContain('再排序为Top5')
    expect(source).not.toContain('前 5 行')
    expect(source).not.toContain('slice(0, 5)')
  })

  it('switches SKC details into a flat SKC table without changing the API schema', () => {
    expect(source).toContain("type TableView = 'spu' | 'skc'")
    expect(source).toContain("useState<TableView>('spu')")
    expect(source).toContain('flatSkcRows')
    expect(source).toContain('visibleSkcRows')
    expect(source).toContain("tableView === 'skc' ? flatSkcRows.length : displayedRows.length")
    expect(source).toContain("tableView === 'spu' ? 'SKC 明细' : 'SPU 汇总'")
    expect(source).toContain("tableView === 'skc' ? 'SKC 筛选' : '商品筛选'")
    expect(source).toContain("tableView === 'skc' ? '按 SKC 直接过滤明细行' : '先选 SPU，再精确到 SKC'")
    expect(source).toContain("product-picker-body--skc-only")
    expect(source).toContain('skc-row skc-row--flat')
    expect(source).toContain('item.parent.sales_qty ? item.row.refund_qty / item.parent.sales_qty : 0')
    expect(source).toContain('item.parent.sales_amount ? item.row.refund_amount / item.parent.sales_amount : 0')
  })

  it('aligns the SKC side of the product picker with P3 behavior', () => {
    expect(source).toContain("tableView === 'skc'")
    expect(source).toContain("pendingSpus[0] ? (skcsBySpu.get(pendingSpus[0]) ?? []) : skcOptions")
    expect(source).toContain('placeholder="搜索 SKC"')
    expect(source).not.toContain('activeSpu')
    expect(source).not.toContain('visibleActiveSpu')
    expect(source).not.toContain('product-picker-item--active')
    expect(source).not.toContain('onMouseEnter={() => setActiveSpu')
    expect(source).not.toContain('的 SKC`')
  })

  it('refetches rows when refund date basis changes', () => {
    const initialFetchEffect = source.slice(
      source.indexOf('  // Initial / base-filter-driven fetch'),
      source.indexOf('  // Filter-driven fetch'),
    )
    const filteredFetchEffect = source.slice(
      source.indexOf('  // Filter-driven fetch'),
      source.indexOf('  // Reset expanded state'),
    )
    expect(initialFetchEffect).toContain('baseFilters.date_basis')
    expect(filteredFetchEffect).toContain('baseFilters.date_basis')
    expect(source).toMatch(/setPage\(1\)[\s\S]*baseFilters\.date_basis[\s\S]*const displayedRows/)
  })

  it('switches product table wording between cohort and refund-flow bases', () => {
    expect(source).toContain('const PRODUCT_REFUND_COPY')
    expect(source).toContain('商品退款表现表')
    expect(source).toContain('订单 cohort 口径')
    expect(source).toContain('商品退款流入表')
    expect(source).toContain('退款流入量')
    expect(source).toContain('流入量/同期销量')
    expect(source).toContain('不是订单 cohort 退款率')
  })
})
