import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KpiCard } from './KpiCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(node)
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
})

describe('KpiCard metric linking', () => {
  it('marks the active KPI and notifies the selected metric when clicked', () => {
    const onSelect = vi.fn()
    render(
      <KpiCard
        variant="current"
        metricKey="gmv"
        active
        onSelect={onSelect}
        label="GMV"
        value="$100"
        periodAverage="$10"
      />,
    )

    const card = document.querySelector<HTMLElement>('.kpi-card')
    expect(card?.className).toContain('kpi-card--active')
    expect(card?.getAttribute('role')).toBe('button')
    expect(card?.getAttribute('aria-pressed')).toBe('true')

    act(() => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('gmv')
  })

  it('renders a sparkline for history KPI cards', () => {
    render(
      <KpiCard
        variant="history"
        metricKey="complaint_rate"
        label="客诉率"
        total="2.0%"
        periodAverage="2.0%"
        sparkline={[
          { bucket: '2026-04-01', value: 0.01 },
          { bucket: '2026-04-02', value: 0.02 },
        ]}
      />,
    )

    expect(document.querySelector('.mini-chart')).not.toBeNull()
  })
})
