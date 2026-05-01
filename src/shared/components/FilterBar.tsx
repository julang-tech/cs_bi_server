import { useMemo, useState, type ReactNode } from 'react'
import {
  alignHistoryRangeToGrain, isHistoryRangeValid,
  formatDateInput, getDataReadyDate, getPresetHistoryRange,
  parseDateInput, shiftDate,
} from '../utils/datePeriod'
import type { Grain, PeriodWindow } from '../../api/types'

const GRAIN_OPTIONS: Array<{ value: Grain; label: string }> = [
  { value: 'day', label: '按日' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

const PRESET_OPTIONS = [
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
  { label: '近 90 天', days: 90 },
]

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function shiftMonth(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

function formatMonthTitle(date: Date): string {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`
}

function buildCalendarCells(month: Date): Date[] {
  const first = monthStart(month)
  const mondayIndex = (first.getDay() || 7) - 1
  const start = shiftDate(first, -mondayIndex)
  return Array.from({ length: 42 }, (_, index) => shiftDate(start, index))
}

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
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draftRange, setDraftRange] = useState<PeriodWindow>(historyRange)
  const [selecting, setSelecting] = useState<'from' | 'to'>('from')
  const [visibleMonth, setVisibleMonth] = useState(() =>
    shiftMonth(monthStart(parseDateInput(historyRange.date_to)), -1),
  )
  const maxDate = useMemo(() => getDataReadyDate(), [])
  const maxDateText = formatDateInput(maxDate)

  function openPicker() {
    setDraftRange(historyRange)
    setSelecting('from')
    setVisibleMonth(shiftMonth(monthStart(parseDateInput(historyRange.date_to)), -1))
    setPickerOpen(true)
  }

  function applyRange(range: PeriodWindow) {
    const next = alignHistoryRangeToGrain(range, grain)
    if (next.date_from > next.date_to) return
    if (!isHistoryRangeValid(next, grain)) return
    onHistoryRangeChange(next)
    setDraftRange(next)
    setPickerOpen(false)
  }

  function selectDate(date: Date) {
    const value = formatDateInput(date)
    if (value > maxDateText) return
    if (selecting === 'from') {
      setDraftRange((current) => ({
        date_from: value,
        date_to: value > current.date_to ? value : current.date_to,
      }))
      setSelecting('to')
      return
    }
    setDraftRange((current) => ({
      date_from: value < current.date_from ? value : current.date_from,
      date_to: value,
    }))
    setSelecting('from')
  }

  function applyPreset(days: number) {
    applyRange(getPresetHistoryRange(days))
  }

  function renderMonth(month: Date) {
    const cells = buildCalendarCells(month)
    const monthIndex = month.getMonth()
    return (
      <div className="range-calendar-month">
        <div className="range-calendar-month__title">{formatMonthTitle(month)}</div>
        <div className="range-calendar-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="range-calendar-grid">
          {cells.map((date) => {
            const value = formatDateInput(date)
            const muted = date.getMonth() !== monthIndex
            const disabled = value > maxDateText
            const selectedStart = value === draftRange.date_from
            const selectedEnd = value === draftRange.date_to
            const inRange = value > draftRange.date_from && value < draftRange.date_to
            return (
              <button
                key={value}
                type="button"
                className={[
                  'range-calendar-day',
                  muted ? 'range-calendar-day--muted' : '',
                  inRange ? 'range-calendar-day--in-range' : '',
                  selectedStart || selectedEnd ? 'range-calendar-day--selected' : '',
                ].filter(Boolean).join(' ')}
                disabled={disabled}
                onClick={() => selectDate(date)}
              >
                {date.getDate()}
              </button>
            )
          })}
        </div>
      </div>
    )
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
        <div className="date-range-picker">
          <button
            type="button"
            className="date-range-trigger"
            aria-expanded={pickerOpen}
            onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}
          >
            <span className="date-range-trigger__date">
              <small>起</small>
              <strong>{historyRange.date_from}</strong>
            </span>
            <span className="date-range-trigger__divider" aria-hidden="true" />
            <span className="date-range-trigger__date">
              <small>终</small>
              <strong>{historyRange.date_to}</strong>
            </span>
            <span className="date-range-trigger__icon" aria-hidden="true">▾</span>
          </button>

          {pickerOpen ? (
            <div className="date-range-popover">
              <div className="range-presets" aria-label="快捷日期范围">
                {PRESET_OPTIONS.map((preset) => (
                  <button key={preset.days} type="button" onClick={() => applyPreset(preset.days)}>
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="range-calendar">
                <div className="range-calendar-toolbar">
                  <button type="button" onClick={() => setVisibleMonth((m) => shiftMonth(m, -1))}>
                    上月
                  </button>
                  <span>{selecting === 'from' ? '选择开始日期' : '选择结束日期'}</span>
                  <button type="button" onClick={() => setVisibleMonth((m) => shiftMonth(m, 1))}>
                    下月
                  </button>
                </div>
                <div className="range-calendar-months">
                  {renderMonth(visibleMonth)}
                  {renderMonth(shiftMonth(visibleMonth, 1))}
                </div>
              </div>

              <div className="range-picker-footer">
                <span>{draftRange.date_from} - {draftRange.date_to}</span>
                <div>
                  <button type="button" className="range-picker-button" onClick={() => setPickerOpen(false)}>
                    取消
                  </button>
                  <button type="button" className="range-picker-button range-picker-button--primary"
                    onClick={() => applyRange(draftRange)}>
                    应用
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {extras}
    </section>
  )
}
