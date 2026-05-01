import type { ReactNode } from 'react'
import {
  alignHistoryRangeToGrain, isHistoryRangeValid,
  parseDateInput, formatWeekInput, formatMonthInput,
  weekInputToRange, monthInputToRange,
} from '../utils/datePeriod'
import type { Grain, PeriodWindow } from '../../api/types'

const GRAIN_OPTIONS: Array<{ value: Grain; label: string }> = [
  { value: 'day', label: '按日' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

interface FilterBarProps {
  grain: Grain
  onGrainChange: (next: Grain) => void
  historyRange: PeriodWindow
  onHistoryRangeChange: (next: PeriodWindow) => void
  storeOptions?: Array<{ value: string; label: string }>
  store?: string
  onStoreChange?: (next: string) => void
  extras?: ReactNode
}

export function FilterBar({
  grain, onGrainChange,
  historyRange, onHistoryRangeChange,
  storeOptions, store, onStoreChange,
  extras,
}: FilterBarProps) {
  const inputType = grain === 'day' ? 'date' : grain === 'week' ? 'week' : 'month'

  function toInputValue(dateValue: string): string {
    if (grain === 'day') return dateValue
    const d = parseDateInput(dateValue)
    if (grain === 'week') return formatWeekInput(d)
    return formatMonthInput(d)
  }

  function fromInputValue(raw: string, role: 'from' | 'to'): string | null {
    if (grain === 'day') return raw
    if (grain === 'week') return weekInputToRange(raw, role)
    return monthInputToRange(raw, role)
  }

  const handleDateChange = (field: 'date_from' | 'date_to', rawValue: string) => {
    if (!rawValue) return
    const role: 'from' | 'to' = field === 'date_from' ? 'from' : 'to'
    const dateValue = fromInputValue(rawValue, role)
    if (!dateValue) return
    const next = alignHistoryRangeToGrain({ ...historyRange, [field]: dateValue }, grain)
    if (next.date_from > next.date_to) return
    if (!isHistoryRangeValid(next, grain)) return
    onHistoryRangeChange(next)
  }

  return (
    <section className="filter-bar">
      <div className="filter-bar__group">
        <span className="filter-bar__label">时间粒度</span>
        <div className="segmented-control" role="tablist">
          {GRAIN_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={grain === opt.value}
              className={`segment-button ${grain === opt.value ? 'segment-button--active' : ''}`}
              onClick={() => onGrainChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {storeOptions && onStoreChange ? (
        <div className="filter-bar__group">
          <span className="filter-bar__label">店铺</span>
          <select className="select-control" value={store ?? ''}
            onChange={(e) => onStoreChange(e.target.value)}>
            <option value="">全部</option>
            {storeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="filter-bar__group filter-bar__group--dates">
        <span className="filter-bar__label">历史区间</span>
        <div className="date-range-control">
          <label className="date-field">
            <span>起</span>
            <input type={inputType} value={toInputValue(historyRange.date_from)}
              max={toInputValue(historyRange.date_to)}
              onChange={(e) => handleDateChange('date_from', e.target.value)} />
          </label>
          <label className="date-field">
            <span>终</span>
            <input type={inputType} value={toInputValue(historyRange.date_to)}
              min={toInputValue(historyRange.date_from)}
              onChange={(e) => handleDateChange('date_to', e.target.value)} />
          </label>
        </div>
      </div>

      {extras}
    </section>
  )
}
