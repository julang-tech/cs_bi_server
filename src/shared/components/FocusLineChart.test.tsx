import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FocusLineChart, type FocusMetricSpec } from './FocusLineChart'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    this.callback([{
      target,
      contentRect: { width: 640, height: 320 } as DOMRectReadOnly,
    } as ResizeObserverEntry], this)
  }

  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

let root: Root | null = null
let host: HTMLDivElement | null = null

const metrics: FocusMetricSpec[] = [
  {
    key: 'sales',
    label: '销量',
    formatter: (n) => String(n),
    history: [{ bucket: '2026-04-01', value: 10 }],
    current: [{ bucket: '2026-04-02', value: 12 }],
  },
  {
    key: 'refund',
    label: '退款金额',
    formatter: (n) => `$${n}`,
    history: [{ bucket: '2026-04-01', value: 2 }],
    current: [{ bucket: '2026-04-02', value: 3 }],
  },
]

function renderChart(onActiveKeyChange = vi.fn(), nextMetrics = metrics) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      <FocusLineChart
        metrics={nextMetrics}
        activeKey={nextMetrics[1]?.key ?? nextMetrics[0]?.key}
        onActiveKeyChange={onActiveKeyChange}
      />,
    )
  })
  return onActiveKeyChange
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
})

describe('FocusLineChart controlled active metric', () => {
  it('uses activeKey and reports tab changes to the parent', () => {
    const onActiveKeyChange = renderChart()
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.focus-chart__tab')]

    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])

    act(() => {
      tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onActiveKeyChange).toHaveBeenCalledWith('sales')
  })

  it('renders a labeled mean line and highlights the visible peak point', () => {
    renderChart(vi.fn(), [
      {
        key: 'sales',
        label: '销量',
        formatter: (n) => `${n}`,
        history: [
          { bucket: '2026-04-01', value: 10 },
          { bucket: '2026-04-02', value: 30 },
          { bucket: '2026-04-03', value: 20 },
        ],
        current: [],
      },
    ])

    expect(document.body.textContent).toContain('均值 20')
    expect(document.body.textContent).toContain('峰值 30')
  })

  it('does not render an in-progress marker when no current point is supplied', () => {
    renderChart(vi.fn(), [
      {
        key: 'sales',
        label: '销量',
        formatter: (n) => `${n}`,
        history: [
          { bucket: '2026-04-30', value: 10 },
          { bucket: '2026-05-01', value: 20 },
        ],
        current: [],
      },
    ])

    expect(document.body.textContent).not.toContain('进行中')
  })
})
