import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p3/ProductComplaintRanking.tsx'), 'utf8')

describe('ProductComplaintRanking pagination', () => {
  it('uses Top50 as the ranking window and defaults to 10 rows per page', () => {
    expect(source).toContain('RANKING_PAGE_SIZE_OPTIONS = [10, 20, 50]')
    expect(source).toContain('useState(10)')
    expect(source).toContain('rows.slice(0, 50)')
    expect(source).toContain('默认按客诉量排序拉取 Top50')
    expect(source).not.toContain('Top20')
    expect(source).not.toContain('useState(5)')
  })
})
