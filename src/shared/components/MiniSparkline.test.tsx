import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MiniSparkline } from './MiniSparkline'

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

describe('MiniSparkline', () => {
  it('keeps extreme outliers inside the mini chart bounds', () => {
    render(
      <MiniSparkline
        items={[
          { bucket: '2026-05-01', value: 10 },
          { bucket: '2026-05-02', value: 11 },
          { bucket: '2026-05-03', value: 12 },
          { bucket: '2026-05-04', value: 13 },
          { bucket: '2026-05-05', value: 1000 },
        ]}
      />,
    )

    const line = document.querySelectorAll('polyline')[1]
    const yValues = line
      ?.getAttribute('points')
      ?.split(' ')
      .map((point) => Number(point.split(',')[1])) ?? []

    expect(yValues.length).toBe(5)
    expect(Math.min(...yValues)).toBeGreaterThanOrEqual(10)
    expect(Math.max(...yValues)).toBeLessThanOrEqual(86)
  })
})
