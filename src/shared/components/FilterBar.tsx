import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  alignHistoryRangeToGrain,
  formatDateInput, getDataReadyDate,
  parseDateInput, shiftDate,
} from '../utils/datePeriod'
import type { Grain, PeriodWindow } from '../../api/types'

const GRAIN_OPTIONS: Array<{ value: Grain; label: string }> = [
  { value: 'day', label: '按日' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

const PRESET_OPTIONS = [
  { label: '昨天', value: 1 },
  { label: '近3天', value: 3 },
  { label: '近5天', value: 5 },
  { label: '近一周', value: 7 },
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
  maxDate?: Date
  storeOptions?: Array<{ value: string; label: string }>
  store?: string
  onStoreChange?: (next: string) => void
  extras?: ReactNode
}

export function FilterBar({
  grain, onGrainChange,
  historyRange, onHistoryRangeChange,
  maxDate: maxDateOverride,
  storeOptions, store, onStoreChange,
  extras,
}: FilterBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draftRange, setDraftRange] = useState<PeriodWindow>(historyRange)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const [startMonth, setStartMonth] = useState(() =>
    monthStart(parseDateInput(historyRange.date_from)),
  )
  const [endMonth, setEndMonth] = useState(() =>
    monthStart(parseDateInput(historyRange.date_to)),
  )
  const maxDate = useMemo(() => maxDateOverride ?? getDataReadyDate(), [maxDateOverride])
  const maxDateText = formatDateInput(maxDate)

  useEffect(() => {
    if (!pickerOpen) return

    function closeOnOutsidePointer(event: MouseEvent | TouchEvent) {
      if (!(event.target instanceof Node)) return
      if (pickerRef.current?.contains(event.target)) return
      setPickerOpen(false)
    }

    document.addEventListener('mousedown', closeOnOutsidePointer)
    document.addEventListener('touchstart', closeOnOutsidePointer)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePointer)
      document.removeEventListener('touchstart', closeOnOutsidePointer)
    }
  }, [pickerOpen])

  function openPicker() {
    setDraftRange(historyRange)
    setStartMonth(monthStart(parseDateInput(historyRange.date_from)))
    setEndMonth(monthStart(parseDateInput(historyRange.date_to)))
    setPickerOpen(true)
  }

  function applyRange(range: PeriodWindow, options: { alignToGrain?: boolean } = {}) {
    const aligned = options.alignToGrain === false ? range : alignHistoryRangeToGrain(range, grain)
    // For week/month grain, alignment can push date_to past the data-ready
    // date (e.g. picking through 5/2 with 按周 → endOfWeek = 5/3 > maxDate).
    // Silently dropping the apply confused users — clamp instead so the
    // partial trailing bucket still renders with whatever data is ready.
    const next: PeriodWindow = {
      date_from: aligned.date_from,
      date_to: aligned.date_to > maxDateText ? maxDateText : aligned.date_to,
    }
    if (next.date_from > next.date_to) return
    onHistoryRangeChange(next)
    setDraftRange(next)
    setPickerOpen(false)
  }

  function selectStartDate(date: Date) {
    const value = formatDateInput(date)
    if (value > maxDateText) return
    setDraftRange((current) => ({
      date_from: value,
      date_to: value > current.date_to ? value : current.date_to,
    }))
  }

  function selectEndDate(date: Date) {
    const value = formatDateInput(date)
    if (value > maxDateText) return
    setDraftRange((current) => ({
      date_from: value < current.date_from ? value : current.date_from,
      date_to: value,
    }))
  }

  function applyPreset(days: number) {
    // "昨天" (days=1) is the single day before maxDate.
    // "近N天" (days>1) spans the last N days ending at maxDate.
    const end = days === 1 ? shiftDate(maxDate, -1) : maxDate
    const start = days === 1 ? shiftDate(maxDate, -1) : shiftDate(maxDate, -(days - 1))
    applyRange({ date_from: formatDateInput(start), date_to: formatDateInput(end) }, { alignToGrain: false })
  }

  function renderMonth(month: Date, onSelectDate: (date: Date) => void) {
    const cells = buildCalendarCells(month)
    const monthIndex = month.getMonth()
    return (
      <div className="range-calendar-month">
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
                onClick={() => onSelectDate(date)}
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
        <span className="filter-bar__label">时间范围</span>
        <div className="date-range-picker" ref={pickerRef}>
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
                  <button key={preset.label} type="button" onClick={() => applyPreset(preset.value)}>
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="range-calendar">
                <div className="range-calendars-wrapper">
                  <div className="range-calendar-side">
                    <div className="range-calendar-toolbar">
                      <button type="button" onClick={() => setStartMonth((m) => shiftMonth(m, -1))}>
                        上月
                      </button>
                      <span>{formatMonthTitle(startMonth)}</span>
                      <button type="button" onClick={() => setStartMonth((m) => shiftMonth(m, 1))}>
                        下月
                      </button>
                    </div>
                    {renderMonth(startMonth, selectStartDate)}
                  </div>
                  <div className="range-calendar-side">
                    <div className="range-calendar-toolbar">
                      <button type="button" onClick={() => setEndMonth((m) => shiftMonth(m, -1))}>
                        上月
                      </button>
                      <span>{formatMonthTitle(endMonth)}</span>
                      <button type="button" onClick={() => setEndMonth((m) => shiftMonth(m, 1))}>
                        下月
                      </button>
                    </div>
                    {renderMonth(endMonth, selectEndDate)}
                  </div>
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
