import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterBar } from './FilterBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function renderFilterBar(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  const onHistoryRangeChange = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  act(() => {
    root?.render(
      <FilterBar
        grain="day"
        onGrainChange={vi.fn()}
        historyRange={{ date_from: '2026-04-17', date_to: '2026-04-30' }}
        onHistoryRangeChange={onHistoryRangeChange}
        {...overrides}
      />,
    )
  })

  return { onHistoryRangeChange }
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

describe('FilterBar date range picker', () => {
  it('labels the history date selector as a time range', () => {
    renderFilterBar()

    expect(host?.textContent).toContain('时间范围')
    expect(host?.textContent).not.toContain('历史区间')
  })

  it('closes the date range popover when clicking outside the picker', () => {
    renderFilterBar()

    const trigger = document.querySelector<HTMLButtonElement>('.date-range-trigger')
    expect(trigger).not.toBeNull()

    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('.date-range-popover')).not.toBeNull()

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.querySelector('.date-range-popover')).toBeNull()
  })

  it('offers yesterday, last-3/5/7-day shortcuts', () => {
    renderFilterBar()

    const trigger = document.querySelector<HTMLButtonElement>('.date-range-trigger')
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host?.textContent).toContain('昨天')
    expect(host?.textContent).toContain('近3天')
    expect(host?.textContent).toContain('近5天')
    expect(host?.textContent).toContain('近一周')
  })

  it('applies yesterday preset without expanding to a full week', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 1, 12))
    const { onHistoryRangeChange } = renderFilterBar({ grain: 'week' })

    const trigger = document.querySelector<HTMLButtonElement>('.date-range-trigger')
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.range-presets button'))
      .find((item) => item.textContent === '昨天')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // maxDate = data-ready (April 30 at 12:00), "昨天" = April 29
    expect(onHistoryRangeChange).toHaveBeenCalledWith({
      date_from: '2026-04-29',
      date_to: '2026-04-29',
    })
  })

  it('uses maxDate as the reference point for presets', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 2, 12))
    const { onHistoryRangeChange } = renderFilterBar({
      maxDate: new Date(2026, 4, 2, 12),
    })

    const trigger = document.querySelector<HTMLButtonElement>('.date-range-trigger')
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.range-presets button'))
      .find((item) => item.textContent === '近一周')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // "近一周" (7): maxDate-6 to maxDate = April 26 to May 2
    expect(onHistoryRangeChange).toHaveBeenCalledWith({
      date_from: '2026-04-26',
      date_to: '2026-05-02',
    })
  })
})
