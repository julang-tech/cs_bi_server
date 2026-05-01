import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p3/P3Dashboard.tsx'), 'utf8')

describe('P3 overview KPI composition', () => {
  it('keeps issue-type detail metrics out of current and history KPI cards', () => {
    const cardsSource = source.slice(
      source.indexOf('  const cards = ['),
      source.indexOf('  const focusMetrics: FocusMetricSpec[]'),
    )

    expect(cardsSource).toContain("label: '订单数'")
    expect(cardsSource).toContain("label: '客诉量'")
    expect(cardsSource).toContain("label: '客诉率'")
    expect(cardsSource).not.toContain('产品问题客诉量')
    expect(cardsSource).not.toContain('物流问题客诉量')
    expect(cardsSource).not.toContain('仓库问题客诉量')
  })
})
