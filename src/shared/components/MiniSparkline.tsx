import { useId } from 'react'
import { computeChartGeometry } from '../utils/computeChartGeometry'
import type { TrendPoint } from '../../api/types'

interface MiniSparklineProps {
  items: TrendPoint[]
  tone?: 'sales' | 'complaints' | 'rate' | 'refund' | 'neutral'
}

const TONE_VARS: Record<NonNullable<MiniSparklineProps['tone']>, string> = {
  sales: 'var(--tone-sales)',
  complaints: 'var(--tone-complaints)',
  rate: 'var(--tone-rate)',
  refund: 'var(--tone-refund)',
  neutral: 'var(--accent)',
}

const MINI_SPARKLINE_BOUNDS = { left: 0, right: 100, top: 10, bottom: 86 }

function percentile(sortedValues: number[], ratio: number) {
  if (!sortedValues.length) return 0
  const index = (sortedValues.length - 1) * ratio
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sortedValues[lower]
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower)
}

function getRobustSparklineDomain(items: TrendPoint[]) {
  const values = items
    .map((item) => item.value)
    .filter((value) => Number.isFinite(value))

  if (values.length < 4) {
    return undefined
  }

  const sortedValues = [...values].sort((a, b) => a - b)
  const q1 = percentile(sortedValues, 0.25)
  const q3 = percentile(sortedValues, 0.75)
  const iqr = q3 - q1

  if (iqr <= 0) {
    return undefined
  }

  const lowerFence = q1 - iqr * 1.5
  const upperFence = q3 + iqr * 1.5
  const min = Math.min(...values)
  const max = Math.max(...values)

  if (min >= lowerFence && max <= upperFence) {
    return undefined
  }

  const lower = Math.min(q1, Math.max(min, lowerFence))
  const upper = Math.max(q3, Math.min(max, upperFence))
  const padding = Math.max((upper - lower) * 0.12, Math.abs(upper || lower || 1) * 0.02)

  return {
    min: Math.min(0, lower - padding),
    max: upper + padding,
  }
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function MiniSparkline({ items, tone = 'neutral' }: MiniSparklineProps) {
  const gradientId = useId().replace(/:/g, '')
  if (!items.length) {
    return <div className="mini-chart mini-chart--empty" aria-hidden="true" />
  }
  const robustDomain = getRobustSparklineDomain(items)
  const displayItems = robustDomain
    ? items.map((item) => ({
      ...item,
      value: clampValue(item.value, robustDomain.min, robustDomain.max),
    }))
    : items
  const { pointsString, areaString } = computeChartGeometry({
    items: displayItems,
    bounds: MINI_SPARKLINE_BOUNDS,
    yMinOverride: robustDomain?.min,
    yMaxOverride: robustDomain?.max,
  })
  const color = TONE_VARS[tone]
  return (
    <div className="mini-chart" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.16} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <polyline fill={`url(#${gradientId})`} stroke="none" points={areaString} />
        <polyline
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          points={pointsString}
        />
      </svg>
    </div>
  )
}
