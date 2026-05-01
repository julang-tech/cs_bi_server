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
})
