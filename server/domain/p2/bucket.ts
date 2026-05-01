export type P2Grain = 'day' | 'week' | 'month'

function isoWeekLabel(date: Date) {
  // ISO week: Monday-start, weeks belong to the year of their Thursday.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function bucketLabelForDate(dateText: string, grain: P2Grain): string {
  if (grain === 'day') {
    return dateText
  }
  if (grain === 'month') {
    return dateText.slice(0, 7)
  }
  const date = new Date(`${dateText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    return dateText
  }
  return isoWeekLabel(date)
}

export function enumerateBuckets(dateFrom: string, dateTo: string, grain: P2Grain): string[] {
  const start = new Date(`${dateFrom}T00:00:00Z`)
  const end = new Date(`${dateTo}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return []
  }
  const seen = new Set<string>()
  const buckets: string[] = []
  const cursor = new Date(start.getTime())
  while (cursor.getTime() <= end.getTime()) {
    const isoDate = cursor.toISOString().slice(0, 10)
    const label = bucketLabelForDate(isoDate, grain)
    if (!seen.has(label)) {
      seen.add(label)
      buckets.push(label)
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return buckets
}
