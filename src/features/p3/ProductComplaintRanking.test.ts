import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p3/ProductComplaintRanking.tsx'), 'utf8')
const sharedSource = fs.readFileSync(path.join(process.cwd(), 'src/shared/components/ProductBreakdownTable.tsx'), 'utf8')

describe('ProductComplaintRanking pagination', () => {
  it('uses Top50 as the ranking window and defaults to 10 rows per page', () => {
    expect(sharedSource).toContain('PAGE_SIZE_OPTIONS = [10, 20, 50]')
    expect(sharedSource).toContain("useState<number>(PAGE_SIZE_OPTIONS[0])")
    expect(source).toContain('rows.slice(0, 50)')
    expect(source).toContain('默认按客诉率倒序展示 Top50')
    expect(source).not.toContain('Top20')
    expect(sharedSource).not.toContain('useState(5)')
  })

  it('closes the shared product picker when clicking outside', () => {
    expect(sharedSource).toContain('useRef')
    expect(sharedSource).toContain('productPickerRef')
    expect(sharedSource).toContain("document.addEventListener('mousedown', closeOnOutsidePointer)")
    expect(sharedSource).toContain("document.addEventListener('touchstart', closeOnOutsidePointer)")
    expect(sharedSource).toContain('productPickerRef.current?.contains(event.target)')
    expect(sharedSource).toContain('setPickerOpen(false)')
    expect(sharedSource).toContain("document.removeEventListener('mousedown', closeOnOutsidePointer)")
    expect(sharedSource).toContain("document.removeEventListener('touchstart', closeOnOutsidePointer)")
    expect(sharedSource).toContain('ref={productPickerRef}')
  })

  it('renders sortable column headers for sales/complaint metrics with default 客诉率倒序', () => {
    expect(source).toContain('defaultSortKey="complaint_rate"')
    expect(source).toContain('defaultSortDirection="desc"')
    expect(source).toContain("key: 'sales_qty'")
    expect(source).toContain("label: copy.salesQty")
    expect(source).toContain("key: 'refund_qty'")
    expect(source).toContain("label: copy.refundQty")
    expect(source).toContain("key: 'refund_amount'")
    expect(source).toContain("label: copy.refundAmount")
    expect(source).toContain("key: 'complaint_count'")
    expect(source).toContain("label: copy.complaintCount")
    expect(source).toContain("key: 'complaint_rate'")
    expect(source).toContain("label: copy.complaintRate")
    expect(sharedSource).toContain('sort-header-btn')
    expect(sharedSource).toContain('toggleSort')
  })

  it('switches ranking wording between cohort and flow bases', () => {
    expect(source).toContain("dateBasis: 'record_date' | 'order_date'")
    expect(source).toContain('const COMPLAINT_RANKING_COPY')
    expect(source).toContain('商品客诉表现表')
    expect(source).toContain('订单 cohort 口径')
    expect(source).toContain('商品客诉登记流入表')
    expect(source).toContain('登记流入率')
    expect(source).toContain('不是订单 cohort 客诉率')
  })
})
