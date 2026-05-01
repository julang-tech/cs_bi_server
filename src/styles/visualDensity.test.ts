import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const readStyle = (file: string) =>
  fs.readFileSync(path.join(repoRoot, 'src', 'styles', file), 'utf8')

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
})
