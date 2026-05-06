import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8')
const indexHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8')
const favicon = fs.readFileSync(path.join(process.cwd(), 'public/favicon.svg'), 'utf8')

describe('app branding', () => {
  it('uses the Linco BI brand in the shell and document title', () => {
    expect(appSource).toContain('linco bi')
    expect(appSource).toContain('小灵看板')
    expect(indexHtml).toContain('<title>linco bi</title>')
  })

  it('uses a customer-service favicon instead of the default tooling logo', () => {
    expect(indexHtml).toContain('href="/favicon.svg"')
    expect(favicon).toContain('linco bi customer service icon')
    expect(favicon).toContain('data-icon="customer-service-headset"')
  })
})
