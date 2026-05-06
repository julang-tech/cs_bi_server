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

export function MiniSparkline({ items, tone = 'neutral' }: MiniSparklineProps) {
  const gradientId = useId().replace(/:/g, '')
  if (!items.length) {
    return <div className="mini-chart mini-chart--empty" aria-hidden="true" />
  }
  const { pointsString, areaString } = computeChartGeometry({
    items,
    bounds: MINI_SPARKLINE_BOUNDS,
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
