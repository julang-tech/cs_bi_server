import { useMemo, useState } from 'react'
import { computeChartGeometry } from '../utils/computeChartGeometry'
import type { TrendPoint } from '../../api/types'

export interface FocusMetricSpec {
  key: string
  label: string
  formatter: (n: number) => string
  history: TrendPoint[]
  current: TrendPoint[]
}

interface FocusLineChartProps {
  metrics: FocusMetricSpec[]
  defaultKey?: string
  ariaLabel?: string
}

interface TooltipState {
  bucket: string
  valueText: string
  x: number
  y: number
}

export function FocusLineChart({ metrics, defaultKey, ariaLabel }: FocusLineChartProps) {
  const [activeKey, setActiveKey] = useState<string>(defaultKey ?? metrics[0]?.key ?? '')
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const active = useMemo(
    () => metrics.find((m) => m.key === activeKey) ?? metrics[0],
    [metrics, activeKey],
  )

  if (!active) return <div className="empty-state">暂无指标</div>

  const allPoints = [...active.history, ...active.current]
  const geo = computeChartGeometry({ items: allPoints })
  const historyCount = active.history.length
  const totalCount = allPoints.length
  const dividerX = historyCount === 0
    ? geo.bounds.left
    : historyCount === totalCount
      ? geo.bounds.right
      : (geo.points[historyCount - 1].x + geo.points[historyCount].x) / 2

  const historyMean = historyCount
    ? active.history.reduce((sum, p) => sum + p.value, 0) / historyCount
    : 0
  const meanY = geo.bounds.bottom -
    ((historyMean - geo.yMin) / (geo.yMax === geo.yMin ? 1 : geo.yMax - geo.yMin)) *
    (geo.bounds.bottom - geo.bounds.top)

  function handleHover(point: { x: number; y: number }, raw: TrendPoint) {
    setTooltip({
      bucket: raw.bucket,
      valueText: active!.formatter(raw.value),
      x: point.x,
      y: point.y,
    })
  }

  return (
    <section className="focus-chart">
      <div className="focus-chart__tabs" role="tablist">
        {metrics.map((m) => (
          <button
            key={m.key}
            type="button"
            role="tab"
            aria-selected={m.key === activeKey}
            className={`focus-chart__tab ${m.key === activeKey ? 'focus-chart__tab--active' : ''}`}
            onClick={() => setActiveKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="focus-chart__plot" onMouseLeave={() => setTooltip(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={ariaLabel ?? active.label}>
          <rect className="focus-chart__band focus-chart__band--history"
            x={geo.bounds.left} y={geo.bounds.top}
            width={dividerX - geo.bounds.left} height={geo.bounds.bottom - geo.bounds.top} />
          <rect className="focus-chart__band focus-chart__band--current"
            x={dividerX} y={geo.bounds.top}
            width={geo.bounds.right - dividerX} height={geo.bounds.bottom - geo.bounds.top} />
          <line className="focus-chart__divider"
            x1={dividerX} x2={dividerX} y1={geo.bounds.top} y2={geo.bounds.bottom} />
          {historyCount ? (
            <line className="focus-chart__mean-line"
              x1={geo.bounds.left} x2={dividerX} y1={meanY} y2={meanY} />
          ) : null}
          <polyline className="focus-chart__line" fill="none" points={geo.pointsString} />
          {active.current.length ? (() => {
            const lastPoint = geo.points[geo.points.length - 1]
            return <circle className="focus-chart__latest" cx={lastPoint.x} cy={lastPoint.y} r="2.2" />
          })() : null}
          {allPoints.map((raw, i) => (
            <g key={`${raw.bucket}-${i}`} className="focus-chart__hit"
              onMouseEnter={() => handleHover(geo.points[i], raw)}
              onFocus={() => handleHover(geo.points[i], raw)}
              tabIndex={0}>
              <circle cx={geo.points[i].x} cy={geo.points[i].y} r="6" fill="transparent" />
            </g>
          ))}
        </svg>
        {tooltip ? (
          <div className={`focus-chart__tooltip ${tooltip.x > 82 ? 'focus-chart__tooltip--left' : ''}`}
            style={{ left: `${tooltip.x}%`, top: `${tooltip.y}%` }}>
            <span>{tooltip.bucket}</span>
            <strong>{active.label}：{tooltip.valueText}</strong>
          </div>
        ) : null}
      </div>
    </section>
  )
}
