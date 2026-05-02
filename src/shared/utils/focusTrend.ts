import type { Grain, PeriodWindow, TrendPoint } from '../../api/types'

function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function formatDateInput(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isoWeekLabel(dateText: string): string | null {
  const date = parseDateInput(dateText)
  if (!date) return null
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function endOfWeek(date: Date): Date {
  const day = date.getDay() || 7
  const end = new Date(date)
  end.setDate(end.getDate() + (7 - day))
  return end
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

function isIncompleteCurrentPeriod(grain: Grain, currentPeriod: PeriodWindow): boolean {
  if (grain === 'day') return false
  const start = parseDateInput(currentPeriod.date_from)
  if (!start) return false
  const expectedEnd = grain === 'week' ? endOfWeek(start) : endOfMonth(start)
  return currentPeriod.date_to < formatDateInput(expectedEnd)
}

function currentBucketCandidates(grain: Grain, currentPeriod: PeriodWindow): Set<string> {
  const candidates = new Set([currentPeriod.date_from, currentPeriod.date_to])
  if (grain === 'week') {
    const weekLabel = isoWeekLabel(currentPeriod.date_to)
    if (weekLabel) candidates.add(weekLabel)
  }
  if (grain === 'month') {
    candidates.add(currentPeriod.date_to.slice(0, 7))
    candidates.add(`${currentPeriod.date_to.slice(0, 7)}-01`)
  }
  return candidates
}

export function splitFocusTrend(
  items: TrendPoint[],
  grain: Grain,
  currentPeriod: PeriodWindow,
): { history: TrendPoint[]; current: TrendPoint[] } {
  if (!isIncompleteCurrentPeriod(grain, currentPeriod) || items.length === 0) {
    return { history: items, current: [] }
  }

  const last = items[items.length - 1]
  if (!currentBucketCandidates(grain, currentPeriod).has(last.bucket)) {
    return { history: items, current: [] }
  }

  return {
    history: items.slice(0, -1),
    current: [last],
  }
}

export function formatFocusBucketLabel(bucket: string, grain: Grain): string {
  if (grain === 'day') return bucket
  if (grain === 'month') return bucket.slice(0, 7)
  if (/^\d{4}-W\d{2}$/.test(bucket)) return bucket
  return isoWeekLabel(bucket) ?? bucket
}
