import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/features/p2/useSpuSkcPicker.ts'), 'utf8')

describe('useSpuSkcPicker selection coupling', () => {
  it('does not auto-select SKCs when selecting SPUs or auto-select SPUs when selecting SKCs', () => {
    const toggleSpuPending = source.slice(
      source.indexOf('  function toggleSpuPending'),
      source.indexOf('  function toggleSkcPending'),
    )
    const toggleSkcPending = source.slice(
      source.indexOf('  function toggleSkcPending'),
      source.indexOf('  function applyPending'),
    )

    expect(toggleSpuPending).toContain('setPendingSpus')
    expect(toggleSpuPending).not.toContain('setPendingSkcs')
    expect(toggleSpuPending).not.toContain('skcsBySpu')

    expect(toggleSkcPending).toContain('setPendingSkcs')
    expect(toggleSkcPending).not.toContain('setPendingSpus')
    expect(toggleSkcPending).not.toContain('spusBySkc')
  })
})
