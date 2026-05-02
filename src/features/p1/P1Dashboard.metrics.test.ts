import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p1/P1Dashboard.tsx'), 'utf8')

describe('P1 overview KPI composition', () => {
  it('keeps low-signal first/unreplied email metrics out of current and history KPI cards', () => {
    const cardsSource = source.slice(
      source.indexOf('  const cards = ['),
      source.indexOf('  const focusMetrics: FocusMetricSpec[]'),
    )

    expect(cardsSource).toContain("label: '来邮数'")
    expect(cardsSource).toContain("label: '回邮数'")
    expect(cardsSource).toContain("label: '平均会话排队时长'")
    expect(cardsSource).toContain("label: '首次响应超时次数'")
    expect(cardsSource).not.toContain('首封邮件数')
    expect(cardsSource).not.toContain('还没回复数')
  })

  it('does not compute hidden previous-range deltas for the focus chart summary', () => {
    const summarySource = source.slice(
      source.indexOf('  // Per-metric summary line for focus chart'),
      source.indexOf('  return ('),
    )

    expect(summarySource).toContain('summaryByKey')
    expect(summarySource).not.toContain('previousHistory')
    expect(summarySource).not.toContain('delta,')
  })

  it('hides the internal schedule-table missing note from the dashboard banner', () => {
    expect(source).toContain('visibleP1Note')
    expect(source).toContain('工时表暂未接入')
  })
})
