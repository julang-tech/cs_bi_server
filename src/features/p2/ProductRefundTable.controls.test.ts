import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p2/ProductRefundTable.tsx'), 'utf8')

describe('ProductRefundTable controls', () => {
  it('keeps the product table header focused on SPU and SKC filters', () => {
    expect(source).toContain('SPU筛选')
    expect(source).toContain('SKC筛选')
    expect(source).not.toContain('上架时段')
    expect(source).not.toContain('listing-date-group')
  })
})
