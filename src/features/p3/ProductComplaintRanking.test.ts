import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p3/ProductComplaintRanking.tsx'), 'utf8')

describe('ProductComplaintRanking pagination', () => {
  it('uses Top50 as the ranking window and defaults to 10 rows per page', () => {
    expect(source).toContain('RANKING_PAGE_SIZE_OPTIONS = [10, 20, 50]')
    expect(source).toContain('useState(10)')
    expect(source).toContain('rows.slice(0, 50)')
    expect(source).toContain('默认按客诉率倒序展示 Top50')
    expect(source).not.toContain('Top20')
    expect(source).not.toContain('useState(5)')
  })

  it('renders sortable column headers for sales/complaint metrics with default 客诉率倒序', () => {
    expect(source).toContain("key: 'complaint_rate', direction: 'desc'")
    expect(source).toContain("key: 'sales_qty', label: copy.salesQty")
    expect(source).toContain("key: 'complaint_count', label: copy.complaintCount")
    expect(source).toContain("key: 'complaint_rate', label: copy.complaintRate")
    expect(source).toContain('sort-header-btn')
    expect(source).toContain('toggleSort')
  })

  it('switches ranking wording between cohort and flow bases', () => {
    expect(source).toContain("dateBasis: 'record_date' | 'order_date' | 'refund_date'")
    expect(source).toContain('const COMPLAINT_RANKING_COPY')
    expect(source).toContain('商品客诉表现表')
    expect(source).toContain('订单 cohort 口径')
    expect(source).toContain('商品客诉登记流入表')
    expect(source).toContain('登记流入率')
    expect(source).toContain('商品退款客诉流入表')
    expect(source).toContain('退款流入率')
    expect(source).toContain('不是订单 cohort 客诉率')
  })
})
