import { useId } from 'react'
import { computeChartGeometry } from '../utils/computeChartGeometry'
import type { TrendPoint } from '../../api/types'

interface MiniSparklineProps {
  items: TrendPoint[]
  tone?: 'sales' | 'complaints' | 'rate' | 'neutral'
}

const TONE_VARS: Record<NonNullable<MiniSparklineProps['tone']>, string> = {
  sales: 'var(--tone-sales)',
  complaints: 'var(--tone-complaints)',
  rate: 'var(--tone-rate)',
  neutral: 'var(--accent)',
}

export function MiniSparkline({ items, tone = 'neutral' }: MiniSparklineProps) {
  const gradientId = useId().replace(/:/g, '')
  if (!items.length) {
    return <div className="mini-placeholder">当前卡片不展示趋势折线</div>
  }
  const { pointsString, areaString } = computeChartGeometry({ items })
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
