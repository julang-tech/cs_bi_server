import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const readStyle = (file: string) =>
  fs.readFileSync(path.join(repoRoot, 'src', 'styles', file), 'utf8')

function cssBlock(styles: string, selector: string) {
  const match = styles.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

describe('dashboard visual density contract', () => {
  const styles = [
    'tokens.css',
    'base.css',
    'layout.css',
    'components.css',
    'extensions.css',
  ].map(readStyle).join('\n')

  it('uses a restrained operations-dashboard surface', () => {
    expect(styles).not.toContain('radial-gradient')
    expect(styles).not.toContain('Georgia')
  })

  it('keeps non-pill corners compact', () => {
    const radii = [...styles.matchAll(/border-radius:\s*(\d+)px/g)]
      .map((match) => Number(match[1]))
      .filter((radius) => radius < 100)
    expect(Math.max(...radii)).toBeLessThanOrEqual(10)
  })

  it('uses compact table row density', () => {
    expect(styles).not.toContain('padding: 24px 28px')
    expect(styles).not.toContain('padding: 28px 28px')
  })

  it('keeps filter date picker aligned with compact toolbar controls', () => {
    expect(styles).not.toContain('min-height: 40px')
    expect(styles).not.toContain('font-size: 20px')
    expect(styles).not.toContain('padding: 14px 14px 10px')
  })

  it('keeps dashboard filters sticky for long BI pages', () => {
    expect(styles).toContain('.dashboard-shell__sticky-filter')
    expect(styles).toContain('position: sticky')
    expect(styles).toContain('top: 0')
  })

  it('keeps normal KPI percentage badges on one natural-width line', () => {
    const delta = cssBlock(styles, '.kpi-card__delta')
    const side = cssBlock(styles, '.kpi-card__side')
    const value = cssBlock(styles, '.kpi-card__value')

    expect(delta).toContain('min-width: 76px')
    expect(delta).toContain('font-size: var(--fs-xs)')
    expect(delta).toContain('white-space: nowrap')
    expect(delta).toContain('text-overflow: ellipsis')
    expect(delta).not.toContain('overflow-wrap: anywhere')
    expect(delta).not.toContain('font-size: clamp')
    expect(side).toContain('min-width: max-content')
    expect(side).not.toContain('max-width: min(46%, 116px)')
    expect(value).toContain('white-space: nowrap')
    expect(value).not.toContain('overflow-wrap: anywhere')
  })
})
