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

  it('fetches the top 50 refund rows and lets users switch page size', () => {
    expect(source).toContain('PRODUCT_REFUND_FETCH_LIMIT = 50')
    expect(source).toContain('PRODUCT_REFUND_PAGE_SIZE_OPTIONS = [10, 20, 50]')
    expect(source).toContain('top_n: PRODUCT_REFUND_FETCH_LIMIT')
    expect(source).toContain('默认拉取退款金额 Top50')
    expect(source).toContain('visibleRows')
    expect(source).toContain('page-size-control')
    expect(source).not.toContain('Top20')
    expect(source).not.toContain('再排序为Top5')
    expect(source).not.toContain('前 5 行')
    expect(source).not.toContain('slice(0, 5)')
  })
})
