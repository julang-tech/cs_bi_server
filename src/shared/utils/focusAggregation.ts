import type { TrendPoint } from '../../api/types'

export type FocusSelection =
  | { type: 'all' }
  | { type: 'bucket'; bucket: string }
  | { type: 'range'; fromBucket: string; toBucket: string }

export type FocusMetricAggregationMode = 'additive' | 'nonAdditive'

export interface FocusAggregationMetric {
  key: string
  label: string
  formatter: (n: number) => string
  history: TrendPoint[]
  current: TrendPoint[]
  aggregationMode?: FocusMetricAggregationMode
}

export interface FocusAggregationResult {
  label: string
  total: string
  average: string
  peak: string
  valley: string
  count: number
}

function getMetricPoints(metric: FocusAggregationMetric): TrendPoint[] {
  return [...metric.history, ...metric.current]
}

function pickSelectedPoints(points: TrendPoint[], selection: FocusSelection): TrendPoint[] {
  if (selection.type === 'all') return points

  if (selection.type === 'bucket') {
    return points.filter((point) => point.bucket === selection.bucket)
  }

  const fromIndex = points.findIndex((point) => point.bucket === selection.fromBucket)
  const toIndex = points.findIndex((point) => point.bucket === selection.toBucket)
  if (fromIndex < 0 || toIndex < 0) return []

  const start = Math.min(fromIndex, toIndex)
  const end = Math.max(fromIndex, toIndex)
  return points.slice(start, end + 1)
}

export function buildFocusSelectionLabel(
  selection: FocusSelection,
  bucketFormatter: (bucket: string) => string = (bucket) => bucket,
): string {
  if (selection.type === 'all') return '完整范围'
  if (selection.type === 'bucket') return bucketFormatter(selection.bucket)
  const from = bucketFormatter(selection.fromBucket)
  const to = bucketFormatter(selection.toBucket)
  return from === to ? from : `${from} 至 ${to}`
}

export function aggregateFocusMetric(
  metric: FocusAggregationMetric | undefined,
  selection: FocusSelection,
  bucketFormatter: (bucket: string) => string = (bucket) => bucket,
): FocusAggregationResult {
  const empty = {
    label: buildFocusSelectionLabel(selection, bucketFormatter),
    total: '--',
    average: '--',
    peak: '--',
    valley: '--',
    count: 0,
  }
  if (!metric) return empty

  const selected = pickSelectedPoints(getMetricPoints(metric), selection)
  if (selected.length === 0) return empty

  const values = selected.map((point) => point.value)
  const sum = values.reduce((acc, value) => acc + value, 0)
  const average = sum / values.length
  const peak = Math.max(...values)
  const valley = Math.min(...values)

  return {
    label: buildFocusSelectionLabel(selection, bucketFormatter),
    total: metric.aggregationMode === 'nonAdditive' ? '不适用' : metric.formatter(sum),
    average: metric.formatter(average),
    peak: metric.formatter(peak),
    valley: metric.formatter(valley),
    count: selected.length,
  }
}
