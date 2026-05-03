import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p2/P2Dashboard.tsx'), 'utf8')

describe('P2 overview focus chart summary', () => {
  it('does not compute hidden previous-range deltas for the focus chart summary', () => {
    const summarySource = source.slice(
      source.indexOf('  // Per-metric summary line for focus chart'),
      source.indexOf('  return ('),
    )

    expect(summarySource).toContain('summaryByKey')
    expect(summarySource).not.toContain('previousHistory')
    expect(summarySource).not.toContain('delta,')
  })
})
