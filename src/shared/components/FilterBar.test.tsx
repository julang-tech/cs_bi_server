import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterBar } from './FilterBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function renderFilterBar() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  act(() => {
    root?.render(
      <FilterBar
        grain="day"
        onGrainChange={vi.fn()}
        historyRange={{ date_from: '2026-04-17', date_to: '2026-04-30' }}
        onHistoryRangeChange={vi.fn()}
      />,
    )
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

describe('FilterBar date range picker', () => {
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
})
