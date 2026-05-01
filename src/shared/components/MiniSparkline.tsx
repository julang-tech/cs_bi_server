import { computeChartGeometry } from '../utils/computeChartGeometry'
import type { TrendPoint } from '../../api/types'

interface MiniSparklineProps {
  items: TrendPoint[]
  tone?: 'sales' | 'complaints' | 'rate' | 'neutral'
}

export function MiniSparkline({ items, tone = 'neutral' }: MiniSparklineProps) {
  if (!items.length) {
    return <div className="mini-placeholder">当前卡片不展示趋势折线</div>
  }
  const { pointsString, areaString } = computeChartGeometry({ items })
  return (
    <div className={`mini-chart mini-chart--${tone}`} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="mini-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polyline fill="url(#mini-gradient)" points={areaString} />
        <polyline className="mini-chart__line" fill="none" points={pointsString} />
      </svg>
    </div>
  )
}
